"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {freezeUnreviewedProviderPlayerPair} =
  require("./provider-player-quote-snapshot");
const {makeOfflineQuoteEvidenceStore} =
  require("./offline-quote-evidence-store");

const NOW=Date.parse("2026-11-20T14:00:00.000Z");
const iso=n=>new Date(NOW+n*60000).toISOString();
const TOKEN=Object.freeze({});
const REF="ODDSPAPI_MANUAL_"+"D".repeat(32);
const FIXTURE="synthetic-store-nba-001";
function syntheticQuote(options={}) {
  const marketId=91001,playerId="93001";
  const d={marketId,sportId:11,playerProp:true,period:"result",
    marketName:"Over Under Player Points (incl. overtime)",handicap:20.5,
    outcomes:[{outcomeId:92001,outcomeName:"Over"},
      {outcomeId:92002,outcomeName:"Under"}]};
  const item=(price=1.88)=>({
    active:true,price,playerName:"Synthetic Private Player",
    changedAt:iso(-2),mainLine:false
  });
  const fixture={fixtureId:FIXTURE,sportId:11,tournamentId:132,
    participant1Id:"5001",participant2Id:"5002",statusId:0,hasOdds:true,
    startTime:iso(180),apiKey:"PRIVATE_API_KEY_MUST_NEVER_STORE",
    bookmakerOdds:{"betano.pt":{
      bookmakerIsActive:true,suspended:false,markets:{
        "91001":{marketActive:true,outcomes:{
          "92001":{players:{[playerId]:item(options.overPrice??1.88)}},
          "92002":{players:{[playerId]:item(options.underPrice??1.92)}}
        }}
      }
    }}
  };
  return freezeUnreviewedProviderPlayerPair({
    now:options.now??NOW,
    capturedAt:options.capturedAt??iso(-1),
    snapshotReference:options.reference??REF,
    fixtureId:FIXTURE,marketId:String(marketId),providerPlayerId:playerId,
    catalogue:[d],leagueOdds:[fixture]
  });
}
function harness(options={}) {
  const docs=new Map();
  const calls={transactions:0,reads:0,creates:0,trust:0};
  const evidence=syntheticQuote(), trustedDigest=evidence.digest;
  let queue=Promise.resolve();
  const runTransaction=async callback=>{
    calls.transactions++;
    const pending=[];
    const previous=queue;
    let done;
    queue=new Promise(resolve=>{done=resolve;});
    await previous;
    try {
      if(options.dbUnavailable)throw Error("PRIVATE FIRESTORE ERROR");
      const result=await callback({
        async read(key){calls.reads++;return docs.get(key)??null;},
        async create(key,record){
          calls.creates++;
          if(docs.has(key))throw Error("CREATE_ONLY_CONFLICT");
          pending.push([key,structuredClone(record)]);
        }
      });
      for(const [key,record] of pending) {
        if(docs.has(key))throw Error("ATOMIC_CREATE_FAILED");
        docs.set(key,record);
      }
      return result;
    }finally{done();}
  };
  const validator=options.validator??(async(token,metadata)=>{
    calls.trust++;
    if(options.trustUnavailable)throw Error("PRIVATE TRUST CALLBACK FAILURE");
    return token===TOKEN && metadata.digest===trustedDigest &&
      metadata.reference===REF && metadata.fixtureId===FIXTURE &&
      metadata.marketId==="91001" && metadata.providerPlayerId==="93001" &&
      metadata.source==="ODDSPAPI_V4_ODDS_BY_TOURNAMENTS";
  });
  const store=makeOfflineQuoteEvidenceStore({
    isTrustedQuoteReceipt:validator,
    runTransaction,
    now:options.now??(()=>NOW)
  });
  return {store,docs,calls,evidence,run:async(s=evidence,t=TOKEN)=>store.store(s,t)};
}
const status = result => {
  assert.deepEqual(Object.keys(result),["status"]);
  return result.status;
};

