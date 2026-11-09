"use strict";
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { defineSecret } = require("firebase-functions/params");

initializeApp();

const oddsPapiKey = defineSecret("ODDSPAPI_API_KEY");

// Safety Update 32.9 — persistent budget shared by all manual OddsPapi probes.
// In-memory caches alone are not a spend guard: cloud instance restarts clear them.
// Reserve the MAXIMUM requests a diagnostic might send before any outbound call.
// The document is server-only and every increment is transactional across instances.
const ODDSPAPI_REQUESTS_PER_UTC_DAY = 6;
async function reserveDiagnosticRequests(amount) {
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 2) {
    throw new HttpsError("invalid-argument", "Invalid diagnostic request reservation.");
  }
  const utcDay = new Date().toISOString().slice(0, 10);
  const db = getFirestore();
  const ref = db.doc("_internal/oddsPapiDailyDiagnosticBudget");
  try {
    return await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const previous = snap.exists ? snap.data() : null;
      const sameDay = previous?.utcDay === utcDay;
      if (sameDay && (!Number.isSafeInteger(previous.reserved) || previous.reserved < 0)) {
        throw new HttpsError("failed-precondition", "Invalid API budget record; requests blocked.");
      }
      const reserved = sameDay ? previous.reserved : 0;
      if (reserved + amount > ODDSPAPI_REQUESTS_PER_UTC_DAY) {
        throw new HttpsError(
          "resource-exhausted",
          "Daily OddsPapi diagnostic safety limit reached. No external API request was made."
        );
      }
      const newReserved = reserved + amount;
      transaction.set(ref, {
        utcDay,
        reserved: newReserved,
        limit: ODDSPAPI_REQUESTS_PER_UTC_DAY,
        lastReservedAt: new Date().toISOString()
      });
      return { utcDay, remaining: ODDSPAPI_REQUESTS_PER_UTC_DAY - newReserved };
    }, { maxAttempts: 5 });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    // Fail closed on Firestore errors: no verified budget means no paid API calls.
    throw new HttpsError("unavailable", "Could not check the OddsPapi budget. No API request was made.");
  }
}


exports.oddsBackendStatus = onCall(
  { region: "europe-west1", maxInstances: 2, enforceAppCheck: false },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Sign in to check the odds backend.");
    }
    return {
      ready: true,
      provider: "OddsPapi",
      oddsConnected: false,
      message: "Authenticated Firebase backend is ready. OddsPapi connection test is available separately."
    };
  }
);

// Deliberately not connected to the public website yet.
// This first probe uses only the documented tournaments endpoint (sportId=11).
// It does not retrieve bookmaker odds or player props.
exports.oddsPapiTournamentProbe = onCall(
  {
    region: "europe-west1",
    secrets: [oddsPapiKey],
    maxInstances: 1,
    concurrency: 1,
    timeoutSeconds: 20,
    enforceAppCheck: false
  },
  async (request) => {
    if (!request.auth || !request.auth.token.email_verified) {
      throw new HttpsError("permission-denied", "A verified Firebase account is required.");
    }
    // Disabled until the owner's UID is configured server-side.
    // This prevents other registered users from exhausting the free API quota.
    const ownerUid = "I6ZhMcObXxNVdfv2AqapDxwIaet1";
    if (!ownerUid || request.auth.uid !== ownerUid) {
      throw new HttpsError("permission-denied", "OddsPapi testing is not enabled for this account.");
    }
    const key = oddsPapiKey.value();
    if (!key) throw new HttpsError("failed-precondition", "OddsPapi secret is missing.");
    await reserveDiagnosticRequests(1);
    const url = new URL("https://api.oddspapi.io/v4/tournaments");
    url.searchParams.set("sportId", "11");
    url.searchParams.set("apiKey", key);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new HttpsError("unavailable", "OddsPapi returned HTTP " + response.status);
      const payload = await response.json();
      const tournaments = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
      const nba = tournaments.filter(t => /\bnba\b/i.test([t.tournamentName, t.tournamentSlug].join(" ")));
      return {
        sportId: 11,
        totalTournaments: tournaments.length,
        nbaTournaments: nba.slice(0, 10).map(t => ({
          tournamentId: t.tournamentId,
          tournamentName: t.tournamentName,
          tournamentSlug: t.tournamentSlug
        })),
        note: "Tournament discovery only; player props and Betano PT odds not yet verified."
      };
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      throw new HttpsError("unavailable", "OddsPapi tournament lookup failed. Check function logs.");
    } finally {
      clearTimeout(timer);
    }
  }
);

