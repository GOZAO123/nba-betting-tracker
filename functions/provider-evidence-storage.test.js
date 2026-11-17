"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {extractManualProviderIdentityBatch}=require("./provider-evidence-acquisition");
const {captureProviderFixture}=require("./offer-team-evidence");
const {makeOfflineProviderEvidenceStore}=require("./provider-evidence-storage");

const NOW=Date.parse("2026-11-17T10:00:00.000Z");
const iso=m=>new Date(NOW+m*60000).toISOString();
const fixture=(change={})=>({
  fixtureId:"d6-fixture-1",sportId:11,tournamentId:132,
  statusId:0,hasOdds:true,startTime:iso(180),
  participant1Id:"5001",participant2Id:"5002",
  apiKey:"DONT_STORE_SECRET",participant1Name:"Team Secret",
  bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,
    suspended:false,markets:{"101":{marketActive:true,
      outcomes:{"201":{players:{"301":{playerName:"Private Player",
        price:1.87,changedAt:iso(-2)}}}}}}}},...change
});
const batch=()=>extractManualProviderIdentityBatch([fixture()],iso(-1));
function mock({trusted=true,failRead=false,failCreate=false,failTransact=false,
  now=()=>NOW, malformedTransaction=false}={}) {
  const token=Object.freeze({kind:"synthetic-server-capability"});
  const docs=new Map();let reads=0,creates=0,authCalls=0,transactionCalls=0;
  // Serialize our mock transactions to mimic atomic compare-and-create.
  let tail=Promise.resolve();
  const runTransaction=async callback=>{
    transactionCalls++;
    const prior=tail;let release;
    tail=new Promise(done=>{release=done;});
    await prior;
    try {
      if(failTransact)throw Error("storage is offline");
      if(malformedTransaction)return callback({});
      return await callback({
        read:async key=>{
          reads++;
          if(failRead)throw Error("read unavailable");
          return docs.has(key)?structuredClone(docs.get(key)):null;
        },
        create:async(key,value)=>{
          if(failCreate)throw Error("write unavailable");
          if(docs.has(key))throw Error("collision");
          creates++;docs.set(key,structuredClone(value));
        }
      });
    } finally {release();}
  };
  const store=makeOfflineProviderEvidenceStore({
    now,runTransaction,
    isTrustedManualReceipt:async(receipt,source)=>{
      authCalls++;
      return trusted && receipt===token && source.source==="ODDSPAPI_V4_ODDS_BY_TOURNAMENTS" &&
        /^ODDSPAPI_MANUAL_[A-F0-9]{32}$/.test(source.reference) &&
        source.capturedAt===iso(-1);
    }
  });
  return {token,store,docs,stats:()=>({reads,creates,authCalls,transactionCalls})};
}

test("35.1D6 stores one sanitized immutable provider snapshot under fixed backend path",async()=>{
 const m=mock(), b=batch(), out=await m.store.storeBatch(b,m.token);
 assert.deepEqual(out,{status:"STORED"});
 assert.deepEqual(m.stats(),{reads:1,creates:1,authCalls:1,transactionCalls:1});
 const entries=[...m.docs.entries()];
 assert.equal(entries.length,1);
 assert.equal(entries[0][0],"_internal/teamEvidence/providerSnapshots/"+b.snapshotReference);
 const row=entries[0][1];
 assert.equal(row.source,"ODDSPAPI_V4_ODDS_BY_TOURNAMENTS");
 assert.equal(row.status,"UNREVIEWED_PROVIDER_EVIDENCE");
 assert.equal(row.receivedAt,iso(0));
 assert.match(row.digest,/^[a-f0-9]{64}$/);
 assert.equal(row.records[0].fixtureId,"d6-fixture-1");
 assert.deepEqual(row.records[0].participantIds,["5001","5002"]);
 assert.doesNotMatch(JSON.stringify(row),/DONT_STORE_SECRET|Private Player|Team Secret|1\.87|apiKey|bookmakerOdds/);
});

test("35.1D6 exact retry is idempotent; no second write or new provider call",async()=>{
 const m=mock(), b=batch();
 assert.equal((await m.store.storeBatch(b,m.token)).status,"STORED");
 assert.equal((await m.store.storeBatch(b,m.token)).status,"ALREADY_STORED");
 assert.equal(m.docs.size,1);
 assert.equal(m.stats().creates,1);
});

