"use strict";

// Update 35.1D2 — read-only, backend-injected ESPN evidence adapter.
// No live callable, no network client, no Firestore, no capture or line selection.
// Never accept ESPN event/roster/participant-bridge proofs from an offer request.
// Future trusted backend wiring MUST supply fetchEspn and reviewed bridge itself.
const { inspectOfflineNbaOffers } = require("./offer-matching");

const DAY_MS = 86400000, MIN_MS = 60000;
const HORIZON_MS = 72 * 60 * MIN_MS, START_TOLERANCE_MS = 5 * MIN_MS;
const MAX_EVENTS = 40, MAX_ROSTER = 30, MAX_MARKETS = 18000, MAX_CATALOGUE = 250000;
const id = x => (typeof x === "string" || typeof x === "number") &&
  /^[1-9][0-9]{0,15}$/.test(String(x)) ? String(x) : null;
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const timestamp = x => typeof x === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) &&
  Number.isFinite(Date.parse(x)) ? Date.parse(x) : NaN;
const safeName = x => typeof x === "string" && x.trim().length &&
  x.length <= 100 && !/[\u0000-\u001f\u007f]/.test(x) ?
  x.trim().normalize("NFC").replace(/\s+/gu, " ") : null;
const teamNameKey = x => safeName(x)?.toLowerCase() || null;
function fail(status) {
  const result = inspectOfflineNbaOffers();
  result.status = status;
  return result;
}
function nbaScoreboardDay(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(ms));
  const value = part => parts.find(p => p.type === part)?.value;
  return value("year") + value("month") + value("day");
}
function checkedProviderFixture(fixture, now) {
  if (!object(fixture) || typeof fixture.fixtureId !== "string" || !fixture.fixtureId ||
      fixture.fixtureId.length > 120 || Number(fixture.sportId) !== 11 ||
      Number(fixture.tournamentId) !== 132 || fixture.statusId !== 0 ||
      fixture.hasOdds !== true || !id(fixture.participant1Id) ||
      !id(fixture.participant2Id) ||
      id(fixture.participant1Id) === id(fixture.participant2Id) ||
      !Number.isSafeInteger(now)) return null;
  const start = timestamp(fixture.startTime), book = fixture.bookmakerOdds?.["betano.pt"];
  if (!Number.isFinite(start) || start <= now + 5 * MIN_MS ||
      start > now + HORIZON_MS || !object(book) ||
      book.bookmakerIsActive !== true || book.suspended === true ||
      !object(book.markets) || Object.keys(book.markets).length > MAX_MARKETS) return null;
  return { start, participants: [id(fixture.participant1Id), id(fixture.participant2Id)] };
}
function checkedReviewedBridge(bridge, participants) {
  if (!Array.isArray(bridge) || bridge.length !== 2) return null;
  const byProvider = new Map(), espnTeams = new Set();
  for (const entry of bridge) {
    const p = id(entry?.providerParticipantId), e = id(entry?.espnTeamId);
    if (!p || !e || byProvider.has(p) || espnTeams.has(e)) return null;
    byProvider.set(p, e); espnTeams.add(e);
  }
  if (!participants.every(p => byProvider.has(p)) || espnTeams.size !== 2) return null;
  return participants.map(providerParticipantId => ({
    providerParticipantId, espnTeamId: byProvider.get(providerParticipantId)
  }));
}
function findUniqueScheduledEspnGame(board, start, bridge) {
  if (!Array.isArray(board?.events) || board.events.length > MAX_EVENTS) return null;
  const requested = new Set(bridge.map(b => b.espnTeamId)), found = [];
  for (const game of board.events) {
    if (!id(game?.id) || !Number.isFinite(timestamp(game?.date)) ||
        Math.abs(timestamp(game.date) - start) > START_TOLERANCE_MS ||
        game.status?.type?.state !== "pre" || Number(game.season?.type) !== 2 ||
        !Array.isArray(game.competitions) || game.competitions.length !== 1) continue;
    const comp = game.competitions[0];
    if (!Array.isArray(comp?.competitors) || comp.competitors.length !== 2) continue;
    if (comp.date != null &&
        (!Number.isFinite(timestamp(comp.date)) ||
         Math.abs(timestamp(comp.date) - timestamp(game.date)) > 2 * MIN_MS)) continue;
    const home = comp.competitors.find(c => c.homeAway === "home");
    const away = comp.competitors.find(c => c.homeAway === "away");
    if (!home || !away || home === away || comp.competitors.filter(c =>
        c.homeAway === "home").length !== 1 || comp.competitors.filter(c =>
        c.homeAway === "away").length !== 1) continue;
    const homeId = id(home.team?.id), awayId = id(away.team?.id);
    if (!homeId || !awayId || homeId === awayId ||
        !requested.has(homeId) || !requested.has(awayId) ||
        !safeName(home.team?.displayName) || !safeName(away.team?.displayName)) continue;
    found.push({
      eventId: id(game.id), startTime: game.date,
      status: "STATUS_SCHEDULED", homeTeamId: homeId, awayTeamId: awayId,
      names: new Map([[homeId,home.team.displayName],[awayId,away.team.displayName]])
    });
  }
  return found.length === 1 ? found[0] : null;
}
function checkedEspnRoster(roster, teamId, expectedTeamName) {
  if (!object(roster) || id(roster.team?.id) !== teamId ||
      teamNameKey(roster.team?.displayName) !== teamNameKey(expectedTeamName) ||
      !Array.isArray(roster.athletes)) return null;
  const athletes = [];
  for (const group of roster.athletes) {
    if (!object(group)) return null;
    const members = Array.isArray(group.items) ? group.items : [group];
    if (athletes.length + members.length > MAX_ROSTER) return null;
    for (const athlete of members) {
      const athleteId = id(athlete?.id), displayName = safeName(athlete?.displayName);
      if (!athleteId || !displayName) return null;
      athletes.push({id: athleteId,displayName});
    }
  }
  if (athletes.length === 0 ||
      new Set(athletes.map(a => a.id)).size !== athletes.length) return null;
  return {teamId, athletes};
}

