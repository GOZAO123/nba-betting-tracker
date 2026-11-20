"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { freezeUnreviewedProviderPlayerPair } =
  require("./provider-player-quote-snapshot");

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const iso = minutes => new Date(NOW + minutes * 60000).toISOString();
const REF = "ODDSPAPI_MANUAL_" + "A".repeat(32);
const NAMES = Object.freeze({
  PTS:"Over Under Player Points (incl. overtime)",
  REB:"Over Under Player Rebounds (incl. overtime)",
  AST:"Over Under Player Assists (incl. overtime)",
  "3PT":"Over Under Player 3 Point FG (incl. overtime)",
  PR:"Over Under Player Points + Rebounds (incl. overtime)",
  PA:"Over Under Player Points + Assists (incl. overtime)",
  RA:"Over Under Player Assists + Rebounds (incl. overtime)",
  PRA:"Over Under Player Points + Assists + Rebounds (incl. overtime)"
});

function catalogueRow(marketId=91001,family="PTS",line=18.5) {
  return {
    marketId, sportId:11, playerProp:true, period:"result",
    marketName:NAMES[family], handicap:line, outcomes:[
      {outcomeId:marketId+1000,outcomeName:"Over"},
      {outcomeId:marketId+1001,outcomeName:"Under"}
    ]
  };
}
function quote(changes={}) {
  return {active:true, price:1.88, playerName:"Synthetic Test Athlete",
    changedAt:iso(-3), mainLine:false, ...changes};
}
function market(definition=catalogueRow()) {
  return {marketActive:true, outcomes:{
    [definition.outcomes[0].outcomeId]: {
      players:{"93001":quote({price:1.88})}
    },
    [definition.outcomes[1].outcomeId]: {
      players:{"93001":quote({price:1.92})}
    }
  }};
}
function fixture() {
  return {
    fixtureId:"synthetic-quote-fixture-001", sportId:11, tournamentId:132,
    participant1Id:"5001", participant2Id:"5002", statusId:0,
    hasOdds:true, startTime:iso(180), bookmakerOdds:{
      "betano.pt":{bookmakerIsActive:true,suspended:false,markets:{
        "91001":market()
      }}
    }
  };
}
function scenario(change=()=>{}) {
  const input = {
    catalogue:[catalogueRow()],
    leagueOdds:[fixture()],
    fixtureId:"synthetic-quote-fixture-001",
    providerPlayerId:"93001",marketId:"91001",
    snapshotReference:REF,capturedAt:iso(-1),now:NOW
  };
  change(input);
  return input;
}
const freeze = change => freezeUnreviewedProviderPlayerPair(scenario(change));
const assertUnapproved = result => {
  assert.ok(result);
  assert.deepEqual([
    result.bookmakerVerified,result.espnPlayerVerified,
    result.autoLineSelected,result.captureAllowed
  ],[false,false,false,false]);
  assert.equal(result.status,"UNREVIEWED_PROVIDER_QUOTE");
  assert.equal(result.attributedBookmaker,"betano.pt");
  assert.equal(result.source,"ODDSPAPI_V4_ODDS_BY_TOURNAMENTS");
};

test("D15.27 exactly one synthetic player Over/Under pair preserves original prices/time/ID",()=>{
  const result=freeze();
  assertUnapproved(result);
  assert.equal(result.capturedAt,iso(-1));
  assert.equal(result.sourceReference,REF);
  assert.equal(result.fixtureId,"synthetic-quote-fixture-001");
  assert.deepEqual(result.providerParticipantIds,["5001","5002"]);
  assert.equal(result.startTime,iso(180));
  assert.equal(result.providerPlayerId,"93001");
  assert.equal(result.providerPlayerName,"Synthetic Test Athlete");
  assert.deepEqual([result.family,result.line,result.marketId],["PTS",18.5,"91001"]);
  assert.deepEqual(result.outcomes,{
    Over:{outcomeId:"92001",price:1.88,changedAt:iso(-3),mainLineFlag:false},
    Under:{outcomeId:"92002",price:1.92,changedAt:iso(-3),mainLineFlag:false}
  });
  assert.equal(result.freshness,"FRESH_WITHIN_15_MIN");
  assert.equal(result.mainLineEvidence,"NO_EXPLICIT_FLAGS");
  assert.match(result.digest,/^[a-f0-9]{64}$/);
});

