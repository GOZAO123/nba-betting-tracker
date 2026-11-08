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
    const ownerUid = process.env.ODDS_OWNER_UID;
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
