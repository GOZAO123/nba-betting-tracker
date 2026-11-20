"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {makeOfflineManualQuotePersistence}=
  require("./offline-manual-quote-persistence");

const NOW=Date.parse("2026-11-20T13:30:00.000Z");
const iso=m=>new Date(NOW+m*60000).toISOString();
const OWNER={auth:{uid:"synthetic-owner",token:{email_verified:true}},data:{}};
const SELECTOR=Object.freeze({
  fixtureId:"synthetic-d832-fixture",marketId:"91001",providerPlayerId:"93001"
});
const catalog=()=>[{
  marketId:91001,sportId:11,playerProp:true,period:"result",
  marketName:"Over Under Player Points (incl. overtime)",handicap:20.5,
  outcomes:[{outcomeId:92001,outcomeName:"Over"},
    {outcomeId:92002,outcomeName:"Under"}]
}];
const quote=(price=1.88)=>({
  active:true,price,playerName:"Synthetic D832 Athlete",
  changedAt:iso(-2),mainLine:false
});
function fixture() {
  return {
    fixtureId:SELECTOR.fixtureId,sportId:11,tournamentId:132,
    statusId:0,hasOdds:true,startTime:iso(180),
    participant1Id:"5001",participant2Id:"5002",
    privateToken:"SYNTHETIC_PRIVATE_KEY_DO_NOT_STORE",
    bookmakerOdds:{"betano.pt":{bookmakerIsActive:true,
      suspended:false,markets:{"91001":{
        marketActive:true,outcomes:{
          "92001":{players:{"93001":quote(1.88)}},
          "92002":{players:{"93001":quote(1.92)}}
        }
      }}}
    }
  };
}
function harness(options={}) {
  const docs=new Map(),events=[],outcomes=[],monitor=[];
  const counts={reserves:[],catalogue:0,odds:0,transactions:0,reads:0,creates:0};
  let current=NOW,slots=0;
  const providerOdds=options.odds??[fixture()];
  const providerCatalogue=options.catalogue??catalog();
  let queue=Promise.resolve();
  const db={
    doc:key=>({path:key}),
    async runTransaction(callback) {
      counts.transactions++;
      let release;
      const previous=queue;
      queue=new Promise(resolve=>{release=resolve;});
      await previous;
      try {
        const pending=[];
        const admin={
          async get(ref) {
            counts.reads++;
            const quotePath=ref.path.includes("/quoteEvidence/");
            if (quotePath && options.failQuoteRead)
              throw Error("PRIVATE_QUOTE_DB_READ_FAILURE");
            if (!quotePath && options.failFixtureRead)
              throw Error("PRIVATE_FIXTURE_DB_READ_FAILURE");
            const exists=docs.has(ref.path);
            return {exists,data:()=>exists?structuredClone(docs.get(ref.path)):undefined};
          },
          async create(ref,doc) {
            counts.creates++;
            const quotePath=ref.path.includes("/quoteEvidence/");
            if (quotePath && options.failQuoteWrite)
              throw Error("PRIVATE_QUOTE_DB_WRITE_FAILURE");
            if (!quotePath && options.failFixtureWrite)
              throw Error("PRIVATE_FIXTURE_DB_WRITE_FAILURE");
            pending.push([ref.path,structuredClone(doc)]);
          }
        };
        const result=await callback(admin);
        for(const [key,value] of pending) {
          if(docs.has(key))throw Error("CREATE_ONLY_COLLISION");
          docs.set(key,value);
          events.push(key.includes("/quoteEvidence/")?"QUOTE_STORED":"FIXTURE_STORED");
        }
        return result;
      } finally {release();}
    }
  };
  const config={
    enabled:options.enabled??true,ownerUid:"synthetic-owner",
    trustedQuoteSelection:options.selector??SELECTOR,db,
    now:()=>current,
    reserve:async n=>{
      counts.reserves.push(n);
      if (options.denyBudget || slots+n>6)throw Error("SYNTHETIC_QUOTA_BLOCKED");
      slots+=n;
    },
    fetchCatalogue:async()=>{counts.catalogue++;return providerCatalogue;},
    fetchOdds:async()=>{counts.odds++;return providerOdds;},
    onQuoteOutcome:async value=>{
      outcomes.push(value);
      if(options.monitorThrows)throw Error("PRIVATE_MONITOR_FAILURE");
    },
    onEvidenceOutcome:async value=>{monitor.push(value);}
  };
  const run=makeOfflineManualQuotePersistence(config);
  return {run,docs,events,outcomes,monitor,counts,providerOdds,
    advance:m=>{current+=m*60000;},quota:()=>slots};
}
const fixtureDocs=s=>[...s.docs.entries()].filter(([key])=>
  key.startsWith("_internal/teamEvidence/providerSnapshots/"));
