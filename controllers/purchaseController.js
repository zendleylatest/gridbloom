"use strict";
const Purchase = require("../models/purchaseModel");
const { PLATFORMS, productFor } = require("../services/storeCatalog");
const { verifyOneTimePurchase, acknowledgeAndroid } = require("../services/storePurchaseVerification");
const { entitlementsFor, pendingGrants, refreshStaleEntitlements } = require("../services/entitlementService");

// Tests replace these to avoid talking to the stores.
const hooks = { verifyDeps: undefined, acknowledge: acknowledgeAndroid };

function guestBlocked(user, res) {
  if (user.isGuest) {
    res.status(403).json({ code: "LINK_ACCOUNT", error: "Link an account to buy." });
    return true;
  }
  return false;
}

async function snapshot(userId) {
  return { ...(await entitlementsFor(userId)), pending: await pendingGrants(userId) };
}

/**
 * POST /api/purchases/verify
 * Body: { platform, productId, purchaseToken, storeUserId? }
 *   purchaseToken: Google Play purchase token | App Store transaction id |
 *   Amazon receipt id.
 * Checks the purchase with the store, records it once, and returns what the
 * player now owns plus any gems waiting to be credited.
 */
async function verifyPurchase(req, res) {
  try {
    const user = req.authUser;
    if (guestBlocked(user, res)) return;
    const { platform, productId, purchaseToken, storeUserId } = req.body || {};
    const product = productFor(productId);
    if (!PLATFORMS.includes(platform) || !product || typeof purchaseToken !== "string" || !purchaseToken) {
      return res.status(400).json({ error: "platform, productId and purchaseToken are required." });
    }

    const result = await verifyOneTimePurchase(
      { platform, productId, token: purchaseToken, storeUserId },
      hooks.verifyDeps
    );
    if (!result.ok) {
      // The store could not be reached: the app keeps the purchase and retries.
      if (result.retryable) {
        return res.status(503).json({ retryable: true, error: "Could not reach the store. Try again shortly." });
      }
      console.warn(`[purchase] rejected ${platform}/${productId} for ${user._id}: ${result.reason}`);
      return res.status(400).json({ error: "This purchase could not be verified.", reason: result.reason });
    }

    const key = `${platform}:${result.transactionKey}`;
    let purchase = await Purchase.findOne({ key });
    if (purchase && String(purchase.userId) !== String(user._id)) {
      if (product.kind === "consumable") {
        return res.status(409).json({ code: "ALREADY_REDEEMED", error: "This purchase was already used on another account." });
      }
      // An unlock follows the store account: restoring on a new profile moves it.
      purchase.userId = user._id;
      purchase.status = "active";
      purchase.verifiedAt = new Date();
      await purchase.save();
    } else if (!purchase) {
      try {
        purchase = await Purchase.create({
          userId: user._id,
          key,
          platform,
          productId,
          kind: product.kind,
          entitlement: product.entitlement || null,
          gems: product.gems || 0,
          token: purchaseToken,
          storeUserId: storeUserId || null,
          orderId: result.orderId,
          testPurchase: Boolean(result.testPurchase),
        });
      } catch (err) {
        if (err?.code !== 11000) throw err;
        purchase = await Purchase.findOne({ key }); // a parallel request recorded it
      }
    } else if (purchase.status === "revoked") {
      purchase.status = "active";
      purchase.verifiedAt = new Date();
      await purchase.save();
    }

    // Google refunds unacknowledged purchases after three days.
    if (platform === "android" && product.kind === "entitlement" && result.acknowledged === false) {
      hooks.acknowledge({ productId, token: purchaseToken }).catch((e) =>
        console.warn("[purchase] acknowledge failed:", e.message)
      );
    }

    return res.json({
      purchase: { id: String(purchase._id), productId, kind: product.kind, gems: purchase.gems, claimed: Boolean(purchase.claimedAt) },
      ...(await snapshot(user._id)),
    });
  } catch (error) {
    console.error("[purchase:verify]", error);
    return res.status(500).json({ error: "Could not verify the purchase." });
  }
}

/** GET /api/purchases/entitlements — what the player owns and gems to credit. */
async function getEntitlements(req, res) {
  try {
    await refreshStaleEntitlements(req.authUser._id, { deps: hooks.verifyDeps });
    return res.json(await snapshot(req.authUser._id));
  } catch (error) {
    console.error("[purchase:entitlements]", error);
    return res.status(500).json({ error: "Could not load purchases." });
  }
}

/** POST /api/purchases/claim { ids } — the app credited these gem packs. */
async function claimGrants(req, res) {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((x) => typeof x === "string").slice(0, 50) : [];
    const rows = await Purchase.find({ _id: { $in: ids }, userId: req.authUser._id, kind: "consumable" });
    for (const p of rows) {
      if (!p.claimedAt) {
        p.claimedAt = new Date();
        await p.save();
      }
    }
    return res.json({ claimed: rows.map((p) => String(p._id)) });
  } catch (error) {
    console.error("[purchase:claim]", error);
    return res.status(500).json({ error: "Could not confirm the purchase." });
  }
}

module.exports = { verifyPurchase, getEntitlements, claimGrants, hooks };