test("D15.30 authorized original synthetic quote is create-only at private digest path",async()=>{
  const s=harness();
  assert.equal(status(await s.run()),"STORED");
  assert.deepEqual([s.calls.trust,s.calls.transactions,s.calls.reads,s.calls.creates],[1,1,1,1]);
  assert.equal(s.docs.size,1);
  const [[key,record]]=[...s.docs];
  assert.match(key,/^_internal\/quoteEvidence\/providerObservations\/[a-f0-9]{64}$/);
  assert.equal(record.status,"UNREVIEWED_QUOTE_EVIDENCE");
  assert.equal(record.receivedAt,iso(0));
  assert.deepEqual(record.quote.outcomes,s.evidence.outcomes);
  assert.equal(record.quote.digest,s.evidence.digest);
  assert.equal(record.quote.sourceReference,REF);
  assert.equal(record.quote.providerPlayerName,"Synthetic Private Player");
  assert.deepEqual([record.quote.bookmakerVerified,record.quote.espnPlayerVerified,
    record.quote.autoLineSelected,record.quote.captureAllowed],
    [false,false,false,false]);
  assert.doesNotMatch(key,/93001|Synthetic|91001|1\.88/);
  assert.doesNotMatch(JSON.stringify(record),/PRIVATE_API_KEY_MUST_NEVER_STORE/);
});

test("D15.30 repeat receipt+fixture+player+market is blocked without overwrite",async()=>{
  const s=harness();
  assert.equal(status(await s.run()),"STORED");
  const original=JSON.stringify([...s.docs.values()][0]);
  assert.equal(status(await s.run()),"REPLAY_BLOCKED");
  assert.equal(s.calls.creates,1);
  assert.equal(JSON.stringify([...s.docs.values()][0]),original);
});

test("D15.30 simultaneous store attempts commit just one atomic create",async()=>{
  const s=harness();
  const result=await Promise.all([s.run(),s.run(),s.run()]);
  assert.deepEqual(result.map(status).sort(),["REPLAY_BLOCKED","REPLAY_BLOCKED","STORED"]);
  assert.equal(s.docs.size,1);
  assert.equal(s.calls.creates,1);
});

test("D15.30 falsified backend receipt object is denied before any transaction",async()=>{
  const s=harness();
  for(const bad of [null,{},Object.freeze({}),"ODDSPAPI_MANUAL_"+ "D".repeat(32)]){
    assert.equal(status(await s.run(s.evidence,bad)),"DENIED");
  }
  assert.equal(s.calls.transactions,0);
  assert.equal(s.calls.creates,0);
});

test("D15.30 receipt validator outage fails closed with no private details",async()=>{
  const s=harness({trustUnavailable:true});
  assert.equal(status(await s.run()),"DENIED");
  assert.equal(s.docs.size,0);
  assert.equal(s.calls.transactions,0);
});

test("D15.30 invalid snapshots are rejected before trust checks and Firestore",async()=>{
  const s=harness();
  for(const bad of [null,{},[],{...s.evidence,malicious:"YES"},
    {...s.evidence,status:"VERIFIED_QUOTE"},
    {...s.evidence,bookmakerVerified:true},
    {...s.evidence,captureAllowed:true},
    {...s.evidence,source:"UNTRUSTED"},
    {...s.evidence,attributedBookmaker:"other.example"},
    {...s.evidence,sourceReference:"fake"},
    {...s.evidence,fixtureId:"../other"}]){
    assert.equal(status(await s.run(bad)),"INVALID_QUOTE");
  }
  assert.equal(s.calls.trust,0);
  assert.equal(s.calls.transactions,0);
});

test("D15.30 quote digest binds original prices and rejects tampered side",async()=>{
  const s=harness();
  const forged=structuredClone(s.evidence);
  forged.outcomes.Over.price=50;
  assert.equal(status(await s.run(forged)),"INVALID_QUOTE");
  assert.equal(s.calls.trust,0);
  assert.equal(s.docs.size,0);
});

test("D15.30 quote digest detects changed player, market or timestamp",async()=>{
  const s=harness();
  for(const changes of [
    {providerPlayerName:"OTHER PLAYER"}, {marketId:"91002"},
    {capturedAt:iso(0)},{startTime:iso(181)}, {line:21.5},
    {providerPlayerId:"93002"}
  ]){
    const changed={...s.evidence,...changes};
    assert.equal(status(await s.run(changed)),"INVALID_QUOTE");
  }
  assert.equal(s.calls.trust,0);
});

test("D15.30 outcome field injection and impossible prices reject before trusted callback",async()=>{
  const s=harness();
  const mutations=[
    quote=>{quote.outcomes.Over.price=Infinity;},
    quote=>{quote.outcomes.Over.price="1.88";},
    quote=>{quote.outcomes.Over.price=1;},
    quote=>{quote.outcomes.Over.changedAt="INVALID";},
    quote=>{quote.outcomes.Over.mainLineFlag="true";},
    quote=>{quote.outcomes.Over.injectedApproval=true;},
    quote=>{quote.outcomes.Under.outcomeId=quote.outcomes.Over.outcomeId;}
  ];
  for(const edit of mutations){
    const copy=structuredClone(s.evidence);
    edit(copy);
    assert.equal(status(await s.run(copy)),"INVALID_QUOTE");
  }
  assert.equal(s.calls.trust,0);
});

