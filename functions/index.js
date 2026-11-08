"use strict";
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");

initializeApp();

// First deployment: authentication-only health check.
// OddsPapi API key and external requests will be added in a later step.
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
      message: "Authenticated Firebase backend is ready. No odds requests are enabled yet."
    };
  }
);
