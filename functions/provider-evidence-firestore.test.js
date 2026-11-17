"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {extractManualProviderIdentityBatch}=require("./provider-evidence-acquisition");
const {captureProviderFixture}=require("./offer-team-evidence");
const {makeOfflineFirestoreEvidenceTransaction,
  makeOfflineFirestoreProviderEvidenceStore}=require("./provider-evidence-firestore");

const NOW=Date.parse("2026-11-17T10:00:00.000Z");
const iso=m=>new Date(NOW+m*60000).toISOString();
const fixture=(update={})=>({
  fixtureId:"synthetic-d7-one",sportId:11,tournamentId:132,statusId:0,
  hasOdds:true,startTime:iso(180),participant1Id:"5001",participant2Id:"5002",
  participant1Name:"Private Team",secret:"NO_EXPORT_KEY",
  bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,suspended:false,
    markets:{"101":{marketActive:true,outcomes:{"201":{
      players:{"301":{playerName:"Private Player",price:1.84,active:true}}
    }}}}}},...update
});
const batch=()=>extractManualProviderIdentityBatch([fixture()],iso(-1));
const PREFIX="_internal/teamEvidence/providerSnapshots/";
function memoryAdmin({failRead=false,failCreate=false,failCommit=false,
  malformedRef=false,invalidSnapshot=false,invalidTx=false,retries=0}={}) {
  const docs=new Map(), stats={transactionCalls:0,reads:0,creates:0,commits:0};
  let tail=Promise.resolve();
  const db={
    doc(p){return {path:malformedRef?"different/path":p};},
    async runTransaction(callback){
      stats.transactionCalls++;
      const prior=tail;let release;
      tail=new Promise(resolve=>{release=resolve;});
      await prior;
      try {
        const runAttempt=async()=>{
          const pending=[];
          const tx={
            async get(ref){
              stats.reads++;
              if(failRead)throw Error("sensitive read failure");
              if(invalidSnapshot)return {exists:"not a boolean"};
              const exists=docs.has(ref.path);
              return {exists,data:()=>exists?structuredClone(docs.get(ref.path)):undefined};
            },
            create(ref,value){
              stats.creates++;
              if(failCreate)throw Error("sensitive write failure");
              pending.push([ref.path,structuredClone(value)]);
              return this;
            }
          };
          const answer=await callback(invalidTx?{}:tx);
          if(failCommit)throw Error("sensitive commit failure");
          return {answer,pending};
        };
        for(let i=0;i<retries;i++)await runAttempt(); // discarded retries
        const {answer,pending}=await runAttempt();
        for(const [p,value] of pending){
          if(docs.has(p))throw Error("create-only collision");
          docs.set(p,value);
        }
        stats.commits++;
        return answer;
      } finally{release();}
    }
  };
  return {db,docs,stats};
}
function setup(options={}){
 const mem=memoryAdmin(options);
 const token=Object.freeze({kind:"SYNTHETIC_BACKEND_RECEIPT"});
 let authChecks=0;
 const store=makeOfflineFirestoreProviderEvidenceStore({
   db:mem.db, now:()=>NOW,
   isTrustedManualReceipt:async(receipt,source)=>{
     authChecks++;
     return receipt===token &&
       source.source==="ODDSPAPI_V4_ODDS_BY_TOURNAMENTS" &&
       source.capturedAt===iso(-1) &&
       /^ODDSPAPI_MANUAL_[A-F0-9]{32}$/.test(source.reference);
   }
 });
 return {...mem,token,store,authChecks:()=>authChecks};
}
test("35.1D7 composing the adapter is inert until backend calls storeBatch",()=>{
 const s=setup();
 assert.deepEqual(s.stats,{transactionCalls:0,reads:0,creates:0,commits:0});
 assert.equal(s.docs.size,0);
 assert.equal(s.authChecks(),0);
});
test("35.1D7 authenticated batch uses one bounded Admin transaction and create-only doc",async()=>{
 const s=setup(),input=batch();
 const outcome=await s.store.storeBatch(input,s.token);
 assert.deepEqual(outcome,{status:"STORED"});
 assert.deepEqual(s.stats,{transactionCalls:1,reads:1,creates:1,commits:1});
 assert.equal(s.docs.size,1);
 const [[key,doc]]=[...s.docs.entries()];
 assert.equal(key,PREFIX+input.snapshotReference);
 assert.equal(doc.status,"UNREVIEWED_PROVIDER_EVIDENCE");
 assert.deepEqual(doc.records[0].participantIds,["5001","5002"]);
 assert.equal(doc.receivedAt,iso(0));
 assert.doesNotMatch(JSON.stringify(doc),/Private Team|Private Player|NO_EXPORT_KEY|1\.84|bookmakerOdds/);
});
test("35.1D7 exact replays use one read and zero further creates",async()=>{
 const s=setup(),input=batch();
 assert.deepEqual(await s.store.storeBatch(input,s.token),{status:"STORED"});
 assert.deepEqual(await s.store.storeBatch(input,s.token),{status:"ALREADY_STORED"});
 assert.equal(s.stats.creates,1);
 assert.equal(s.stats.reads,2);
 assert.equal(s.docs.size,1);
});
test("35.1D7 immutable conflicting snapshot cannot overwrite existing document",async()=>{
 const s=setup(),input=batch();
 await s.store.storeBatch(input,s.token);
 const other=captureProviderFixture(fixture({fixtureId:"synthetic-d7-two"}),{
   reference:input.snapshotReference,capturedAt:input.capturedAt
 });
 assert.deepEqual(await s.store.storeBatch({...input,records:[other]},s.token),
   {status:"CONFLICT"});
 assert.equal(s.stats.creates,1);
 assert.equal(s.docs.size,1);
});
test("35.1D7 authorization denial precedes transaction and Firestore reads",async()=>{
 const s=setup();
 assert.deepEqual(await s.store.storeBatch(batch(),{}),{status:"DENIED"});
 assert.deepEqual(s.stats,{transactionCalls:0,reads:0,creates:0,commits:0});
});
test("35.1D7 invalid evidence is rejected without any Firestore activity",async()=>{
 const s=setup(),input=batch();
 assert.deepEqual(await s.store.storeBatch({...input,extra:"spoof"},s.token),
   {status:"INVALID_BATCH"});
 assert.equal(s.authChecks(),0);
 assert.equal(s.stats.transactionCalls,0);
});
test("35.1D7 simultaneous identical callbacks cannot create twice",async()=>{
 const s=setup(),input=batch();
 const out=await Promise.all([
   s.store.storeBatch(input,s.token),
   s.store.storeBatch(input,s.token)
 ]);
 assert.deepEqual(new Set(out.map(x=>x.status)),
   new Set(["STORED","ALREADY_STORED"]));
 assert.equal(s.stats.creates,1);
 assert.equal(s.docs.size,1);
});
test("35.1D7 competing same-reference snapshots preserve first commit",async()=>{
 const s=setup(),input=batch();
 const variant=captureProviderFixture(fixture({participant2Id:"5111"}),{
   reference:input.snapshotReference,capturedAt:input.capturedAt
 });
 const out=await Promise.all([
  s.store.storeBatch(input,s.token),
  s.store.storeBatch({...input,records:[variant]},s.token)
 ]);
 assert.deepEqual(new Set(out.map(x=>x.status)),
   new Set(["STORED","CONFLICT"]));
 assert.equal(s.stats.creates,1);
});
test("35.1D7 Admin map key order does not break immutable idempotence",async()=>{
 const s=setup(),input=batch();await s.store.storeBatch(input,s.token);
 const row=[...s.docs.values()][0];
 row.records[0]=Object.fromEntries(Object.entries(row.records[0]).reverse());
 assert.equal((await s.store.storeBatch(input,s.token)).status,"ALREADY_STORED");
});
test("35.1D7 transaction retry callback does not duplicate creates",async()=>{
 const s=setup({retries:1}),input=batch();
 assert.equal((await s.store.storeBatch(input,s.token)).status,"STORED");
 assert.equal(s.stats.transactionCalls,1);
 assert.equal(s.stats.reads,2); // one discarded retry, one commit
 assert.equal(s.stats.creates,2); // attempted create in both transactions
 assert.equal(s.docs.size,1);    // only the committed transaction persists
});
test("35.1D7 fail closed on malformed transaction, snapshots or references",async()=>{
 for(const flag of ["invalidTx","invalidSnapshot","malformedRef"]){
   const s=setup({[flag]:true});
   assert.deepEqual(await s.store.storeBatch(batch(),s.token),{status:"UNAVAILABLE"});
   assert.equal(s.docs.size,0);
 }
});
test("35.1D7 failed backend reads, creates or commits return fixed status only",async()=>{
 for(const flag of ["failRead","failCreate","failCommit"]){
   const s=setup({[flag]:true});
   const response=await s.store.storeBatch(batch(),s.token);
   assert.deepEqual(response,{status:"UNAVAILABLE"});
   assert.doesNotMatch(JSON.stringify(response),/sensitive|commit|API|credential/i);
   assert.equal(s.docs.size,0);
 }
});
test("35.1D7 requires Admin-style db and independent trusted receipt adapter",()=>{
 for(const options of [{},{db:{}},{db:{doc(){},runTransaction(){}}}]){
   assert.throws(()=>makeOfflineFirestoreProviderEvidenceStore(options),
     /Missing/);
 }
 assert.throws(()=>makeOfflineFirestoreEvidenceTransaction({doc:()=>null}),
   /Missing backend/);
});
test("35.1D7 rejects an arbitrary browser-supplied read path",async()=>{
 const s=memoryAdmin(),tx=makeOfflineFirestoreEvidenceTransaction(s.db);
 for(const p of ["users/someone/propResearchLedger/x",
   "_internal/teamEvidence/providerSnapshots/../../users",
   "_internal/teamEvidence/providerSnapshots/not-an-opaque-id"]){
   await assert.rejects(tx(t=>t.read(p)),/Invalid evidence document path/);
 }
 assert.equal(s.stats.reads,0);
 assert.equal(s.docs.size,0);
});
test("35.1D7 rejects create without the exact absent-document read",async()=>{
 const s=memoryAdmin(),tx=makeOfflineFirestoreEvidenceTransaction(s.db);
 const b=batch(),p=PREFIX+b.snapshotReference;
 await assert.rejects(tx(t=>t.create(p,{status:"UNREVIEWED_PROVIDER_EVIDENCE"})),
   /not authorized/);
 assert.equal(s.stats.creates,0);
});
test("35.1D7 forbids multiple reads per transaction",async()=>{
 const s=memoryAdmin(),tx=makeOfflineFirestoreEvidenceTransaction(s.db);
 const p=PREFIX+batch().snapshotReference;
 await assert.rejects(tx(async t=>{await t.read(p);await t.read(p);}),
   /Multiple evidence reads forbidden/);
 assert.equal(s.stats.reads,1);
});
test("35.1D7 forbids direct caller creating another document after an absent read",async()=>{
 const s=memoryAdmin(),tx=makeOfflineFirestoreEvidenceTransaction(s.db);
 const b=batch(),p=PREFIX+b.snapshotReference;
 await assert.rejects(tx(async t=>{await t.read(p);await t.create(p+"/extra",{});}),
   /not authorized/);
 assert.equal(s.stats.creates,0);
});
test("35.1D7 refuses raw odds or spoofed fields even on internal create path",async()=>{
 const s=memoryAdmin(),tx=makeOfflineFirestoreEvidenceTransaction(s.db);
 const b=batch(),p=PREFIX+b.snapshotReference;
 await assert.rejects(tx(async t=>{await t.read(p);await t.create(p,{
   source:"ODDSPAPI_V4_ODDS_BY_TOURNAMENTS",
   status:"UNREVIEWED_PROVIDER_EVIDENCE",reference:b.snapshotReference,
   price:1.84,apiKey:"LEAK"
 });}),/not authorized/);
 assert.equal(s.stats.creates,0);
});
test("35.1D7 storage path remains default-denied to browsers",()=>{
 const rules=fs.readFileSync(path.join(__dirname,"..","firestore.rules"),"utf8");
 assert.match(rules,/Everything else is denied by default/);
 assert.doesNotMatch(rules,/teamEvidence|providerSnapshots/);
});
test("35.1D7 adapter cannot run in production without explicit future wiring",()=>{
 const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
 const file=fs.readFileSync(path.join(__dirname,"provider-evidence-firestore.js"),"utf8");
 assert.doesNotMatch(index,/provider-evidence-firestore|makeOfflineFirestoreProviderEvidenceStore/);
 assert.doesNotMatch(file,/require\(["']firebase-admin|https:\/\/|\bfetch\(|onCall\(|setInterval\(|onSchedule\(/);
});
test("35.1D7 stored state is unreviewed and cannot authorize D3 crosswalk",async()=>{
 const s=setup();await s.store.storeBatch(batch(),s.token);
 const row=[...s.docs.values()][0];
 assert.equal(row.status,"UNREVIEWED_PROVIDER_EVIDENCE");
 for(const field of ["teams","espnEventId","reviewStatus","captureAllowed",
   "line","odds","modelOver"])assert.equal(Object.hasOwn(row,field),false);
});
