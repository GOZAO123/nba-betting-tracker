"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {resolveGame,verifyInactive}=require("./nba-inactive");

const start=Date.parse("2026-11-12T00:00:00Z");
const entry={
  eventId:"401909968",eventStartMs:start,home:"Toronto Raptors",
  away:"Boston Celtics",team:"Boston Celtics",player:"Paul George"
};
const schedule={leagueSchedule:{gameDates:[{games:[{
  gameId:"0022600219",gameDateTimeUTC:"2026-11-12T00:00:00Z",
  homeTeam:{teamId:1610612761,teamTricode:"TOR"},
  awayTeam:{teamId:1610612738,teamTricode:"BOS"}
}]}]}};
function summary(overrides={}){
 const meta={
  GAME_ID:"0022600219",GAME_STATUS_ID:3,
  GAME_DATE_EST:"2026-11-11T00:00:00",HOME_TEAM_ID:1610612761,
  VISITOR_TEAM_ID:1610612738,...overrides
 };
 return {resultSets:[
  {name:"GameSummary",headers:Object.keys(meta),rowSet:[Object.values(meta)]},
  {name:"InactivePlayers",headers:[
    "PLAYER_ID","FIRST_NAME","LAST_NAME","TEAM_ID","TEAM_ABBREVIATION"
  ],rowSet:[[202331,"Paul","George",1610612738,"BOS"]]}
 ]};
}
test("match NBA game by exact independent date, home/away names and UTC tip-off",()=>{
 const g=resolveGame(schedule,entry);
 assert.deepEqual(g,{
  gameId:"0022600219",homeId:"1610612761",awayId:"1610612738",
  homeCode:"TOR",awayCode:"BOS",teamCode:"BOS",teamId:"1610612738",
  expectedUsDate:"2026-11-11"
 });
 assert.equal(resolveGame(schedule,{...entry,team:"Unknown Team"}),null);
 assert.equal(resolveGame(schedule,{...entry,home:"Boston Celtics"}),null);
 assert.equal(resolveGame(schedule,{...entry,eventStartMs:start+3*60000}),null);
 assert.equal(resolveGame({leagueSchedule:{gameDates:[]}},entry),null);
});
test("official NBA inactive dataset must explicitly list correct unique player",()=>{
 const g=resolveGame(schedule,entry);
 assert.deepEqual(verifyInactive(summary(),g,entry),{
  kind:"dnp",reason:"NBA_OFFICIAL_INACTIVE",
  nbaGameId:"0022600219",nbaPlayerId:"202331"
 });
 assert.equal(verifyInactive(summary(),g,{...entry,player:"Different Player"}),null);
 assert.equal(verifyInactive(summary(),g,{...entry,player:"George Paul"}),null);
});
test("never accept wrong game, wrong team or non-final NBA summary",()=>{
 const g=resolveGame(schedule,entry);
 for(const changes of [
  {GAME_ID:"0022600220"},{GAME_STATUS_ID:2},
  {GAME_DATE_EST:"2026-11-10T00:00:00"},
  {HOME_TEAM_ID:1610612738},{VISITOR_TEAM_ID:1610612761}
 ])assert.equal(verifyInactive(summary(changes),g,entry),null);
});
test("missing or ambiguous inactive information fails closed",()=>{
 const g=resolveGame(schedule,entry),s=summary();
 assert.equal(verifyInactive({...s,resultSets:s.resultSets.slice(0,1)},g,entry),null);
 const wrongTeam=structuredClone(s);
 wrongTeam.resultSets[1].rowSet[0][3]=1610612761;
 assert.equal(verifyInactive(wrongTeam,g,entry),null);
 const wrongCode=structuredClone(s);
 wrongCode.resultSets[1].rowSet[0][4]="TOR";
 assert.equal(verifyInactive(wrongCode,g,entry),null);
 const collision=structuredClone(s);
 collision.resultSets[1].rowSet.push([...collision.resultSets[1].rowSet[0]]);
 assert.equal(verifyInactive(collision,g,entry),null);
});
test("schedule duplicate or bad game IDs are never guessed",()=>{
 assert.equal(resolveGame({leagueSchedule:{gameDates:[
  ...schedule.leagueSchedule.gameDates,...schedule.leagueSchedule.gameDates
 ]}},entry),null);
 const invalid=structuredClone(schedule);
 invalid.leagueSchedule.gameDates[0].games[0].gameId="401909968";
 assert.equal(resolveGame(invalid,entry),null);
 const wrong=structuredClone(schedule);
 wrong.leagueSchedule.gameDates[0].games[0].awayTeam.teamTricode="PHI";
 assert.equal(resolveGame(wrong,entry),null);
});
test("NBA missing structure or malformed rows cannot certify inactivity",()=>{
 const g=resolveGame(schedule,entry);
 assert.equal(verifyInactive({},g,entry),null);
 const s=summary();
 s.resultSets[1].headers.push("UNKNOWN");
 assert.equal(verifyInactive(s,g,entry),null);
});
