"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {makeOfflineEspnScoreboardCustody,
  sanitizeOfflineEspnScoreboard}=
  require("./offline-espn-scoreboard-custody");
const {extractOfflineFixtureTeamEvidence}=
  require("./offline-fixture-team-evidence");
const {makeOfflineFixtureEspnReviewPacket}=
  require("./offline-fixture-espn-review-packet");

const NOW=Date.parse("2026-11-23T18:00:00.000Z");
const iso=delta=>new Date(NOW+delta).toISOString();
const REF="ESPN_SCOREBOARD_SYNTHETIC_001";
const META={reference:REF,capturedAt:iso(-60000)};
const TOKEN=Object.freeze({});
const event=(id="401234567",homeId="13",awayId="14")=>({
  id,date:iso(180*60000),
  status:{type:{state:"pre",rawPrivate:"DO_NOT_STORE"}},
  season:{type:2,privateSeasonNote:"DO_NOT_STORE"},
  competitions:[{competitors:[
    {homeAway:"home",team:{
      id:homeId,displayName:"Synthetic Utah Jazz",
      abbreviation:"UTA",privateStats:{value:23}
    }},
    {homeAway:"away",team:{
      id:awayId,displayName:"Synthetic Los Angeles Lakers",
      privateStats:{value:99}
    }}
  ]}],
  bookmakerOdds:{"betano.pt":{price:1.87}},
  credential:"DO_NOT_STORE_RAW_API_SECRET"
});
const scoreboard=(events=[event()])=>({
  events,leagues:[{privateToken:"UNTRUSTED_SOURCE"}],
  responseHeaders:{Authorization:"BEARER_DONT_SAVE"}
});
function fakeDb() {
  const docs=new Map(),actions=[];
  const db={
    docs,actions,
    doc(loc){actions.push("doc");return {path:loc};},
    async runTransaction(work){
      actions.push("transaction");
      const pending=[];
      const tx={
        async get(ref){actions.push("get");return {
          exists:docs.has(ref.path),
          data:()=>structuredClone(docs.get(ref.path))
        };},
        create(ref,data){
          actions.push("create");
          if(docs.has(ref.path))throw Error("exists");
          pending.push([ref.path,structuredClone(data)]);
        }
      };
      const outcome=await work(tx);
      for(const [loc,data] of pending)docs.set(loc,data);
      return outcome;
    }
  };
  return db;
}
function setup({db=fakeDb(),trusted=true,clock=NOW}={}){
  const calls=[];
  const capture=makeOfflineEspnScoreboardCustody({
    db,now:()=>clock,
    async attestCapture(token,meta){
      calls.push(meta);
      return trusted && token===TOKEN &&
        meta.source==="ESPN_NBA_SCOREBOARD" &&
        meta.reference===REF &&
        meta.capturedAt===META.capturedAt &&
        /^[a-f0-9]{64}$/.test(meta.digest);
    }
  });
  return {db,capture,calls};
}

test("ESPN scoreboard sanitizer only retains a bounded event/identity allowlist",()=>{
  const clean=sanitizeOfflineEspnScoreboard(scoreboard());
  assert.ok(clean);
  assert.equal(clean.events.length,1);
  assert.deepEqual(Object.keys(clean),["events"]);
  assert.deepEqual(Object.keys(clean.events[0]).sort(),
    ["competitions","date","id","season","status"]);
  assert.deepEqual(clean.events[0].competitions[0].competitors.map(c=>c.team.id),
    ["13","14"]);
  assert.equal(clean.events[0].season.type,2);
  assert.equal(clean.events[0].status.type.state,"pre");
  assert.ok(Object.isFrozen(clean));
  assert.ok(Object.isFrozen(clean.events[0].competitions[0].competitors));
  assert.doesNotMatch(JSON.stringify(clean),
    /DO_NOT_STORE|DO_NOT_SAVE|privateStats|bookmakerOdds|price|BEARER_DONT_SAVE|abbreviation/);
});

