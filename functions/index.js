"use strict";
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { defineSecret } = require("firebase-functions/params");

initializeApp();

const oddsPapiKey = defineSecret("ODDSPAPI_API_KEY");

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
