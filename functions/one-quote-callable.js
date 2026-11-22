"use strict";

const {makeOfflineOneQuoteApproval, makeOfflineLinkedQuoteCollector} =
  require("./offline-one-quote-approval");
const {makeOfflineFixedOriginOddsPapiTransport} =
  require("./manual-odds-fixed-transport");

const publicErrors = new Map([
  ["unauthenticated", "Sign-in required."],
  ["permission-denied", "Verified owner required."],
  ["invalid-argument", "Expected an empty request."],
  ["failed-precondition", "No usable collection approval or collector is disabled."]
]);

function makeOneQuoteCallable({
  getConfig, getDb, ownerUid, reserve, getApiKey, fetchImpl, HttpsError, now = Date.now
}) {
  return async request => {
    try {
      const {enabled, approvalId, scopeJson} = getConfig();
      if (enabled !== "true") throw new HttpsError("failed-precondition", publicErrors.get("failed-precondition"));
      if (!request?.auth) throw new HttpsError("unauthenticated", publicErrors.get("unauthenticated"));
      if (request.auth.uid !== ownerUid || request.auth.token?.email_verified !== true)
        throw new HttpsError("permission-denied", publicErrors.get("permission-denied"));

      const scope = JSON.parse(scopeJson);
      if (!scope || typeof scope !== "object" || Array.isArray(scope))
        throw new TypeError("Missing server scope.");
      const db = getDb();
      const transport = makeOfflineFixedOriginOddsPapiTransport({getApiKey, fetchImpl});
      const collect = makeOfflineLinkedQuoteCollector({
        enabled: true, ownerUid, db, now, reserve, trustedQuoteScope: scope,
        ...transport, readPrivateEvidence: async path => (await db.doc(path).get()).data()
      });
      return await makeOfflineOneQuoteApproval({
        enabled: true, ownerUid, approvalId, db, collect, now
      })(request);
    } catch (error) {
      const code = publicErrors.has(error?.code) ? error.code : "unavailable";
      throw new HttpsError(code, publicErrors.get(code) ?? "Collection attempt did not complete.");
    }
  };
}

module.exports = {makeOneQuoteCallable};
