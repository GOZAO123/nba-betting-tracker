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

/**
 * Manual-only OddsPapi market catalogue diagnostic (1 external request maximum).
 * The live odds endpoint exposes market IDs, while /v4/markets gives their official
 * market names, handicap lines, playerProp flags, and Over/Under outcome names.
 * No odds, secrets, or raw global catalogue are returned to the browser.
 */
const marketCatalogCache = { at: 0, data: null, pending: null };
exports.oddsPapiMarketCatalogProbe = onCall(
  {
    region: "europe-west1", secrets: [oddsPapiKey],
    maxInstances: 1, concurrency: 1, timeoutSeconds: 60,
    memory: "512MiB", enforceAppCheck: false
  },
  async (request) => {
    if (!request.auth || request.auth.uid !== "I6ZhMcObXxNVdfv2AqapDxwIaet1" || !request.auth.token.email_verified) {
      throw new HttpsError("permission-denied", "Only the authorised account can identify NBA markets.");
    }
    // Market definitions are static enough to reuse during the same server session.
    if (marketCatalogCache.data && Date.now() - marketCatalogCache.at < 12 * 60 * 60 * 1000) {
      return { ...marketCatalogCache.data, cached: true };
    }
    if (marketCatalogCache.pending) return marketCatalogCache.pending;
    const run = async () => {
      const key = oddsPapiKey.value();
      if (!key) throw new HttpsError("failed-precondition", "OddsPapi key is unavailable.");
      await reserveDiagnosticRequests(1);
      const url = new URL("https://api.oddspapi.io/v4/markets");
      url.searchParams.set("language", "en");
      url.searchParams.set("apiKey", key);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35000);
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
        if (!response.ok) throw new HttpsError("unavailable", "OddsPapi markets endpoint returned HTTP " + response.status);
        const payload = await response.json();
        const markets = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [];
        if (!markets.length) throw new HttpsError("unavailable", "OddsPapi market catalogue did not contain the expected market array.");
        const knownIds = ["111680", "111682", "111684"];
        const byId = new Map(markets.map(m => [String(m.marketId), m]));
        const compact = m => m ? {
          marketId: String(m.marketId),
          marketName: String(m.marketName || "").slice(0, 130),
          handicap: Number.isFinite(Number(m.handicap)) ? Number(m.handicap) : null,
          playerProp: m.playerProp === true,
          sportId: m.sportId,
          period: String(m.period || "").slice(0, 40),
          marketType: String(m.marketType || "").slice(0, 60),
          outcomes: Array.isArray(m.outcomes)
            ? m.outcomes.slice(0, 6).map(o => ({
              id: String(o.outcomeId || "").slice(0, 30),
              name: String(o.outcomeName || "").slice(0, 50)
            })) : []
        } : null;
        const officialSamples = knownIds.map(id => ({ id, market: compact(byId.get(id)) }));
        const playerMarkets = markets.filter(m => Number(m.sportId) === 11 && m.playerProp === true);
        const categories = new Map();
        for (const market of playerMarkets) {
          const name = String(market.marketName || "").trim();
          if (!name || !/(point|rebound|assist|3.point|three.point|three.pointer)/i.test(name)) continue;
          const item = categories.get(name) || { marketName: name.slice(0, 100), marketCount: 0, example: null };
          item.marketCount++;
          if (!item.example) item.example = compact(market);
          categories.set(name, item);
        }
        const result = {
          diagnosticVersion: "33.2",
          totalDefinitions: markets.length, nbaPlayerPropDefinitions: playerMarkets.length,
          sampleIds: officialSamples,
          categorySamples: [...categories.values()].sort((a, b) => b.marketCount - a.marketCount).slice(0, 18),
          requestsUsed: 1, cached: false,
          note: "Verified OddsPapi market catalogue metadata only. Betting availability, player identity and live Betano PT odds require separate validation."
        };
        marketCatalogCache.data = result;
        marketCatalogCache.at = Date.now();
        return result;
      } catch (error) {
        if (error instanceof HttpsError) throw error;
        throw new HttpsError("unavailable", "Could not retrieve market definitions. Check Firebase logs.");
      } finally {
        clearTimeout(timer);
      }
    };
    marketCatalogCache.pending = run();
    try { return await marketCatalogCache.pending; }
    finally { marketCatalogCache.pending = null; }
  }
);


