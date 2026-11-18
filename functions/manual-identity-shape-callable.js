"use strict";

// D15.1: testable, owner-only HTTP-callable boundary for the separately named
// identity-schema diagnostic. This module has NO provider, Firebase or IO imports.
function makeManualIdentityShapeCallable({
  enabled = false, ownerUid, run, secretAvailable, HttpsError
} = {}) {
  if (typeof enabled !== "boolean" || typeof ownerUid !== "string" ||
      ownerUid.length === 0 || typeof run !== "function" ||
      typeof secretAvailable !== "function" || typeof HttpsError !== "function")
    throw new TypeError("Missing trusted identity callable dependencies.");

  const reject = (code, message) => new HttpsError(code, message);
  return Object.freeze(async request => {
    // No disabled-state feedback, secret read, reservation, cache or HTTP
    // access is exposed to unauthenticated or unverified callers.
    if (!request?.auth || request.auth.uid !== ownerUid ||
        request.auth.token?.email_verified !== true)
      throw reject("permission-denied",
        "Only the verified owner may inspect OddsPapi identity schema.");

    let emptyPayload = false;
    try {
      const data = request.data;
      emptyPayload = data == null ||
        (typeof data === "object" && !Array.isArray(data) &&
         Object.keys(data).length === 0);
    } catch (_) { /* Untrusted getters must fail closed. */ }
    if (!emptyPayload)
      throw reject("invalid-argument",
        "Identity-schema diagnostic accepts no parameters.");

    // Independent backend constant, never controlled by request data or env.
    if (!enabled)
      throw reject("failed-precondition",
        "Identity-schema diagnostic is disabled. No provider request made.");

    // Check credential presence BEFORE consuming a reservation; never leak it.
    let hasSecret = false;
    try { hasSecret = secretAvailable() === true; } catch (_) { /* redacted */ }
    if (!hasSecret)
      throw reject("failed-precondition",
        "Identity-schema diagnostic credential unavailable. No provider request made.");

    try {
      // D15 runner reasserts owner+empty data, handles transactional UTC
      // budget, single fixed-origin fetch, in-flight dedupe and short cache.
      return await run(request);
    } catch (_) {
      // An exception after reservation may still have cost one paid request.
      // Do not echo raw provider text or silently retry.
      throw reject("unavailable",
        "Identity-schema diagnostic unavailable. One UTC-day reservation and paid provider request may have been consumed. Do not retry automatically.");
    }
  });
}

module.exports = { makeManualIdentityShapeCallable };
