"use strict";

// Update 35.2C — one reviewed, game-specific NBA nonparticipation exception.
// Official NBA evidence is HUMAN-REVIEWED and versioned in this source. It is
// NOT parsed or re-authenticated live. Backend revalidates ESPN Final and the
// player's absence before an owner-requested, idempotent Firestore transaction.
// This cannot be used for arbitrary observations, players, or games.
const { frozenFieldsMatch } = require("./auto-settlement");

const GRACE_MS = 5 * 60 * 1000;
const MIN_AGE_MS = 70 * 60 * 1000;
const REASON = "NBA_OFFICIAL_REVIEWED_INACTIVE";
const SOURCE = "official_nba_pre_reviewed_plus_espn_final_absence";
const REVIEWED_CASE = Object.freeze({
  recordId: "401909968_4251_REB_4p5_Under",
  eventId: "401909968",
  athleteId: "4251",
  teamId: "2",
  homeId: "28",
  awayId: "2",
  eventStartMs: 1794441600000,
  player: "Paul George",
  team: "Boston Celtics",
  home: "Toronto Raptors",
  away: "Boston Celtics",
  market: "REB",
  line: 4.5,
  side: "Under",
  nbaGameId: "0022600219",
  reviewedGame: "BOS@TOR",
  nbaReportStatus: "Out",
  nbaReportReason: "Injury/Illness - Illness",
  nbaReportPublishedEastern: "2026-11-11 16:00 ET",
  nbaReportUrl: "https://ak-static.cms.nba.com/referee/injury/Injury-Report_2026-11-11_04_00PM.pdf",
  nbaPostgameUrl: "https://www.nba.com/game/bos-vs-tor-0022600219",
  nbaPostgameEvidence: "Paul George sat out because of an illness",
  reviewMethod: "fixed_pre_reviewed_official_sources_not_live_parsed"
});

function verifiedReceipt(entry) {
  let ms;
  try { ms = entry?.capturedServerAt?.toMillis?.(); } catch (_) { return null; }
  return Number.isSafeInteger(ms) ? ms : null;
}

function matchReviewedCase(recordId, entry, now, allowAlready = false) {
  if (recordId !== REVIEWED_CASE.recordId || !entry ||
      !Number.isSafeInteger(now) || now < REVIEWED_CASE.eventStartMs + MIN_AGE_MS)
    throw new Error("No reviewed nonparticipation exception applies to this record.");
  for (const field of ["eventId", "athleteId", "teamId", "homeId", "awayId",
    "eventStartMs", "player", "team", "home", "away", "market", "line", "side"])
    if (entry[field] !== REVIEWED_CASE[field])
      throw new Error("Saved ESPN identity or observed selection differs from reviewed case.");
  if (entry.schemaVersion !== 2 || entry.capturedVia !== "trusted_firebase_callable" ||
      !Number.isFinite(entry.odds) || entry.odds < 1.01 ||
      !Number.isFinite(entry.modelSelected) || entry.modelSelected < 0 ||
      entry.modelSelected > 1 || !Number.isFinite(entry.modelOver) ||
      entry.modelOver < 0 || entry.modelOver > 1 ||
      entry.resultStat !== null || entry.resultWon !== null)
    throw new Error("Saved record is not an eligible trusted, unscored observation.");
  const captured = verifiedReceipt(entry);
  if (captured === null || captured >= entry.eventStartMs - GRACE_MS ||
      entry.clientCapturedMs !== captured)
    throw new Error("Original prospective server capture receipt is invalid.");
  if (entry.status === "void" && allowAlready &&
      entry.voidReason === REASON &&
      entry.reconciliationEvidence?.reviewMethod === REVIEWED_CASE.reviewMethod &&
      entry.reconciliationEvidence?.nbaGameId === REVIEWED_CASE.nbaGameId)
    return "already";
  if (entry.status !== "pending" || entry.settledAt != null ||
      entry.voidReason != null || entry.settlementSource != null)
    throw new Error("Reviewed exception requires an unchanged PENDING observation.");
  return "pending";
}

