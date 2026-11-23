"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {extractOfflineFixtureTeamEvidence}=
  require("./offline-fixture-team-evidence");
const {makeOfflineFixtureEspnReviewPacket}=
  require("./offline-fixture-espn-review-packet");
const {makeOfflineTwoSourceBindingCustody}=
  require("./offline-two-source-binding-custody");

const NOW=Date.parse("2026-11-23T14:00:00.000Z");
const iso=ms=>new Date(NOW+ms).toISOString();
const fixtureId="fixture-two-source-001";
const pReference="ODDSPAPI_FIXTURES_"+"A".repeat(32);
const eReference="ESPN_BIND_CAPTURE_001";
const SOURCE={
  fixtureId,providerReference:pReference,espnReference:eReference
};
const TOKEN=Object.freeze({});
function makeSources(){
  const receipt=extractOfflineFixtureTeamEvidence([{
    fixtureId,sportId:11,tournamentId:132,statusId:0,hasOdds:true,
    startTime:iso(180*60000),updatedAt:iso(-150000),
    participant1Id:"9401",participant1Name:"Synthetic Provider Home",
    participant2Id:"9402",participant2Name:"Synthetic Provider Away"
  }],{reference:pReference,capturedAt:iso(-120000)},NOW);
  assert.ok(receipt,"D17 synthetic provider source must be valid");
  const scoreboard={events:[{
    id:"401987654",date:iso(180*60000),
    status:{type:{state:"pre"}},season:{type:2},
    competitions:[{competitors:[
      {homeAway:"home",team:{id:"31",displayName:"Synthetic ESPN East"}},
      {homeAway:"away",team:{id:"32",displayName:"Synthetic ESPN West"}}
    ]}]
  }]};
  const metadata={reference:eReference,capturedAt:iso(-30000)};
  const packet=makeOfflineFixtureEspnReviewPacket({
    fixtureId,providerReceipt:receipt,
    espnScoreboard:scoreboard,espnMetadata:metadata,now:NOW
  });
  assert.ok(packet,"D18 packet must be ready for MANUAL review only");
  return {
    provider:{...receipt,receivedAt:iso(-60000)},
    espn:{schemaVersion:1,source:"ESPN_NBA_SCOREBOARD",
      reference:eReference,capturedAt:metadata.capturedAt,scoreboard},
    packet
  };
}
const PATHS={
  binding:"_internal/teamReview/sourceBindings/"+fixtureId,
  provider:"_internal/teamEvidence/fixtureTeamSnapshots/"+pReference,
  espn:"_internal/teamReview/espnSnapshots/"+eReference
};
function fakeDb(initial={}){
  const docs=new Map(Object.entries(initial)),calls=[];
  const db={docs,calls,
    doc(key){calls.push("doc");return {path:key};},
    async runTransaction(work){
      calls.push("transaction");
      const writes=[];
      const result=await work({
        async get(ref){calls.push("get");return {
          exists:docs.has(ref.path),
          data:()=>structuredClone(docs.get(ref.path))
        };},
        create(ref,row){
          calls.push("create");
          if(docs.has(ref.path))throw Error("Already exists");
          writes.push([ref.path,structuredClone(row)]);
        }
      });
      for(const [loc,row] of writes)docs.set(loc,row);
      return result;
    }
  };
  return db;
}
function harness({initial,auth=true,attested=true,clock=NOW}={}){
  const {provider,espn,packet}=makeSources();
  const db=fakeDb(initial||{
    [PATHS.provider]:provider,[PATHS.espn]:espn
  });
  const authCalls=[],proofs=[];
  const custody=makeOfflineTwoSourceBindingCustody({
    db,now:()=>clock,
    async authorizeBinding(token,proposal){
      authCalls.push(proposal);
      return auth&&token===TOKEN&&
        Object.keys(proposal).sort().join("|")===
          "espnReference|fixtureId|providerReference"&&
        proposal.fixtureId===fixtureId&&
        proposal.providerReference===pReference&&
        proposal.espnReference===eReference;
    },
    async attestSourceOrigins(token,proof){
      proofs.push(proof);
      return attested&&token===TOKEN&&
        proof.fixtureId===fixtureId&&
        proof.providerReference===pReference&&
        proof.espnReference===eReference&&
        proof.providerDigest===packet.provider.snapshotDigest&&
        proof.espnDigest===packet.espn.digest&&
        proof.packetDigest===packet.packetDigest;
    }
  });
  return {db,custody,authCalls,proofs,packet,
    submit:(token=TOKEN,proposal=SOURCE)=>custody.bindSources(proposal,token)};
}

