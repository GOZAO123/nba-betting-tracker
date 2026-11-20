"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {makeOfflineManualEvidenceAudit}=require("./manual-evidence-receipt");

const NOW=Date.parse("2026-11-20T13:30:00.000Z");
const iso=n=>new Date(NOW+n*60000).toISOString();
const OWNER={auth:{uid:"synthetic-owner",token:{email_verified:true}},data:{}};
const SELECTION=Object.freeze({
  fixtureId:"synthetic-d829-fixture",marketId:"91001",providerPlayerId:"93001"
});
function definition(marketId=91001,handicap=20.5){
  return {marketId,sportId:11,playerProp:true,period:"result",
    marketName:"Over Under Player Points (incl. overtime)",handicap,
    outcomes:[{outcomeId:marketId+1000,outcomeName:"Over"},
      {outcomeId:marketId+1001,outcomeName:"Under"}]};
}
function q(price=1.88,overrides={}){
  return {active:true,price,playerName:"Synthetic Quote Player",
    changedAt:iso(-2),mainLine:false,...overrides};
}
function market(d=definition()){
  return {marketActive:true,outcomes:{
    [String(d.outcomes[0].outcomeId)]:{players:{"93001":q()}},
    [String(d.outcomes[1].outcomeId)]:{players:{"93001":q(1.92)}}
  }};
}
function fixture(){
  return {
    fixtureId:SELECTION.fixtureId,sportId:11,tournamentId:132,
    statusId:0,hasOdds:true,startTime:iso(180),
    participant1Id:"5001",participant2Id:"5002",
    apiKey:"PRIVATE_PROVIDER_TOKEN_DO_NOT_STORE",
    bookmakerOdds:{"betano.pt":{
      bookmakerIsActive:true,suspended:false,markets:{"91001":market()}
    }}
  };
}
function setup(options={}){
  let clock=NOW,quota=0;
  const records=new Map(), quotes=[];
  const calls={reserves:[],catalogue:0,odds:0,transactions:0,creates:0};
  const originalCatalogue=options.catalogue??[definition()];
  const originalOdds=options.odds??[fixture()];
  const db={
    doc:p=>({path:p}),
    async runTransaction(action){
      calls.transactions++;
      if(options.failDb)throw Error("PRIVATE_FIRESTORE_FAILURE");
      const pending=[];
      const res=await action({
        async get(ref){
          const value=records.get(ref.path);
          return {exists:records.has(ref.path),
            data:()=>value===undefined?undefined:structuredClone(value)};
        },
        create(ref,value){calls.creates++;pending.push([ref.path,structuredClone(value)]);}
      });
      for(const [key,value] of pending)records.set(key,value);
      return res;
    }
  };
  const config={
    ownerUid:"synthetic-owner",db,now:()=>clock,
    reserve:async n=>{
      calls.reserves.push(n);
      if(options.denyBudget || quota+n>6)throw Error("BUDGET_DENIED");
      quota+=n;
    },
    fetchCatalogue:async()=>{calls.catalogue++;return originalCatalogue;},
    fetchOdds:async()=>{calls.odds++;return originalOdds;}
  };
  if(options.quoteEnabled!==false) {
    config.trustedQuoteSelection=options.selection??SELECTION;
    config.onTrustedQuote=options.onQuote??(async value=>{quotes.push(value);});
  }
  const runner=makeOfflineManualEvidenceAudit(config);
  return {runner,records,quotes,calls,originalOdds,originalCatalogue,
    advance:n=>{clock+=n*60000;},quotaUsed:()=>quota};
}
const assertSafe=report=>{
  assert.equal(report.researchSaved,false);
  assert.equal(report.pricesBookmakerVerified,false);
  assert.doesNotMatch(JSON.stringify(report),
    /Synthetic Quote Player|PRIVATE_PROVIDER_TOKEN|93001|91001|synthetic-d829-fixture|1\.88|1\.92/);
};
const assertUnapproved=quote=>{
  assert.equal(quote.status,"UNREVIEWED_PROVIDER_QUOTE");
  assert.deepEqual([
    quote.bookmakerVerified,quote.espnPlayerVerified,
    quote.autoLineSelected,quote.captureAllowed
  ],[false,false,false,false]);
};

