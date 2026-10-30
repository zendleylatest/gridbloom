const test = require("node:test");
const assert = require("node:assert/strict");

// ---- in-memory Purchase model --------------------------------------------------
const rows = [];
let nextId = 1;
const matches = (doc, q) =>
  Object.entries(q).every(([k, v]) => {
    if (v && typeof v === "object" && "$in" in v) return v.$in.map(String).includes(String(doc[k]));
    if (v && typeof v === "object" && "$lt" in v) return doc[k] < v.$lt;
    return String(doc[k]) === String(v);
  });
const wrap = (d) => Object.assign(d, { save: async () => d });
const modelPath = require.resolve("../models/purchaseModel");
const Model = {
  find: (q) => {
    const out = rows.filter((r) => matches(r, q));
    const p = Promise.resolve(out);
    p.lean = async () => out.map((r) => ({ ...r }));
    return p;
  },
  findOne: async (q) => rows.find((r) => matches(r, q)) || null,
  create: async (d) => {
    if (rows.some((r) => r.key === d.key)) throw Object.assign(new Error("dup"), { code: 11000 });
    const row = wrap({ _id: `p${nextId++}`, status: "active", claimedAt: null, verifiedAt: new Date(), ...d });
    rows.push(row);
    return row;
  },
};
// make find() results saveable for refresh logic
const origFind = Model.find;
Model.find = (q) => {
  const p = origFind(q);
  const base = p.then.bind(p);
  p.then = (res, rej) => base((out) => out.map(wrap)).then(res, rej);
  return p;
};
require.cache[modelPath] = { id: modelPath, filename: modelPath, loaded: true, exports: Model };

const verification = require("../services/storePurchaseVerification");
const { verifyOneTimePurchase } = verification;
const c = require("../controllers/purchaseController");
const { refreshStaleEntitlements, entitlementsFor } = require("../services/entitlementService");