test("35.1D6 conflicting immutable snapshot under same reference is rejected",async()=>{
 const m=mock(), first=batch();
 await m.store.storeBatch(first,m.token);
 const raw=fixture({fixtureId:"d6-fixture-2"});
 const normalized=captureProviderFixture(raw,{
   reference:first.snapshotReference,capturedAt:first.capturedAt});
 const changed={...first,records:[normalized]};
 assert.equal((await m.store.storeBatch(changed,m.token)).status,"CONFLICT");
 assert.equal(m.stats().creates,1);
 assert.equal(m.docs.size,1);
});

test("35.1D6 unauthorized source capability denied before all database reads",async()=>{
 const m=mock(), b=batch();
 assert.deepEqual(await m.store.storeBatch(b,{kind:"synthetic-server-capability"}),
   {status:"DENIED"});
 assert.deepEqual(m.stats(),{reads:0,creates:0,authCalls:1,transactionCalls:0});
});

test("35.1D6 explicit receipt validator refusal denies without storage",async()=>{
 const m=mock({trusted:false});
 assert.deepEqual(await m.store.storeBatch(batch(),m.token),{status:"DENIED"});
 assert.equal(m.stats().reads,0);
});

test("35.1D6 malformed, stale, future and missing evidence fail before receipt validation",async()=>{
 const m=mock(), b=batch();
 for (const invalid of [
   null,{},[],{...b,source:"CLIENT_UPLOAD"},
   {...b,schemaVersion:2},{...b,status:"APPROVED"},
   {...b,extra:{price:1.9}},
   {...b,snapshotReference:"../../wrong"},
   {...b,capturedAt:iso(-6)},
   {...b,capturedAt:iso(1)},
   {...b,totalFixtures:251},
   {...b,acceptedFixtures:2},
   {...b,rejectedFixtures:99},
   {...b,records:[]}
 ]) assert.equal((await m.store.storeBatch(invalid,m.token)).status,
   "INVALID_BATCH");
 assert.deepEqual(m.stats(),{reads:0,creates:0,authCalls:0,transactionCalls:0});
});

test("35.1D6 tampered fingerprint cannot be stored",async()=>{
 const m=mock(),b=batch();
 const altered={...b,records:[{...b.records[0],digest:"f".repeat(64)}]};
 assert.equal((await m.store.storeBatch(altered,m.token)).status,"INVALID_BATCH");
 assert.equal(m.stats().transactionCalls,0);
});

test("35.1D6 client-provided name, quote, market or authentication field is rejected",async()=>{
 const m=mock(), b=batch();
 for (const forbidden of [
   {price:1.84},{playerName:"Private Player"},{apiKey:"SECRET"},
   {reviewStatus:"APPROVED"},{eventId:"9999"},{bookmaker:"betano.pt"}
 ]) {
   const record={...b.records[0],...forbidden};
   const res=await m.store.storeBatch({...b,records:[record]},m.token);
   assert.equal(res.status,"INVALID_BATCH");
 }
 assert.equal(m.stats().transactionCalls,0);
});

test("35.1D6 batch with mismatched reference/receipt cannot be accepted",async()=>{
 const m=mock(),b=batch();
 const wrong={...b,records:[{...b.records[0],reference:"ODDSPAPI_MANUAL_"+ "A".repeat(32)}]};
 assert.equal((await m.store.storeBatch(wrong,m.token)).status,"INVALID_BATCH");
});

test("35.1D6 duplicated fixture ID within one batch is quarantined",async()=>{
 const m=mock(),b=batch();
 const duplicate={...b,totalFixtures:2,acceptedFixtures:2,records:[b.records[0],b.records[0]]};
 assert.equal((await m.store.storeBatch(duplicate,m.token)).status,"INVALID_BATCH");
});

test("35.1D6 rejects kickoff too close or beyond 72-hour horizon at storage time",async()=>{
 const m=mock(),b=batch();
 for(const start of [iso(5),iso(72*60+1)]){
   const rec=captureProviderFixture(fixture({startTime:start}),{
     reference:b.snapshotReference,capturedAt:b.capturedAt});
   assert.ok(rec);
   assert.equal((await m.store.storeBatch({...b,records:[rec]},m.token)).status,
     "INVALID_BATCH");
 }
});