const quoteDocs=s=>[...s.docs.entries()].filter(([key])=>
  key.startsWith("_internal/quoteEvidence/providerObservations/"));
function assertAggregate(report) {
  assert.equal(report.researchSaved,false);
  assert.equal(report.pricesBookmakerVerified,false);
  assert.doesNotMatch(JSON.stringify(report),
    /Synthetic D832 Athlete|93001|91001|1\.88|1\.92|SYNTHETIC_PRIVATE_KEY|synthetic-d832-fixture/);
}
function assertQuote(quoteDoc) {
  assert.equal(quoteDoc.status,"UNREVIEWED_QUOTE_EVIDENCE");
  assert.deepEqual([
    quoteDoc.quote.bookmakerVerified,quoteDoc.quote.espnPlayerVerified,
    quoteDoc.quote.autoLineSelected,quoteDoc.quote.captureAllowed
  ],[false,false,false,false]);
}

test("D15.32 disabled default is inert with no source, DB, or quota effects",async()=>{
  const run=makeOfflineManualQuotePersistence();
  await assert.rejects(run(OWNER),err=>err.code==="failed-precondition");
  const s=harness({enabled:false});
  await assert.rejects(s.run(OWNER),err=>err.code==="failed-precondition");
  assert.deepEqual(s.counts.reserves,[]);
  assert.deepEqual([s.counts.catalogue,s.counts.odds,s.counts.transactions],[0,0,0]);
});

test("D15.32 D8's original receipt writes fixture before one private quote document",async()=>{
  const s=harness(),report=await s.run(OWNER);
  assertAggregate(report);
  assert.equal(report.requestsUsedOnThisClick,2);
  assert.deepEqual(s.counts.reserves,[2]);
  assert.deepEqual([s.counts.catalogue,s.counts.odds,
    s.counts.transactions,s.counts.reads,s.counts.creates],[1,1,2,2,2]);
  assert.deepEqual(s.events,["FIXTURE_STORED","QUOTE_STORED"]);
  assert.equal(fixtureDocs(s).length,1);
  assert.equal(quoteDocs(s).length,1);
  assert.deepEqual(s.outcomes,[{status:"STORED"}]);
  const [[,fixtureRecord]]=fixtureDocs(s),[[quotePath,quoteRecord]]=quoteDocs(s);
  assert.match(quotePath,/^_internal\/quoteEvidence\/providerObservations\/[a-f0-9]{64}$/);
  assertQuote(quoteRecord);
  assert.equal(quoteRecord.quote.sourceReference,fixtureRecord.reference);
  assert.equal(quoteRecord.quote.capturedAt,fixtureRecord.capturedAt);
  assert.equal(quoteRecord.quote.fixtureId,fixtureRecord.records[0].fixtureId);
  assert.deepEqual(quoteRecord.quote.providerParticipantIds,
    fixtureRecord.records[0].participantIds);
  assert.deepEqual([quoteRecord.quote.marketId,quoteRecord.quote.providerPlayerId],
    ["91001","93001"]);
  assert.deepEqual([quoteRecord.quote.outcomes.Over.price,
    quoteRecord.quote.outcomes.Under.price],[1.88,1.92]);
  assert.match(quoteRecord.quote.digest,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(quoteRecord),
    /SYNTHETIC_PRIVATE_KEY_DO_NOT_STORE/);
  assert.doesNotMatch(JSON.stringify(fixtureRecord),
    /Synthetic D832 Athlete|1\.88|1\.92|SYNTHETIC_PRIVATE_KEY_DO_NOT_STORE/);
});