// Update 33.3 — independently verify full-game player props against the official
// market catalogue and the current Betano PT event odds. Manual test only:
// exactly two upstream requests at most (markets + NBA tournament listing).
const verifiedPropsCache = {at:0, data:null, pending:null};
const verifiedPropNames = Object.freeze({
  "Over Under Player Points (incl. overtime)": "PTS",
  "Over Under Player Rebounds (incl. overtime)": "REB",
  "Over Under Player Assists (incl. overtime)": "AST",
  "Over Under Player 3 Point FG (incl. overtime)": "3PT",
  "Over Under Player Points + Rebounds (incl. overtime)": "PR",
  "Over Under Player Points + Assists (incl. overtime)": "PA",
  "Over Under Player Assists + Rebounds (incl. overtime)": "RA",
  "Over Under Player Points + Assists + Rebounds (incl. overtime)": "PRA"
});
function summariseVerifiedProps(definitions,fixtures,now=Date.now()){
  const marketMap=new Map();
  for(const m of definitions){
    if(Number(m?.sportId)!==11||m?.playerProp!==true)continue;
    const family=verifiedPropNames[String(m.marketName||"").trim()];
    if(!family||!Number.isFinite(Number(m.handicap))||Number(m.handicap)<0)continue;
    const validOutcomes=new Map();
    for(const o of m.outcomes||[]){
      const side=String(o?.outcomeName||"").trim();
      if(side==="Over"||side==="Under")validOutcomes.set(String(o.outcomeId),side);
    }
    if(validOutcomes.size!==2)continue;
    marketMap.set(String(m.marketId),{family,line:Number(m.handicap),outcomes:validOutcomes});
  }
  const eligible=fixtures.filter(f=>{
    const start=Date.parse(f?.startTime);
    return f?.fixtureId&&f?.hasOdds&&Number.isFinite(start)&&start>now&&start<=now+36*3600000;
  }).sort((a,b)=>Date.parse(a.startTime)-Date.parse(b.startTime));
  const fixture=eligible[0];
  const result={
    diagnosticVersion:"33.3",catalogueDefinitions:definitions.length,
    verifiedFullGameMarketIds:marketMap.size,
    eligibleFixtures:eligible.length,
    fixtureId:fixture?String(fixture.fixtureId):null,
    fixture:fixture?[fixture.participant1Name,fixture.participant2Name].filter(Boolean).join(" vs "):null,
    startTime:fixture?.startTime||null,
    bookmakerPresent:false,bookmakerSuspended:null,
    activeSelections:0,unavailableSelections:0,marketCount:0,
    marketCounts:[],samples:[],
    cached:false,requestsReserved:2,
    note:"Official full-game, including-overtime market definitions only. Active selections are not predictions; player names are OddsPapi identities, not yet matched to ESPN."
  };
  if(!fixture)return result;
  const book=fixture.bookmakerOdds?.["betano.pt"];
  if(!book)return result;
  result.bookmakerPresent=true;
  result.bookmakerSuspended=book.suspended===true;
  if(book.suspended===true||book.bookmakerIsActive===false)return result;
  const totals=new Map();
  const all=[];
  for(const [marketId,market] of Object.entries(book.markets||{})){
    const meta=marketMap.get(String(marketId));
    if(!meta)continue;
    result.marketCount++;
    const count=totals.get(meta.family)||{family:meta.family,marketIds:0,activeSelections:0};
    count.marketIds++;
    totals.set(meta.family,count);
    if(market.marketActive!==true)continue;
    for(const [outcomeId,outcome] of Object.entries(market.outcomes||{})){
      const selection=meta.outcomes.get(String(outcomeId));
      if(!selection)continue;
      for(const [playerId,entry] of Object.entries(outcome?.players||{})){
        const price=Number(entry?.price);
        const name=typeof entry?.playerName==="string"?entry.playerName.trim():"";
        if(!name||playerId==="0"||entry?.active!==true||!Number.isFinite(price)||price<=1){
          result.unavailableSelections++;
          continue;
        }
        result.activeSelections++;count.activeSelections++;
        all.push({
          family:meta.family,line:meta.line,selection,
          marketId:String(marketId),outcomeId:String(outcomeId),
          player:name.slice(0,100),
          oddsPapiPlayerId:String(playerId).slice(0,60),
          price,mainLine:entry.mainLine===true,
          changedAt:typeof entry.changedAt==="string"?entry.changedAt:null
        });
      }
    }
  }
  result.marketCounts=[...totals.values()].sort((a,b)=>a.family.localeCompare(b.family));
  // A small representative sample per market family; never return the full odds payload.
  const byFamily=new Map();
  for(const x of all.sort((a,b)=>
     Number(b.mainLine)-Number(a.mainLine)||
     a.player.localeCompare(b.player)||a.line-b.line||a.selection.localeCompare(b.selection))){
    const n=byFamily.get(x.family)||0;
    if(n>=6)continue;
    byFamily.set(x.family,n+1);
    result.samples.push(x);
  }
  result.samples.sort((a,b)=>a.family.localeCompare(b.family)||a.player.localeCompare(b.player));
  return result;
}
exports.oddsPapiVerifiedPropsProbe = onCall(
  {region:"europe-west1",secrets:[oddsPapiKey],maxInstances:1,concurrency:1,
   timeoutSeconds:120,memory:"512MiB",enforceAppCheck:false},
  async request=>{
    if(!request.auth||request.auth.uid!=="I6ZhMcObXxNVdfv2AqapDxwIaet1"||!request.auth.token.email_verified)
      throw new HttpsError("permission-denied","Only the authorised account can verify Betano PT props.");
    if(verifiedPropsCache.data&&Date.now()-verifiedPropsCache.at<15*60000)
      return {...verifiedPropsCache.data,cached:true};
    if(verifiedPropsCache.pending)return verifiedPropsCache.pending;
    const run=async()=>{
      const key=oddsPapiKey.value();
      if(!key)throw new HttpsError("failed-precondition","OddsPapi secret is not available.");
      // Reserve two slots BEFORE either upstream request; failures and unused slots
      // are conservatively charged against the daily six-request safety ceiling.
      await reserveDiagnosticRequests(2);
      let used=0;
      async function get(path,params){
        if(++used>2)throw new HttpsError("resource-exhausted","Per-test request limit reached.");
        const url=new URL("https://api.oddspapi.io"+path);
        for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
        url.searchParams.set("apiKey",key);
        const controller=new AbortController();
        const timer=setTimeout(()=>controller.abort(),35000);
        try{
          const response=await fetch(url,{signal:controller.signal,headers:{Accept:"application/json"}});
          if(!response.ok)throw new HttpsError("unavailable","OddsPapi responded HTTP "+response.status);
          return await response.json();
        }finally{clearTimeout(timer)}
      }
      try{
        const definitions=await get("/v4/markets",{language:"en"});
        const markets=Array.isArray(definitions)?definitions:Array.isArray(definitions?.data)?definitions.data:[];
        if(!markets.length)throw new HttpsError("unavailable","Missing official market definitions.");
        const odds=await get("/v4/odds-by-tournaments",{
          tournamentIds:"132",bookmaker:"betano.pt",language:"en",verbosity:3
        });
        const fixtures=Array.isArray(odds)?odds:Array.isArray(odds?.data)?odds.data:Array.isArray(odds?.fixtures)?odds.fixtures:[];
        if(!fixtures.length)throw new HttpsError("unavailable","Missing NBA fixture array.");
        const result=summariseVerifiedProps(markets,fixtures);
        result.requestsUsed=used;
        verifiedPropsCache.data=result;
        verifiedPropsCache.at=Date.now();
        return result;
      }catch(e){
        if(e instanceof HttpsError)throw e;
        throw new HttpsError("unavailable","Market verification failed. Check Firebase logs.");
      }
    };
    verifiedPropsCache.pending=run();
    try{return await verifiedPropsCache.pending}
    finally{verifiedPropsCache.pending=null}
  }
);


