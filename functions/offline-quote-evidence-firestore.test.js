"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const { freezeUnreviewedProviderPlayerPair } =
  require("./provider-player-quote-snapshot");
const { makeOfflineFirestoreQuoteTransaction,
  makeOfflineFirestoreQuoteEvidenceStore } =
  require("./offline-quote-evidence-firestore");

const NOW=Date.parse("2026-11-20T14:00:00.000Z");
const iso=n=>new Date(NOW+n*60000).toISOString();
const REF="ODDSPAPI_MANUAL_"+"E".repeat(32);
const TOKEN=Object.freeze({});
const PREFIX="_internal/quoteEvidence/providerObservations/";

function syntheticQuote(options={}) {
  const def={marketId:91001,sportId:11,playerProp:true,period:"result",
    marketName:"Over Under Player Points (incl. overtime)",handicap:20.5,
    outcomes:[{outcomeId:92001,outcomeName:"Over"},
      {outcomeId:92002,outcomeName:"Under"}]};
  const quote=(price,changed={})=>({
    playerName:"Synthetic Offline Athlete",active:true,price,
    changedAt:iso(-2),mainLine:false,...changed
  });
  const fixture={fixtureId:"synthetic-quoted-fixture",sportId:11,
    tournamentId:132,participant1Id:"5001",participant2Id:"5002",
    statusId:0,hasOdds:true,startTime:iso(180),
    bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,suspended:false,
      markets:{"91001":{marketActive:true,outcomes:{
        "92001":{players:{"93001":quote(options.price??1.88)}},
        "92002":{players:{"93001":quote(1.92)}}
      }}}}}
  };
  return freezeUnreviewedProviderPlayerPair({
    now:NOW,capturedAt:iso(-1),snapshotReference:REF,
    fixtureId:fixture.fixtureId,providerPlayerId:"93001",marketId:"91001",
    catalogue:[def],leagueOdds:[fixture]
  });
}

function fakeAdmin(options={}) {
  const docs=new Map();
  const calls={doc:0,transaction:0,reads:0,creates:0,commits:0};
  let tail=Promise.resolve();
  const db={
    doc(value) {
      calls.doc++;
      return {path:options.badReference ? "other/collection/path" : value};
    },
    async runTransaction(callback) {
      calls.transaction++;
      let release;
      const previous=tail;
      tail=new Promise(resolve=>{release=resolve;});
      await previous;
      try {
        if (options.throwTransaction) throw Error("PRIVATE_TX_FAILURE");
        const pending=[];
        const tx={
          async get(ref) {
            calls.reads++;
            if (options.throwRead)throw Error("PRIVATE_READ_FAILURE");
            if (options.malformedSnapshot)return {exists:"incorrect"};
            const exists=docs.has(ref.path);
            return {exists,data:()=>options.invalidData ? "bad" :
              exists?structuredClone(docs.get(ref.path)):undefined};
          },
          async create(ref,value) {
            calls.creates++;
            if (options.throwCreate)throw Error("PRIVATE_CREATE_FAILURE");
            pending.push([ref.path,structuredClone(value)]);
          }
        };
        const result=await callback(options.invalidTx?{}:tx);
        if (options.throwCommit)throw Error("PRIVATE_COMMIT_FAILURE");
        for (const [key,entry] of pending) {
          if (docs.has(key))throw Error("ATOMIC_CREATE_ONLY");
          docs.set(key,entry);
        }
        calls.commits++;
        return result;
      } finally {release();}
    }
  };
  return {db,docs,calls};
}

function setup(options={}) {
  const mem=fakeAdmin(options), evidence=syntheticQuote();
  let checks=0;
  const store=makeOfflineFirestoreQuoteEvidenceStore({
    db:mem.db,now:()=>NOW,
    isTrustedQuoteReceipt:async(token,metadata)=>{
      checks++;
      if(options.rejectTrust)throw Error("PRIVATE_CAPABILITY_ERROR");
      return token===TOKEN &&
        metadata.digest===evidence.digest &&
        metadata.reference===REF &&
        metadata.fixtureId==="synthetic-quoted-fixture" &&
        metadata.providerPlayerId==="93001" &&
        metadata.marketId==="91001";
    }
  });
  return {...mem,evidence,store,trustChecks:()=>checks,
    run:(quote=evidence,token=TOKEN)=>store.store(quote,token)};
}
const status=x=>{
  assert.deepEqual(Object.keys(x),["status"]);
  return x.status;
};

test("D15.31 constructor has zero Admin SDK calls or quote writes",()=>{
  const s=setup();
  assert.deepEqual(s.calls,{doc:0,transaction:0,reads:0,creates:0,commits:0});
  assert.equal(s.trustChecks(),0);
  assert.equal(s.docs.size,0);
});