test("35.1D6 concurrent identical writes create exactly one snapshot",async()=>{
 const m=mock(),b=batch();
 const [a,c]=await Promise.all([m.store.storeBatch(b,m.token),
   m.store.storeBatch(b,m.token)]);
 assert.deepEqual(new Set([a.status,c.status]),new Set(["STORED","ALREADY_STORED"]));
 assert.equal(m.docs.size,1);assert.equal(m.stats().creates,1);
});

test("35.1D6 concurrent different content with same reference cannot overwrite",async()=>{
 const m=mock(),b=batch();
 const alt=captureProviderFixture(fixture({fixtureId:"d6-other"}),{
   reference:b.snapshotReference,capturedAt:b.capturedAt});
 const [a,c]=await Promise.all([m.store.storeBatch(b,m.token),
   m.store.storeBatch({...b,records:[alt]},m.token)]);
 assert.deepEqual(new Set([a.status,c.status]),new Set(["STORED","CONFLICT"]));
 assert.equal(m.docs.size,1);assert.equal(m.stats().creates,1);
});

test("35.1D6 tampered existing stored row is conflict, not success",async()=>{
 const m=mock(),b=batch();await m.store.storeBatch(b,m.token);
 const key=[...m.docs.keys()][0];
 m.docs.get(key).records[0].participantIds[1]="9999";
 assert.equal((await m.store.storeBatch(b,m.token)).status,"CONFLICT");
 assert.equal(m.stats().creates,1);
});

test("35.1D6 storage read/write failures fail closed with no sensitive errors",async()=>{
 for(const opts of [{failRead:true},{failCreate:true},{failTransact:true},
   {malformedTransaction:true}]){
   const m=mock(opts),res=await m.store.storeBatch(batch(),m.token);
   assert.deepEqual(res,{status:"UNAVAILABLE"});
   assert.doesNotMatch(JSON.stringify(res),/storage|SECRET|Firestore/i);
 }
});

test("35.1D6 invalid storage dependencies rejected before use",()=>{
 for(const cfg of [{},{runTransaction:async()=>true},
   {isTrustedManualReceipt:async()=>true}])
  assert.throws(()=>makeOfflineProviderEvidenceStore(cfg),
    /Missing trusted storage dependencies/);
});

test("35.1D6 no client, production Firebase, OddsPapi, ESPN or polling wiring",()=>{
 const source=fs.readFileSync(path.join(__dirname,"provider-evidence-storage.js"),"utf8");
 const prod=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 const rules=fs.readFileSync(path.join(__dirname,"..","firestore.rules"),"utf8");
 assert.doesNotMatch(prod,/provider-evidence-storage|makeOfflineProviderEvidenceStore/);
 assert.doesNotMatch(source,/https:\/\/|onCall\(|getFirestore\(|setInterval\(|fetch\(/);
 assert.doesNotMatch(rules,/teamEvidence|providerSnapshots/);
 assert.match(rules,/Everything else is denied by default/);
});

test("35.1D6 immutable snapshot cannot grant D3 approvals or auto-select odds",async()=>{
 const m=mock(),b=batch();await m.store.storeBatch(b,m.token);
 const row=[...m.docs.values()][0];
 assert.equal(row.status,"UNREVIEWED_PROVIDER_EVIDENCE");
 for(const field of ["espnEventId","teams","reviewStatus","odds","price",
   "line","mainLine","captureAllowed","autoLineSelected"])
   assert.equal(Object.hasOwn(row,field),false);
});

test("35.1D6 Firestore map key reordering does not falsely reject exact replay",async()=>{
 const m=mock(),b=batch();await m.store.storeBatch(b,m.token);
 const key=[...m.docs.keys()][0],doc=m.docs.get(key);
 doc.records[0]=Object.fromEntries(Object.entries(doc.records[0]).reverse());
 assert.equal((await m.store.storeBatch(b,m.token)).status,"ALREADY_STORED");
 assert.equal(m.stats().creates,1);
});

test("35.1D6 hostile malformed objects fail closed without reading storage",async()=>{
 const m=mock();
 const malformed=new Proxy({},{
   ownKeys:()=>{throw Error("malicious getter");}
 });
 assert.equal((await m.store.storeBatch(malformed,m.token)).status,"INVALID_BATCH");
 assert.equal(m.stats().transactionCalls,0);
});