test("D15.32 public audit denies anonymous, wrong owner, spoofed quote selectors before reserve",async()=>{
  const s=harness();
  for(const bad of [
    null,{}, {auth:{uid:"attacker",token:{email_verified:true}},data:{}},
    {auth:{uid:"synthetic-owner",token:{email_verified:false}},data:{}},
    {...OWNER,data:{fixtureId:SELECTOR.fixtureId}},
    {...OWNER,data:{price:1.88,providerPlayerId:"93001",verified:true}},
    {...OWNER,data:{snapshotReference:"ODDSPAPI_MANUAL_"+"E".repeat(32)}}
  ])await assert.rejects(s.run(bad));
  assert.deepEqual(s.counts.reserves,[]);
  assert.deepEqual([s.counts.odds,s.counts.transactions,quoteDocs(s).length],[0,0,0]);
});

test("D15.32 cached audit uses zero new provider requests and zero new quote writes",async()=>{
  const s=harness();
  assertAggregate(await s.run(OWNER));
  const cached=await s.run(OWNER);
  assertAggregate(cached);
  assert.equal(cached.cached,true);
  assert.equal(cached.requestsUsedOnThisClick,0);
  assert.deepEqual(s.counts.reserves,[2]);
  assert.deepEqual([s.counts.odds,s.counts.transactions,quoteDocs(s).length],[1,2,1]);
});

test("D15.32 concurrent manual audit clicks share one source and two safe writes",async()=>{
  const s=harness();
  const [a,b,c]=await Promise.all([s.run(OWNER),s.run(OWNER),s.run(OWNER)]);
  for(const result of [a,b,c])assertAggregate(result);
  assert.deepEqual(s.counts.reserves,[2]);
  assert.deepEqual([s.counts.odds,fixtureDocs(s).length,quoteDocs(s).length],[1,1,1]);
  assert.deepEqual(s.outcomes,[{status:"STORED"}]);
});

test("D15.32 stale manual cache reuses catalogue with only one fresh league request",async()=>{
  const s=harness();
  assertAggregate(await s.run(OWNER));
  s.advance(16);
  assertAggregate(await s.run(OWNER));
  assert.deepEqual(s.counts.reserves,[2,1]);
  assert.equal(s.counts.catalogue,1);
  assert.equal(s.counts.odds,2);
  assert.equal(fixtureDocs(s).length,2);
  assert.equal(quoteDocs(s).length,2);
  assert.equal(s.outcomes.length,2);
  assert.ok(s.outcomes.every(x=>x.status==="STORED"));
});

test("D15.32 missing provider side preserves fixture only; no private quote claim",async()=>{
  const odds=[fixture()];
  delete odds[0].bookmakerOdds["betano.pt"].markets["91001"].outcomes["92002"];
  const s=harness({odds});
  assertAggregate(await s.run(OWNER));
  assert.equal(fixtureDocs(s).length,1);
  assert.equal(quoteDocs(s).length,0);
  assert.equal(s.outcomes.length,0);
  assert.deepEqual(s.counts.reserves,[2]);
});

test("D15.32 incorrect backend player ID cannot infer name or create quote evidence",async()=>{
  const s=harness({selector:{...SELECTOR,providerPlayerId:"93002"}});
  assertAggregate(await s.run(OWNER));
  assert.equal(fixtureDocs(s).length,1);
  assert.equal(quoteDocs(s).length,0);
  assert.equal(s.outcomes.length,0);
});

test("D15.32 absent accepted fixture evidence denies both stores before private quote",async()=>{
  const odds=[fixture()];
  odds[0].participant1Id=null;
  const s=harness({odds});
  assertAggregate(await s.run(OWNER));
  assert.equal(fixtureDocs(s).length,0);
  assert.equal(quoteDocs(s).length,0);
  assert.equal(s.counts.transactions,0);
});

test("D15.32 fixture transaction failure cannot authorize quote or retry provider",async()=>{
  const s=harness({failFixtureWrite:true});
  assertAggregate(await s.run(OWNER));
  assert.equal(fixtureDocs(s).length,0);
  assert.equal(quoteDocs(s).length,0);
  assert.equal(s.counts.transactions,1);
  assert.equal(s.counts.odds,1);
  assert.equal(s.outcomes.length,0);
});

test("D15.32 private quote transaction failure leaves fixture intact and no new fetch",async()=>{
  const s=harness({failQuoteWrite:true});
  assertAggregate(await s.run(OWNER));
  assert.equal(fixtureDocs(s).length,1);
  assert.equal(quoteDocs(s).length,0);
  assert.deepEqual(s.outcomes,[{status:"UNAVAILABLE"}]);
  assert.deepEqual(s.counts.reserves,[2]);
  assert.equal(s.counts.odds,1);
});