// Update 34.5A — owner-only trusted entry point for prospective ESPN player-prop
// research. This does not use OddsPapi. Quotes/probabilities remain manually
// supplied and UNVERIFIED; backend validates ESPN identities and capture time.
// IMPORTANT: The existing Firestore rules remain unchanged until both client
// migration and trusted settlement have been tested.
const { Timestamp, FieldValue } = require("firebase-admin/firestore");
const LEDGER_ALLOWED_MARKETS = Object.freeze(["PTS","REB","AST","3PT","PR","PA","RA","PRA"]);
const LEDGER_CAPTURE_GRACE_MS = 5*60*1000;
const LEDGER_OWNER = "I6ZhMcObXxNVdfv2AqapDxwIaet1";

function ledgerAssertOwner(request) {
  if (!request.auth) throw new HttpsError("unauthenticated","Google sign-in required.");
  if (request.auth.uid !== LEDGER_OWNER || request.auth.token.email_verified !== true)
    throw new HttpsError("permission-denied","This research ledger is restricted to its owner.");
}
function ledgerReject(message) {
  throw new HttpsError("invalid-argument",message);
}
function ledgerText(x,max) {
  return typeof x==="string"&&x.length>0&&x.length<=max?x.trim():null;
}
function ledgerDigits(x) {
  return typeof x==="string"&&/^\d{1,20}$/.test(x)?x:null;
}
function ledgerNameKey(x) {
  return String(x||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
}
function ledgerNbaDay(serverDate) {
  const parts=new Intl.DateTimeFormat("en-US",{
    timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"
  }).formatToParts(serverDate);
  const val=type=>parts.find(p=>p.type===type)?.value;
  return val("year")+val("month")+val("day");
}
async function ledgerGetEspn(path) {
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),12000);
  try {
    const response=await fetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/"+path,{
      signal:controller.signal,headers:{Accept:"application/json"},cache:"no-store"
    });
    if (!response.ok) throw new Error("ESPN HTTP "+response.status);
    return await response.json();
  } catch (error) {
    throw new HttpsError("unavailable","ESPN verification unavailable. No research write confirmed.");
  } finally {
    clearTimeout(timeout);
  }
}
function ledgerValidateCapture(payload) {
  if (!payload||typeof payload!=="object"||Array.isArray(payload))
    ledgerReject("Missing research entry.");
  const player=ledgerText(payload.player,80),team=ledgerText(payload.team,80),
    athleteId=ledgerDigits(payload.athleteId),teamId=ledgerDigits(payload.teamId),
    eventId=ledgerDigits(payload.eventId),
    market=payload.market,side=payload.side;
  const homeId=ledgerDigits(payload.homeId),awayId=ledgerDigits(payload.awayId);
  const line=payload.line,odds=payload.odds,modelOver=payload.modelOver;
  if (!player||!team||!athleteId||!teamId||!eventId||!homeId||!awayId||
      homeId===awayId||!LEDGER_ALLOWED_MARKETS.includes(market)||
      !["Over","Under"].includes(side)||payload.confirmedObservedQuote!==true)
    ledgerReject("Invalid ESPN identity, prop market or quote confirmation.");
  if (!Number.isFinite(line)||line<0.5||line>150.5||
      Math.abs(line-Math.floor(line)-0.5)>1e-9)
    ledgerReject("Research line must be a positive half-point value.");
  if (!Number.isFinite(odds)||odds<1.01||odds>100||
      !Number.isFinite(modelOver)||modelOver<0.02||modelOver>0.98)
    ledgerReject("Invalid decimal price or experimental probability.");
  if (!Number.isInteger(payload.hits12)||payload.hits12<0||payload.hits12>12||
      payload.games12!==12)
    ledgerReject("A verified last-12 ESPN research summary is required.");
  const count24=payload.games24??null,hits24=payload.hits24??null;
  if (!((count24===null&&hits24===null)||
       (count24===24&&Number.isInteger(hits24)&&hits24>=0&&hits24<=24)))
    ledgerReject("Invalid historical 24-game sample.");
  const start=payload.eventStartMs;
  if (!Number.isSafeInteger(start)||start<=Date.now()+LEDGER_CAPTURE_GRACE_MS||
      start>Date.now()+8*86400000)
    ledgerReject("ESPN fixture must be upcoming and more than 5 minutes away.");
  return {player,team,athleteId,teamId,eventId,homeId,awayId,
    market,line,side,odds,modelOver,start,hits12:payload.hits12,games12:12,
    hits24, games24:count24};
}
function ledgerVerifyFixture(board,record) {
  if (!Array.isArray(board?.events))throw new HttpsError("unavailable","ESPN fixture list unavailable.");
  const matches=board.events.filter(e=>String(e?.id||"")===record.eventId);
  if (matches.length!==1)throw new HttpsError("failed-precondition","ESPN fixture is missing or ambiguous.");
  const e=matches[0];
  const start=Date.parse(e.date||"");
  if (!Number.isFinite(start)||start!==record.start||
      ledgerNbaDay(new Date(start))!==ledgerNbaDay(new Date(record.start))||
      e.status?.type?.state!=="pre"||Number(e.season?.type)!==2||
      start<=Date.now()+LEDGER_CAPTURE_GRACE_MS)
    throw new HttpsError("failed-precondition","ESPN fixture is no longer a verified upcoming regular-season game.");
  const comp=e.competitions?.[0]?.competitors||[];
  const h=comp.find(x=>x.homeAway==="home"),a=comp.find(x=>x.homeAway==="away");
  const hid=String(h?.team?.id||""),aid=String(a?.team?.id||"");
  if (hid!==record.homeId||aid!==record.awayId||
      ![hid,aid].includes(record.teamId))
    throw new HttpsError("failed-precondition","The saved fixture's teams do not match ESPN.");
  const home=ledgerText(h?.team?.displayName,80),away=ledgerText(a?.team?.displayName,80);
  if (!home||!away)throw new HttpsError("failed-precondition","ESPN team names unavailable.");
  return {home,away};
}
function ledgerVerifyRoster(roster,record) {
  if (String(roster?.team?.id||"")!==record.teamId||
      ledgerNameKey(roster?.team?.displayName)!==ledgerNameKey(record.team))
    throw new HttpsError("failed-precondition","ESPN roster team mismatch.");
  const players=(roster.athletes||[]).flatMap(x=>Array.isArray(x?.items)?x.items:[x]);
  const matching=players.filter(a=>String(a?.id||"")===record.athleteId&&
    ledgerNameKey(a?.displayName)===ledgerNameKey(record.player));
  if (matching.length!==1)
    throw new HttpsError("failed-precondition","Player identity not uniquely verified on ESPN.");
}
function ledgerDocId(record) {
  return [record.eventId,record.athleteId,record.market,
    String(record.line).replace(".","p"),record.side].join("_");
}
exports.ledgerCaptureProspective=onCall(
  {region:"europe-west1",maxInstances:1,concurrency:5,timeoutSeconds:45,
    memory:"256MiB",enforceAppCheck:false},
  async request=>{
    ledgerAssertOwner(request);
    const record=ledgerValidateCapture(request.data);
    const day=ledgerNbaDay(new Date(record.start));
    const board=await ledgerGetEspn("scoreboard?dates="+day);
    const verifiedGame=ledgerVerifyFixture(board,record);
    const roster=await ledgerGetEspn("teams/"+record.teamId+"/roster");
    ledgerVerifyRoster(roster,record);
    const db=getFirestore(),id=ledgerDocId(record);
    const ref=db.doc("users/"+request.auth.uid+"/propResearchLedger/"+id);
    // Server-controlled capture timestamp; independent of browser clock.
    const receipt=await db.runTransaction(async tx=>{
      const previous=await tx.get(ref);
      if (previous.exists)throw new HttpsError("already-exists",
        "This game, player, market, line and side were already recorded.");
      if (Date.now()+LEDGER_CAPTURE_GRACE_MS>=record.start)
        throw new HttpsError("failed-precondition","Too near tip-off; no record saved.");
      const captured=Timestamp.now();
      tx.create(ref,{
        schemaVersion:2,status:"pending",source:"manual_betano_unverified",
        capturedVia:"trusted_firebase_callable",
        player:record.player,athleteId:record.athleteId,
        team:record.team,teamId:record.teamId,
        eventId:record.eventId,eventStartMs:record.start,
        home:verifiedGame.home,away:verifiedGame.away,
        homeId:record.homeId,awayId:record.awayId,
        market:record.market,line:record.line,side:record.side,odds:record.odds,
        modelOver:record.modelOver,
        modelSelected:record.side==="Over"?record.modelOver:1-record.modelOver,
        hits12:record.hits12,games12:record.games12,
        hits24:record.hits24,games24:record.games24,
        capturedServerAt:captured,clientCapturedMs:captured.toMillis(),
        settledAt:null,resultStat:null,resultWon:null,
        disclaimer:"Manual Betano quote not provider-verified. Client-researched model estimate is uncalibrated."
      });
      return captured.toMillis();
    },{maxAttempts:3});
    return {saved:true,recordId:id,serverCapturedMs:receipt,verifiedEventId:record.eventId};
  }
);

