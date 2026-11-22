"use strict";

// Update 35.1D15.27 — OFFLINE ONLY. Preserve one original OddsPapi-reported
// Betano PT player Over/Under pair as an unreviewed, immutable backend value.
// NO HTTP, Firebase, ledger write, player-ID approval or automatic line choice.
// Caller MUST supply backend-fetched provider payload and authenticated receipt.
const { createHash } = require("node:crypto");
const { officialCatalogueMap } = require("./league-market-audit");

const SOURCE = "ODDSPAPI_V4_ODDS_BY_TOURNAMENTS";
const MAX_FIXTURES = 250, MAX_MARKETS = 18000;
const MINUTE = 60000, MAX_RECEIPT_AGE = 5 * MINUTE;
const MAX_HORIZON = 72 * 60 * MINUTE, FRESH_FOR = 15 * MINUTE;
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const identifier = x => (typeof x === "string" || typeof x === "number") &&
  /^[1-9][0-9]{0,15}$/.test(String(x)) ? String(x) : null;
const fixtureId = x => typeof x === "string" &&
  /^[A-Za-z0-9._:-]{1,120}$/.test(x) ? x : null;
const reference = x => typeof x === "string" &&
  /^ODDSPAPI_MANUAL_[A-F0-9]{32}$/.test(x);
const timestamp = x => typeof x === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) &&
  Number.isFinite(Date.parse(x)) ? Date.parse(x) : NaN;
const validName = x => typeof x === "string" && x.trim() !== "" &&
  x.length <= 100 && !/[\u0000-\u001f\u007f]/.test(x);
const quotePrice = x => typeof x === "number" && Number.isFinite(x) &&
  x > 1 && x <= 1000;
const quoteFlag = x => x === true || x === false || x === undefined ?
  (x === undefined ? null : x) : undefined;
const leagueFixtures = x => Array.isArray(x) ? x :
  Array.isArray(x?.data) ? x.data : Array.isArray(x?.fixtures) ? x.fixtures : null;

// Returns null on any ambiguity or invalid input. A successful return is NOT
// authorisation to capture or to represent a direct Betano bookmaker offer.
// The SHA-256 digest detects later alterations; it is not a signature or proof
// of the authenticity of data passed into this offline function.
function freezeUnreviewedProviderPlayerPair(input = {}) {
  try {
    if (!object(input) ||
        Object.keys(input).sort().join("|") !== [
          "capturedAt","catalogue","fixtureId","leagueOdds",
          "marketId","now","providerPlayerId","snapshotReference"
        ].join("|")) return null;
    const { catalogue, leagueOdds, now, capturedAt, snapshotReference } = input;
    const wantedFixture = fixtureId(input.fixtureId);
    const playerId = identifier(input.providerPlayerId);
    const wantedMarketId = identifier(input.marketId);
    const captured = timestamp(capturedAt);
    const fixtures = leagueFixtures(leagueOdds);
    if (!wantedFixture || !playerId || !wantedMarketId ||
        !reference(snapshotReference) || !Number.isSafeInteger(now) ||
        !Number.isFinite(captured) || captured > now ||
        now - captured > MAX_RECEIPT_AGE || !fixtures ||
        fixtures.length > MAX_FIXTURES) return null;

    // A repeated fixture must be quarantined, even if the duplicates match.
    const matches = fixtures.filter(f => object(f) && f.fixtureId === wantedFixture);
    if (matches.length !== 1) return null;
    const fixture = matches[0];
    const start = timestamp(fixture.startTime);
    if (Number(fixture.sportId) !== 11 || Number(fixture.tournamentId) !== 132 ||
        fixture.statusId !== 0 || fixture.hasOdds !== true ||
        !identifier(fixture.participant1Id) ||
        !identifier(fixture.participant2Id) ||
        String(fixture.participant1Id) === String(fixture.participant2Id) ||
        !Number.isFinite(start) || start <= now + 5 * MINUTE ||
        start > now + MAX_HORIZON) return null;

    const book = fixture.bookmakerOdds?.["betano.pt"];
    if (!object(book) || book.bookmakerIsActive !== true ||
        book.suspended === true || !object(book.markets)) return null;
    const marketEntries = Object.entries(book.markets);
    if (marketEntries.length > MAX_MARKETS) return null;

    // Reuse the authoritative all-family market/OT/half-line/duplicate-ID gate.
    const mapped = officialCatalogueMap(catalogue).mapped;
    const definition = mapped.get(wantedMarketId);
    const market = book.markets[wantedMarketId];
    if (!definition || !object(market) || market.marketActive !== true ||
        !object(market.outcomes)) return null;
    const [family, line] = [definition.family, definition.line];

    // Even when the caller names a market ID, reject any second active market
    // representing the same family/line rather than selecting first-wins.
    let sameLineCount = 0;
    for (const [key, row] of marketEntries) {
      const meta = mapped.get(key);
      if (row?.marketActive === true && meta?.family === family &&
          meta.line === line && ++sameLineCount > 1) return null;
    }
    if (sameLineCount !== 1 || Object.keys(market.outcomes).length !== 2 ||
        definition.outcomeSides.size !== 2) return null;

    const sides = {};
    const flags = [];
    let originalName = null;
    let freshness = true;
    for (const side of ["Over","Under"]) {
      const outcomeId = [...definition.outcomeSides.entries()]
        .find(entry => entry[1] === side)?.[0];
      const entry = outcomeId && market.outcomes[outcomeId]?.players?.[playerId];
      if (!outcomeId || !object(entry) || entry.active !== true ||
          !quotePrice(entry.price) || !validName(entry.playerName)) return null;
      if (originalName !== null && originalName !== entry.playerName) return null;
      originalName = entry.playerName;
      const changed = timestamp(entry.changedAt), flag = quoteFlag(entry.mainLine);
      if (!Number.isFinite(changed) || changed > captured + 2 * MINUTE ||
          flag === undefined) return null;
      freshness = freshness && captured - changed <= FRESH_FOR;
      flags.push(flag);
      sides[side] = Object.freeze({
        outcomeId, price: entry.price, changedAt: entry.changedAt,
        mainLineFlag: flag
      });
    }

    const mainLineEvidence = flags.every(flag => flag === true) ?
      "BOTH_EXPLICIT_FLAGS_UNVERIFIED" :
      flags.some(flag => flag === true) ? "CONFLICTING_FLAGS" :
      "NO_EXPLICIT_FLAGS";
    const fields = [
      SOURCE, snapshotReference, capturedAt, wantedFixture, fixture.startTime,
      String(fixture.participant1Id), String(fixture.participant2Id),
      playerId, originalName, wantedMarketId, family, line, sides.Over, sides.Under
    ];
    const digest = createHash("sha256").update(JSON.stringify(fields)).digest("hex");

    return Object.freeze({
      schemaVersion: 1,
      status: "UNREVIEWED_PROVIDER_QUOTE",
      source: SOURCE,
      attributedBookmaker: "betano.pt",
      sourceReference: snapshotReference,
      capturedAt, fixtureId: wantedFixture,
      startTime: fixture.startTime,
      providerParticipantIds: Object.freeze([
        String(fixture.participant1Id),String(fixture.participant2Id)
      ]),
      providerPlayerId: playerId,
      providerPlayerName: originalName,
      marketId: wantedMarketId, family, line,
      outcomes: Object.freeze(sides),
      freshness: freshness ? "FRESH_WITHIN_15_MIN" : "STALE_PROVIDER_TIMESTAMP",
      mainLineEvidence,
      digest,
      bookmakerVerified: false, espnPlayerVerified: false,
      autoLineSelected: false, captureAllowed: false
    });
  } catch (_) {
    // Malformed source, circular data, trapping getters or oversized catalogue
    // never expose raw provider values or exception text.
    return null;
  }
}

