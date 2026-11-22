"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createHash}=require("node:crypto");
const fs=require("node:fs");
const path=require("node:path");
const {captureProviderFixture}=require("./offer-team-evidence");
const {freezeUnreviewedProviderPlayerPair}=
  require("./provider-player-quote-snapshot");
const {makeOfflinePlayerReceiptLink}=
  require("./offline-player-receipt-link");
const {makeReviewedTeamBridgeResolver}=require("./offer-team-crosswalk");
const {makeReviewedPlayerBridgeResolver}=require("./offer-player-crosswalk");
const {inspectOfflineNbaOffers}=require("./offer-matching");

const NOW=Date.parse("2026-11-20T16:00:00.000Z");
const iso=n=>new Date(NOW+n*60000).toISOString();
const sha=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const REF="ODDSPAPI_MANUAL_"+"B".repeat(32);
const SRC="ODDSPAPI_V4_ODDS_BY_TOURNAMENTS";
const FIX="synthetic-d15-37-fixture";
const PLAYER="93001",MARKET="91001";
const TOKEN=Object.freeze({});
const selector=()=>({fixtureId:FIX,marketId:MARKET,
  providerPlayerId:PLAYER,sourceReference:REF});
const market={marketId:91001,sportId:11,playerProp:true,period:"result",
  marketName:"Over Under Player Points (incl. overtime)",handicap:20.5,
  outcomes:[{outcomeId:92001,outcomeName:"Over"},
    {outcomeId:92002,outcomeName:"Under"}]};
const fixture=(mainLine=false)=>({
  fixtureId:FIX,sportId:11,tournamentId:132,
  participant1Id:"5001",participant2Id:"5002",statusId:0,hasOdds:true,
  startTime:iso(180),
  bookmakerOdds:{"betano.pt":{
    bookmakerIsActive:true,suspended:false,markets:{"91001":{
      marketActive:true,outcomes:{
        "92001":{players:{[PLAYER]:{
          active:true,price:1.88,playerName:"Synthetic First Last",
          changedAt:iso(-2),mainLine
        }}},
        "92002":{players:{[PLAYER]:{
          active:true,price:1.92,playerName:"Synthetic First Last",
          changedAt:iso(-2),mainLine
        }}}
      }
    }}
  }}
});
const quotePath=()=>"_internal/quoteEvidence/providerObservations/"+
  sha([REF,FIX,PLAYER,MARKET]);
const teamPath=()=>"_internal/teamEvidence/providerSnapshots/"+REF;
function setup(options={}) {
  const source=fixture(options.mainLine);
  const quoted=freezeUnreviewedProviderPlayerPair({
    now:NOW,capturedAt:iso(-1),snapshotReference:REF,
    fixtureId:FIX,marketId:MARKET,providerPlayerId:PLAYER,
    catalogue:[market],leagueOdds:[source]
  });
  assert.ok(quoted,"Existing D15.27 quote producer must make synthetic evidence");
  const fixtureRow=captureProviderFixture(source,{
    reference:REF,capturedAt:iso(-1)
  });
  assert.ok(fixtureRow,"Existing D4 fixture producer must make synthetic evidence");
  const batch={
    schemaVersion:1,source:SRC,status:"UNREVIEWED_PROVIDER_EVIDENCE",
    reference:REF,capturedAt:iso(-1),receivedAt:iso(0),
    totalFixtures:1,acceptedFixtures:1,rejectedFixtures:0,
    digest:sha([REF,iso(-1),1,1,0,[[
      fixtureRow.fixtureId,fixtureRow.startTime,
      ...fixtureRow.participantIds,fixtureRow.digest
    ]]]),
    records:[structuredClone(fixtureRow)]
  };
  const quoteDoc={schemaVersion:1,source:SRC,
    status:"UNREVIEWED_QUOTE_EVIDENCE",receivedAt:iso(0),
    quote:structuredClone(quoted)};
  const docs=new Map([[teamPath(),batch],[quotePath(),quoteDoc]]);
  const calls=[];
  const reader=async p=>{
    calls.push(p);
    if(options.failRead)throw Error("PRIVATE_FIRESTORE_ERROR");
    return docs.get(p)??null;
  };
  const trust=async(token,meta)=>{
    if(options.failTrust)throw Error("PRIVATE_OWNER_CREDENTIAL");
    return token===TOKEN&&JSON.stringify(meta)===JSON.stringify(selector());
  };
  const review=makeOfflinePlayerReceiptLink({
    readPrivateEvidence:reader,isTrustedInternalReview:trust,
    now:options.now??(()=>NOW)
  });
  return {docs,review,calls,quoted,batch,quoteDoc,source,run:(s=selector(),t=TOKEN)=>
    review(s,t)};
}
const denied=async promise=>assert.equal(await promise,null);
const rehashQuote=q=>{
  const side=n=>({
    outcomeId:q.outcomes[n].outcomeId,price:q.outcomes[n].price,
    changedAt:q.outcomes[n].changedAt,
    mainLineFlag:q.outcomes[n].mainLineFlag
  });
  q.digest=sha([SRC,q.sourceReference,q.capturedAt,q.fixtureId,q.startTime,
    ...q.providerParticipantIds,q.providerPlayerId,q.providerPlayerName,
    q.marketId,q.family,q.line,side("Over"),side("Under")]);
};
const rehashBatch=b=>{
  b.digest=sha([b.reference,b.capturedAt,b.totalFixtures,b.acceptedFixtures,
    b.rejectedFixtures,b.records.map(r=>[
      r.fixtureId,r.startTime,...r.participantIds,r.digest
    ])]);
};