function ledgerParseStat(labels,values,names,mode="number") {
  if (!Array.isArray(labels)||!Array.isArray(values))return null;
  const index=labels.findIndex(x=>names.includes(String(x).trim().toUpperCase()));
  if (index<0||index>=values.length||values[index]===null)return null;
  const raw=String(values[index]).trim();
  if (!raw||raw==="--")return null;
  if (mode==="minutes") {
    const match=/^(\d+):(\d{1,2})$/.exec(raw);
    if (match)return Number(match[2])<60?Number(match[1])+Number(match[2])/60:null;
  }
  if (mode==="made") {
    const match=/^(\d+)\s*-\s*\d+$/.exec(raw);
    if (match)return Number(match[1]);
  }
  return /^\d+(?:\.\d+)?$/.test(raw)?Number(raw):null;
}
function ledgerExtractFinalFromEspn(summary,entry) {
  const header=summary?.header,comp=header?.competitions?.[0];
  if (!comp||String(header?.id||comp.id||"")!==String(entry.eventId)||
      (comp.id&&String(comp.id)!==String(entry.eventId)))
    throw new HttpsError("failed-precondition","ESPN final event ID mismatch.");
  const homeAway=(comp.competitors||[]).map(x=>String(x.team?.id||""));
  if (homeAway.length!==2||!homeAway.includes(String(entry.homeId))||
      !homeAway.includes(String(entry.awayId)))
    throw new HttpsError("failed-precondition","ESPN final NBA teams mismatch.");
  const start=Date.parse(comp.date||"");
  if (Number.isFinite(start)&&Math.abs(start-entry.eventStartMs)>120000)
    throw new HttpsError("failed-precondition","ESPN game start has changed.");
  const status=comp.status?.type;
  if (status?.state!=="post"&&status?.state!=="final")
    throw new HttpsError("failed-precondition","Game not completed.");
  if (status.completed!==true&&!/^STATUS_FINAL/.test(String(status.name||"")))
    throw new HttpsError("failed-precondition","ESPN final not confirmed.");
  const sides=(summary?.boxscore?.players||[]).filter(x=>
    String(x.team?.id||"")===String(entry.teamId));
  if (sides.length!==1)
    throw new HttpsError("failed-precondition","Matching ESPN player-team box score unavailable.");
  let found=null;
  for(const group of sides[0].statistics||[]){
    const labels=group.labels||[];
    for(const player of group.athletes||[]){
      if (String(player?.athlete?.id||"")!==String(entry.athleteId))continue;
      if (player.didNotPlay===true||player.dnp===true)continue;
      const values=player.stats;
      const minutes=ledgerParseStat(labels,values,["MIN"],"minutes");
      if (!Number.isFinite(minutes)||minutes<=0)continue;
      const PTS=ledgerParseStat(labels,values,["PTS"]);
      const REB=ledgerParseStat(labels,values,["REB","TRB"]);
      const AST=ledgerParseStat(labels,values,["AST"]);
      const three=ledgerParseStat(labels,values,["3PM","3PT"],"made");
      const stats={PTS,REB,AST,"3PT":three,
        PR:Number.isFinite(PTS)&&Number.isFinite(REB)?PTS+REB:null,
        PA:Number.isFinite(PTS)&&Number.isFinite(AST)?PTS+AST:null,
        RA:Number.isFinite(REB)&&Number.isFinite(AST)?REB+AST:null,
        PRA:Number.isFinite(PTS)&&Number.isFinite(REB)&&Number.isFinite(AST)?PTS+REB+AST:null};
      const v=stats[entry.market];
      if (!Number.isFinite(v))continue;
      if(found!==null&&found!==v)
        throw new HttpsError("failed-precondition","Contradictory player stats in ESPN final.");
      found=v;
    }
  }
  if(found===null)
    throw new HttpsError("failed-precondition","Player DNP or stat unavailable; record remains pending.");
  if(!Number.isFinite(entry.line)||Math.floor(entry.line)+0.5!==entry.line||
     !["Over","Under"].includes(entry.side))
    throw new HttpsError("failed-precondition","Stored betting line is invalid.");
  return {stat:found,won:entry.side==="Over"?found>entry.line:found<entry.line};
}
exports.ledgerSettleProspective=onCall(
  {region:"europe-west1",maxInstances:1,concurrency:5,timeoutSeconds:40,
    memory:"256MiB",enforceAppCheck:false},
  async request=>{
    ledgerAssertOwner(request);
    const id=ledgerText(request.data?.recordId,100);
    if(!id||!/^[A-Za-z0-9_]+$/.test(id))
      ledgerReject("Invalid prospective research record ID.");
    const db=getFirestore(),ref=db.doc("users/"+request.auth.uid+"/propResearchLedger/"+id);
    const snapshot=await ref.get();
    if(!snapshot.exists)throw new HttpsError("not-found","Research entry missing.");
    const entry=snapshot.data();
    if(entry.status!=="pending"||!Number.isSafeInteger(entry.eventStartMs)||
       Date.now()<entry.eventStartMs+70*60000)
      throw new HttpsError("failed-precondition","Entry not eligible for ESPN settlement.");
    const receipt=entry.capturedServerAt?.toMillis?.();
    if(!Number.isFinite(receipt)||receipt>=entry.eventStartMs-LEDGER_CAPTURE_GRACE_MS)
      throw new HttpsError("failed-precondition","Missing valid prospective server receipt.");
    const summary=await ledgerGetEspn("summary?event="+encodeURIComponent(entry.eventId));
    const result=ledgerExtractFinalFromEspn(summary,entry);
    await db.runTransaction(async tx=>{
      const latest=await tx.get(ref);
      if(!latest.exists)throw new HttpsError("not-found","Research entry missing.");
      const current=latest.data();
      for(const key of ["eventId","eventStartMs","athleteId","teamId",
        "homeId","awayId","market","line","side","modelSelected","odds"]){
        if(current[key]!==entry[key])
          throw new HttpsError("failed-precondition","Original research entry changed; cannot settle.");
      }
      const time=current.capturedServerAt?.toMillis?.();
      if(!Number.isFinite(time)||time>=current.eventStartMs-LEDGER_CAPTURE_GRACE_MS||
         current.status!=="pending")
        throw new HttpsError("failed-precondition","Record no longer eligible to settle.");
      tx.update(ref,{status:"settled",resultStat:result.stat,resultWon:result.won,
        settledAt:FieldValue.serverTimestamp(),
        settlementSource:"ESPN Final verified by server: event/team/athlete"});
    },{maxAttempts:3});
    return {settled:true,resultStat:result.stat,resultWon:result.won,recordId:id};
  }
);

