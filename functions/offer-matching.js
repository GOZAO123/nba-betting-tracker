"use strict";

// Update 35.1D1: OFFLINE candidate matching gate. NOT a capture/settlement path.
// Its callers must supply independently obtained and validated ESPN evidence;
// these input assertions alone cannot authenticate a real ESPN identity.
// No raw provider odds, personal names, market IDs or credentials are returned.
const { officialCatalogueMap } = require("./league-market-audit");
const FAMILIES = Object.freeze(["PTS", "REB", "AST", "3PT", "PR", "PA", "RA", "PRA"]);
const FUTURE_MS = 72 * 60 * 60 * 1000;
const FRESH_MS = 15 * 60 * 1000;
const SAME_EVENT_MS = 5 * 60 * 1000;
const MAX_MARKET_OBJECTS = 18000;
const id = x => (typeof x === "string" || typeof x === "number") &&
  /^[1-9][0-9]{0,15}$/.test(String(x)) ? String(x) : null;
const obj = x => x !== null && typeof x === "object" && !Array.isArray(x);
const iso = x => typeof x === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) &&
  Number.isFinite(Date.parse(x)) ? Date.parse(x) : NaN;
const name = x => typeof x === "string" && x.trim().length > 0 &&
  x.length <= 100 && !/[\u0000-\u001f\u007f]/.test(x) ?
  x.trim().normalize("NFC").replace(/\s+/gu, " ") : null;
const emptyFamily = market => ({market, pairedLines: 0, freshPairs: 0,
  stalePairs: 0, explicitMainPairs: 0, decision: "NO_VALID_PAIR"});
function report(status) {
  return { status, eventMatched: false, athleteMatch: "NOT_VERIFIED",
    bookmakerVerified: false, autoLineSelected: false, captureAllowed: false,
    families: FAMILIES.map(emptyFamily) };
}

function checkedEvent(fixture, espnEvent, teamBridge, rosters, now) {
  if (!obj(fixture) || !obj(espnEvent) || !Array.isArray(teamBridge) ||
      !Array.isArray(rosters) || !Number.isFinite(now)) return null;
  if (!fixture.fixtureId || typeof fixture.fixtureId !== "string" ||
      Number(fixture.sportId) !== 11 || Number(fixture.tournamentId) !== 132 ||
      fixture.statusId !== 0 || fixture.hasOdds !== true ||
      !id(fixture.participant1Id) || !id(fixture.participant2Id) ||
      String(fixture.participant1Id) === String(fixture.participant2Id)) return null;
  const start = iso(fixture.startTime), espnStart = iso(espnEvent.startTime);
  if (!Number.isFinite(start) || !Number.isFinite(espnStart) ||
      start <= now + 5 * 60000 || start > now + FUTURE_MS ||
      Math.abs(start - espnStart) > SAME_EVENT_MS ||
      !id(espnEvent.eventId) || espnEvent.status !== "STATUS_SCHEDULED" ||
      !id(espnEvent.homeTeamId) || !id(espnEvent.awayTeamId) ||
      String(espnEvent.homeTeamId) === String(espnEvent.awayTeamId)) return null;
  // A bridge is an *assertion* supplied by future trusted server-side adapters,
  // never by the client. Both provider participants and both ESPN teams must agree.
  if (teamBridge.length !== 2 || rosters.length !== 2) return null;
  const providerTeams = new Set(), espnTeams = new Set();
  for (const bridge of teamBridge) {
    const p = id(bridge?.providerParticipantId), e = id(bridge?.espnTeamId);
    if (!p || !e || providerTeams.has(p) || espnTeams.has(e)) return null;
    providerTeams.add(p); espnTeams.add(e);
  }
  if (![fixture.participant1Id,fixture.participant2Id].every(x=>providerTeams.has(String(x))) ||
      ![espnEvent.homeTeamId,espnEvent.awayTeamId].every(x=>espnTeams.has(String(x)))) return null;
  const athleteRows = [], seenIds = new Set(), rosterTeams = new Set();
  for (const roster of rosters) {
    const team = id(roster?.teamId);
    if (!team || !espnTeams.has(team) || rosterTeams.has(team) ||
        !Array.isArray(roster.athletes) || roster.athletes.length > 30 ||
        roster.athletes.length === 0) return null;
    rosterTeams.add(team);
    for (const athlete of roster.athletes) {
      const athleteId = id(athlete?.id), display = name(athlete?.displayName);
      if (!athleteId || !display || seenIds.has(athleteId)) return null;
      seenIds.add(athleteId); athleteRows.push({team, id: athleteId, display});
    }
  }
  return {athleteRows};
}