test("D15.27 supports all eight precise full-game overtime families, never partial game",()=>{
  for(const family of Object.keys(NAMES)){
    const result=freeze(input=>{
      input.catalogue=[catalogueRow(91001,family,18.5)];
    });
    assertUnapproved(result);
    assert.equal(result.family,family);
  }
  assert.equal(freeze(input=>{input.catalogue[0].period="fulltime";}),null);
  assert.equal(freeze(input=>{input.catalogue[0].period="p1";}),null);
  assert.equal(freeze(input=>{input.catalogue[0].period=null;}),null);
});

test("D15.27 source quotation is deep-frozen and not changed by later upstream mutations",()=>{
  const original=scenario(), value=freezeUnreviewedProviderPlayerPair(original);
  assertUnapproved(value);
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.outcomes));
  assert.ok(Object.isFrozen(value.outcomes.Over));
  assert.ok(Object.isFrozen(value.outcomes.Under));
  assert.ok(Object.isFrozen(value.providerParticipantIds));
  const before=value.digest;
  const price=original.leagueOdds[0].bookmakerOdds["betano.pt"].markets["91001"]
    .outcomes["92001"].players["93001"];
  price.price=2.10;
  assert.equal(value.outcomes.Over.price,1.88);
  assert.equal(value.digest,before);
  const revised=freezeUnreviewedProviderPlayerPair(original);
  assertUnapproved(revised);
  assert.notEqual(revised.digest,before);
});

test("D15.27 duplicate fixture IDs are quarantined, not first-wins",()=>{
  assert.equal(freeze(input=>input.leagueOdds.push(structuredClone(input.leagueOdds[0]))),null);
  assert.equal(freeze(input=>input.fixtureId="nonexistent-fixture"),null);
  assert.equal(freeze(input=>input.leagueOdds=[]),null);
});

test("D15.27 requires NBA scheduled fixture and exact two provider participant IDs",()=>{
  const changes=[
    {sportId:12},{tournamentId:131},{statusId:1},{hasOdds:false},
    {participant1Id:null},{participant1Id:"5002"},{startTime:iso(4)},
    {startTime:iso(73*60)}
  ];
  for(const change of changes)
    assert.equal(freeze(input=>Object.assign(input.leagueOdds[0],change)),null);
});

test("D15.27 missing, inactive, or suspended attributed bookmaker cannot create a snapshot",()=>{
  assert.equal(freeze(input=>{delete input.leagueOdds[0].bookmakerOdds["betano.pt"];}),null);
  assert.equal(freeze(input=>{input.leagueOdds[0].bookmakerOdds["betano.pt"].suspended=true;}),null);
  assert.equal(freeze(input=>{input.leagueOdds[0].bookmakerOdds["betano.pt"].bookmakerIsActive=false;}),null);
  assert.equal(freeze(input=>{
    input.leagueOdds[0].bookmakerOdds["other.example"]=
      input.leagueOdds[0].bookmakerOdds["betano.pt"];
    delete input.leagueOdds[0].bookmakerOdds["betano.pt"];
  }),null);
});

test("D15.27 no arbitrary market, invalid line or unresolved official catalogue",()=>{
  assert.equal(freeze(input=>{input.marketId="99999";}),null);
  assert.equal(freeze(input=>{input.catalogue[0].handicap=18;}),null);
  assert.equal(freeze(input=>{input.catalogue[0].marketName="Unknown market";}),null);
  assert.equal(freeze(input=>{input.catalogue=[];}),null);
});

test("D15.27 duplicate catalogue IDs cannot select first definition",()=>{
  assert.equal(freeze(input=>input.catalogue.push({
    ...input.catalogue[0],handicap:19.5
  })),null);
});

test("D15.27 duplicate active family+line across different market IDs is ambiguous",()=>{
  assert.equal(freeze(input=>{
    const second=catalogueRow(91002,"PTS",18.5);
    input.catalogue.push(second);
    input.leagueOdds[0].bookmakerOdds["betano.pt"].markets["91002"]=market(second);
  }),null);
});

test("D15.27 incomplete/unknown Over and Under outcomes cannot freeze a pair",()=>{
  assert.equal(freeze(input=>{
    delete input.leagueOdds[0].bookmakerOdds["betano.pt"].markets["91001"]
      .outcomes["92002"];
  }),null);
  assert.equal(freeze(input=>{
    input.leagueOdds[0].bookmakerOdds["betano.pt"].markets["91001"]
      .outcomes["99999"]={players:{}};
  }),null);
  assert.equal(freeze(input=>{
    input.catalogue[0].outcomes[1].outcomeName="Over";
  }),null);
});

