"use strict";

// Update 35.1D9: OFFLINE, inert, fixed-origin OddsPapi transport contract.
// All HTTP effects and secret access are injected. No scheduled work, Firebase
// initialization, production wiring, or request is made at construction.
const ORIGIN = "https://api.oddspapi.io";
const MARKET_PATH = "/v4/markets";
const LEAGUE_PATH = "/v4/odds-by-tournaments";
const MARKET_LIMIT = 32 * 1024 * 1024;
const LEAGUE_LIMIT = 12 * 1024 * 1024;
const MAX_CHUNKS = 8192;
const TIMEOUT_MS = 35000;
const SAFE_FAILURE = "Manual OddsPapi transport unavailable; a reserved request may have been consumed.";

function safeJsonStream(response, expectedUrl, limit) {
  // A rejected redirect must not be accepted even if a malicious/mock fetcher
  // returns an apparently successful response at another URL.
  if (!response || response.ok !== true || response.redirected === true ||
      (typeof response.url === "string" && response.url.length > 0 &&
        response.url !== expectedUrl) ||
      !response.body || typeof response.body.getReader !== "function")
    throw new Error("Unsafe provider response.");
  const type = response.headers?.get?.("content-type");
  if (type != null && !/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|\s*$)/i.test(type))
    throw new Error("Unexpected response content type.");
  const length = response.headers?.get?.("content-length");
  if (length != null && length !== "") {
    if (!/^\d+$/.test(length) || Number(length) > limit)
      throw new Error("Provider response too large.");
  }

  return (async () => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8",{fatal:true});
    let bytes = 0, chunks = 0, text = "", done = false;
    try {
      while (!done) {
        if (++chunks > MAX_CHUNKS) throw new Error("Provider response chunk limit.");
        const item = await reader.read();
        if (!item || typeof item.done !== "boolean")
          throw new Error("Invalid response stream.");
        if (item.done) { done = true; break; }
        const value = item.value;
        if (!(value instanceof Uint8Array) || value.byteLength < 1)
          throw new Error("Invalid streamed bytes.");
        bytes += value.byteLength;
        if (bytes > limit) throw new Error("Provider response byte limit.");
        text += decoder.decode(value,{stream:true});
      }
      text += decoder.decode();
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object")
        throw new Error("Invalid provider payload.");
      return parsed;
    } finally {
      if (!done) {
        try { await reader.cancel(); } catch (_) { /* ignored */ }
      }
      try { reader.releaseLock(); } catch (_) { /* ignored */ }
    }
  })();
}

function makeOfflineFixedOriginOddsPapiTransport({
  getApiKey, fetchImpl, makeSignal = ms => AbortSignal.timeout(ms)
}={}) {
  if ([getApiKey,fetchImpl,makeSignal].some(fn=>typeof fn!=="function"))
    throw new TypeError("Missing trusted provider transport dependencies.");

  async function request(path, params, limit) {
    try {
      // Secret evaluated ONLY on invocation, never on construction or import.
      const key = getApiKey();
      if (typeof key !== "string" || !key ||
          key.length > 256 || /[\u0000-\u001f\u007f]/.test(key))
        throw new Error("Missing protected provider credential.");
      const url = new URL(ORIGIN + path);
      for (const [name,value] of Object.entries(params))
        url.searchParams.set(name,value);
      url.searchParams.set("apiKey",key);
      const target = url.toString();
      // Redirects are disallowed, including from the expected origin. No
      // credentials/cookies are forwarded, even to a second host.
      const response = await fetchImpl(target,Object.freeze({
        method:"GET",redirect:"error",cache:"no-store",credentials:"omit",
        headers:Object.freeze({Accept:"application/json"}),
        signal:makeSignal(TIMEOUT_MS)
      }));
      return await safeJsonStream(response,target,limit);
    } catch (_) {
      // Never echo raw HTTP/provider text, URL query, API key or stack trace.
      throw new Error(SAFE_FAILURE);
    }
  }
  return Object.freeze({
    fetchCatalogue:()=>request(MARKET_PATH,{language:"en"},MARKET_LIMIT),
    fetchOdds:()=>request(LEAGUE_PATH,{
      tournamentIds:"132",bookmaker:"betano.pt",language:"en",verbosity:"3"
    },LEAGUE_LIMIT)
  });
}

module.exports={makeOfflineFixedOriginOddsPapiTransport};
