const test = require("node:test");
const assert = require("node:assert/strict");
const { buildAmazonSubscriptionResult } = require("../services/iapVerificationService");

const PRODUCT_ID = "123monthly";
const RECEIPT_ID = "receipt-abc";
const FUTURE_MS = Date.now() + 30 * 24 * 60 * 60 * 1000;
const PAST_MS = Date.now() - 30 * 24 * 60 * 60 * 1000;

function baseResponse(overrides = {}) {
  return {
    productId: PRODUCT_ID,
    receiptId: RECEIPT_ID,
    productType: "SUBSCRIPTION",
    purchaseDate: Date.now() - 60 * 24 * 60 * 60 * 1000,
    renewalDate: FUTURE_MS,
    autoRenewing: true,
    ...overrides,
  };
}

test("active current-format RVS response is verified as active", () => {
  const result = buildAmazonSubscriptionResult(baseResponse(), PRODUCT_ID, RECEIPT_ID);
  assert.equal(result.ok, true);
  assert.equal(result.status, "active");
  assert.equal(result.payload.usedLegacySkuField, false);
});

test("expired/cancelled response (past renewalDate) is not active", () => {
  const result = buildAmazonSubscriptionResult(
    baseResponse({ renewalDate: PAST_MS }),
    PRODUCT_ID,
    RECEIPT_ID
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "expired");
});

test("cancelled response (cancelDate set) is not active", () => {
  const result = buildAmazonSubscriptionResult(
    baseResponse({ cancelDate: Date.now() - 1000 }),
    PRODUCT_ID,
    RECEIPT_ID
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "expired");
});

test("mismatched productId is rejected as invalid, not silently accepted", () => {
  const result = buildAmazonSubscriptionResult(
    baseResponse({ productId: "someone-elses-sku" }),
    PRODUCT_ID,
    RECEIPT_ID
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid");
  assert.equal(result.payload.productMatches, false);
});

test("mismatched receiptId is rejected as invalid", () => {
  const result = buildAmazonSubscriptionResult(
    baseResponse({ receiptId: "different-receipt" }),
    PRODUCT_ID,
    RECEIPT_ID
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid");
  assert.equal(result.payload.receiptMatches, false);
});

test("non-subscription productType is rejected as invalid", () => {
  const result = buildAmazonSubscriptionResult(
    baseResponse({ productType: "CONSUMABLE" }),
    PRODUCT_ID,
    RECEIPT_ID
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid");
});

test("legacy payload without productId falls back to sku field", () => {
  const legacy = baseResponse();
  delete legacy.productId;
  legacy.sku = PRODUCT_ID;
  const result = buildAmazonSubscriptionResult(legacy, PRODUCT_ID, RECEIPT_ID);
  assert.equal(result.ok, true);
  assert.equal(result.payload.usedLegacySkuField, true);
});

test("response missing receiptId entirely is rejected as invalid", () => {
  const noReceipt = baseResponse();
  delete noReceipt.receiptId;
  const result = buildAmazonSubscriptionResult(noReceipt, PRODUCT_ID, RECEIPT_ID);
  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid");
});

test("empty/garbage response is rejected as invalid, not active", () => {
  const result = buildAmazonSubscriptionResult({}, PRODUCT_ID, RECEIPT_ID);
  assert.equal(result.ok, false);
  assert.equal(result.status, "invalid");
});

test("customer cancelled auto-renew mid-term: still active until renewalDate, flagged as not renewing", () => {
  const result = buildAmazonSubscriptionResult(
    baseResponse({ autoRenewing: false, renewalDate: Date.now() + 7 * 24 * 60 * 60 * 1000 }),
    PRODUCT_ID,
    RECEIPT_ID
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "active");
  assert.equal(result.autoRenewing, false);
  assert.equal(
    new Date(result.expiresAt).getTime() > Date.now(),
    true,
    "expiresAt must be the paid-through date so the entitlement ends then"
  );
});

test("after the paid term ends (renewalDate passed + cancelDate set) it is expired", () => {
  const result = buildAmazonSubscriptionResult(
    baseResponse({
      autoRenewing: false,
      renewalDate: Date.now() - 1000,
      cancelDate: Date.now() - 500,
    }),
    PRODUCT_ID,
    RECEIPT_ID
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, "expired");
});

test("free trial end date in the future is reported as a trial", () => {
  const result = buildAmazonSubscriptionResult(
    baseResponse({ freeTrialEndDate: Date.now() + 3 * 24 * 60 * 60 * 1000 }),
    PRODUCT_ID,
    RECEIPT_ID
  );
  assert.equal(result.isTrial, true);
  assert.equal(
    buildAmazonSubscriptionResult(baseResponse(), PRODUCT_ID, RECEIPT_ID).isTrial,
    false
  );
});