// Scope is supplied by the trusted backend before the manual run. Its name
// filter discovers an original ID for custody only, with no ESPN assertion.
function normalizeOfflineQuoteScope(scope) {
  if (!object(scope) || Object.keys(scope).sort().join("|") !==
      "family|line|participant1Id|participant2Id|playerName|startTime") return null;
  const participant1Id = identifier(scope.participant1Id);
  const participant2Id = identifier(scope.participant2Id);
  const startTime = timestamp(scope.startTime);
  if (!participant1Id || !participant2Id || participant1Id === participant2Id ||
      !Number.isFinite(startTime) || !validName(scope.playerName) ||
      !["PTS","REB","AST","3PT","PR","PA","RA","PRA"].includes(scope.family) ||
      !Number.isFinite(scope.line) || scope.line < 0 ||
      scope.line % 1 !== 0.5) return null;
  return Object.freeze({
    participant1Id, participant2Id, startTime,
    playerName:scope.playerName, family:scope.family, line:scope.line
  });
}

function resolveOfflineQuoteSelection(scope, catalogue, leagueOdds) {
  const fixtures = leagueFixtures(leagueOdds);
  if (!fixtures || fixtures.length > MAX_FIXTURES) return null;
  const matches = fixtures.filter(f => object(f) &&
    Number(f.sportId) === 11 && Number(f.tournamentId) === 132 &&
    identifier(f.participant1Id) === scope.participant1Id &&
    identifier(f.participant2Id) === scope.participant2Id &&
    timestamp(f.startTime) === scope.startTime);
  if (matches.length !== 1 || !fixtureId(matches[0].fixtureId)) return null;

  const book = matches[0].bookmakerOdds?.["betano.pt"];
  if (!object(book) || book.bookmakerIsActive !== true ||
      book.suspended === true || !object(book.markets)) return null;
  const markets = Object.entries(book.markets);
  if (markets.length > MAX_MARKETS) return null;

  const {mapped} = officialCatalogueMap(catalogue);
  const wantedMarkets = markets.filter(([id, market]) => {
    const definition = mapped.get(id);
    return market?.marketActive === true &&
      definition?.family === scope.family && definition.line === scope.line;
  });
  if (wantedMarkets.length !== 1) return null;

  const [[marketId, market]] = wantedMarkets;
  let providerPlayerId = null;
  for (const outcomeId of mapped.get(marketId).outcomeSides.keys()) {
    const players = market.outcomes?.[outcomeId]?.players;
    if (!object(players)) return null;
    const entries = Object.entries(players);
    if (entries.length > MAX_MARKETS) return null;
    const matchingPlayers = entries.filter(([, player]) =>
      player?.playerName === scope.playerName);
    if (matchingPlayers.length !== 1) return null;
    const [originalId, player] = matchingPlayers[0];
    if (!identifier(originalId) || player.active !== true ||
        (providerPlayerId !== null && providerPlayerId !== originalId)) return null;
    providerPlayerId = originalId;
  }
  return providerPlayerId ? {
    fixtureId:matches[0].fixtureId, marketId, providerPlayerId
  } : null;
}

module.exports = {
  freezeUnreviewedProviderPlayerPair,
  normalizeOfflineQuoteScope,
  resolveOfflineQuoteSelection
};