test("D15.37 existing D4 and D15.27 generated documents link without approving",async()=>{
  const h=setup();
  const result=await h.run();
  assert.ok(result);
  assert.equal(Object.isFrozen(result),true);
  assert.equal(Object.isFrozen(result.providerParticipantIds),true);
  assert.equal(result.status,"UNREVIEWED_RECEIPT_LINK_ONLY");
  assert.equal(result.sourceReference,REF);
  assert.equal(result.providerPlayerId,PLAYER);
  assert.equal(result.providerPlayerName,"Synthetic First Last");
  assert.equal(result.marketId,MARKET);
  assert.deepEqual(result.providerParticipantIds,["5001","5002"]);
  assert.equal(result.quoteDigest,h.quoted.digest);
  assert.equal(result.fixtureDigest,h.batch.records[0].digest);
  for(const flag of ["bookmakerVerified","espnPlayerVerified",
    "autoLineSelected","captureAllowed"])assert.equal(result[flag],false);
  assert.equal("outcomes" in result,false);
  assert.equal("price" in result,false);
  assert.equal("espnAthleteId" in result,false);
  assert.deepEqual(h.calls,[quotePath(),teamPath()]);
});

test("D15.37 only deterministic internal paths are read, never raw player IDs",async()=>{
  const h=setup();await h.run();
  assert.ok(h.calls.every(p=>p.startsWith("_internal/")));
  assert.doesNotMatch(quotePath(),/93001|91001|Synthetic|1\.88/);
  assert.ok(h.calls.every(p=>!p.includes("..")));
});

test("D15.37 missing quote or fixture record fails closed",async()=>{
  for(const missing of [quotePath(),teamPath()]) {
    const h=setup();h.docs.delete(missing);await denied(h.run());
    assert.equal(h.calls.length,missing===quotePath()?1:2);
  }
});

test("D15.37 token is backend-only and client values cannot authorize",async()=>{
  const h=setup();
  for(const token of [null,undefined,"owner",{},[],true,REF])
    await denied(h.review(selector(),token));
  assert.deepEqual(h.calls,[]);
});

test("D15.37 selector must have exact known fields and numeric original IDs",async()=>{
  const h=setup();
  for(const s of [null,{},[],{...selector(),extra:"verified"},
    {...selector(),sourceReference:"browser"},
    {...selector(),fixtureId:"../../x"},
    {...selector(),marketId:"0"},
    {...selector(),providerPlayerId:"00093001"},
    {...selector(),providerPlayerId:93001}])
    await denied(h.run(s));
  assert.equal(h.calls.length,0);
});

test("D15.37 unavailable trusted review cannot touch private storage",async()=>{
  const h=setup({failTrust:true});
  await denied(h.run());
  assert.deepEqual(h.calls,[]);
});

