"use strict";

// Update 35.1D15.34: offline regression assertions for trust-accurate wording
// after one owner-approved live OddsPapi preview and ESPN roster-name check.
// No browser, Firebase, provider or ESPN requests are run by this test.
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");

const html=fs.readFileSync(path.join(__dirname,"..","index.html"),"utf8");
const doesNotSay=phrase=>assert.ok(!html.includes(phrase),phrase);
const says=phrase=>assert.ok(html.includes(phrase),phrase);

test("D15.34 diagnostic button identifies OddsPapi, not independent Betano verification",()=>{
  says('id="verifiedPropsBtn" type="button" class="mini">Preview OddsPapi Betano-market props');
  says("OddsPapi market preview loaded");
  says("Recognized full-game market IDs: ");
  doesNotSay("Preview verified Betano props");
  doesNotSay("Verified market preview loaded");
  doesNotSay("Verified full-game market IDs: ");
});

test("D15.34 sample table labels price as OddsPapi-reported Betano PT",()=>{
  says("'OddsPapi price (Betano PT)','Provider main line'");
  says("No active provider-reported full-game player-prop prices were returned.");
  doesNotSay("'Betano odds','Provider main line'");
  doesNotSay("No active, verified full-game player-prop prices were returned.");
});

test("D15.34 ESPN roster match permits only clearly marked unverified transfer",()=>{
  says("ESPN roster name matched; the OddsPapi-reported Betano price is not independently bookmaker-verified.");
  says("Manual transfer to Props Analyzer is for historical research only.");
  says('id="espnSendToAnalyzer" type="button" class="primary mini" hidden>Use provider quote preview in Props Analyzer');
  doesNotSay("Verified Betano offer ready for manual transfer to Props Analyzer.");
  doesNotSay("Use this verified Betano offer in Props Analyzer");
});

test("D15.34 Analyzer receives research-only quote language without price authentication claims",()=>{
  says("OddsPapi-reported line and ESPN roster-name match transferred; bookmaker price is not independently verified.");
  says("Analyze player for historical comparison only.");
  doesNotSay("Verified Betano line and ESPN player selected.");
});

test("D15.34 existing research preview no longer claims independently verified offers",()=>{
  says("Compare an OddsPapi-reported Betano-market preview with ESPN's recent game history");
  says("Only that small provider sample is analysed; bookmaker prices are not independently verified.");
  doesNotSay("Compare a verified Betano preview with ESPN's recent game history");
  doesNotSay("including a line copied from an existing verified Betano preview");
  doesNotSay("Prefilled from an earlier verified preview: ");
});

test("D15.34 explicit manual reservation confirmation remains intact",()=>{
  says("document.getElementById('verifiedPropsBtn')?.addEventListener('click',async()=>");
  says("if(!auth.currentUser){status.textContent='Sign in first.';return}");
  says("if(!confirm('Preview active full-game Betano PT player props? This reserves 2 of your 6 daily OddsPapi diagnostic requests. No bets will be placed.'))return;");
  says("httpsCallable(oddsFunctions,'oddsPapiVerifiedPropsProbe')({})");
});

test("D15.34 ESPN lookup still requires user-selected team and unique matching roster identity",()=>{
  says('document.getElementById("espnIdentityBtn")?.addEventListener("click",async()=>');
  says('const found=new Map(people.filter(x=>canonicalPlayerName(x.displayName)===lookup)');
  says("if(found.size===1)");
  says("ESPN roster match: ");
  says("Availability not confirmed.");
});

test("D15.34 original provider quote binding and analyzer event are preserved",()=>{
  says("selectedPreviewOffer={");
  says("oddsPapiPlayerId:String(x.oddsPapiPlayerId||\"\")");
  says('new CustomEvent("tracker-verified-odds-to-analyzer"');
  says("v.offer!==selectedPreviewOffer");
  says("Date.parse(v.startTime)<=Date.now()");
});

test("D15.34 Lisbon time formatting and disabled research capture expectations remain",()=>{
  says("timeZone:'Europe/Lisbon'");
  says("hour12:false");
  says("No picks.");
  // Static source regression only: confirm no external client SDK imports
  // in this standalone test; runtime behavior is handled by existing suites.
  const testSource=fs.readFileSync(__filename,"utf8");
  assert.doesNotMatch(testSource,
    /require\(["'](?:node:http|node:https|firebase-admin|firebase-functions)["']\)/);
});