test("D15.32 quote read error fails closed without changing fixture-only receipt",async()=>{
  const s=harness({failQuoteRead:true});
  assertAggregate(await s.run(OWNER));
  assert.equal(fixtureDocs(s).length,1);
  assert.equal(quoteDocs(s).length,0);
  assert.deepEqual(s.outcomes,[{status:"UNAVAILABLE"}]);
  assert.equal(s.counts.odds,1);
});

test("D15.32 quote-monitor exception cannot alter aggregate audit or trigger request",async()=>{
  const s=harness({monitorThrows:true});
  assertAggregate(await s.run(OWNER));
  assert.equal(quoteDocs(s).length,1);
  assert.deepEqual(s.outcomes,[{status:"STORED"}]);
  assert.deepEqual(s.counts.reserves,[2]);
});

test("D15.32 budget denial occurs before any upstream or storage side effect",async()=>{
  const s=harness({denyBudget:true});
  await assert.rejects(s.run(OWNER),/SYNTHETIC_QUOTA_BLOCKED/);
  assert.deepEqual(s.counts.reserves,[2]);
  assert.deepEqual([s.counts.catalogue,s.counts.odds,s.counts.transactions],[0,0,0]);
});

test("D15.32 configured backend cannot be activated or spoofed via request data",async()=>{
  const s=harness();
  await assert.rejects(s.run({...OWNER,data:{
    enabled:true, trustedQuoteSelection:SELECTOR, receipt:{},
    providerPlayerId:"93001", bookmakerVerified:true
  }}));
  assert.equal(s.counts.odds,0);
  assert.equal(s.counts.transactions,0);
});

test("D15.32 constructor rejects malformed config and unsupported client-like overrides",()=>{
  for(const config of [
    null,[],{enabled:"yes"},{enabled:true,ownerUid:"synthetic-owner"},
    {enabled:true,auth:{uid:"synthetic-owner"}},
    {enabled:true,apiKey:"PRIVATE"}, {enabled:true,clientProvidedQuote:true}
  ]) assert.throws(()=>makeOfflineManualQuotePersistence(config),
    /Invalid offline quote persistence configuration|Missing trusted backend quote integration dependencies/);
});

test("D15.32 returned runner cannot expose store, token, fetcher or backend capabilities",()=>{
  const s=harness();
  assert.equal(typeof s.run,"function");
  for(const key of ["store","takeBackendOwnedSource","token","quoteStore",
    "trustedQuoteSelection","onTrustedQuote","db","fetchOdds","reserve"])
    assert.equal(Object.hasOwn(s.run,key),false);
  assert.equal(Object.isFrozen(s.run),true);
});

test("D15.32 fixture and quote evidence do not enter the protected research ledger",async()=>{
  const s=harness();
  assertAggregate(await s.run(OWNER));
  for(const key of s.docs.keys())assert.doesNotMatch(key,/propResearchLedger/);
  for(const row of s.docs.values()){
    assert.doesNotMatch(JSON.stringify(row),
      /captureAllowed":true|bookmakerVerified":true|espnPlayerVerified":true/);
  }
});

test("D15.32 module, existing production adapter and browser rules remain disconnected",()=>{
  const prod=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const integration=fs.readFileSync(
    path.join(__dirname,"manual-evidence-integration.js"),"utf8");
  const code=fs.readFileSync(path.join(__dirname,
    "offline-manual-quote-persistence.js"),"utf8");
  const rules=fs.readFileSync(path.join(__dirname,"..","firestore.rules"),"utf8");
  assert.doesNotMatch(prod,/makeOfflineManualQuotePersistence|offline-manual-quote-persistence/);
  assert.doesNotMatch(integration,/makeOfflineManualQuotePersistence|offline-manual-quote-persistence/);
  assert.doesNotMatch(code,/require\(["'](?:firebase-admin|firebase-functions|https?|node:https?)["']\)/);
  assert.doesNotMatch(code,/\b(?:fetch|setInterval|setTimeout|onCall|onSchedule)\s*\(/);
  assert.doesNotMatch(code,/propResearchLedger/);
  assert.match(rules,/allow create, update, delete: if false;/);
  assert.doesNotMatch(rules,/quoteEvidence/);
});
