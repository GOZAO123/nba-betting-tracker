"use strict";

// Update 35.1D5: offline, allowlisted identity evidence extraction from an
// ALREADY-FETCHED, separately owner-authorized manual OddsPapi league response.
// No network, storage, credentials, approval, line choice or production wiring.
const { randomUUID } = require("node:crypto");
const { captureProviderFixture } = require("./offer-team-evidence");

const MAX_FIXTURES = 250;
const MAX_EVIDENCE_ROWS = 64;
const HORIZON_MS = 72 * 60 * 60 * 1000;
const MIN_BEFORE_START_MS = 5 * 60 * 1000;
const SOURCE = "ODDSPAPI_V4_ODDS_BY_TOURNAMENTS";

const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const timestamp = x => typeof x === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(x) &&
  Number.isFinite(Date.parse(x)) ? Date.parse(x) : NaN;
const fixtureArray = payload => Array.isArray(payload) ? payload :
  Array.isArray(payload?.data) ? payload.data :
  Array.isArray(payload?.fixtures) ? payload.fixtures : null;

function extractManualProviderIdentityBatch(payload, capturedAt) {
  const capturedMs = timestamp(capturedAt);
  const fixtures = fixtureArray(payload);
  if (!Number.isFinite(capturedMs) || !fixtures ||
      fixtures.length > MAX_FIXTURES) return null;

  // Duplicate IDs are quarantined in their entirety, not first-wins.
  // This stays bounded at MAX_FIXTURES and never scans individual odds/players.
  const seen = new Set(), duplicates = new Set();
  for (const fixture of fixtures) {
    const key = typeof fixture?.fixtureId === "string" ? fixture.fixtureId : null;
    if (key) {
      if (seen.has(key)) duplicates.add(key);
      seen.add(key);
    }
  }

  const snapshotReference =
    "ODDSPAPI_MANUAL_" + randomUUID().replace(/-/g, "").toUpperCase();
  const records = [];
  let rejected = 0;
  for (const fixture of fixtures) {
    if (!object(fixture) || duplicates.has(fixture.fixtureId)) {
      rejected++;
      continue;
    }
    // This is an exact provider-source filter, not a verified bookmaker offer.
    const book = fixture.bookmakerOdds?.["betano.pt"];
    if (!object(book) || book.bookmakerIsActive !== true ||
        book.suspended === true || !object(book.markets)) {
      rejected++;
      continue;
    }
    const start = timestamp(fixture.startTime);
    if (!Number.isFinite(start) ||
        start <= capturedMs + MIN_BEFORE_START_MS ||
        start > capturedMs + HORIZON_MS) {
      rejected++;
      continue;
    }
    // D4 requires explicit NBA sport/tournament, scheduled status and two
    // nonduplicated numeric participant IDs. Missing fields are NOT guessed.
    const normalized = captureProviderFixture(fixture, {
      reference: snapshotReference, capturedAt
    });
    if (!normalized) {
      rejected++;
      continue;
    }
    records.push(normalized);
    if (records.length > MAX_EVIDENCE_ROWS) return null;
  }

  return Object.freeze({
    schemaVersion: 1,
    source: SOURCE,
    status: "UNREVIEWED_PROVIDER_EVIDENCE",
    snapshotReference,
    capturedAt,
    totalFixtures: fixtures.length,
    acceptedFixtures: records.length,
    rejectedFixtures: rejected,
    records: Object.freeze(records)
  });
}

module.exports = { extractManualProviderIdentityBatch };