test("D15.31 approved synthetic quote writes one fixed private document only",async()=>{
  const s=setup(),result=await s.run();
  assert.equal(status(result),"STORED");
  assert.deepEqual([s.calls.transaction,s.calls.reads,s.calls.creates],[1,1,1]);
  assert.equal(s.docs.size,1);
  const [[key,record]]=[...s.docs];
  assert.match(key,/^_internal\/quoteEvidence\/providerObservations\/[a-f0-9]{64}$/);
  assert.equal(record.quote.digest,s.evidence.digest);
  assert.equal(record.quote.sourceReference,REF);
  assert.deepEqual([record.quote.outcomes.Over.price,record.quote.outcomes.Under.price],[1.88,1.92]);
  assert.deepEqual([record.quote.bookmakerVerified,record.quote.espnPlayerVerified,
    record.quote.autoLineSelected,record.quote.captureAllowed],[false,false,false,false]);
  assert.doesNotMatch(key,/93001|Synthetic|1\.88|91001/);
});

test("D15.31 exact replay blocks without calling Admin create again",async()=>{
  const s=setup();
  assert.equal(status(await s.run()),"STORED");
  const before=JSON.stringify([...s.docs.values()][0]);
  assert.equal(status(await s.run()),"REPLAY_BLOCKED");
  assert.equal(s.calls.creates,1);
  assert.equal(JSON.stringify([...s.docs.values()][0]),before);
});

test("D15.31 concurrent receipt attempts atomically store one only",async()=>{
  const s=setup();
  const answers=await Promise.all([s.run(),s.run(),s.run(),s.run()]);
  assert.deepEqual(answers.map(status).sort(),[
    "REPLAY_BLOCKED","REPLAY_BLOCKED","REPLAY_BLOCKED","STORED"
  ]);
  assert.equal(s.docs.size,1);
  assert.equal(s.calls.creates,1);
});

test("D15.31 wrong capability and forged string stop before any Firestore call",async()=>{
  const s=setup();
  for(const bad of [null,{},"ODDSPAPI_MANUAL_"+ "E".repeat(32)]) {
    assert.equal(status(await s.run(s.evidence,bad)),"DENIED");
  }
  assert.equal(s.calls.transaction,0);
  assert.equal(s.docs.size,0);
});

test("D15.31 invalid quote digest or extra field never reaches trusted callback",async()=>{
  const s=setup();
  const tampered=structuredClone(s.evidence);
  tampered.outcomes.Over.price=2.5;
  for(const value of [
    tampered,{...s.evidence,status:"VERIFIED_QUOTE"},
    {...s.evidence,extra:"BROWSER_APPROVED"}
  ])assert.equal(status(await s.run(value)),"INVALID_QUOTE");
  assert.equal(s.trustChecks(),0);
  assert.equal(s.calls.transaction,0);
});

test("D15.31 no write when private receipt callback throws or denies",async()=>{
  const s=setup({rejectTrust:true});
  assert.equal(status(await s.run()),"DENIED");
  assert.equal(s.calls.transaction,0);
});

test("D15.31 malformed Admin document references fail before Admin read",async()=>{
  const s=setup({badReference:true});
  assert.equal(status(await s.run()),"UNAVAILABLE");
  assert.equal(s.calls.reads,0);
  assert.equal(s.calls.creates,0);
});

test("D15.31 invalid snapshots and malformed Admin transaction are unavailable",async()=>{
  for(const key of ["malformedSnapshot","invalidTx","throwRead"]) {
    const s=setup({[key]:true});
    assert.equal(status(await s.run()),"UNAVAILABLE");
    assert.equal(s.docs.size,0);
    assert.equal(s.calls.creates,0);
  }
});

test("D15.31 failed Admin create or commit cannot claim STORED",async()=>{
  for(const key of ["throwCreate","throwCommit","throwTransaction"]) {
    const s=setup({[key]:true});
    assert.equal(status(await s.run()),"UNAVAILABLE");
    assert.equal(s.docs.size,0);
  }
});

test("D15.31 direct transaction facade cannot access arbitrary paths",async()=>{
  const s=setup();
  const run=makeOfflineFirestoreQuoteTransaction(s.db);
  for(const bad of [
    "_internal/quoteEvidence/providerObservations/../../secrets",
    "_internal/quoteEvidence/providerObservations/GOOD",
    "users/synthetic-owner/propResearchLedger/fake",
    "_internal/teamEvidence/providerSnapshots/"+"F".repeat(32)
  ])await assert.rejects(run(tx=>tx.read(bad)));
  assert.equal(s.calls.reads,0);
  assert.equal(s.calls.creates,0);
});

test("D15.31 transaction forbids create before read or across documents",async()=>{
  const s=setup();
  const pathRef=PREFIX+"f".repeat(64);
  const run=makeOfflineFirestoreQuoteTransaction(s.db);
  await assert.rejects(run(async tx=>tx.create(pathRef,{})));
  await assert.rejects(run(async tx=>{
    await tx.read(pathRef);
    await tx.create(PREFIX+"e".repeat(64),{});
  }));
  assert.equal(s.calls.creates,0);
});

