"use strict";

// Update 34.6E: purely deterministic checks for official NBA inactive evidence.
// ESPN remains the primary source for scored results and Final identity.
// This module never performs network requests or Firestore writes.
const TEAM_CODES = Object.freeze({
  "Atlanta Hawks":"ATL","Boston Celtics":"BOS","Brooklyn Nets":"BKN",
  "Charlotte Hornets":"CHA","Chicago Bulls":"CHI","Cleveland Cavaliers":"CLE",
  "Dallas Mavericks":"DAL","Denver Nuggets":"DEN","Detroit Pistons":"DET",
  "Golden State Warriors":"GSW","Houston Rockets":"HOU","Indiana Pacers":"IND",
  "LA Clippers":"LAC","Los Angeles Clippers":"LAC","Los Angeles Lakers":"LAL",
  "Memphis Grizzlies":"MEM","Miami Heat":"MIA","Milwaukee Bucks":"MIL",
  "Minnesota Timberwolves":"MIN","New Orleans Pelicans":"NOP",
  "New York Knicks":"NYK","Oklahoma City Thunder":"OKC",
  "Orlando Magic":"ORL","Philadelphia 76ers":"PHI","Phoenix Suns":"PHX",
  "Portland Trail Blazers":"POR","Sacramento Kings":"SAC",
  "San Antonio Spurs":"SAS","Toronto Raptors":"TOR","Utah Jazz":"UTA",
  "Washington Wizards":"WAS"
});
const MAX_START_DIFFERENCE_MS = 120000;
function nameKey(text) {
  return typeof text==="string" ? text.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g,"").toLowerCase()
    .replace(/[^a-z0-9]+/g," ").trim() : "";
}
function usGameDate(ms) {
  if (!Number.isSafeInteger(ms)) return null;
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(new Date(ms));
  const pick=k=>parts.find(x=>x.type===k)?.value;
  return pick("year")+"-"+pick("month")+"-"+pick("day");
}
function nbaCode(text) {
  return Object.hasOwn(TEAM_CODES,text) ? TEAM_CODES[text] : null;
}
// Resolve game IDs ONLY from NBA's game-specific official schedule, never
// by guessing from an ESPN event number, from a search hit or a date alone.
function resolveGame(schedule, entry) {
  const home=nbaCode(entry?.home),away=nbaCode(entry?.away),
    team=nbaCode(entry?.team),ms=entry?.eventStartMs;
  if(!home||!away||home===away||!team||![home,away].includes(team)||
      !Number.isSafeInteger(ms))return null;
  const dates=schedule?.leagueSchedule?.gameDates;
  if(!Array.isArray(dates)||dates.length<1||dates.length>450)return null;
  const matches=[];
  for(const date of dates){
    if(!Array.isArray(date?.games))return null;
    for(const game of date.games){
      const id=String(game?.gameId||"");
      if(!/^002\d{7}$/.test(id)||
         String(game?.homeTeam?.teamTricode)!==home||
         String(game?.awayTeam?.teamTricode)!==away)continue;
      const start=Date.parse(game?.gameDateTimeUTC||"");
      if(!Number.isFinite(start)||Math.abs(start-ms)>MAX_START_DIFFERENCE_MS)
        continue;
      const homeId=String(game?.homeTeam?.teamId||"");
      const awayId=String(game?.awayTeam?.teamId||"");
      if(!/^\d{8,12}$/.test(homeId)||!/^\d{8,12}$/.test(awayId)||homeId===awayId)
        return null;
      matches.push({gameId:id,homeId,awayId,homeCode:home,awayCode:away,
        teamCode:team,teamId:team===home?homeId:awayId,expectedUsDate:usGameDate(ms)});
    }
  }
  return matches.length===1?matches[0]:null;
}
function rowsOf(resultSets,name,requiredColumns) {
  if(!Array.isArray(resultSets))return null;
  const sets=resultSets.filter(s=>s?.name===name);
  if(sets.length!==1||!Array.isArray(sets[0].headers)||!Array.isArray(sets[0].rowSet))
    return null;
  const headers=sets[0].headers;
  if(new Set(headers).size!==headers.length ||
      requiredColumns.some(c=>!headers.includes(c))||
      sets[0].rowSet.length>400)return null;
  const out=[];
  for(const vals of sets[0].rowSet){
    if(!Array.isArray(vals)||vals.length!==headers.length)return null;
    out.push(Object.fromEntries(headers.map((h,i)=>[h,vals[i]])));
  }
  return out;
}
// This endpoint's InactivePlayers result set explicitly records nonparticipation.
// Missing rows / mismatched teams / partial data NEVER imply nonparticipation.
function verifyInactive(summary, game, entry) {
  if(!game||!entry||!summary||!Array.isArray(summary.resultSets))return null;
  const meta=rowsOf(summary.resultSets,"GameSummary",
    ["GAME_ID","GAME_STATUS_ID","GAME_DATE_EST","HOME_TEAM_ID","VISITOR_TEAM_ID"]);
  const inactive=rowsOf(summary.resultSets,"InactivePlayers",
    ["PLAYER_ID","FIRST_NAME","LAST_NAME","TEAM_ID","TEAM_ABBREVIATION"]);
  if(!meta||meta.length!==1||!inactive)return null;
  const m=meta[0];
  if(String(m.GAME_ID)!==game.gameId||Number(m.GAME_STATUS_ID)!==3||
     String(m.HOME_TEAM_ID)!==game.homeId||
     String(m.VISITOR_TEAM_ID)!==game.awayId||
     typeof m.GAME_DATE_EST!=="string"||
     m.GAME_DATE_EST.slice(0,10)!==game.expectedUsDate)return null;
  const target=nameKey(entry.player);
  if(!target||target.length<5)return null;
  const rows=inactive.filter(p=>
    String(p.TEAM_ID)===game.teamId &&
    String(p.TEAM_ABBREVIATION)===game.teamCode &&
    nameKey(String(p.FIRST_NAME||"")+" "+String(p.LAST_NAME||""))===target);
  if(rows.length!==1||!/^[0-9]{1,12}$/.test(String(rows[0].PLAYER_ID||"")))
    return null;
  // Require the exact team to be present only once in the inactive list.
  // A name collision across teams or duplicate player rows cannot certify DNP.
  const repeated=inactive.filter(p=>String(p.PLAYER_ID)===String(rows[0].PLAYER_ID));
  if(repeated.length!==1)return null;
  return {kind:"dnp",reason:"NBA_OFFICIAL_INACTIVE",
    nbaGameId:game.gameId,nbaPlayerId:String(rows[0].PLAYER_ID)};
}
module.exports={nbaCode,nameKey,usGameDate,resolveGame,verifyInactive};