function inspectOfflineNbaOffers({ catalogue, fixture, espnEvent, teamBridge, rosters,
  providerPlayerId, reviewedAthleteBridge = null, now } = {}) {
  const result = report("INVALID_INPUT");
  const playerId = id(providerPlayerId);
  if (!playerId || !Number.isFinite(now)) return result;
  const checked = checkedEvent(fixture, espnEvent, teamBridge, rosters, now);
  if (!checked) { result.status = "EVENT_OR_ESPN_EVIDENCE_UNVERIFIED"; return result; }
  const book = fixture.bookmakerOdds?.["betano.pt"];
  if (!obj(book) || book.bookmakerIsActive !== true || book.suspended === true ||
      !obj(book.markets)) { result.status = "BOOKMAKER_NOT_ACTIVE"; return result; }
  const marketEntries = Object.entries(book.markets);
  if (marketEntries.length > MAX_MARKET_OBJECTS) return result;
  let mapped;
  try { mapped = officialCatalogueMap(catalogue).mapped; }
  catch (_) { result.status = "CATALOGUE_UNVERIFIED"; return result; }
  result.eventMatched = true;
  const grouped = new Map(FAMILIES.map(market => [market, new Map()]));
  const providerNames = new Set();
  for (const [marketId, market] of marketEntries) {
    const meta = id(marketId) && mapped.get(String(marketId));
    if (!meta || !obj(market) || market.marketActive !== true ||
        !obj(market.outcomes) || !Number.isFinite(meta.line)) continue;
    // The complete exact Over/Under outcome pair is required; unknown outcomes
    // are not treated as equivalent to either side.
    const sides = [...meta.outcomeSides.entries()];
    if (sides.length !== 2 || Object.keys(market.outcomes).length !== 2 ||
        !sides.every(([outcomeId]) => Object.hasOwn(market.outcomes, outcomeId))) continue;
    const overId = sides.find(x => x[1] === "Over")?.[0];
    const underId = sides.find(x => x[1] === "Under")?.[0];
    if (!overId || !underId) continue;
    const over = market.outcomes[overId]?.players?.[playerId];
    const under = market.outcomes[underId]?.players?.[playerId];
    if (![over,under].every(x => obj(x) && x.active === true &&
        typeof x.price === "number" && Number.isFinite(x.price) &&
        x.price > 1 && x.price <= 1000 && name(x.playerName))) continue;
    const overName = name(over.playerName), underName = name(under.playerName);
    if (overName !== underName) { result.status = "PROVIDER_PLAYER_NAME_CONFLICT"; return result; }
    const stamps = [iso(over.changedAt),iso(under.changedAt)];
    if (!stamps.every(x => Number.isFinite(x) && x <= now + 2 * 60000)) continue;
    providerNames.add(overName);
    const fresh = stamps.every(x => now - x <= FRESH_MS);
    const main = over.mainLine === true && under.mainLine === true;
    const key = meta.line.toFixed(1);
    const marketLines = grouped.get(meta.family);
    if (!marketLines.has(key)) marketLines.set(key, []);
    marketLines.get(key).push({fresh,main});
  }
  if (providerNames.size > 1) { result.status = "PROVIDER_PLAYER_NAME_CONFLICT"; return result; }
  if (providerNames.size === 0) { result.status = "NO_VALID_PROVIDER_PLAYER_PAIR"; return result; }
  const [providerName] = providerNames;
  const matching = checked.athleteRows.filter(x => x.display === providerName);
  if (matching.length !== 1) {
    result.status = matching.length ? "AMBIGUOUS_ESPN_NAME" : "ESPN_NAME_NOT_CONFIRMED";
    return result;
  }
  if (reviewedAthleteBridge !== null) {
    if (!obj(reviewedAthleteBridge) || id(reviewedAthleteBridge.providerPlayerId) !== playerId ||
        id(reviewedAthleteBridge.espnAthleteId) !== matching[0].id ||
        id(reviewedAthleteBridge.espnTeamId) !== matching[0].team) {
      result.status = "REVIEWED_ATHLETE_BRIDGE_CONFLICT"; return result;
    }
    result.athleteMatch = "REVIEW_ASSERTION_ONLY";
  } else result.athleteMatch = "EXACT_NAME_ONLY_NOT_VERIFIED";
  result.status = "REVIEW_CANDIDATES_ONLY";
  result.families = FAMILIES.map(market => {
    const data = grouped.get(market);
    const rows = [...data.values()].flat();
    const fresh = rows.filter(x => x.fresh);
    const flagged = fresh.filter(x => x.main);
    const duplicateLine = [...data.values()].some(x => x.length > 1);
    let decision = "NO_VALID_PAIR";
    if (duplicateLine) decision = "AMBIGUOUS_DUPLICATE_LINE";
    else if (fresh.length === 0 && rows.length) decision = "STALE_ONLY";
    else if (flagged.length > 1) decision = "MULTIPLE_EXPLICIT_MAIN_LINES";
    else if (flagged.length === 1) decision = "EXPLICIT_MAIN_LINE_REVIEW_REQUIRED";
    else if (fresh.length) decision = "NO_EXPLICIT_MAIN_LINE";
    return {market, pairedLines: rows.length, freshPairs: fresh.length,
      stalePairs: rows.length - fresh.length, explicitMainPairs: flagged.length, decision};
  });
  // Always false: neither input ESPN proof nor OddsPapi prices can independently
  // establish a real bookmaker offer or authorize secure backend capture.
  return result;
}

module.exports = { inspectOfflineNbaOffers };