test("D15.37 missing or conflicting original fixture identifiers reject join",async()=>{
  for(const change of [
    q=>{q.fixtureId="synthetic-other";},
    q=>{q.startTime=iso(181);},
    q=>{q.capturedAt=iso(-2);},
    q=>{q.providerParticipantIds[0]="5009";},
    q=>{q.providerParticipantIds.reverse();}
  ]) {
    const h=setup();change(h.quoteDoc.quote);
    rehashQuote(h.quoteDoc.quote);
    await denied(h.run());
  }
});

test("D15.37 changed original player name and line are digest-bound",async()=>{
  for(const change of [
    q=>{q.providerPlayerName="Synthetic Imposter";},
    q=>{q.line=22.5;},
    q=>{q.outcomes.Over.price=2.41;},
    q=>{q.outcomes.Under.changedAt=iso(-30);}
  ]) {
    const h=setup();change(h.quoteDoc.quote);await denied(h.run());
  }
});

test("D15.37 quote digest is not itself source authenticity or approval",async()=>{
  for(const change of [
    q=>{q.bookmakerVerified=true;},
    q=>{q.espnPlayerVerified=true;},
    q=>{q.autoLineSelected=true;},
    q=>{q.captureAllowed=true;},
    q=>{q.status="VERIFIED_PROVIDER_QUOTE";},
    q=>{q.attributedBookmaker="other.example";},
    q=>{q.extraClaim="independent ES PN audit";}
  ]) {
    const h=setup();change(h.quoteDoc.quote);await denied(h.run());
  }
});

test("D15.37 tampered fixture row and batch digest both reject",async()=>{
  for(const change of [
    b=>{b.records[0].participantIds[0]="9999";},
    b=>{b.records[0].fixtureId="another";},
    b=>{b.records[0].startTime=iso(200);},
    b=>{b.digest="a".repeat(64);},
    b=>{b.records[0].digest="b".repeat(64);}
  ]) {
    const h=setup();change(h.batch);await denied(h.run());
  }
});

test("D15.37 duplicate fixture rows reject even with recalculated batch checksum",async()=>{
  const h=setup();
  h.batch.records.push(structuredClone(h.batch.records[0]));
  h.batch.acceptedFixtures=2;
  h.batch.totalFixtures=2;
  rehashBatch(h.batch);
  await denied(h.run());
});

test("D15.37 separate receipts cannot silently join",async()=>{
  const h=setup();
  h.batch.reference="ODDSPAPI_MANUAL_"+"C".repeat(32);
  h.batch.records[0].reference=h.batch.reference;
  rehashBatch(h.batch);
  await denied(h.run());
});

test("D15.37 malformed stored schemas and promotions are denied",async()=>{
  for(const change of [
    h=>{h.batch.status="APPROVED";},
    h=>{h.quoteDoc.status="VERIFIED";},
    h=>{h.batch.newField=1;},
    h=>{h.quoteDoc.newField=1;},
    h=>{h.batch.records[0].injectedTeamReview=true;},
    h=>{h.quoteDoc.quote.outcomes.Over.adminOverride=true;}
  ]) {
    const h=setup();change(h);await denied(h.run());
  }
});

test("D15.37 malformed timestamps and impossible timing reject",async()=>{
  for(const change of [
    h=>{h.batch.receivedAt=iso(-2);},
    h=>{h.quoteDoc.receivedAt=iso(-2);},
    h=>{h.quoteDoc.receivedAt=iso(7);},
    h=>{h.batch.receivedAt=iso(7);},
    h=>{h.quoteDoc.quote.outcomes.Over.changedAt=iso(4);},
    h=>{h.batch.records[0].startTime="not-a-date";}
  ]) {
    const h=setup();change(h);await denied(h.run());
  }
});

test("D15.37 historical read stays possible after kickoff but never turns into capture",async()=>{
  const h=setup({now:()=>NOW+30*24*60*60000});
  const result=await h.run();
  assert.equal(result.status,"UNREVIEWED_RECEIPT_LINK_ONLY");
  assert.equal(result.captureAllowed,false);
});

test("D15.37 future receivedAt is not accepted",async()=>{
  const h=setup({now:()=>NOW-2*60000});
  await denied(h.run());
});

