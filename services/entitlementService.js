"use strict";
const Purchase = require("../models/purchaseModel");
const { verifyOneTimePurchase } = require("./storePurchaseVerification");

const RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

/** What the player owns, derived only from verified purchases. */
async function entitlementsFor(userId) {
  const rows = await Purchase.find({ userId, kind: "entitlement", status: "active" }).lean();
  const has = (name) => rows.some((r) => r.entitlement === name);
  return { premium: has("premium"), removeAds: has("removeAds") };
}

/** Gem packs bought and verified but not yet credited by the app. */
async function pendingGrants(userId) {
  const rows = await Purchase.find({
    userId,
    kind: "consumable",
    status: "active",
    claimedAt: null,
  }).lean();
  return rows.map((r) => ({ id: String(r._id), productId: r.productId, gems: r.gems }));
}

/**
 * Re-checks entitlement purchases with the store about once a day, so a
 * refund takes the unlock away again. A store that is unreachable never
 * revokes anything.
 */
async function refreshStaleEntitlements(userId, { now = Date.now(), deps } = {}) {
  const stale = await Purchase.find({
    userId,
    kind: "entitlement",
    status: "active",
    verifiedAt: { $lt: new Date(now - RECHECK_AFTER_MS) },
  });
  for (const p of stale) {
    const res = await verifyOneTimePurchase(
      { platform: p.platform, productId: p.productId, token: p.token, storeUserId: p.storeUserId },
      deps
    );
    if (res.ok) {
      p.verifiedAt = new Date(now);
    } else if (!res.retryable) {
      p.status = "revoked";
    } else {
      continue;
    }
    await p.save();
  }
}

module.exports = { entitlementsFor, pendingGrants, refreshStaleEntitlements, RECHECK_AFTER_MS };