test("captured scoreboard is directly compatible with the existing D18 packet",()=>{
  const clean=sanitizeOfflineEspnScoreboard(scoreboard());
  const provider=extractOfflineFixtureTeamEvidence([{
    fixtureId:"synthetic-custody-game",sportId:11,tournamentId:132,
    statusId:0,hasOdds:true,
    startTime:iso(180*60000),updatedAt:iso(-120000),
    participant1Id:5001,participant1Name:"Synthetic Lakers",
    participant2Id:5002,participant2Name:"Synthetic Jazz"
  }],{
    reference:"ODDSPAPI_FIXTURES_"+"A".repeat(32),
    capturedAt:iso(-120000)
  },NOW);
  assert.ok(provider);
  const packet=makeOfflineFixtureEspnReviewPacket({
    fixtureId:"synthetic-custody-game",
    providerReceipt:provider,espnScoreboard:clean,
    espnMetadata:META,now:NOW
  });
  assert.ok(packet);
  assert.equal(packet.status,"EVIDENCE_READY_FOR_MANUAL_REVIEW");
  assert.equal(packet.approved,false);
  assert.equal(packet.reviewedPairs,null);
  assert.deepEqual([packet.espn.home.teamId,packet.espn.away.teamId],
    ["13","14"]);
});

test("no malformed, duplicate, ambiguous or unsafe scoreboard is silently truncated",()=>{
  const one=event(),different=event("401234568","15","16");
  for(const invalid of [
    null,{},scoreboard([]),
    scoreboard(Array(41).fill(event())),
    scoreboard([one,{...one,id:"401234568",season:{type:0}}]),
    scoreboard([one,one]),
    scoreboard([{...one,competitions:[]}]),
    scoreboard([{...one,status:{type:{state:"future"}}}]),
    scoreboard([{...one,season:{type:99}}]),
    scoreboard([{...one,date:"2026-11-23 21:00"}]),
    scoreboard([{...one,competitions:[{competitors:[
      one.competitions[0].competitors[0],one.competitions[0].competitors[0]
    ]}]}]),
    scoreboard([{...one,competitions:[{competitors:[
      one.competitions[0].competitors[0],
      {...one.competitions[0].competitors[1],
        team:{id:"14",displayName:"<script>Unsafe</script>"}}
    ]}]}])
  ])assert.equal(sanitizeOfflineEspnScoreboard(invalid),null);
  const simultaneous=sanitizeOfflineEspnScoreboard(scoreboard([
    one,different
  ]));
  assert.equal(simultaneous.events.length,2,
    "same-time events must not be removed and cause false unique matches");
});

test("strict metadata, clock and source capture age prevent custody access",async()=>{
  for(const opts of [
    {metadata:{...META,reference:"https://fake.host"}},
    {metadata:{...META,extra:"injected"}},
    {metadata:{...META,capturedAt:iso(30000)}},
    {metadata:{...META,capturedAt:iso(-6*60000)}},
    {metadata:{...META,capturedAt:"2026-11-23T17:59:00Z"}},
    {metadata:null},
    {raw:{events:[]}}
  ]) {
    const t=setup();
    const status=await t.capture.storeCapture(
      opts.raw??scoreboard(),
      Object.hasOwn(opts,"metadata")?opts.metadata:META,TOKEN
    );
    assert.deepEqual(status,{status:"INVALID_CAPTURE"});
    assert.deepEqual(t.db.actions,[]);
    assert.deepEqual(t.calls,[]);
  }
});