const nbaOddsCache = { at: 0, data: null, pending: null };
exports.oddsPapiNbaOddsProbe = onCall(
  { region: "europe-west1", secrets: [oddsPapiKey], maxInstances: 1, concurrency: 1, timeoutSeconds: 30, enforceAppCheck: false },
  async (request) => {
    if (!request.auth || request.auth.uid !== "I6ZhMcObXxNVdfv2AqapDxwIaet1" || !request.auth.token.email_verified) {
      throw new HttpsError("permission-denied", "Only the authorised account can test odds.");
    }
    if (nbaOddsCache.data && Date.now() - nbaOddsCache.at < 15 * 60 * 1000) {
      return { ...nbaOddsCache.data, cached: true };
    }
    if (nbaOddsCache.pending) return nbaOddsCache.pending;
    const run = async () => {
      if (!oddsPapiKey.value()) throw new HttpsError("failed-precondition", "OddsPapi key is unavailable.");
      await reserveDiagnosticRequests(1);
      const url = new URL("https://api.oddspapi.io/v4/odds-by-tournaments");
      url.searchParams.set("tournamentIds", "132");
      url.searchParams.set("bookmakers", "betano.pt");
      url.searchParams.set("language", "en");
      url.searchParams.set("oddsFormat", "decimal");
      url.searchParams.set("apiKey", oddsPapiKey.value());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 18000);
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
        if (!response.ok) {
          throw new HttpsError("unavailable", "OddsPapi returned HTTP " + response.status + ". Check bookmaker slug and subscription.");
        }
        const payload = await response.json();
        const fixtures = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.fixtures) ? payload.fixtures : [];
        const result = {
          diagnosticVersion: "26.1",
          tournamentId: 132, requestedBookmaker: "betano.pt",
          fixtures: fixtures.length, withOdds: 0, marketCount: 0, playerEntries: 0,
          namedPlayerEntries: 0, bookmakerSlugs: [], samples: [], cached: false,
          responseShape: Array.isArray(payload) ? "array" : Object.keys(payload || {}).slice(0, 12).join(", "),
          note: "Diagnostic summary only. Markets are not yet mapped to PTS/REB/AST or validated against Betano Portugal."
        };
        const slugs = new Set();
        for (const fixture of fixtures) {
          if (fixture.hasOdds) result.withOdds++;
          for (const [slug, book] of Object.entries(fixture.bookmakerOdds || {})) {
            slugs.add(slug);
            for (const [marketId, market] of Object.entries(book.markets || {})) {
              result.marketCount++;
              for (const outcome of Object.values(market.outcomes || {})) {
                for (const entry of Object.values(outcome.players || {})) {
                  result.playerEntries++;
                  if (entry.playerName) {
                    result.namedPlayerEntries++;
                    if (result.samples.length < 8) result.samples.push({
                      fixtureId: fixture.fixtureId, marketId, player: String(entry.playerName).slice(0, 100),
                      outcome: String(entry.bookmakerOutcomeId || "").slice(0, 100),
                      price: entry.price, changedAt: entry.changedAt || null
                    });
                  }
                }
              }
            }
          }
        }
        // Summarise the structure without returning raw bookmaker payloads or credentials.
        result.marketDiagnostics = [];
        for (const fixture of fixtures.slice(0, 3)) {
          const book = fixture.bookmakerOdds?.["betano.pt"];
          if (!book) continue;
          for (const [marketId, market] of Object.entries(book.markets || {}).slice(0, 12)) {
            const outcomes = Object.entries(market.outcomes || {});
            result.marketDiagnostics.push({
              fixtureId: String(fixture.fixtureId || "").slice(0, 50),
              marketId: String(marketId).slice(0, 70),
              marketKeys: Object.keys(market || {}).slice(0, 16),
              marketName: String(market.marketName || market.name || "").slice(0, 90),
              outcomeCount: outcomes.length,
              outcomeSamples: outcomes.slice(0, 2).map(([outcomeId, outcome]) => ({
                outcomeId: String(outcomeId).slice(0, 70),
                keys: Object.keys(outcome || {}).slice(0, 16),
                playersType: Array.isArray(outcome?.players) ? "array" : typeof outcome?.players,
                playersCount: Object.keys(outcome?.players || {}).length,
                playerEntryShapes: Object.entries(outcome?.players || {}).slice(0, 2).map(([entryId, entry]) => ({
                  entryId: String(entryId).slice(0, 50),
                  keys: entry && typeof entry === "object" ? Object.keys(entry).slice(0, 20) : [],
                  nameFields: entry && typeof entry === "object" ? {
                    playerName: typeof entry.playerName === "string" ? entry.playerName.slice(0, 70) : null,
                    name: typeof entry.name === "string" ? entry.name.slice(0, 70) : null,
                    participantName: typeof entry.participantName === "string" ? entry.participantName.slice(0, 70) : null
                  } : null
                }))
              }))
            });
            if (result.marketDiagnostics.length >= 12) break;
          }
          if (result.marketDiagnostics.length >= 12) break;
        }
        result.diagnosticCount = result.marketDiagnostics.length;
        result.bookmakerSlugs = [...slugs];
        nbaOddsCache.at = Date.now();
        nbaOddsCache.data = result;
        return result;
      } catch (err) {
        if (err instanceof HttpsError) throw err;
        throw new HttpsError("unavailable", "NBA odds lookup failed. Check Firebase function logs.");
      } finally {
        clearTimeout(timer);
      }
    };
    nbaOddsCache.pending = run();
    try { return await nbaOddsCache.pending; }
    finally { nbaOddsCache.pending = null; }
  }
);

