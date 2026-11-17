"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { extractManualProviderIdentityBatch } = require("./provider-evidence-acquisition");
const { makeLeagueMarketAuditRunner } = require("./league-market-audit-runner");

const NOW = Date.parse("2026-11-17T10:00:00.000Z");
const iso = m => new Date(NOW + m * 60000).toISOString();
const owner = { auth: { uid: "synthetic-owner", token: { email_verified: true } }, data: {} };
const CATALOGUE = [{
  marketId: 101, sportId: 11, playerProp: true,
  marketName: "Over Under Player Points (incl. overtime)",
  period: "result", handicap: 20.5,
  outcomes: [{ outcomeId: 201, outcomeName: "Over" },
    { outcomeId: 202, outcomeName: "Under" }]
}];
function fixture(change = {}) {
  return {
    fixtureId: "fixture-d5-1", sportId: 11, tournamentId: 132,
    statusId: 0, hasOdds: true, startTime: iso(180),
    participant1Id: "5001", participant2Id: "5002",
    participant1Name: "Synthetic Team A", participant2Name: "Synthetic Team B",
    apiKey: "SECRET_MUST_NOT_LEAVE",
    bookmakerOdds: { "betano.pt": { bookmakerIsActive: true,
      suspended: false, markets: { "101": { marketActive: true,
        outcomes: { "201": { players: { "301": {
          active: true, playerName: "Synthetic Player", price: 1.83,
          changedAt: iso(-2), mainLine: false
        } } } } } } } },
    ...change
  };
}
function setup({ odds = [fixture()], callback = null, failFetch = false } = {}) {
  let reserved = 0, catalogueCalls = 0, oddsCalls = 0, callbacks = 0;
  const collected = [];
  const run = makeLeagueMarketAuditRunner({
    ownerUid: "synthetic-owner",
    now: () => NOW,
    reserve: async n => { reserved += n; },
    fetchCatalogue: async () => { catalogueCalls++; return CATALOGUE; },
    fetchOdds: async () => {
      oddsCalls++; if (failFetch) throw Error("upstream blocked");
      return odds;
    },
    onProviderEvidence: callback === null ? undefined : async batch => {
      callbacks++; collected.push(batch);
      if (callback) await callback(batch);
    }
  });
  // undefined is intentionally rejected; normal "off" test instead omits it.
  return { run, stats: () => ({ reserved, catalogueCalls, oddsCalls, callbacks }), collected };
}

test("35.1D5 extracts a bounded, D4-compatible unreviewed fixture record", () => {
  const batch = extractManualProviderIdentityBatch([fixture()], iso(0));
  assert.equal(batch.status, "UNREVIEWED_PROVIDER_EVIDENCE");
  assert.equal(batch.acceptedFixtures, 1);
  assert.equal(batch.rejectedFixtures, 0);
  assert.equal(batch.totalFixtures, 1);
  assert.match(batch.snapshotReference, /^ODDSPAPI_MANUAL_[A-F0-9]{32}$/);
  const record = batch.records[0];
  assert.equal(record.fixtureId, "fixture-d5-1");
  assert.deepEqual(record.participantIds, ["5001", "5002"]);
  assert.equal(record.reference, batch.snapshotReference);
  assert.match(record.digest, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(batch), true);
  assert.equal(Object.isFrozen(batch.records), true);
  assert.equal(Object.isFrozen(record), true);
});

test("35.1D5 does not leak raw odds, names, player IDs, secrets or lines", () => {
  const output = JSON.stringify(extractManualProviderIdentityBatch([fixture()], iso(0)));
  for (const value of ["SECRET_MUST_NOT_LEAVE", "Synthetic Team", "Synthetic Player",
    "1.83", "20.5", "mainLine", "bookmakerOdds", "apiKey", '"301"'])
    assert.equal(output.includes(value), false, value);
});

test("35.1D5 accepts documented array/data/fixtures envelope shapes", () => {
  for (const payload of [[fixture()], { data: [fixture()] }, { fixtures: [fixture()] }])
    assert.equal(extractManualProviderIdentityBatch(payload, iso(0)).acceptedFixtures, 1);
});