test("D15.29 actual offline D8 manual runner ties one player pair to its stored fixture receipt",async()=>{
  const s=setup(),report=await s.runner(OWNER);
  assertSafe(report);
  assert.equal(report.requestsUsedOnThisClick,2);
  assert.deepEqual(s.calls.reserves,[2]);
  assert.deepEqual([s.calls.catalogue,s.calls.odds,s.calls.transactions,s.calls.creates],[1,1,1,1]);
  assert.equal(s.quotes.length,1);
  assert.equal(s.records.size,1);
  const [record]=s.records.values();
  const quote=s.quotes[0];
  assertUnapproved(quote);
  assert.equal(quote.sourceReference,record.reference);
  assert.equal(quote.capturedAt,record.capturedAt);
  assert.equal(quote.fixtureId,record.records[0].fixtureId);
  assert.deepEqual(quote.providerParticipantIds,record.records[0].participantIds);
  assert.deepEqual([quote.marketId,quote.providerPlayerId,quote.line],["91001","93001",20.5]);
  assert.deepEqual([quote.outcomes.Over.price,quote.outcomes.Under.price],[1.88,1.92]);
  assert.match(quote.digest,/^[a-f0-9]{64}$/);
  assert.ok(Object.isFrozen(quote));
  assert.doesNotMatch(JSON.stringify(record),/Synthetic Quote Player|PRIVATE_PROVIDER_TOKEN|1\.88|1\.92|bookmakerOdds/);
  assert.doesNotMatch(JSON.stringify(quote),/PRIVATE_PROVIDER_TOKEN/);
});

test("D15.29 default D8 remains unchanged and never emits an optional player quote",async()=>{
  const s=setup({quoteEnabled:false});
  const report=await s.runner(OWNER);
  assertSafe(report);
  assert.equal(s.quotes.length,0);
  assert.equal(s.records.size,1);
  assert.deepEqual(s.calls.reserves,[2]);
  assert.equal(s.calls.odds,1);
});

test("D15.29 ordinary manual audit refuses unauthenticated and client-supplied quote proof",async()=>{
  const s=setup();
  const cases=[
    null,{}, {auth:{uid:"attacker",token:{email_verified:true}},data:{}},
    {auth:{uid:"synthetic-owner",token:{email_verified:false}},data:{}},
    {...OWNER,data:{providerPlayerId:"93001"}},
    {...OWNER,data:{snapshotReference:"ODDSPAPI_MANUAL_"+ "F".repeat(32)}},
    {...OWNER,data:{catalogue:[],leagueOdds:[fixture()],capturedAt:iso(0)}}
  ];
  for(const candidate of cases)await assert.rejects(s.runner(candidate));
  assert.deepEqual([s.calls.catalogue,s.calls.odds,s.quotes.length,s.records.size],[0,0,0,0]);
  assert.deepEqual(s.calls.reserves,[]);
});

test("D15.29 optional hook refuses missing, malformed or unpaired backend dependencies",()=>{
  const base={
    ownerUid:"synthetic-owner",db:{doc:()=>{},runTransaction:async()=>{}},
    reserve:async()=>{},fetchCatalogue:async()=>{},fetchOdds:async()=>{},
    now:()=>NOW
  };
  for(const cfg of [
    {trustedQuoteSelection:SELECTION},
    {onTrustedQuote:async()=>{}},
    {trustedQuoteSelection:{...SELECTION,fromBrowser:true},onTrustedQuote:async()=>{}},
    {trustedQuoteSelection:{...SELECTION,fixtureId:"../private"},onTrustedQuote:async()=>{}},
    {trustedQuoteSelection:{...SELECTION,providerPlayerId:"0"},onTrustedQuote:async()=>{}},
    {trustedQuoteSelection:SELECTION,onTrustedQuote:"not-function"}
  ])assert.throws(()=>makeOfflineManualEvidenceAudit({...base,...cfg}),
    /Invalid trusted quote review dependencies/);
});

test("D15.29 cached manual audit invokes no second quote source or callback",async()=>{
  const s=setup(),first=await s.runner(OWNER),second=await s.runner(OWNER);
  assertSafe(first);assertSafe(second);
  assert.equal(second.cached,true);
  assert.equal(second.requestsUsedOnThisClick,0);
  assert.deepEqual([s.calls.catalogue,s.calls.odds,s.quotes.length,s.records.size],[1,1,1,1]);
  assert.deepEqual(s.calls.reserves,[2]);
});