test("D15.27 provider player identity is exact, never inferred from another quoted player",()=>{
  assert.equal(freeze(input=>{input.providerPlayerId="93002";}),null);
  assert.equal(freeze(input=>{input.providerPlayerId="fake";}),null);
  assert.equal(freeze(input=>{
    input.leagueOdds[0].bookmakerOdds["betano.pt"].markets["91001"]
      .outcomes["92002"].players["93001"].playerName="Other Athlete";
  }),null);
});

test("D15.27 preserve stale provider quotes but mark stale; no promotion",()=>{
  const value=freeze(input=>{
    for(const outcome of Object.values(
      input.leagueOdds[0].bookmakerOdds["betano.pt"].markets["91001"].outcomes))
      outcome.players["93001"].changedAt=iso(-60);
  });
  assertUnapproved(value);
  assert.equal(value.freshness,"STALE_PROVIDER_TIMESTAMP");
  assert.equal(value.outcomes.Over.changedAt,iso(-60));
});

test("D15.27 invalid, nonnumeric and future provider quote values reject",()=>{
  for(const value of [1,0,-1,NaN,Infinity,"1.88",null]){
    assert.equal(freeze(input=>{
      input.leagueOdds[0].bookmakerOdds["betano.pt"].markets["91001"]
        .outcomes["92001"].players["93001"].price=value;
    }),null);
  }
  for(const changedAt of ["bad",null,iso(4)]){
    assert.equal(freeze(input=>{
      input.leagueOdds[0].bookmakerOdds["betano.pt"].markets["91001"]
        .outcomes["92001"].players["93001"].changedAt=changedAt;
    }),null);
  }
});

test("D15.27 conflicting or explicit main flags are evidence only, never a selection",()=>{
  const both=freeze(input=>{
    for(const outcome of Object.values(
      input.leagueOdds[0].bookmakerOdds["betano.pt"].markets["91001"].outcomes))
      outcome.players["93001"].mainLine=true;
  });
  assertUnapproved(both);
  assert.equal(both.mainLineEvidence,"BOTH_EXPLICIT_FLAGS_UNVERIFIED");
  const conflict=freeze(input=>{
    input.leagueOdds[0].bookmakerOdds["betano.pt"].markets["91001"]
      .outcomes["92001"].players["93001"].mainLine=true;
  });
  assertUnapproved(conflict);
  assert.equal(conflict.mainLineEvidence,"CONFLICTING_FLAGS");
  const missing=freeze(input=>{
    delete input.leagueOdds[0].bookmakerOdds["betano.pt"].markets["91001"]
      .outcomes["92001"].players["93001"].mainLine;
  });
  assertUnapproved(missing);
  assert.equal(missing.outcomes.Over.mainLineFlag,null);
});

test("D15.27 receipt is only source metadata, never an authenticated permission",()=>{
  assert.equal(freeze(input=>input.snapshotReference="fabricated"),null);
  assert.equal(freeze(input=>input.capturedAt=iso(1)),null);
  assert.equal(freeze(input=>input.capturedAt=iso(-6)),null);
  assert.equal(freeze(input=>input.now=NaN),null);
  assert.equal(freeze(input=>input.extraBrowserClaim={owner:true}),null);
  assert.equal(freezeUnreviewedProviderPlayerPair(),null);
});

test("D15.27 bounded fixture/market inputs and accessor traps fail closed",()=>{
  assert.equal(freeze(input=>input.leagueOdds=Array(251).fill({})),null);
  assert.equal(freeze(input=>{
    input.leagueOdds[0].bookmakerOdds["betano.pt"].markets=
      Object.fromEntries(Array.from({length:18001},(_,i)=>[String(i),{}]));
  }),null);
  assert.equal(freeze(input=>{
    Object.defineProperty(input.leagueOdds[0],"bookmakerOdds",{get(){throw Error("PRIVATE");}});
  }),null);
});

test("D15.27 no production import, persistence, external requests, or polling",()=>{
  const prod=fs.readFileSync(path.join(__dirname,"index.js"),"utf8");
  const moduleSource=fs.readFileSync(path.join(__dirname,"provider-player-quote-snapshot.js"),"utf8");
  assert.doesNotMatch(prod,/provider-player-quote-snapshot|freezeUnreviewedProviderPlayerPair/);
  assert.doesNotMatch(moduleSource,/require\(["'](?:firebase-admin|firebase-functions|https?|node:https?)["']\)/);
  assert.doesNotMatch(moduleSource,/(?:fetch|setInterval|onCall|onSchedule)\s*\(/);
  assert.doesNotMatch(moduleSource,/(?:\.set|\.update|\.create|\.delete)\s*\(/);
});