test("35.1D5 rejects unbounded/malformed payload and receipt timestamp", () => {
  for (const payload of [null, {}, {data: {}}, Array(251).fill({})])
    assert.equal(extractManualProviderIdentityBatch(payload, iso(0)), null);
  assert.equal(extractManualProviderIdentityBatch([fixture()], "2026-11-17 10:00"), null);
});

test("35.1D5 missing or contradictory provider identity fields are never guessed", () => {
  const alterations = [
    { sportId: null }, { sportId: 10 }, { tournamentId: undefined },
    { statusId: undefined }, { statusId: 1 }, { hasOdds: false },
    { participant1Id: null }, { participant1Id: "same", participant2Id: "same" },
    { participant2Id: "5001" }, { fixtureId: "fixture bad" },
    { startTime: "invalid" }
  ];
  for (const change of alterations) {
    const b=extractManualProviderIdentityBatch([fixture(change)],iso(0));
    assert.equal(b.acceptedFixtures,0,JSON.stringify(change));
    assert.equal(b.rejectedFixtures,1);
  }
});

test("35.1D5 missing/wrong/inactive Betano bookmaker is excluded", () => {
  for (const change of [
    { bookmakerOdds: {} }, { bookmakerOdds: { "betano.pt": null } },
    { bookmakerOdds: { "betano.pt": { bookmakerIsActive: false, markets: {} } } },
    { bookmakerOdds: { "betano.pt": { bookmakerIsActive: true, suspended: true, markets: {} } } },
    { bookmakerOdds: { "betano.pt": { bookmakerIsActive: true, suspended: false, markets: null } } }
  ]) assert.equal(extractManualProviderIdentityBatch([fixture(change)],iso(0)).acceptedFixtures,0);
});

test("35.1D5 near-tipoff and outside 72-hour window never become evidence", () => {
  for(const m of [0,5,72*60+1]) {
    const b=extractManualProviderIdentityBatch([fixture({startTime:iso(m)})],iso(0));
    assert.equal(b.acceptedFixtures,0);
  }
  assert.equal(extractManualProviderIdentityBatch([fixture({startTime:iso(6)})],iso(0)).acceptedFixtures,1);
});

test("35.1D5 duplicated fixture IDs quarantine ALL conflicting entries", () => {
  const b=extractManualProviderIdentityBatch([
    fixture(),fixture({participant2Id:"5999"}),
    fixture({fixtureId:"fixture-d5-2",participant1Id:"6001",participant2Id:"6002"})
  ],iso(0));
  assert.equal(b.acceptedFixtures,1);
  assert.equal(b.rejectedFixtures,2);
  assert.equal(b.records[0].fixtureId,"fixture-d5-2");
});

test("35.1D5 oversized evidence selection refuses first-N truncation", () => {
  const list=Array.from({length:65},(_,n)=>fixture({
    fixtureId:"fixture-"+(1000+n),
    participant1Id:String(10000+2*n),participant2Id:String(10001+2*n)
  }));
  assert.equal(extractManualProviderIdentityBatch(list,iso(0)),null);
});

test("35.1D5 runner invokes optional sink once with allowlisted data after a valid paid-stage fetch",async()=>{
  const s=setup({callback:async()=>{}});
  const result=await s.run(owner);
  assert.deepEqual(s.stats(),{reserved:2,catalogueCalls:1,oddsCalls:1,callbacks:1});
  assert.equal(result.activePriceEntries,1);
  assert.equal(result.requestsUsedOnThisClick,2);
  assert.equal(s.collected[0].records[0].fixtureId,"fixture-d5-1");
  assert.equal("records" in result,false);
  assert.doesNotMatch(JSON.stringify(result),/fixture-d5-1|5001|Synthetic Player|SECRET_MUST_NOT_LEAVE/);
});

