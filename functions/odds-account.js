"use strict";

// Update 35.1A: allowlist-only summary of the provider's UNMETERED account endpoint.
// Never return API keys, email, account identifiers, subscription IDs, or raw data.
function summarizeOddsAccount(account) {
  if (!account || typeof account !== "object" || !Array.isArray(account.subscriptions)) {
    throw new Error("Unexpected OddsPapi account response.");
  }
  const active = account.subscriptions.filter(s =>
    s && typeof s === "object" && s.is_active === true);
  const selected = active.length === 1 ? active[0] :
    active.filter(s => typeof account.current_subscription_id === "string" &&
      s.subscription_id === account.current_subscription_id)[0];
  if (!selected) return {
    status: "subscription-unavailable",
    monthlyLimit: null, monthlyUsed: null, monthlyRemaining: null,
    priceStatus: "unknown", autoRenew: null, nbaBasketballIncluded: null,
    betanoPtListed: null, betanoPtPlayerProps: null, genericBetanoListed: null
  };

  const validCount = value => Number.isSafeInteger(value) && value >= 0;
  const limit = validCount(selected.request_limit) ? selected.request_limit : null;
  const used = validCount(selected.request_count) ? selected.request_count : null;
  const books = selected.bookmakers && typeof selected.bookmakers === "object" &&
    !Array.isArray(selected.bookmakers) ? selected.bookmakers : {};
  const ptListed = Object.prototype.hasOwnProperty.call(books, "betano.pt");
  const genericListed = Object.prototype.hasOwnProperty.call(books, "betano");
  const pt = ptListed && books["betano.pt"] && typeof books["betano.pt"] === "object" ?
    books["betano.pt"] : null;
  const price = selected.price;
  return {
    status: "ok",
    monthlyLimit: limit,
    monthlyUsed: used,
    monthlyRemaining: limit !== null && used !== null ? Math.max(0, limit - used) : null,
    priceStatus: typeof price === "number" && Number.isFinite(price) ?
      (price === 0 ? "zero-reported" : "nonzero-reported") : "unknown",
    autoRenew: typeof selected.auto_renew === "boolean" ? selected.auto_renew : null,
    nbaBasketballIncluded: Array.isArray(selected.sport_ids) ?
      selected.sport_ids.some(id => id === 11) : null,
    betanoPtListed: ptListed,
    betanoPtPlayerProps: pt && typeof pt.has_player_props === "boolean" ?
      pt.has_player_props : null,
    genericBetanoListed: genericListed
  };
}

module.exports = { summarizeOddsAccount };
