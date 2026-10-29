const jwt = require("jsonwebtoken");
const User = require("../models/usersModel");

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

module.exports = { handleAppleNotification };
