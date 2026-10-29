const jwt = require('jsonwebtoken');

// 1. Generate JWT for App Store Server API (ES256, expires 1hr)
const generateAppleJWT = () => {
  const privateKey = process.env.APPLE_IAP_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error('APPLE_IAP_PRIVATE_KEY is not configured');
  }
  const formattedPrivateKey = privateKey.replace(/\\n/g, '\n');
  return jwt.sign({}, formattedPrivateKey, {
    algorithm: 'ES256',
    keyid: process.env.APPLE_IAP_KEY_ID,
    issuer: process.env.APPLE_IAP_ISSUER_ID,
    audience: 'appstoreconnect-v1',
    expiresIn: '1h',
  });
};

// 2. Look up transaction from Apple (by originalTransactionId)
// GET https://api.storekit.itunes.apple.com/inApps/v1/subscriptions/{transactionId}
const verifyAppleTransaction = async ({ transactionId }) => {
  const token = generateAppleJWT();
  const isSandbox = process.env.APPLE_IAP_SANDBOX === 'true';
  const baseUrl = isSandbox
    ? 'https://api.storekit-sandbox.itunes.apple.com'
    : 'https://api.storekit.itunes.apple.com';
  const url = `${baseUrl}/inApps/v1/subscriptions/${transactionId}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Apple API error: ${response.status} ${errorBody}`);
  }

  const responseData = await response.json();
  const latestReceipt = responseData?.data?.[0]?.lastTransactions?.[0];
  if (!latestReceipt) throw new Error('No transaction found');

  // Decode the JWS transaction payload
  const decodedTransaction = jwt.decode(latestReceipt.signedTransactionInfo);
  if (!decodedTransaction) throw new Error('Failed to decode transaction info');

  const status = latestReceipt.status; // 1 = active, 2 = expired, 3 = billing retry, 4 = grace period, 5 = revoked
  const isActive = status === 1 || status === 4;
  const expiresAtMs = decodedTransaction.expiresDate;

  // Renewal info carries the auto-renew switch (1 = on, 0 = user turned it off).
  const renewalInfo = latestReceipt.signedRenewalInfo
    ? jwt.decode(latestReceipt.signedRenewalInfo)
    : null;
  const autoRenewing =
    renewalInfo && renewalInfo.autoRenewStatus !== undefined
      ? renewalInfo.autoRenewStatus === 1
      : null;
  const isTrial =
    decodedTransaction.offerType === 1 &&
    decodedTransaction.offerDiscountType === 'FREE_TRIAL';

  return {
    isActive,
    autoRenewing,
    isTrial,
    expiresAt: new Date(expiresAtMs),
    originalTransactionId: decodedTransaction.originalTransactionId,
    productId: decodedTransaction.productId,
  };
};

module.exports = { verifyAppleTransaction };
