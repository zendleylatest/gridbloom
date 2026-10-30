const mongoose = require("mongoose");

/**
 * A verified one-time store purchase (no subscriptions in Gridbloom).
 *  - entitlement products (Lifetime Adventure Unlock, Remove Ads) stay
 *    active until the store refunds them;
 *  - consumable products (gems) are granted once: [claimedAt] is set when
 *    the app has credited them.
 * [key] is `<platform>:<store transaction id>` and is unique, so a purchase
 * can never be redeemed twice.
 */
const purchaseSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "users", required: true, index: true },
    key: { type: String, required: true, unique: true },
    platform: { type: String, enum: ["android", "ios", "amazon"], required: true },
    productId: { type: String, required: true },
    kind: { type: String, enum: ["entitlement", "consumable"], required: true },
    entitlement: { type: String, default: null }, // "premium" | "removeAds"
    gems: { type: Number, default: 0 },
    status: { type: String, enum: ["active", "revoked"], default: "active", index: true },
    // What the store needs to look the purchase up again (refund checks).
    token: { type: String, required: true },
    storeUserId: { type: String, default: null },
    orderId: { type: String, default: null },
    testPurchase: { type: Boolean, default: false },
    verifiedAt: { type: Date, default: Date.now },
    claimedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Purchase", purchaseSchema);