test("D15.31 transaction forbids repeated reads, even of same path",async()=>{
  const s=setup();
  const run=makeOfflineFirestoreQuoteTransaction(s.db);
  await assert.rejects(run(async tx=>{
    const p=PREFIX+"f".repeat(64);
    await tx.read(p);
    await tx.read(p);
  }));
  assert.equal(s.calls.reads,1);
});

test("D15.31 transaction forbids untrusted successful response without create",async()=>{
  const s=setup();
  const run=makeOfflineFirestoreQuoteTransaction(s.db);
  await assert.rejects(run(async tx=>{
    await tx.read(PREFIX+"f".repeat(64));
    return "STORED";
  }));
  assert.equal(s.calls.creates,0);
});

test("D15.31 transaction forbids false replay result without an existing doc",async()=>{
  const s=setup();
  const run=makeOfflineFirestoreQuoteTransaction(s.db);
  await assert.rejects(run(async tx=>{
    await tx.read(PREFIX+"f".repeat(64));
    return "REPLAY_BLOCKED";
  }));
  assert.equal(s.calls.creates,0);
});

test("D15.31 transaction forbids malformed document and extra price injection",async()=>{
  const s=setup();
  const run=makeOfflineFirestoreQuoteTransaction(s.db),p=PREFIX+"f".repeat(64);
  for(const fake of [{},{schemaVersion:1,quote:s.evidence},
    {schemaVersion:1,status:"UNREVIEWED_QUOTE_EVIDENCE",
      source:"ODDSPAPI_V4_ODDS_BY_TOURNAMENTS",
      receivedAt:iso(0),quote:s.evidence,apiKey:"PRIVATE_SECRET"}]){
    await assert.rejects(run(async tx=>{
      await tx.read(p);await tx.create(p,fake);return "STORED";
    }));
  }
  assert.equal(s.calls.creates,0);
});

test("D15.31 raw transaction facade cannot bypass quote content digest checks",async()=>{
  const s=setup();
  // This looks like a complete record but has a forged quote price; no
  // authoritative store/token callback is available through the facade.
  const altered=structuredClone(s.evidence);
  altered.outcomes.Under.price=3.5;
  const doc={schemaVersion:1,status:"UNREVIEWED_QUOTE_EVIDENCE",
    source:"ODDSPAPI_V4_ODDS_BY_TOURNAMENTS",receivedAt:iso(0),
    quote:altered};
  const run=makeOfflineFirestoreQuoteTransaction(s.db);
  const p=PREFIX+"f".repeat(64);
  await assert.rejects(run(async tx=>{
    await tx.read(p);await tx.create(p,doc);return "STORED";
  }));
  assert.equal(s.calls.creates,0);
});

test("D15.31 transaction returns only safe status and does not echo private data",async()=>{
  const s=setup(),outcome=await s.run();
  assert.deepEqual(outcome,{status:"STORED"});
  assert.doesNotMatch(JSON.stringify(outcome),
    /Synthetic Offline Athlete|93001|1\.88|PRIVATE_/);
});

test("D15.31 transaction refuses already present corrupt document without overwrite",async()=>{
  const s=setup();
  assert.equal(status(await s.run()),"STORED");
  const [key]=s.docs.keys();
  s.docs.set(key,{status:"CORRUPT_EXISTING_RECORD"});
  assert.equal(status(await s.run()),"REPLAY_BLOCKED");
  assert.equal(s.calls.creates,1);
});

test("D15.31 adapter and current production/Firestore rules remain disconnected",()=>{
  const p=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const moduleSource=fs.readFileSync(
    path.join(__dirname,"offline-quote-evidence-firestore.js"),"utf8");
  const rules=fs.readFileSync(path.join(__dirname,"..","firestore.rules"),"utf8");
  assert.doesNotMatch(p,/offline-quote-evidence-firestore|makeOfflineFirestoreQuoteEvidenceStore/);
  assert.doesNotMatch(moduleSource,/require\(["'](?:firebase-admin|firebase-functions|https?|node:https?)["']\)/);
  assert.doesNotMatch(moduleSource,/\b(?:fetch|setInterval|setTimeout|onCall|onSchedule)\s*\(/);
  assert.match(rules,/allow create, update, delete: if false;/);
  assert.doesNotMatch(rules,/quoteEvidence/);
});

test("D15.31 missing database and trusted capability callbacks reject construction",()=>{
  for(const bad of [
    undefined,{doc:()=>{}},{runTransaction:async()=>{}}
  ])assert.throws(()=>makeOfflineFirestoreQuoteTransaction(bad),
    /Missing backend Firestore quote dependencies/);
  assert.throws(()=>makeOfflineFirestoreQuoteEvidenceStore({db:fakeAdmin().db}),
    /Missing trusted quote receipt callback/);
});