// Update 34.6 — optional daily, server-only automatic ESPN settlement.
// This does not touch OddsPapi and does not require a signed-in browser.
// Deploy this function separately, only after owner approval (Cloud Scheduler
// creates a billed job; Firebase Blaze plan may be required).
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { runAutomaticSettlement } = require("./auto-settlement");
const AUTO_LEDGER_SCAN_LIMIT = 300;

exports.ledgerAutoSettleProspective = onSchedule(
  {
    schedule: "0 12 * * *", timeZone: "Europe/Lisbon",
    region: "europe-west1", maxInstances: 1, concurrency: 1,
    timeoutSeconds: 480, memory: "256MiB"
  },
  async () => {
    const db = getFirestore();
    // Status-only collection query uses Firestore's default single-field index.
    // A hard cap bounds daily reads; older/DNP records are excluded by the
    // pure runner's 14-day eligibility window, and do not consume ESPN calls.
    const pending = await db.collection("users").doc(LEDGER_OWNER)
      .collection("propResearchLedger").where("status", "==", "pending")
      .limit(AUTO_LEDGER_SCAN_LIMIT).get();
    const result = await runAutomaticSettlement({
      snapshots: pending.docs, now: Date.now(), db,
      fetchSummary: eventId => ledgerGetEspn("summary?event=" + encodeURIComponent(eventId)),
      extractFinal: ledgerExtractFinalFromEspn,
      serverTimestamp: () => FieldValue.serverTimestamp()
    });
    // Do not log identifying data, player names or manually observed odds.
    console.info("ESPN automatic prospective settlement", {
      ...result, scanLimitReached: pending.size === AUTO_LEDGER_SCAN_LIMIT
    });
    if (pending.size === AUTO_LEDGER_SCAN_LIMIT)
      console.warn("Pending ledger scan cap reached; some records may need manual settlement.");
  }
);