test("35.1D5 cached repeated click cannot refetch or replay evidence sink",async()=>{
  const s=setup({callback:async()=>{}});
  await s.run(owner);
  const second=await s.run(owner);
  assert.equal(second.cached,true);
  assert.equal(second.requestsUsedOnThisClick,0);
  assert.deepEqual(s.stats(),{reserved:2,catalogueCalls:1,oddsCalls:1,callbacks:1});
});

test("35.1D5 concurrent clicks share a single authorized fetch and sink",async()=>{
  const s=setup({callback:async()=>{}});
  const [a,b]=await Promise.all([s.run(owner),s.run(owner)]);
  assert.deepEqual([a.cached,b.cached],[false,true]);
  assert.deepEqual(s.stats(),{reserved:2,catalogueCalls:1,oddsCalls:1,callbacks:1});
});

test("35.1D5 failing optional sink cannot cause another paid call or disrupt audit",async()=>{
  const s=setup({callback:async()=>{throw Error("sensitive backend failure");}});
  const result=await s.run(owner);
  assert.equal(result.activePriceEntries,1);
  assert.equal(result.cached,false);
  assert.doesNotMatch(JSON.stringify(result),/sensitive/);
  await s.run(owner);
  assert.deepEqual(s.stats(),{reserved:2,catalogueCalls:1,oddsCalls:1,callbacks:1});
});

test("35.1D5 unauthenticated, unverified and spoofed-argument requests never reach sink",async()=>{
  const s=setup({callback:async()=>{}});
  const requests=[null,{}, {auth:{uid:"synthetic-owner",token:{email_verified:false}},data:{}},
    {auth:{uid:"other",token:{email_verified:true}},data:{}},
    {auth:owner.auth,data:{forceEvidence:true}}];
  for(const req of requests)await assert.rejects(s.run(req));
  assert.deepEqual(s.stats(),{reserved:0,catalogueCalls:0,oddsCalls:0,callbacks:0});
});

test("35.1D5 failed audit or missing strict IDs cannot create evidence",async()=>{
  const failed=setup({callback:async()=>{},failFetch:true});
  await assert.rejects(failed.run(owner));
  assert.equal(failed.stats().callbacks,0);
  const unidentifiable=setup({callback:async()=>{},odds:[fixture({participant1Id:null})]});
  const report=await unidentifiable.run(owner);
  assert.equal(report.totalFixtures,1);
  assert.equal(unidentifiable.stats().callbacks,0);
});

test("35.1D5 production has no callback wiring, storage, paid request, or polling",()=>{
  const source=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const runner=fs.readFileSync(path.join(__dirname,"league-market-audit-runner.js"),"utf8");
  const extractor=fs.readFileSync(path.join(__dirname,"provider-evidence-acquisition.js"),"utf8");
  assert.doesNotMatch(source,/onProviderEvidence|provider-evidence-acquisition/);
  assert.doesNotMatch(extractor,/fetch\(|https:|getFirestore\(|onCall\(|setInterval\(/);
  assert.doesNotMatch(runner,/await\s+fetchOdds\(\)[\s\S]{0,200}await\s+fetchOdds\(\)/);
});

test("35.1D5 optional hook is disabled by default (legacy audit stays unchanged)",async()=>{
  let hits=0;
  const runner=makeLeagueMarketAuditRunner({
    ownerUid:"synthetic-owner",now:()=>NOW,
    reserve:async()=>{},fetchCatalogue:async()=>CATALOGUE,
    fetchOdds:async()=>{hits++;return [fixture()];}
  });
  const result=await runner(owner);
  assert.equal(hits,1);
  assert.equal(result.totalFixtures,1);
  assert.equal("evidence" in result,false);
});

test("35.1D5 nonfunction evidence sink is rejected at construction",()=>{
  assert.throws(()=>makeLeagueMarketAuditRunner({
    ownerUid:"synthetic-owner",now:()=>NOW,
    reserve:async()=>{},fetchCatalogue:async()=>CATALOGUE,
    fetchOdds:async()=>[fixture()],onProviderEvidence:{}
  }),/Missing league market audit dependencies/);
});