test("D15.30 stale raw provider timestamp remains unreviewed if bound to a genuine snapshot",async()=>{
  const s=harness({
    validator:async(token)=>token===TOKEN
  });
  const stale=syntheticQuote({overPrice:1.77});
  // Different but valid original price is still unreviewed.
  assert.equal(status(await s.run(stale)),"STORED");
  const record=[...s.docs.values()][0];
  assert.equal(record.quote.outcomes.Over.price,1.77);
  assert.equal(record.quote.bookmakerVerified,false);
});

test("D15.30 changing an existing price under the same source reference cannot overwrite",async()=>{
  const s=harness({validator:async(token)=>token===TOKEN});
  const first=syntheticQuote({overPrice:1.88});
  const second=syntheticQuote({overPrice:2.10});
  assert.equal(status(await s.run(first)),"STORED");
  assert.equal(status(await s.run(second)),"REPLAY_BLOCKED");
  assert.equal([...s.docs.values()][0].quote.outcomes.Over.price,1.88);
  assert.equal(s.calls.creates,1);
});

test("D15.30 distinct trusted source references can represent distinct observations",async()=>{
  const s=harness({validator:async(token)=>token===TOKEN});
  const first=syntheticQuote();
  const later=syntheticQuote({reference:"ODDSPAPI_MANUAL_"+"E".repeat(32)});
  assert.equal(status(await s.run(first)),"STORED");
  assert.equal(status(await s.run(later)),"STORED");
  assert.equal(s.docs.size,2);
  // A future authoritative producer MUST prevent malicious source-ref renewal.
});

test("D15.30 expired source receipt is invalid even with trusted token",async()=>{
  const s=harness({now:()=>NOW+6*60000});
  assert.equal(status(await s.run()),"INVALID_QUOTE");
  assert.equal(s.docs.size,0);
});

test("D15.30 malformed clock and transaction errors are sanitized",async()=>{
  const a=harness({now:()=>{throw Error("PRIVATE TIME");}});
  assert.equal(status(await a.run()),"INVALID_QUOTE");
  const b=harness({dbUnavailable:true});
  assert.equal(status(await b.run()),"UNAVAILABLE");
  assert.equal(b.docs.size,0);
});

test("D15.30 untrusted transaction result cannot claim a successful write",async()=>{
  const s=harness({
    validator:async()=>true
  });
  const fake=makeOfflineQuoteEvidenceStore({
    now:()=>NOW,isTrustedQuoteReceipt:async()=>true,
    runTransaction:async()=>({secret:"PRIVATE_DATA"})
  });
  assert.equal(status(await fake.store(s.evidence,TOKEN)),"UNAVAILABLE");
});

test("D15.30 constructor never initializes backend dependencies",()=>{
  let effects=0;
  const store=makeOfflineQuoteEvidenceStore({
    isTrustedQuoteReceipt:async()=>{effects++;return true;},
    runTransaction:async()=>{effects++;return "STORED";},
    now:()=>{effects++;return NOW;}
  });
  assert.equal(typeof store.store,"function");
  assert.equal(Object.isFrozen(store),true);
  assert.equal(effects,0);
});

test("D15.30 missing source trust and transaction adapters reject construction",()=>{
  for(const bad of [{},{isTrustedQuoteReceipt:async()=>true},
    {runTransaction:async()=>true},
    {isTrustedQuoteReceipt:()=>true,runTransaction:async()=>true,now:5}]){
    assert.throws(()=>makeOfflineQuoteEvidenceStore(bad),
      /Missing trusted quote storage dependencies/);
  }
});

test("D15.30 module and research ledger remain disconnected and browser writes denied",()=>{
  const code=fs.readFileSync(path.join(__dirname,"offline-quote-evidence-store.js"),"utf8");
  const prod=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const rules=fs.readFileSync(path.join(__dirname,"..","firestore.rules"),"utf8");
  assert.doesNotMatch(prod,/offline-quote-evidence-store|makeOfflineQuoteEvidenceStore/);
  assert.doesNotMatch(code,/require\(["'](?:firebase-admin|firebase-functions|https?|node:https?)["']\)/);
  assert.doesNotMatch(code,/\b(?:fetch|setInterval|setTimeout|onCall|onSchedule)\s*\(/);
  assert.match(rules,/allow create, update, delete: if false;/);
  assert.match(rules,/Everything else is denied by default/);
  assert.doesNotMatch(code,/propResearchLedger/);
});