const detailedProbeCache = { at: 0, data: null, pending: null };
exports.oddsPapiDetailedPropsProbe = onCall(
  { region: "europe-west1", secrets: [oddsPapiKey], maxInstances: 1, concurrency: 1, timeoutSeconds: 45, enforceAppCheck: false },
  async (request) => {
    if (!request.auth || request.auth.uid !== "I6ZhMcObXxNVdfv2AqapDxwIaet1" || !request.auth.token.email_verified) {
      throw new HttpsError("permission-denied", "Only the authorised account can test odds.");
    }
    // Manual-only diagnostic. No scheduled function or automatic API polling.
    if (detailedProbeCache.data && Date.now() - detailedProbeCache.at < 30 * 60 * 1000)
      return { ...detailedProbeCache.data, cached: true };
    if (detailedProbeCache.pending) return detailedProbeCache.pending;
    const run = async () => {
      const key = oddsPapiKey.value();
      if (!key) throw new HttpsError("failed-precondition", "OddsPapi key is unavailable.");
      // Worst case is 2 outbound requests, so reserve both upfront.
      // Unused slots are not refunded: this conservative guard cannot undercount.
      await reserveDiagnosticRequests(2);
      let requestsUsed = 0;
      async function get(path, params) {
        // Hard ceiling of two outbound OddsPapi calls per invocation.
        if (requestsUsed >= 2) throw new HttpsError("resource-exhausted", "Diagnostic API request limit reached.");
        requestsUsed++;
        const url = new URL("https://api.oddspapi.io" + path);
        for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
        url.searchParams.set("apiKey", key);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
          if (!response.ok) throw new HttpsError("unavailable", "OddsPapi returned HTTP " + response.status);
          return await response.json();
        } finally { clearTimeout(timer); }
      }
      try {
        const listing = await get("/v4/odds-by-tournaments", {
          bookmakers: "betano.pt", tournamentIds: "132", language: "en", oddsFormat: "decimal"
        });
        const fixtures = Array.isArray(listing) ? listing : Array.isArray(listing?.data) ? listing.data : Array.isArray(listing?.fixtures) ? listing.fixtures : [];
        const now = Date.now(), hour = 60 * 60 * 1000;
        const eligible = fixtures.filter(f => {
          const start = Date.parse(f.startTime);
          return f.fixtureId && f.hasOdds && Number.isFinite(start) && start > now && start <= now + 36 * hour;
        }).sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
        const within24 = eligible.filter(f => Date.parse(f.startTime) <= now + 24 * hour);
        const fixture = (within24.length ? within24 : eligible)[0];
        if (!fixture) {
          const result = {
            diagnosticVersion: "28.1", fixtures: fixtures.length, eligibleFixtures: 0,
            fixtureId: null, requestsUsed,
            note: "No upcoming NBA fixture with odds within 36 hours. No detailed odds request made.",
            cached: false
          };
          detailedProbeCache.data = result; detailedProbeCache.at = Date.now();
          return result;
        }
        const details = await get("/v4/odds", {
          fixtureId: fixture.fixtureId, bookmakers: "betano.pt", language: "en", oddsFormat: "decimal", verbosity: 3
        });
        const book = details?.bookmakerOdds?.["betano.pt"];
        const markets = Object.entries(book?.markets || {});
        const samples = [];
        let namedPlayers = 0, playerSelections = 0, marketCountWithNames = 0, linesFound = 0, decimalPrices = 0;
        const marketDiagnostics = [];
        for (const [marketId, market] of markets) {
          let namesInMarket = 0;
          const outcomeNames = [];
          for (const [outcomeId, outcome] of Object.entries(market.outcomes || {})) {
            if (outcomeNames.length < 6) outcomeNames.push(String(outcome.name || outcome.outcomeName || outcomeId).slice(0, 80));
            for (const [playerId, entry] of Object.entries(outcome.players || {})) {
              playerSelections++;
              const name = [entry?.playerName, entry?.name, entry?.participantName].find(v => typeof v === "string" && v.trim());
              const line = [entry?.line, entry?.handicap, entry?.points, outcome?.line, outcome?.handicap].find(v => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)));
              const price = Number(entry?.price);
              if (line !== undefined) linesFound++;
              if (Number.isFinite(price) && price > 1) decimalPrices++;
              if (name) {
                namedPlayers++; namesInMarket++;
                if (samples.length < 12) samples.push({
                  marketId: String(marketId).slice(0, 80), outcomeId: String(outcomeId).slice(0, 80),
                  playerId: String(playerId).slice(0, 80), player: name.slice(0, 90),
                  line: line === undefined ? null : Number(line),
                  price: Number.isFinite(price) && price > 1 ? price : null,
                  bookmakerOutcomeId: String(entry.bookmakerOutcomeId || "").slice(0, 100)
                });
              }
            }
          }
          if (namesInMarket) marketCountWithNames++;
          if (marketDiagnostics.length < 12) marketDiagnostics.push({
            marketId: String(marketId).slice(0, 80),
            marketName: String(market.marketName || market.name || "").slice(0, 90),
            outcomes: outcomeNames
          });
        }
        const result = {
          diagnosticVersion: "28.1", fixtureId: String(fixture.fixtureId),
          startTime: fixture.startTime, fixtures: fixtures.length, eligibleFixtures: eligible.length,
          selectedWindowHours: within24.length ? 24 : 36,
          fixture: [details?.participant1Name || fixture.participant1Name, details?.participant2Name || fixture.participant2Name].filter(Boolean).join(" vs "),
          bookmakerPresent: Boolean(book), marketCount: markets.length,
          playerSelections, namedPlayers, marketCountWithNames, linesFound, decimalPrices,
          marketDiagnostics, samples, requestsUsed,
          databaseMatches: null,
          note: "Diagnostic only. Market mapping and roster matching await verified player-name/line fields. No bets generated.",
          cached: false
        };
        detailedProbeCache.data = result; detailedProbeCache.at = Date.now();
        return result;
      } catch (err) {
        if (err instanceof HttpsError) throw err;
        throw new HttpsError("unavailable", "Detailed OddsPapi test failed. See Firebase logs.");
      }
    };
    detailedProbeCache.pending = run();
    try { return await detailedProbeCache.pending; }
    finally { detailedProbeCache.pending = null; }
  }
);