test("D21 construction is inert and requires Admin and two trusted verifiers",()=>{
  assert.throws(()=>makeOfflineTwoSourceBindingCustody(),TypeError);
  assert.throws(()=>makeOfflineTwoSourceBindingCustody({
    db:{doc:()=>{},runTransaction:async()=>{}},
    authorizeBinding:async()=>true
  }),TypeError);
  const h=harness();
  assert.equal(h.db.calls.length,0);
  assert.equal(h.authCalls.length,0);
  assert.equal(h.proofs.length,0);
});

test("D21 reject untrusted paths, injected client fields and invalid IDs before DB",async()=>{
  const invalid=[null,{},[],{...SOURCE,approved:true},
    {...SOURCE,fixtureId:"../../escape"},
    {...SOURCE,fixtureId:""},
    {...SOURCE,providerReference:"https://api.oddspapi.io/v4/fixtures"},
    {...SOURCE,providerReference:"ODDSPAPI_FIXTURES_"+"z".repeat(32)},
    {...SOURCE,espnReference:"ESPN_../outside"},
    {...SOURCE,espnReference:"https://api.espn.com"},
    {...SOURCE,espnReference:"ODDSPAPI_FIXTURES_"+"A".repeat(32)}
  ];
  for(const input of invalid){
    const h=harness();
    assert.deepEqual(await h.submit(TOKEN,input),{status:"INVALID_REQUEST"});
    assert.equal(h.db.calls.length,0);
    assert.equal(h.authCalls.length,0);
    assert.equal(h.proofs.length,0);
  }
});

test("D21 untrusted capture token and owner authorization deny before any read",async()=>{
  for(const candidate of [null,{},Object.freeze({...SOURCE})]){
    const h=harness();
    assert.deepEqual(await h.submit(candidate),{status:"DENIED"});
    assert.deepEqual(h.db.calls,[]);
    assert.equal(h.proofs.length,0);
  }
  const h=harness({auth:false});
  assert.deepEqual(await h.submit(),{status:"DENIED"});
  assert.deepEqual(h.db.calls,[]);
});

test("D21 exact private source snapshots create one unreviewed digest-only binding",async()=>{
  const h=harness();
  assert.deepEqual(await h.submit(),{status:"STORED"});
  assert.deepEqual(h.authCalls,[SOURCE]);
  assert.equal(h.proofs.length,1);
  assert.deepEqual(h.db.calls.slice(-1),["create"]);
  const saved=h.db.docs.get(PATHS.binding);
  assert.deepEqual(Object.keys(saved).sort(),
    ["espnDigest","espnReference","fixtureId","packetDigest",
     "providerDigest","providerReference","schemaVersion"]);
  assert.deepEqual(saved,{
    schemaVersion:1,fixtureId,
    providerReference:pReference,
    espnReference:eReference,
    providerDigest:h.packet.provider.snapshotDigest,
    espnDigest:h.packet.espn.digest,
    packetDigest:h.packet.packetDigest
  });
  assert.doesNotMatch(JSON.stringify(saved),
    /Synthetic|9401|9402|401987654|31|32|odds|secret|approved|pairs/);
  assert.equal(h.db.docs.size,3);
  assert.equal(h.db.docs.has("_internal/teamReview/fixtureJournals/"+fixtureId),false);
  assert.deepEqual(await h.submit(),{status:"REPLAY_BLOCKED"});
  assert.deepEqual(h.db.docs.get(PATHS.binding),saved);
});