function verifyEspnFinalAbsent(summary, entry) {
  const header = summary?.header, comp = header?.competitions?.[0];
  if (!comp || String(header?.id ?? "") !== String(entry.eventId) ||
      (comp.id != null && String(comp.id) !== String(entry.eventId)))
    throw new Error("ESPN Final game ID mismatch.");
  const started = Date.parse(comp.date || "");
  if (!Number.isFinite(started) || Math.abs(started - entry.eventStartMs) > 120000)
    throw new Error("ESPN game start does not match the saved receipt.");
  const st = comp.status?.type;
  if (!st || !["post", "final"].includes(st.state) ||
      (st.completed !== true && !/^STATUS_FINAL/.test(String(st.name || ""))))
    throw new Error("ESPN game is not explicitly Final.");
  const competitors = comp.competitors;
  if (!Array.isArray(competitors) || competitors.length !== 2)
    throw new Error("ESPN game has ambiguous competitors.");
  const h = competitors.filter(c => c?.homeAway === "home");
  const a = competitors.filter(c => c?.homeAway === "away");
  if (h.length !== 1 || a.length !== 1 ||
      String(h[0].team?.id ?? "") !== String(entry.homeId) ||
      String(a[0].team?.id ?? "") !== String(entry.awayId) ||
      String(entry.teamId) !== String(a[0].team?.id ?? ""))
    throw new Error("ESPN home/away/team identity mismatch.");
  const sides = summary?.boxscore?.players;
  if (!Array.isArray(sides) || !sides.length)
    throw new Error("ESPN box score unavailable.");
  const teamRows = sides.filter(s => String(s?.team?.id ?? "") === String(entry.teamId));
  if (teamRows.length !== 1 || !Array.isArray(teamRows[0].statistics))
    throw new Error("ESPN team box score absent or ambiguous.");
  let examined = 0;
  for (const side of sides) {
    for (const group of side?.statistics || []) {
      if (!Array.isArray(group?.athletes)) continue;
      for (const row of group.athletes) {
        if (String(row?.athlete?.id ?? "") === String(entry.athleteId))
          throw new Error("ESPN contains the player: use normal verified settlement, not the reviewed exception.");
        if (side === teamRows[0] && /^\d{1,20}$/.test(String(row?.athlete?.id ?? "")))
          examined++;
      }
    }
  }
  if (examined === 0)
    throw new Error("ESPN team has no verifiable athlete rows; absence cannot be assessed.");
  return { eventId: String(entry.eventId), teamId: String(entry.teamId),
    athleteId: String(entry.athleteId), checkedTeamAthletes: examined };
}

function makeEvidence(checked) {
  return {
    schemaVersion: 1,
    source: SOURCE,
    reviewMethod: REVIEWED_CASE.reviewMethod,
    nbaGameId: REVIEWED_CASE.nbaGameId,
    nbaReportUrl: REVIEWED_CASE.nbaReportUrl,
    nbaReportPublishedEastern: REVIEWED_CASE.nbaReportPublishedEastern,
    nbaReportStatus: REVIEWED_CASE.nbaReportStatus,
    nbaReportReason: REVIEWED_CASE.nbaReportReason,
    nbaPostgameUrl: REVIEWED_CASE.nbaPostgameUrl,
    espnEventId: checked.eventId,
    espnTeamId: checked.teamId,
    espnAthleteId: checked.athleteId,
    espnReviewedTeamAthletes: checked.checkedTeamAthletes,
    disclaimer: "Official NBA sources manually reviewed; not fetched or parsed by this callable. ESPN Final and absence checked live. No independently verified Betano void."
  };
}

async function reconcileReviewedInactive({ db, uid, recordId, now,
  fetchEspnFinal, serverTimestamp }) {
  if (!db || typeof db.doc !== "function" || !/^[A-Za-z0-9]+$/.test(String(uid || "")) ||
      typeof fetchEspnFinal !== "function" || typeof serverTimestamp !== "function" ||
      typeof recordId !== "string" || recordId !== REVIEWED_CASE.recordId)
    throw new Error("Invalid or unsupported reviewed reconciliation request.");
  const ref = db.doc("users/" + uid + "/propResearchLedger/" + recordId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Saved observation not found.");
  const original = snap.data();
  const state = matchReviewedCase(recordId, original, now, true);
  if (state === "already") return { voided:true, alreadyReconciled:true,
    reason:REASON, recordId };
  // Only one free ESPN summary request; never call OddsPapi or NBA paid APIs.
  const final = await fetchEspnFinal(original.eventId);
  const checked = verifyEspnFinalAbsent(final, original);
  const evidence = makeEvidence(checked);
  const wrote = await db.runTransaction(async tx => {
    const currentSnap = await tx.get(ref);
    if (!currentSnap.exists) throw new Error("Record disappeared before reconciliation.");
    const current = currentSnap.data();
    if (!frozenFieldsMatch(original, current))
      throw new Error("Frozen research fields changed since verification.");
    if (matchReviewedCase(recordId, current, now, true) === "already") return false;
    matchReviewedCase(recordId, current, now, false);
    tx.update(ref, {
      status: "void", voidReason: REASON,
      resultStat: null, resultWon: null, settledAt: serverTimestamp(),
      settlementSource: "Official NBA pre-reviewed inactive evidence; ESPN Final athlete absent",
      reconciliationEvidence: evidence
    });
    return true;
  }, { maxAttempts: 3 });
  return {voided:true,alreadyReconciled:!wrote,reason:REASON,recordId};
}

module.exports = { REVIEWED_CASE, REASON, SOURCE, verifiedReceipt,
  matchReviewedCase, verifyEspnFinalAbsent, makeEvidence, reconcileReviewedInactive };