test("D15.37 storage error, throwing getters, invalid clock fail without secrets",async()=>{
  const a=setup({failRead:true});await denied(a.run());
  const b=setup({now:()=>NaN});await denied(b.run());
  const c=setup();
  Object.defineProperty(c.batch,"records",{get(){throw Error("PRIVATE_ODDS_VALUE");}});
  await denied(c.run());
});

test("D15.37 asynchronous selector mutation cannot redirect authorized reads",async()=>{
  const h=setup();
  const mutable=selector();
  const gate=makeOfflinePlayerReceiptLink({
    readPrivateEvidence:async p=>h.docs.get(p)??null,
    isTrustedInternalReview:async(token,metadata)=>{
      assert.equal(Object.isFrozen(metadata),true);
      assert.equal(metadata.sourceReference,REF);
      mutable.sourceReference="ODDSPAPI_MANUAL_"+"C".repeat(32);
      mutable.fixtureId="another-fixture";
      mutable.providerPlayerId="99999";
      return token===TOKEN;
    },
    now:()=>NOW
  });
  const result=await gate(mutable,TOKEN);
  assert.ok(result);
  assert.equal(result.sourceReference,REF);
  assert.equal(result.fixtureId,FIX);
  assert.equal(result.providerPlayerId,PLAYER);
  assert.equal(result.captureAllowed,false);
});

test("D15.37 constructor is inert and requires all isolated adapters",async()=>{
  for(const args of [{},{readPrivateEvidence:async()=>null},
    {isTrustedInternalReview:async()=>true},
    {readPrivateEvidence:async()=>null,isTrustedInternalReview:async()=>true,now:4}])
    assert.throws(()=>makeOfflinePlayerReceiptLink(args),
      /Missing private evidence review dependencies/);
  let calls=0;
  const reader=makeOfflinePlayerReceiptLink({
    readPrivateEvidence:async()=>{calls++;return null;},
    isTrustedInternalReview:async()=>{calls++;return true;},
    now:()=>{calls++;return NOW;}
  });
  assert.equal(calls,0);
  assert.equal(Object.isFrozen(reader),true);
  await denied(reader(selector(),TOKEN));
  assert.equal(calls,3);
});

