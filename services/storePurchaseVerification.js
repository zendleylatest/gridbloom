"use strict";
/**
 * Asks the store whether a one-time purchase really happened. Talks to the
 * store directly (Google Play Developer API, App Store Server API, Amazon
 * RVS): no third-party purchase service involved.
 *
 * Result: { ok, retryable, transactionKey, orderId, testPurchase, reason }.
 *  - ok: the purchase is real and not refunded;
 *  - retryable: the store could not be reached / is misconfigured, so this
 *    says nothing about the purchase (do not treat it as a refund).
 */
const jwt = require("jsonwebtoken");

const PACKAGE = () => process.env.ANDROID_PACKAGE_NAME || "com.speckpro.gridbloomgame.android";
const BUNDLE = () => process.env.APPLE_BUNDLE_ID || "com.speckpro.gridbloomgame.android";
const GOOGLE_API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

function defaults() {
  const iap = require("./iapVerificationService");
  const apple = require("./appleIapService");
  return {
    fetch: (...a) => fetch(...a),
    googleToken: iap.getGoogleAccessToken,
    amazonSecret: iap.amazonSharedSecret,
    amazonSandbox: iap.amazonSandboxEnabled,
    appleJwt: apple.generateAppleJWT,
  };
}

const fail = (reason, retryable = false) => ({ ok: false, retryable, reason });

// ---- Google Play ------------------------------------------------------------

async function verifyAndroid({ productId, token }, d) {
  let access;
  try {
    access = await d.googleToken();
  } catch (e) {
    return fail(`Google Play is not configured: ${e.message}`, true);
  }
  const url = `${GOOGLE_API}/${encodeURIComponent(PACKAGE())}/purchases/products/${encodeURIComponent(
    productId
  )}/tokens/${encodeURIComponent(token)}`;
  let res;
  try {
    res = await d.fetch(url, { headers: { Authorization: `Bearer ${access}` } });
  } catch (e) {
    return fail(`Google Play request failed: ${e.message}`, true);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 400/404/410: the token is invalid or no longer exists.
    const definitive = [400, 404, 410].includes(res.status);
    return fail(data?.error?.message || `Google Play ${res.status}`, !definitive);
  }
  if (data.purchaseState !== 0) {
    return fail(data.purchaseState === 2 ? "Payment is still pending" : "Purchase was cancelled or refunded");
  }
  return {
    ok: true,
    transactionKey: token,
    orderId: data.orderId || null,
    testPurchase: data.purchaseType === 0,
    acknowledged: data.acknowledgementState === 1,
  };
}

/** Acknowledges an entitlement purchase so Google does not refund it after 3 days. */
async function acknowledgeAndroid({ productId, token }, d = defaults()) {
  const access = await d.googleToken();
  const url = `${GOOGLE_API}/${encodeURIComponent(PACKAGE())}/purchases/products/${encodeURIComponent(
    productId
  )}/tokens/${encodeURIComponent(token)}:acknowledge`;
  const res = await d.fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
    body: "{}",
  });
  return res.ok;
}

// ---- App Store --------------------------------------------------------------

async function appleLookup(baseUrl, transactionId, d) {
  const res = await d.fetch(`${baseUrl}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, {
    headers: { Authorization: `Bearer ${d.appleJwt()}` },
  });
  return res;
}

async function verifyIos({ productId, token }, d) {
  const sandboxOnly = process.env.APPLE_IAP_SANDBOX === "true";
  let res;
  try {
    res = await appleLookup(
      sandboxOnly ? "https://api.storekit-sandbox.itunes.apple.com" : "https://api.storekit.itunes.apple.com",
      token,
      d
    );
    // Apple: a sandbox transaction is "not found" in production. Retry there.
    if (res.status === 404 && !sandboxOnly) {
      res = await appleLookup("https://api.storekit-sandbox.itunes.apple.com", token, d);
    }
  } catch (e) {
    return fail(`App Store request failed: ${e.message}`, true);
  }
  if (!res.ok) {
    const definitive = [400, 404].includes(res.status);
    return fail(`App Store ${res.status}`, !definitive);
  }
  const body = await res.json().catch(() => ({}));
  const tx = body.signedTransactionInfo ? jwt.decode(body.signedTransactionInfo) : null;
  if (!tx) return fail("App Store returned no transaction");
  if (tx.bundleId !== BUNDLE()) return fail("Purchase belongs to another app");
  if (tx.productId !== productId) return fail("Purchase is for a different product");
  if (tx.revocationDate) return fail("Purchase was refunded");
  return {
    ok: true,
    transactionKey: String(tx.originalTransactionId || tx.transactionId || token),
    orderId: tx.transactionId ? String(tx.transactionId) : null,
    testPurchase: tx.environment === "Sandbox",
  };
}

// ---- Amazon Appstore --------------------------------------------------------

async function verifyAmazon({ productId, token, storeUserId }, d) {
  const secret = d.amazonSecret();
  if (!secret) return fail("Amazon RVS is not configured", true);
  if (!storeUserId) return fail("Missing Amazon user id");
  const base = d.amazonSandbox() ? "https://appstore-sdk.amazon.com/sandbox" : "https://appstore-sdk.amazon.com";
  const url = `${base}/version/1.0/verifyReceiptId/developer/${encodeURIComponent(secret)}/user/${encodeURIComponent(
    storeUserId
  )}/receiptId/${encodeURIComponent(token)}`;
  let res;
  try {
    res = await d.fetch(url, { headers: { Accept: "application/json" } });
  } catch (e) {
    return fail(`Amazon RVS request failed: ${e.message}`, true);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const definitive = [400, 404, 410].includes(res.status);
    return fail(data?.message || `Amazon RVS ${res.status}`, !definitive);
  }
  const sku = data.productId || data.sku;
  if (sku !== productId) return fail("Purchase is for a different product");
  if (data.receiptId !== token) return fail("Receipt does not match");
  if (!["CONSUMABLE", "ENTITLED"].includes(data.productType)) return fail("Not a one-time purchase");
  if (data.cancelDate) return fail("Purchase was cancelled");
  return {
    ok: true,
    transactionKey: token,
    orderId: data.receiptId || null,
    testPurchase: Boolean(data.testTransaction),
  };
}

/** @param {{platform, productId, token, storeUserId?}} input */
async function verifyOneTimePurchase(input, deps) {
  const d = { ...defaults(), ...(deps || {}) };
  switch (input.platform) {
    case "android":
      return verifyAndroid(input, d);
    case "ios":
      return verifyIos(input, d);
    case "amazon":
      return verifyAmazon(input, d);
    default:
      return fail("Unknown platform");
  }
}

module.exports = { verifyOneTimePurchase, acknowledgeAndroid };