test("D21 absent original provider or ESPN document cannot create a binding",async()=>{
  const sources=makeSources();
  for(const initial of [
    {[PATHS.espn]:sources.espn},
    {[PATHS.provider]:sources.provider},
    {}
  ]){
    const h=harness({initial});
    assert.deepEqual(await h.submit(),{status:"SOURCE_UNAVAILABLE"});
    assert.equal(h.db.docs.has(PATHS.binding),false);
  }
});

test("D21 tampering either original source digest or its shape fails closed",async()=>{
  const mutations=[
    (p,e)=>{p.digest="0".repeat(64);},
    (p,e)=>{p.records[0].participant1Id="9999";},
    (p,e)=>{p.receivedAt=iso(1000);},
    (p,e)=>{p.extra={odds:1.81};},
    (p,e)=>{e.scoreboard.events[0].competitions[0]
      .competitors[0].team.displayName="Replaced ESPN Home";},
    (p,e)=>{e.scoreboard.events[0].competitions[0]
      .competitors[1].team.odds=1.81;},
    (p,e)=>{e.scoreboard.events[0].date=iso(200*60000);},
    (p,e)=>{e.scoreboard.events[0].status.type.state="post";},
    (p,e)=>{e.source="UNTRUSTED_SCOREBOARD";},
    (p,e)=>{e.capturedAt=iso(1000);},
    (p,e)=>{e.rawKey="REJECT_EXTRA";}
  ];
  for(const mutate of mutations){
    const src=makeSources();
    mutate(src.provider,src.espn);
    const h=harness({initial:{
      [PATHS.provider]:src.provider,[PATHS.espn]:src.espn
    }});
    assert.deepEqual(await h.submit(),{status:"SOURCE_UNAVAILABLE"});
    assert.equal(h.db.docs.has(PATHS.binding),false);
  }
});

test("D21 mismatched fixture, expired source and reviewer proximity fail closed",async()=>{
  const src=makeSources();
  const changed=structuredClone(src.provider);
  changed.records[0].fixtureId="different-game";
  const h=harness({initial:{
    [PATHS.provider]:changed,[PATHS.espn]:src.espn
  }});
  assert.deepEqual(await h.submit(),{status:"SOURCE_UNAVAILABLE"});
  const stale=harness({clock:NOW+32*60000});
  assert.deepEqual(await stale.submit(),{status:"SOURCE_UNAVAILABLE"});
});

test("D21 independent digest attestation refuses mismatches without any writes",async()=>{
  const h=harness({attested:false});
  assert.deepEqual(await h.submit(),{status:"SOURCE_UNAVAILABLE"});
  assert.equal(h.authCalls.length,1);
  assert.equal(h.proofs.length,1);
  assert.deepEqual(h.db.calls.filter(x=>x==="create"),[]);
});

test("D21 backend errors and wrong ref paths return fixed safe status",async()=>{
  const h=harness();
  h.db.runTransaction=async()=>{throw Error("PRIVATE_SOURCE_TOKEN_OR_CREDENTIAL");};
  assert.deepEqual(await h.submit(),{status:"STORE_UNAVAILABLE"});
  const broken=harness();
  broken.db.doc=()=>({path:"malicious/path"});
  assert.deepEqual(await broken.submit(),{status:"STORE_UNAVAILABLE"});
  assert.doesNotMatch(JSON.stringify(await broken.submit()),
    /PRIVATE|malicious|ODDSPAPI|ESPN_/);
});

test("D21 rejects missing, negative or non-integer server clock",async()=>{
  for(const value of [null,NaN,Infinity,-1,2.5]){
    const h=harness({clock:value});
    assert.deepEqual(await h.submit(),{status:"INVALID_REQUEST"});
    assert.deepEqual(h.db.calls,[]);
  }
});

test("D21 no production route, paid provider, browser writer or polling",()=>{
  const source=fs.readFileSync(path.join(__dirname,
    "offline-two-source-binding-custody.js"),"utf8");
  const index=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  assert.doesNotMatch(index,
    /require\(["']\.\/offline-two-source-binding-custody["']\)/);
  assert.doesNotMatch(source,
    /onCall\s*\(|onSchedule\s*\(|\bfetch\s*\(|firebase-admin|firebase-functions|api\.oddspapi\.io|setInterval\s*\(/);
});
