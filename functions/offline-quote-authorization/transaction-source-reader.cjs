'use strict';
const {isDeepStrictEqual}=require('node:util');
const B='_internal/teamReview/sourceBindings/';
const P='_internal/teamEvidence/fixtureTeamSnapshots/';
const E='_internal/teamReview/espnSnapshots/';
const exact=(x,k)=>x!==null&&typeof x==='object'&&!Array.isArray(x)&&Reflect.ownKeys(x).length===k.length&&k.every(a=>Object.hasOwn(x,a)&&Object.getOwnPropertyDescriptor(x,a).get===undefined&&Object.getOwnPropertyDescriptor(x,a).set===undefined);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const utc=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&new Date(Date.parse(x)).toISOString()===x;
function makeTransactionSourceReader({db,makePacket,sanitizeScoreboard}={}){
 if(typeof db?.doc!=='function'||typeof makePacket!=='function'||typeof sanitizeScoreboard!=='function')throw new TypeError('Missing trusted dependencies');
 return async function read({tx,fixtureId,packetDigest,pairs,now}={}){
  try{
   if(typeof tx?.get!=='function'||typeof fixtureId!=='string'||!/^[A-Za-z0-9._:-]{1,120}$/.test(fixtureId)||fixtureId==='.'||fixtureId==='..'||!hash(packetDigest)||!Number.isSafeInteger(now)||now<0||!Array.isArray(pairs)||pairs.length!==2)return null;
   if(!pairs.every(p=>exact(p,['providerParticipantId','espnTeamId'])&&typeof p.providerParticipantId==='string'&&typeof p.espnTeamId==='string'))return null;
   const pinned=structuredClone(pairs);
   const readDoc=async path=>{const ref=db.doc(path);if(ref?.path!==path)throw Error('Invalid reference');const s=await tx.get(ref);return s?.exists===true?s.data():null;};
   const b=await readDoc(B+fixtureId);
   if(!exact(b,['schemaVersion','fixtureId','providerReference','espnReference','providerDigest','espnDigest','packetDigest'])||b.schemaVersion!==1||b.fixtureId!==fixtureId||b.packetDigest!==packetDigest||!hash(b.providerDigest)||!hash(b.espnDigest)||typeof b.providerReference!=='string'||!/^ODDSPAPI_FIXTURES_[A-F0-9]{32}$/.test(b.providerReference)||typeof b.espnReference!=='string'||!/^ESPN_[A-Z0-9_-]{6,88}$/.test(b.espnReference))return null;
   const [p,e]=await Promise.all([readDoc(P+b.providerReference),readDoc(E+b.espnReference)]);
   if(!exact(p,['schemaVersion','source','status','reference','capturedAt','totalFixtures','acceptedFixtures','skippedOutsideWindow','records','digest','receivedAt'])||p.reference!==b.providerReference||!utc(p.receivedAt)||!utc(p.capturedAt)||Date.parse(p.receivedAt)<Date.parse(p.capturedAt)||Date.parse(p.receivedAt)>now||!exact(e,['schemaVersion','source','reference','capturedAt','scoreboard'])||e.schemaVersion!==1||e.source!=='ESPN_NBA_SCOREBOARD'||e.reference!==b.espnReference||!utc(e.capturedAt))return null;
   const normalized=sanitizeScoreboard(e.scoreboard);
   if(!normalized||!isDeepStrictEqual(normalized,e.scoreboard))return null;
   const {receivedAt,...receipt}=p;
   const packet=makePacket({fixtureId,providerReceipt:receipt,espnScoreboard:e.scoreboard,espnMetadata:{reference:e.reference,capturedAt:e.capturedAt},now});
   if(!packet||packet.provider.snapshotDigest!==b.providerDigest||packet.espn.digest!==b.espnDigest||packet.packetDigest!==packetDigest)return null;
   const providers=new Set(packet.provider.participants.map(x=>x.participantId));
   const teams=new Set([packet.espn.home.teamId,packet.espn.away.teamId]);
   if(providers.size!==2||teams.size!==2||!pinned.every(x=>providers.delete(x.providerParticipantId)&&teams.delete(x.espnTeamId))||providers.size||teams.size)return null;
   return Object.freeze({status:'SOURCE_CONSISTENCY_ONLY',packet});
  }catch(_){return null;}
 };
}
module.exports={makeTransactionSourceReader};
