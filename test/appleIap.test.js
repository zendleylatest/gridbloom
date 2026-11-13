const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

process.env.APPLE_BUNDLE_ID = "com.speckpro.gridbloomgame.ios";

// ---- in-memory Purchase model ---------------------------------------------------
const rows = [];
const modelPath = require.resolve("../models/purchaseModel");
require.cache[modelPath] = {
  id: modelPath,
  filename: modelPath,
  loaded: true,
  exports: {
    findOne: async (q) => rows.find((r) => r.key === q.key) || null,
  },
};
const addPurchase = (d) => {
  const row = { status: "active", save: async () => row, ...d };
  rows.push(row);
  return row;
};

const { generateAppleJWT } = require("../services/appleIapService");
const { verifyOneTimePurchase } = require("../services/storePurchaseVerification");
const { applyGridbloomNotification } = require("../controllers/appleNotificationController");

const signedTx = (over = {}) =>
  jwt.sign(
    {
      bundleId: "com.speckpro.gridbloomgame.ios",
      productId: "remove_ads",
      transactionId: "2000",
      originalTransactionId: "2000",
      environment: "Sandbox",
      ...over,
    },
    "not-checked"
  );

// Apple's answer for a transaction id.
function appleDeps(state) {
  return {
    appleJwt: () => "jwt",
    fetch: async (url) => {
      state.urls.push(url);
      const inSandbox = url.includes("storekit-sandbox");
      if (state.down) return { ok: false, status: 503, json: async () => ({}) };
      if (state.sandboxOnly && !inSandbox) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ signedTransactionInfo: signedTx(state.tx) }),
      };
    },
  };
}

test("the App Store Server API token carries the bundle id", () => {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  process.env.APPLE_IAP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).replace(/\n/g, "\\n");
  process.env.APPLE_IAP_KEY_ID = "KEY123";
  process.env.APPLE_IAP_ISSUER_ID = "issuer-1";
  const token = generateAppleJWT();
  const { header, payload } = jwt.decode(token, { complete: true });
  assert.equal(header.alg, "ES256");
  assert.equal(header.kid, "KEY123");
  assert.equal(payload.bid, "com.speckpro.gridbloomgame.ios");
  assert.equal(payload.iss, "issuer-1");
  assert.equal(payload.aud, "appstoreconnect-v1");
});

test("ios: a sandbox purchase is found by retrying in the sandbox", async () => {
  const state = { urls: [], sandboxOnly: true };
  const r = await verifyOneTimePurchase({ platform: "ios", productId: "remove_ads", token: "2000" }, appleDeps(state));
  assert.equal(r.ok, true);
  assert.equal(r.testPurchase, true);
  assert.equal(r.transactionKey, "2000");
  assert.equal(state.urls.length, 2);
});

test("ios: wrong product, other app and refunds are rejected; outages retry", async () => {
  const check = (tx, down) => {
    const state = { urls: [], tx, down };
    return verifyOneTimePurchase({ platform: "ios", productId: "remove_ads", token: "2000" }, appleDeps(state));
  };
  assert.equal((await check({ productId: "gems_40" })).ok, false);
  assert.equal((await check({ bundleId: "com.other.app" })).ok, false);
  const refunded = await check({ revocationDate: Date.now() });
  assert.equal(refunded.ok, false);
  assert.equal(refunded.retryable, false);
  const outage = await check({}, true);
  assert.equal(outage.ok, false);
  assert.equal(outage.retryable, true);
});

test("notification: a refund revokes the purchase, a reversal restores it", async () => {
  rows.length = 0;
  const p = addPurchase({ key: "ios:2000", productId: "remove_ads", token: "2000" });
  const tx = { bundleId: "com.speckpro.gridbloomgame.ios", originalTransactionId: "2000" };

  const refund = await applyGridbloomNotification("REFUND", tx, appleDeps({ urls: [], tx: { revocationDate: Date.now() } }));
  assert.equal(refund, "handled");
  assert.equal(p.status, "revoked");

  const back = await applyGridbloomNotification("REFUND_REVERSED", tx, appleDeps({ urls: [], tx: {} }));
  assert.equal(back, "handled");
  assert.equal(p.status, "active");
});

test("notification: a forged refund changes nothing, an outage asks Apple to retry", async () => {
  rows.length = 0;
  const p = addPurchase({ key: "ios:2000", productId: "remove_ads", token: "2000" });
  const tx = { bundleId: "com.speckpro.gridbloomgame.ios", originalTransactionId: "2000" };

  // The payload claims a refund, but Apple says the purchase is fine.
  assert.equal(await applyGridbloomNotification("REFUND", tx, appleDeps({ urls: [], tx: {} })), "handled");
  assert.equal(p.status, "active");

  assert.equal(await applyGridbloomNotification("REFUND", tx, appleDeps({ urls: [], down: true })), "retry");
  assert.equal(p.status, "active");
});

test("notification: other apps and unknown transactions are left alone", async () => {
  rows.length = 0;
  const deps = appleDeps({ urls: [], tx: {} });
  assert.equal(await applyGridbloomNotification("REFUND", { bundleId: "com.other.app", originalTransactionId: "9" }, deps), "unknown");
  assert.equal(await applyGridbloomNotification("REFUND", { bundleId: "com.speckpro.gridbloomgame.ios", originalTransactionId: "9" }, deps), "unknown");
  assert.equal(await applyGridbloomNotification("TEST", null, deps), "unknown");
});