test("D15.37 code and production remain offline and browser research writes denied",()=>{
  const file=fs.readFileSync(path.join(__dirname,
    "offline-player-receipt-link.js"),"utf8");
  const prod=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const rules=fs.readFileSync(path.join(__dirname,"..","firestore.rules"),"utf8");
  assert.doesNotMatch(prod,/offline-player-receipt-link|makeOfflinePlayerReceiptLink/);
  assert.doesNotMatch(file,/require\(["'](?:firebase-admin|firebase-functions|https?|node:https?)["']\)/);
  assert.doesNotMatch(file,/\b(?:fetch|setInterval|setTimeout|onCall|onSchedule)\s*\(/);
  assert.doesNotMatch(file,/\b(?:adminTx|db|tx)\.(?:set|update|delete|create)\s*\(/);
  assert.doesNotMatch(file,/propResearchLedger/);
  assert.match(rules,/allow create, update, delete: if false;/);
});

function reviewSyntheticOffer(h, athletes) {
  const espnEvent={
    eventId:"40101010",startTime:iso(180),status:"STATUS_SCHEDULED",
    homeTeamId:"1001",awayTeamId:"1002"
  };
  const resolveTeams=makeReviewedTeamBridgeResolver([{
    schemaVersion:1,providerFixtureId:FIX,providerStartTime:iso(180),
    espnEventId:espnEvent.eventId,reviewMethod:"MANUAL_TWO_SOURCE_ID_REVIEW",
    reviewStatus:"APPROVED",reviewedAt:iso(-30),validUntil:iso(120),
    evidence:{
      providerReference:"ODDSPAPI_FIXTURE_REVIEW_SYNTHETIC",
      espnReference:"ESPN_SCOREBOARD_REVIEW_SYNTHETIC"
    },
    teams:[
      {providerParticipantId:"5001",espnTeamId:"1001"},
      {providerParticipantId:"5002",espnTeamId:"1002"}
    ]
  }],()=>NOW);
  const reviewedTeamBridge=resolveTeams({
    fixtureId:FIX,participant1Id:"5001",participant2Id:"5002",
    startTime:iso(180)
  });
  assert.ok(reviewedTeamBridge);

  const espnRoster={teamId:"1001",athletes};
  const resolvePlayer=makeReviewedPlayerBridgeResolver([{
    schemaVersion:1,reviewMethod:"MANUAL_TWO_SOURCE_PLAYER_ID_REVIEW",
    reviewStatus:"APPROVED",reviewedAt:iso(-1),validUntil:iso(120),
    provider:{
      fixtureId:FIX,participantId:"5001",playerId:PLAYER,
      playerName:h.quoted.providerPlayerName,quoteDigest:h.quoted.digest,
      sourceReference:REF,startTime:iso(180)
    },
    espn:{
      eventId:espnEvent.eventId,teamId:"1001",athleteId:"7001",
      displayName:h.quoted.providerPlayerName,
      reference:"ESPN_ROSTER_MANUAL_SYNTHETIC"
    }
  }],()=>NOW);
  const athlete=resolvePlayer({quote:h.quoted,reviewedTeamBridge,espnRoster});
  const offer=inspectOfflineNbaOffers({
    catalogue:[market],fixture:h.source,espnEvent,
    teamBridge:reviewedTeamBridge.teamBridge,
    rosters:[espnRoster,{teamId:"1002",athletes:[
      {id:"7003",displayName:"Other Synthetic Athlete"}
    ]}],
    providerPlayerId:PLAYER,reviewedAthleteBridge:athlete,now:NOW
  });
  return {athlete,offer};
}

test("synthetic Betano main-line candidate matches reviewed ESPN identity and the original receipt",async()=>{
  const h=setup({mainLine:true});
  const receipt=await h.run();
  assert.ok(receipt);
  assert.equal(receipt.quoteDigest,h.quoted.digest);
  assert.equal(receipt.fixtureDigest,h.batch.records[0].digest);
  assert.equal(receipt.marketId,MARKET);
  assert.equal(h.quoted.line,20.5);
  assert.equal(h.quoted.outcomes.Over.mainLineFlag,true);
  assert.equal(h.quoted.outcomes.Under.mainLineFlag,true);

  const {athlete,offer}=reviewSyntheticOffer(h,[
    {id:"7001",displayName:receipt.providerPlayerName}
  ]);
  assert.equal(athlete?.espnAthleteId,"7001");
  assert.equal(athlete.providerPlayerId,receipt.providerPlayerId);
  assert.equal(offer.status,"REVIEW_CANDIDATES_ONLY");
  assert.equal(offer.athleteMatch,"REVIEW_ASSERTION_ONLY");
  assert.deepEqual(offer.families.find(row=>row.market==="PTS"),{
    market:"PTS",pairedLines:1,freshPairs:1,stalePairs:0,explicitMainPairs:1,
    decision:"EXPLICIT_MAIN_LINE_REVIEW_REQUIRED"
  });
  for(const result of [receipt,athlete,offer]) {
    assert.equal(result.bookmakerVerified,false);
    assert.equal(result.autoLineSelected,false);
    assert.equal(result.captureAllowed,false);
  }
  assert.deepEqual(h.calls,[quotePath(),teamPath()]);
});

test("synthetic main-line quote stays unverified when ESPN identity is ambiguous",async()=>{
  const h=setup({mainLine:true});
  const receipt=await h.run();
  assert.ok(receipt);
  const displayName=receipt.providerPlayerName;
  const {athlete,offer}=reviewSyntheticOffer(h,[
    {id:"7001",displayName},{id:"7002",displayName}
  ]);
  assert.equal(athlete,null);
  assert.equal(offer.status,"AMBIGUOUS_ESPN_NAME");
  assert.equal(offer.captureAllowed,false);
});

test("synthetic main-line quote cannot link a mismatched original receipt",async()=>{
  const h=setup({mainLine:true});
  h.quoteDoc.quote.startTime=iso(181);
  rehashQuote(h.quoteDoc.quote);
  await denied(h.run());
  assert.deepEqual(h.calls,[quotePath(),teamPath()]);
});
