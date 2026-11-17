"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {makeOfflineManualEvidenceAudit}=require("./manual-evidence-receipt");

const BASE=Date.parse("2026-11-17T10:00:00.000Z");
const iso=m=>new Date(BASE+m*60000).toISOString();
const user=Object.freeze({auth:{uid:"synthetic-owner",token:{email_verified:true}},data:{}});
const catalogue=[{marketId:101,sportId:11,playerProp:true,
  marketName:"Over Under Player Points (incl. overtime)",period:"result",
  handicap:20.5,outcomes:[{outcomeId:201,outcomeName:"Over"},
    {outcomeId:202,outcomeName:"Under"}]}];
const fixture=(change={})=>({
  fixtureId:"synthetic-d8-1",sportId:11,tournamentId:132,statusId:0,
  hasOdds:true,startTime:iso(180),participant1Id:"5011",participant2Id:"5022",
  participant1Name:"Synthetic Team Secret",apiKey:"DO_NOT_RETAIN",
  bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,suspended:false,
    markets:{"101":{marketActive:true,outcomes:{"201":{
      players:{"301":{playerName:"Sensitive Player",active:true,
        price:1.83,changedAt:iso(-2)}}}}}}}},...change
});
function setup(config={}){
 let clock=BASE;
 const docs=new Map();
 const calls={reserved:[],catalogue:0,odds:0,reads:0,creates:0,transactions:0};
 let reservedCount=0, oddsFailure=!!config.failOdds, catalogueFailure=!!config.failCatalogue;
 let externalOdds=config.odds??[fixture()];
 let blocked=!!config.failReserve;
 // Simple serial transaction fake: the only persistent records are committed.
 let queue=Promise.resolve();
 const db={
   doc:key=>({path:key}),
   async runTransaction(callback){
     calls.transactions++;
     const prev=queue;let unlock;
     queue=new Promise(resolve=>{unlock=resolve;});
     await prev;
     try{
       const pending=[];
       const tx={
         async get(ref){
           calls.reads++;
           if(config.failRead)throw Error("secret database unavailable");
           const exists=docs.has(ref.path);
           return {exists,data:()=>exists?structuredClone(docs.get(ref.path)):undefined};
         },
         create(ref,data){
           calls.creates++;
           if(config.failCreate)throw Error("private storage failure");
           pending.push([ref.path,structuredClone(data)]);
         }
       };
       const outcome=await callback(tx);
       for(const [key,value] of pending){
         if(docs.has(key))throw Error("Already exists");
         docs.set(key,value);
       }
       return outcome;
     }finally{unlock();}
   }
 };
 const runner=makeOfflineManualEvidenceAudit({
   ownerUid:"synthetic-owner",db,now:()=>clock,
   reserve:async n=>{
     calls.reserved.push(n);
     if(blocked)throw Error("daily budget blocked");
     if(reservedCount+n>6)throw Error("daily budget exhausted");
     reservedCount+=n;
   },
   fetchCatalogue:async()=>{calls.catalogue++;if(catalogueFailure)throw Error("catalogue failed");return catalogue;},
   fetchOdds:async()=>{calls.odds++;if(oddsFailure)throw Error("provider down");return externalOdds;}
 });
 return {
   run:runner,docs,calls,
   advance:m=>{clock+=m*60000;},
   blockReserve:flag=>{blocked=flag;},
   failCatalogue:flag=>{catalogueFailure=flag;},
   failOdds:flag=>{oddsFailure=flag;},
   setOdds:data=>{externalOdds=data;},
   countReservations:()=>reservedCount
 };
}
test("35.1D8 returns the ordinary aggregate while storing only authenticated manual fixture IDs",async()=>{
 const s=setup();
 const report=await s.run(user);
 assert.equal(report.activePriceEntries,1);
 assert.equal(report.requestsUsedOnThisClick,2);
 assert.equal(report.researchSaved,false);
 assert.equal(report.pricesBookmakerVerified,false);
 assert.deepEqual(s.calls.reserved,[2]);
 assert.equal(s.calls.catalogue,1);
 assert.equal(s.calls.odds,1);
 assert.equal(s.docs.size,1);
 assert.equal(s.calls.reads,1);
 assert.equal(s.calls.creates,1);
 const [[key,row]]=[...s.docs];
 assert.match(key,/^_internal\/teamEvidence\/providerSnapshots\/ODDSPAPI_MANUAL_[A-F0-9]{32}$/);
 assert.equal(row.status,"UNREVIEWED_PROVIDER_EVIDENCE");
 assert.deepEqual(row.records[0].participantIds,["5011","5022"]);
 assert.equal(row.records[0].fixtureId,"synthetic-d8-1");
 assert.doesNotMatch(JSON.stringify(row),/DO_NOT_RETAIN|Sensitive Player|Synthetic Team Secret|1\.83|bookmakerOdds/);
 assert.doesNotMatch(JSON.stringify(report),/synthetic-d8-1|DO_NOT_RETAIN|5011|5022|Sensitive Player/);
});
test("35.1D8 repeated cached audit cannot re-fetch, re-reserve or re-save evidence",async()=>{
 const s=setup();
 await s.run(user);
 const repeat=await s.run(user);
 assert.equal(repeat.cached,true);
 assert.equal(repeat.requestsUsedOnThisClick,0);
 assert.deepEqual(s.calls.reserved,[2]);
 assert.equal(s.calls.odds,1);
 assert.equal(s.calls.creates,1);
 assert.equal(s.docs.size,1);
});
test("35.1D8 stale audit reuses catalogue but reserves a new paid-stage call",async()=>{
 const s=setup();
 await s.run(user);
 s.advance(16);
 const next=await s.run(user);
 assert.equal(next.catalogueCached,true);
 assert.equal(next.requestsUsedOnThisClick,1);
 assert.deepEqual(s.calls.reserved,[2,1]);
 assert.equal(s.calls.catalogue,1);
 assert.equal(s.calls.odds,2);
 assert.equal(s.docs.size,2);
});
test("35.1D8 concurrent owner clicks share one reservation, upstream fetch and write",async()=>{
 const s=setup(),[a,b]=await Promise.all([s.run(user),s.run(user)]);
 assert.deepEqual(new Set([a.cached,b.cached]),new Set([false,true]));
 assert.deepEqual(s.calls.reserved,[2]);
 assert.equal(s.calls.odds,1);
 assert.equal(s.calls.creates,1);
});
test("35.1D8 rejects anonymous, wrong-owner, unverified and spoofed arguments before reserve",async()=>{
 const s=setup();
 for(const bad of [null,{}, {auth:{uid:"intruder",token:{email_verified:true}},data:{}},
   {auth:{uid:"synthetic-owner",token:{email_verified:false}},data:{}},
   {auth:user.auth,data:{fixtureId:"fake"}}, {auth:user.auth,data:[]}])
   await assert.rejects(s.run(bad));
 assert.deepEqual(s.calls.reserved,[]);
 assert.equal(s.calls.odds,0);
 assert.equal(s.docs.size,0);
});
test("35.1D8 denied budget stops all paid stages and all evidence writes",async()=>{
 const s=setup({failReserve:true});
 await assert.rejects(s.run(user),/daily budget blocked/);
 assert.deepEqual(s.calls.reserved,[2]);
 assert.equal(s.calls.catalogue,0);
 assert.equal(s.calls.odds,0);
 assert.equal(s.calls.transactions,0);
});
test("35.1D8 failing catalogue cannot call paid league endpoint or store evidence",async()=>{
 const s=setup({failCatalogue:true});
 await assert.rejects(s.run(user),/catalogue failed/);
 assert.equal(s.calls.catalogue,1);
 assert.equal(s.calls.odds,0);
 assert.equal(s.docs.size,0);
});
test("35.1D8 retry after catalogue failure invalidates the prior unused permission",async()=>{
 const s=setup({failCatalogue:true});
 await assert.rejects(s.run(user),/catalogue failed/);
 s.failCatalogue(false);
 const result=await s.run(user);
 assert.equal(result.activePriceEntries,1);
 assert.deepEqual(s.calls.reserved,[2,2]);
 assert.equal(s.calls.odds,1);
 assert.equal(s.docs.size,1);
});
test("35.1D8 failing provider response never produces a receipt or an automatic retry",async()=>{
 const s=setup({failOdds:true});
 await assert.rejects(s.run(user),/provider down/);
 assert.equal(s.calls.odds,1);
 assert.equal(s.docs.size,0);
 assert.equal(s.calls.transactions,0);
});
test("35.1D8 malformed league response fails audit without storing unverified records",async()=>{
 const s=setup({odds:{}});
 await assert.rejects(s.run(user),/fixtures/);
 assert.equal(s.calls.odds,1);
 assert.equal(s.docs.size,0);
});
test("35.1D8 missing provider participant IDs cannot be guessed from team names",async()=>{
 const s=setup({odds:[fixture({participant1Id:null})]});
 const report=await s.run(user);
 assert.equal(report.totalFixtures,1);
 assert.equal(s.calls.odds,1);
 assert.equal(s.calls.transactions,0);
 assert.equal(s.docs.size,0);
});
test("35.1D8 missing scheduled status rejects evidence without changing aggregate audit",async()=>{
 const s=setup({odds:[fixture({statusId:undefined})]});
 const report=await s.run(user);
 assert.equal(report.activePriceEntries,1);
 assert.equal(s.docs.size,0);
});
test("35.1D8 quarantines duplicate fixture IDs without guessing first-wins",async()=>{
 const s=setup({odds:[fixture(),fixture({participant2Id:"5999"})]});
 const report=await s.run(user);
 assert.equal(report.totalFixtures,2);
 assert.equal(s.docs.size,0);
});
test("35.1D8 inactive exact bookmaker does not generate provider evidence",async()=>{
 const s=setup({odds:[fixture({bookmakerOdds:{"betano.pt":{
   bookmakerIsActive:false,suspended:false,markets:{}}}})]});
 const report=await s.run(user);
 assert.equal(report.totalFixtures,1);
 assert.equal(s.docs.size,0);
});
test("35.1D8 internal storage unavailable cannot trigger a second paid request",async()=>{
 const s=setup({failCreate:true});
 const report=await s.run(user);
 assert.equal(report.activePriceEntries,1);
 assert.equal(s.calls.odds,1);
 assert.equal(s.calls.transactions,1);
 assert.equal(s.docs.size,0);
 assert.equal((await s.run(user)).cached,true);
 assert.equal(s.calls.odds,1);
});
test("35.1D8 failed database read is non-retrying and does not leak private errors",async()=>{
 const s=setup({failRead:true});
 const report=await s.run(user);
 assert.equal(report.activePriceEntries,1);
 assert.equal(s.calls.odds,1);
 assert.equal(s.docs.size,0);
 assert.doesNotMatch(JSON.stringify(report),/database unavailable|secret/);
});
test("35.1D8 no new paid call when existing six-slot UTC guard rejects further requests",async()=>{
 const s=setup();
 await s.run(user);
 for(let i=0;i<4;i++){s.advance(16);await s.run(user);}
 assert.equal(s.countReservations(),6);
 s.advance(16);
 await assert.rejects(s.run(user),/daily budget exhausted/);
 assert.equal(s.calls.odds,5);
 assert.equal(s.docs.size,5);
});
test("35.1D8 no asynchronous polling, HTTP or real Cloud Function installation",()=>{
 const content=fs.readFileSync(path.join(__dirname,"manual-evidence-receipt.js"),"utf8");
 const production=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 const rules=fs.readFileSync(path.join(__dirname,"..","firestore.rules"),"utf8");
 assert.doesNotMatch(content,/https:\/\/|\bfetch\(|setInterval\(|onSchedule\(|onCall\(|require\(["']firebase-admin/);
 assert.doesNotMatch(production,/manual-evidence-receipt|makeOfflineManualEvidenceAudit/);
 assert.doesNotMatch(rules,/teamEvidence|providerSnapshots/);
});
test("35.1D8 refuses missing or nonfunction trusted source and quota adapters",()=>{
 for(const cfg of [{},{ownerUid:"synthetic-owner"},
  {ownerUid:"synthetic-owner",reserve:async()=>{},fetchCatalogue:async()=>{}},
  {ownerUid:"synthetic-owner",reserve:async()=>{},fetchCatalogue:async()=>{},
   fetchOdds:async()=>{},db:{}}])
  assert.throws(()=>makeOfflineManualEvidenceAudit(cfg),/Missing|backend Firestore/);
});
test("35.1D8 trust receipt capability is private to the owner-gated runner",()=>{
 const runner=setup().run;
 assert.equal(typeof runner,"function");
 assert.equal(Object.hasOwn(runner,"fetchOdds"),false);
 assert.equal(Object.hasOwn(runner,"onProviderEvidence"),false);
 assert.equal(Object.hasOwn(runner,"receipt"),false);
});
test("35.1D8 identity observations never grant approval or automatic betting capture",async()=>{
 const s=setup();await s.run(user);
 const record=[...s.docs.values()][0];
 for(const forbidden of ["teams","espnEventId","reviewStatus",
   "captureAllowed","autoLineSelected","mainLine","price","odds",
   "modelOver","athleteId","settlement"])
   assert.equal(Object.hasOwn(record,forbidden),false);
});