// This module never fetches ESPN itself: the future owner-only backend supplies
// fetchEspn(path) using its existing fixed-host ledgerGetEspn transport.
// getReviewedTeamBridge is a SERVER-OWNED reviewed crosswalk, not a browser field.
// Both dependencies are injected for deterministic, zero-network tests.
async function inspectWithServerEspnEvidence(input, dependencies) {
  if (!object(input) || !object(dependencies) ||
      Object.keys(input).sort().join(",") !== "catalogue,fixture,providerPlayerId" ||
      typeof dependencies.fetchEspn !== "function" ||
      typeof dependencies.getReviewedTeamBridge !== "function") return fail("INVALID_INPUT");
  const now = dependencies.now, fixture = input.fixture;
  const checked = checkedProviderFixture(fixture, now);
  if (!checked || !id(input.providerPlayerId)) return fail("INVALID_PROVIDER_FIXTURE");
  const definitions = Array.isArray(input.catalogue) ? input.catalogue :
    Array.isArray(input.catalogue?.data) ? input.catalogue.data : null;
  if (!definitions || definitions.length > MAX_CATALOGUE)
    return fail("INVALID_PROVIDER_CATALOGUE");
  let bridge;
  try {
    bridge = checkedReviewedBridge(await dependencies.getReviewedTeamBridge(
      Object.freeze({fixtureId:fixture.fixtureId,
        participant1Id:checked.participants[0],participant2Id:checked.participants[1],
        startTime:fixture.startTime})
    ), checked.participants);
  } catch (_) { return fail("REVIEWED_TEAM_BRIDGE_UNAVAILABLE"); }
  if (!bridge) return fail("REVIEWED_TEAM_BRIDGE_UNAVAILABLE");

  // A single deterministic ESPN calendar day is derived from the PROVIDER
  // start in New York time. No browser-supplied ESPN event ID can override it.
  let scoreboard;
  try {
    scoreboard = await dependencies.fetchEspn("scoreboard?dates=" +
      nbaScoreboardDay(checked.start));
  } catch (_) { return fail("ESPN_SCOREBOARD_UNAVAILABLE"); }
  const game = findUniqueScheduledEspnGame(scoreboard, checked.start, bridge);
  if (!game) return fail("ESPN_EVENT_NOT_UNIQUELY_VERIFIED");

  // Strictly sequential and bounded: at most one scoreboard + two roster reads.
  // On a broken/ambiguous first roster, never request the second roster.
  const rosters = [];
  for (const teamId of [game.homeTeamId,game.awayTeamId]) {
    let roster;
    try { roster = await dependencies.fetchEspn("teams/" + teamId + "/roster"); }
    catch (_) { return fail("ESPN_ROSTER_UNAVAILABLE"); }
    const checkedRoster = checkedEspnRoster(roster, teamId, game.names.get(teamId));
    if (!checkedRoster) return fail("ESPN_ROSTER_UNVERIFIED");
    rosters.push(checkedRoster);
  }
  if (new Set(rosters.flatMap(r => r.athletes.map(a => a.id))).size !==
      rosters.reduce((n,r) => n + r.athletes.length,0))
    return fail("ESPN_ROSTER_UNVERIFIED");

  try {
    return inspectOfflineNbaOffers({
      catalogue: input.catalogue, fixture, providerPlayerId: input.providerPlayerId,
      espnEvent: {eventId:game.eventId,startTime:game.startTime,status:game.status,
        homeTeamId:game.homeTeamId,awayTeamId:game.awayTeamId},
      teamBridge:bridge, rosters, now
    });
  } catch (_) { return fail("INSPECTION_UNAVAILABLE"); }
}

module.exports = { inspectWithServerEspnEvidence };