test("inert factory never reads Firestore or verifies captures on construction",()=>{
  const t=setup();
  assert.deepEqual(t.db.actions,[]);
  assert.deepEqual(t.calls,[]);
  assert.throws(()=>makeOfflineEspnScoreboardCustody(),TypeError);
  assert.throws(()=>makeOfflineEspnScoreboardCustody({
    db:{doc:()=>{}},attestCapture:async()=>true
  }),TypeError);
});
test("untrusted or browser-supplied tokens are denied before any Firestore access",async()=>{
  for(const token of [null,{},Object.freeze({reference:REF})]) {
    const t=setup();
    assert.deepEqual(await t.capture.storeCapture(scoreboard(),META,token),
      {status:"DENIED"});
    assert.deepEqual(t.db.actions,[]);
    assert.equal(t.calls.length,1);
  }
  const t=setup({trusted:false});
  assert.deepEqual(await t.capture.storeCapture(scoreboard(),META,TOKEN),
    {status:"DENIED"});
  assert.deepEqual(t.db.actions,[]);
});
test("authenticated create-only storage has exactly the required private D18 schema",async()=>{
  const t=setup();
  assert.deepEqual(await t.capture.storeCapture(scoreboard(),META,TOKEN),
    {status:"STORED"});
  assert.equal(t.db.docs.size,1);
  const [loc,saved]=[...t.db.docs.entries()][0];
  assert.equal(loc,"_internal/teamReview/espnSnapshots/"+REF);
  assert.deepEqual(Object.keys(saved).sort(),
    ["capturedAt","reference","schemaVersion","scoreboard","source"]);
  assert.equal(saved.schemaVersion,1);
  assert.equal(saved.source,"ESPN_NBA_SCOREBOARD");
  assert.equal(saved.reference,REF);
  assert.equal(saved.capturedAt,META.capturedAt);
  assert.doesNotMatch(JSON.stringify(saved),
    /DO_NOT_STORE|privateStats|bookmakerOdds|price|BEARER_DONT_SAVE/);
  assert.deepEqual(await t.capture.storeCapture(scoreboard(),META,TOKEN),
    {status:"REPLAY_BLOCKED"});
  assert.equal(t.db.docs.size,1);
  assert.equal(t.calls.length,2);
});
test("independent references cannot override an already-captured snapshot",async()=>{
  const t=setup();
  await t.capture.storeCapture(scoreboard(),META,TOKEN);
  const old=[...t.db.docs.values()][0];
  const changes=scoreboard([event("401234569")]);
  assert.deepEqual(await t.capture.storeCapture(changes,META,TOKEN),
    {status:"REPLAY_BLOCKED"});
  assert.deepEqual([...t.db.docs.values()][0],old);
});
test("unexpected Admin path and transaction failures are sanitized",async()=>{
  const db={
    doc(path){return {path:"untrusted"};},
    async runTransaction(){throw Error("RAW_PRIVATE_ADMIN_SECRET");}
  };
  const t=setup({db});
  assert.deepEqual(await t.capture.storeCapture(scoreboard(),META,TOKEN),
    {status:"STORE_UNAVAILABLE"});
  const db2={
    doc(path){return {path};},
    async runTransaction(){throw Error("RAW_PRIVATE_ADMIN_SECRET");}
  };
  const t2=setup({db:db2});
  assert.deepEqual(await t2.capture.storeCapture(scoreboard(),META,TOKEN),
    {status:"STORE_UNAVAILABLE"});
});
test("ESPN custody has no production wiring, network or browser write path",()=>{
  const code=fs.readFileSync(path.join(__dirname,
    "offline-espn-scoreboard-custody.js"),"utf8");
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const rules=fs.readFileSync(path.join(__dirname,"..","firestore.rules"),"utf8");
  assert.doesNotMatch(index,
    /require\(["']\.\/offline-espn-scoreboard-custody["']\)/);
  assert.doesNotMatch(code,
    /\bfetch\s*\(|onCall\s*\(|onSchedule\s*\(|setInterval\s*\(/);
  assert.doesNotMatch(code,/firebase-functions|firebase-admin|api\.oddspapi\.io/);
  assert.match(rules,/Everything else is denied by default/);
});
