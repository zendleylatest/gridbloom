const jwt = require("jsonwebtoken");
const User = require("../models/usersModel");
const Purchase = require("../models/purchaseModel");
const { verifyOneTimePurchase } = require("../services/storePurchaseVerification");

const BUNDLE = () => process.env.APPLE_BUNDLE_ID || "com.speckpro.gridbloomgame.ios";

/**
 * Gridbloom one-time purchases: Apple tells us a transaction changed (refund,
 * reversal, ...). The payload is only used to find the purchase; the new state
 * always comes from asking the App Store Server API again, so a forged or
 * replayed notification cannot revoke or grant anything.
 *
 * Returns "handled" (answer 200), "retry" (answer 500 so Apple resends) or
 * "unknown" (not a Gridbloom purchase).
 */
async function applyGridbloomNotification(notificationType, transaction, deps) {
  if (!transaction || (transaction.bundleId && transaction.bundleId !== BUNDLE())) {
    return "unknown";
  }
  const id = transaction.originalTransactionId || transaction.transactionId;
  if (!id) return "unknown";
  const purchase = await Purchase.findOne({ key: `ios:${id}` });
  if (!purchase) return "unknown";

  const res = await verifyOneTimePurchase(
    { platform: "ios", productId: purchase.productId, token: purchase.token },
    deps
  );
  if (res.ok) {
    // E.g. REFUND_REVERSED: Apple took the refund back.
    if (purchase.status === "revoked") {
      purchase.status = "active";
      purchase.verifiedAt = new Date();
      await purchase.save();
    }
    return "handled";
  }
  if (res.retryable) return "retry";
  if (purchase.status !== "revoked") {
    purchase.status = "revoked";
    await purchase.save();
    console.warn(`[apple] ${notificationType}: revoked ${purchase.productId} (${purchase.key})`);
  }
  return "handled";
}

async function handleAppleNotification(req, res) {
  try {
    const { signedPayload } = req.body;
    if (!signedPayload) {
      return res.status(400).send("Missing signedPayload");
    }

    // Decode the notification payload (JWS format)
    const decodedPayload = jwt.decode(signedPayload);
    if (!decodedPayload) {
      return res.status(400).send("Invalid signedPayload");
    }

    const notificationType = decodedPayload.notificationType;
    const data = decodedPayload.data;

    if (!data || !data.signedTransactionInfo) {
      // Not all notifications have transaction info (e.g., TEST notifications)
      return res.status(200).send("OK");
    }

    const transaction = jwt.decode(data.signedTransactionInfo);
    if (!transaction) return res.status(200).send("OK");

    const mine = await applyGridbloomNotification(notificationType, transaction);
    if (mine === "retry") return res.status(500).send("Try again");
    if (mine === "handled") return res.status(200).send("OK");

    const originalTransactionId = transaction.originalTransactionId;
    if (!originalTransactionId) return res.status(200).send("OK");

    const user = await User.findOne({ "subscription.originalTransactionId": originalTransactionId });
    if (!user) {
      // User not found for this transaction. Return 200 to prevent Apple from retrying.
      return res.status(200).send("OK");
    }

    let isActive = false;
    let expiresAt = new Date(transaction.expiresDate);

    if (
      notificationType === "DID_RENEW" ||
      notificationType === "SUBSCRIBED" ||
      notificationType === "OFFER_REDEEMED"
    ) {
      isActive = true;
    } else if (
      notificationType === "EXPIRED" ||
      notificationType === "DID_FAIL_TO_RENEW" ||
      notificationType === "CANCEL" ||
      notificationType === "REFUND" ||
      notificationType === "REVOKE"
    ) {
      isActive = false;
    } else {
      // For other notifications, determine state by expiration date
      isActive = transaction.expiresDate > Date.now();
    }

    user.subscription.status = isActive ? "active" : "expired";
    user.subscription.expiresAt = expiresAt;

    await user.save();

    res.status(200).send("OK");
  } catch (error) {
    console.error("[Apple Webhook Error]:", error);
    res.status(500).send("Internal Server Error");
  }
}

module.exports = { handleAppleNotification, applyGridbloomNotification };
