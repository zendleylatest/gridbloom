"use strict";
/**
 * The products Gridbloom sells. All are one-time purchases (there are no
 * subscriptions). The same ids are used on Google Play, the App Store and the
 * Amazon Appstore, and in the app (lib/iap/store_products.dart).
 */
const CATALOG = Object.freeze({
  premium_adventure_lifetime: { kind: "entitlement", entitlement: "premium" },
  remove_ads: { kind: "entitlement", entitlement: "removeAds" },
  gems_40: { kind: "consumable", gems: 40 },
  gems_120: { kind: "consumable", gems: 120 },
});

const PLATFORMS = Object.freeze(["android", "ios", "amazon"]);

const productFor = (id) => CATALOG[id] || null;

module.exports = { CATALOG, PLATFORMS, productFor };