const call = (handler, req) =>
  new Promise((resolve, reject) => {
    const res = { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
    Promise.resolve(handler({ body: {}, ...req }, res)).catch(reject);
  });
const user = (id, isGuest = false) => ({ _id: id, isGuest });
const reset = () => { rows.length = 0; nextId = 1; };

// A fake store: tokens decide the answer.
function fakeDeps(state = {}) {
  return {
    googleToken: async () => "tok",
    appleJwt: () => "jwt",
    amazonSecret: () => "secret",
    amazonSandbox: () => false,
    fetch: async (url) => {
      state.calls = (state.calls || 0) + 1;
      const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
      if (url.includes("androidpublisher")) {
        if (url.includes("badtoken")) return json(404, { error: { message: "not found" } });
        if (url.includes("refunded")) return json(200, { purchaseState: 1 });
        if (url.includes("storedown")) return json(503, {});
        if (url.includes("pending")) return json(200, { purchaseState: 2 });
        return json(200, { purchaseState: 0, orderId: "GPA.1", acknowledgementState: 0, purchaseType: 0 });
      }
      if (url.includes("amazon.com")) {
        const receipt = decodeURIComponent(url.split("/receiptId/")[1]);
        return json(200, { productId: state.amazonSku || "gems_40", receiptId: receipt, productType: "CONSUMABLE" });
      }
      return json(404, {});
    },
  };
}

test("catalog: one-time products only", () => {
  const { CATALOG } = require("../services/storeCatalog");
  assert.deepEqual(Object.keys(CATALOG).sort(), ["gems_120", "gems_40", "premium_adventure_lifetime", "remove_ads"]);
  assert.ok(Object.values(CATALOG).every((p) => p.kind === "entitlement" || p.kind === "consumable"));
});

test("store verification: google outcomes", async () => {
  const d = fakeDeps();
  const ok = await verifyOneTimePurchase({ platform: "android", productId: "gems_40", token: "t1" }, d);
  assert.equal(ok.ok, true);
  assert.equal(ok.transactionKey, "t1");
  assert.equal((await verifyOneTimePurchase({ platform: "android", productId: "gems_40", token: "badtoken" }, d)).retryable, false);
  assert.equal((await verifyOneTimePurchase({ platform: "android", productId: "gems_40", token: "refunded" }, d)).ok, false);
  assert.equal((await verifyOneTimePurchase({ platform: "android", productId: "gems_40", token: "storedown" }, d)).retryable, true);
  assert.equal((await verifyOneTimePurchase({ platform: "nope", productId: "gems_40", token: "x" }, d)).ok, false);
});

test("store verification: amazon checks sku and receipt", async () => {
  const d = fakeDeps();
  const ok = await verifyOneTimePurchase({ platform: "amazon", productId: "gems_40", token: "r1", storeUserId: "u" }, d);
  assert.equal(ok.ok, true);
  const wrong = await verifyOneTimePurchase({ platform: "amazon", productId: "gems_120", token: "r1", storeUserId: "u" }, d);
  assert.equal(wrong.ok, false);
  assert.equal((await verifyOneTimePurchase({ platform: "amazon", productId: "gems_40", token: "r1" }, d)).ok, false);
});

test("guests cannot buy; bad requests are rejected", async () => {
  reset();
  c.hooks.verifyDeps = fakeDeps();
  const g = await call(c.verifyPurchase, { authUser: user("g", true), body: { platform: "android", productId: "gems_40", purchaseToken: "t" } });
  assert.equal(g.status, 403);
  assert.equal(g.body.code, "LINK_ACCOUNT");
  const bad = await call(c.verifyPurchase, { authUser: user("a"), body: { platform: "android", productId: "free_gems", purchaseToken: "t" } });
  assert.equal(bad.status, 400);
});

test("gems are recorded once, credited once, and never re-granted", async () => {
  reset();
  c.hooks.verifyDeps = fakeDeps();
  const a = user("a");
  const first = await call(c.verifyPurchase, { authUser: a, body: { platform: "android", productId: "gems_120", purchaseToken: "tokA" } });
  assert.equal(first.status, 200);
  assert.equal(first.body.purchase.gems, 120);
  assert.equal(first.body.pending.length, 1);
  // The same token again (app resent it): no second grant.
  const again = await call(c.verifyPurchase, { authUser: a, body: { platform: "android", productId: "gems_120", purchaseToken: "tokA" } });
  assert.equal(again.body.pending.length, 1);
  assert.equal(rows.length, 1);
  const id = first.body.purchase.id;
  await call(c.claimGrants, { authUser: a, body: { ids: [id] } });
  const ent = await call(c.getEntitlements, { authUser: a });
  assert.equal(ent.body.pending.length, 0);
  // Another account cannot redeem the same gem pack.
  const other = await call(c.verifyPurchase, { authUser: user("b"), body: { platform: "android", productId: "gems_120", purchaseToken: "tokA" } });
  assert.equal(other.status, 409);
  assert.equal(other.body.code, "ALREADY_REDEEMED");
});

test("unlocks become entitlements and follow the store account", async () => {
  reset();
  c.hooks.verifyDeps = fakeDeps();
  c.hooks.acknowledge = async () => true;
  const r = await call(c.verifyPurchase, { authUser: user("a"), body: { platform: "android", productId: "premium_adventure_lifetime", purchaseToken: "tokP" } });
  assert.equal(r.body.premium, true);
  assert.equal(r.body.removeAds, false);
  const r2 = await call(c.verifyPurchase, { authUser: user("a"), body: { platform: "android", productId: "remove_ads", purchaseToken: "tokR" } });
  assert.equal(r2.body.removeAds, true);
  assert.equal((await entitlementsFor("a")).premium, true);
  // Restoring on a new profile moves the unlock there.
  const moved = await call(c.verifyPurchase, { authUser: user("b"), body: { platform: "android", productId: "premium_adventure_lifetime", purchaseToken: "tokP" } });
  assert.equal(moved.body.premium, true);
  assert.equal((await entitlementsFor("a")).premium, false);
});

test("an unreachable store is retryable, not a refusal", async () => {
  reset();
  c.hooks.verifyDeps = fakeDeps();
  const r = await call(c.verifyPurchase, { authUser: user("a"), body: { platform: "android", productId: "gems_40", purchaseToken: "storedown" } });
  assert.equal(r.status, 503);
  assert.equal(r.body.retryable, true);
  assert.equal(rows.length, 0);
  const bad = await call(c.verifyPurchase, { authUser: user("a"), body: { platform: "android", productId: "gems_40", purchaseToken: "badtoken" } });
  assert.equal(bad.status, 400);
});

test("a refund takes the unlock away at the next daily re-check; an outage does not", async () => {
  reset();
  const deps = fakeDeps();
  c.hooks.verifyDeps = deps;
  c.hooks.acknowledge = async () => true;
  await call(c.verifyPurchase, { authUser: user("a"), body: { platform: "android", productId: "remove_ads", purchaseToken: "tokOK" } });
  assert.equal((await entitlementsFor("a")).removeAds, true);
  const day = 24 * 3600 * 1000;
  // Too soon: nothing is re-checked.
  const callsBefore = deps.calls;
  await refreshStaleEntitlements("a", { now: Date.now() + 1000, deps });
  assert.equal(deps.calls, callsBefore);
  // Store outage after a day: unlock stays.
  rows[0].token = "storedown";
  await refreshStaleEntitlements("a", { now: Date.now() + 2 * day, deps });
  assert.equal((await entitlementsFor("a")).removeAds, true);
  // Refunded: unlock removed.
  rows[0].token = "refunded";
  await refreshStaleEntitlements("a", { now: Date.now() + 2 * day, deps });
  assert.equal((await entitlementsFor("a")).removeAds, false);
});