test("D15.29 concurrent manual clicks share exactly one reserved source and quote",async()=>{
  const s=setup();
  const [a,b]=await Promise.all([s.runner(OWNER),s.runner(OWNER)]);
  assertSafe(a);assertSafe(b);
  assert.equal(s.calls.odds,1);
  assert.equal(s.quotes.length,1);
  assert.equal(s.records.size,1);
  assert.deepEqual(s.calls.reserves,[2]);
});

test("D15.29 stale audit reuses only prevalidated cached catalogue, fetches one new league source",async()=>{
  const s=setup();
  await s.runner(OWNER);
  s.advance(16);
  await s.runner(OWNER);
  assert.deepEqual(s.calls.reserves,[2,1]);
  assert.deepEqual([s.calls.catalogue,s.calls.odds,s.quotes.length,s.records.size],[1,2,2,2]);
  assert.notEqual(s.quotes[0].sourceReference,s.quotes[1].sourceReference);
  assertUnapproved(s.quotes[1]);
});

test("D15.29 approved source is immutable after original provider response mutates",async()=>{
  const s=setup(),report=await s.runner(OWNER);
  assertSafe(report);
  const quote=s.quotes[0],digest=quote.digest;
  const entry=s.originalOdds[0].bookmakerOdds["betano.pt"].markets["91001"]
    .outcomes["92001"].players["93001"];
  entry.price=2.52;
  s.originalCatalogue[0].handicap=22.5;
  assert.equal(quote.outcomes.Over.price,1.88);
  assert.equal(quote.line,20.5);
  assert.equal(quote.digest,digest);
});

test("D15.29 missing Over/Under side suppresses quote but not fixture-only store",async()=>{
  const original=[fixture()];
  delete original[0].bookmakerOdds["betano.pt"].markets["91001"].outcomes["92002"];
  const s=setup({odds:original});
  assertSafe(await s.runner(OWNER));
  assert.equal(s.quotes.length,0);
  assert.equal(s.records.size,1);
  assert.deepEqual(s.calls.reserves,[2]);
  assert.equal(s.calls.odds,1);
});

test("D15.29 wrong backend player selector cannot guess player from matching name",async()=>{
  const s=setup({selection:{...SELECTION,providerPlayerId:"93002"}});
  assertSafe(await s.runner(OWNER));
  assert.equal(s.quotes.length,0);
  assert.equal(s.records.size,1);
});

test("D15.29 invalid fixture identity prevents callback and trusted fixture store",async()=>{
  const original=[fixture()];
  original[0].participant1Id=null;
  const s=setup({odds:original});
  assertSafe(await s.runner(OWNER));
  assert.equal(s.quotes.length,0);
  assert.equal(s.records.size,0);
  assert.deepEqual(s.calls.reserves,[2]);
});

test("D15.29 failed fixture Firestore transaction cannot emit a private quote",async()=>{
  const s=setup({failDb:true});
  assertSafe(await s.runner(OWNER));
  assert.equal(s.quotes.length,0);
  assert.equal(s.records.size,0);
  assert.equal(s.calls.odds,1);
});

test("D15.29 private quote callback failure cannot break aggregate or trigger paid retry",async()=>{
  let called=0;
  const s=setup({onQuote:async()=>{called++;throw Error("PRIVATE_QUOTE_ERROR");}});
  const report=await s.runner(OWNER);
  assertSafe(report);
  assert.equal(called,1);
  assert.equal(s.records.size,1);
  assert.deepEqual(s.calls.reserves,[2]);
  assert.equal(s.calls.odds,1);
});

test("D15.29 six-slot reservation denial blocks any further source collection",async()=>{
  const s=setup({denyBudget:true});
  await assert.rejects(s.runner(OWNER),/BUDGET_DENIED/);
  assert.equal(s.calls.odds,0);
  assert.equal(s.quotes.length,0);
  assert.equal(s.records.size,0);
  assert.deepEqual(s.calls.reserves,[2]);
});

test("D15.29 existing production integration rejects quote hook as an unapproved source",()=>{
  const integration=fs.readFileSync(path.join(__dirname,"manual-evidence-integration.js"),"utf8");
  const production=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const moduleCode=fs.readFileSync(path.join(__dirname,"manual-evidence-receipt.js"),"utf8");
  assert.doesNotMatch(integration,/trustedQuoteSelection|onTrustedQuote/);
  assert.doesNotMatch(production,/trustedQuoteSelection|onTrustedQuote|provider-player-quote-snapshot/);
  assert.doesNotMatch(moduleCode,/https:\/\/api\.oddspapi\.io|setInterval\(|onSchedule\(|onCall\(/);
});
