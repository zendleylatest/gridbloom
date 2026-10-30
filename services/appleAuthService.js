// Apple Sign In Service
//
// Verifies Apple identity tokens (JWTs) by fetching Apple's public JWKS and
// using jsonwebtoken to validate the RS256 signature. No third-party auth
// service is involved — this speaks directly to Apple's JWKS endpoint.
//
// Required env vars:
//   APPLE_BUNDLE_ID — your iOS bundle ID (e.g. com.speckpro.gridbloomgame.android)

const crypto = require("crypto");
const { methodConflict } = require("./authProviders");
const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");

const appleJwksClient = jwksClient({
  jwksUri: "https://appleid.apple.com/auth/keys",
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000, // 10 minutes
});

/**
 * Fetch the RSA public key matching the kid in the JWT header.
 * @param {{ kid: string }} header
 * @returns {Promise<string>} PEM public key
 */
async function getAppleSigningKey(header) {
  if (!header.kid) {
    throw Object.assign(new Error("Apple identity token missing key ID."), { status: 401 });
  }
  const key = await appleJwksClient.getSigningKey(header.kid);
  return key.getPublicKey();
}

/**
 * Decode and verify an Apple identity token.
 * @param {string} identityToken
 * @returns {Promise<object>} JWT claims (sub, email, aud, iss, …)
 */
async function verifyAppleIdentityToken(identityToken) {
  let decodedHeader;
  try {
    decodedHeader = jwt.decode(identityToken, { complete: true })?.header;
  } catch {
    throw Object.assign(new Error("Invalid Apple identity token."), { status: 401 });
  }

  if (!decodedHeader) {
    throw Object.assign(new Error("Invalid Apple identity token."), { status: 401 });
  }

  const publicKey = await getAppleSigningKey(decodedHeader);

  // Accept both the native bundle ID and any configured service ID.
  const acceptedAudiences = [
    process.env.APPLE_BUNDLE_ID,
    process.env.APPLE_SERVICE_ID,
  ].filter(Boolean);

  if (!acceptedAudiences.length) {
    throw Object.assign(
      new Error("Apple authentication is not configured on this server."),
      { status: 500 }
    );
  }

  const claims = jwt.verify(identityToken, publicKey, {
    algorithms: ["RS256"],
    issuer: "https://appleid.apple.com",
    audience: acceptedAudiences,
  });

  return claims;
}

/**
 * Authenticate (or register) a user via Apple Sign In.
 *
 * @param {{ identity_token: string, email?: string, full_name?: string, User: Model }} options
 * @param {Function} setUser  — your existing JWT generator (same as Google handler)
 * @returns {Promise<{ token: string, id: string }>}
 */
async function appleAuthService({ identity_token, email, full_name }, User, setUser) {
  // 1. Verify the identity token against Apple's JWKS
  const claims = await verifyAppleIdentityToken(identity_token);

  const appleUserId = claims.sub;
  if (!appleUserId) {
    throw Object.assign(new Error("Apple token missing subject (sub) claim."), { status: 400 });
  }

  // 2. Resolve email.
  //    Apple only provides the real email on the very first authorisation.
  //    If it is absent (subsequent logins), we derive a stable, non-PII
  //    internal address from the apple user ID so the account can still be
  //    created or found on first-time-after-deletion flows.
  const fallbackEmail =
    `apple_${crypto
      .createHash("sha256")
      .update(appleUserId)
      .digest("hex")
      .slice(0, 24)}@users.gridbloom.app`;

  const userEmail = claims.email || email || fallbackEmail;
  const fullName = (full_name || "").trim();

  // 3. Look up by Apple user ID first (most reliable)
  let user = await User.findOne({ appleId: appleUserId });

  if (user) {
    // Update display name if it was missing and Apple is providing it now
    if (fullName && !user.name) {
      user.name = fullName;
      await user.save();
    }
    if (user.isBanned) {
      throw Object.assign(
        new Error("Your account is banned. Please contact support."),
        { status: 403, bannedReason: user.bannedReason || "" }
      );
    }
    return { token: setUser(user), id: user._id };
  }

  // 4. Fall back to email lookup
  user = await User.findOne({ email: userEmail });

  if (user) {
    // The email belongs to an account made another way (Google, or email +
    // password): never take it over, tell the player which method to use.
    const conflict = methodConflict(user, "apple");
    if (conflict) {
      throw Object.assign(new Error(conflict.error), {
        status: 409,
        code: conflict.code,
        method: conflict.method,
      });
    }
    if (!user.appleId) {
      user.appleId = appleUserId;
    }
    if (fullName && !user.name) {
      user.name = fullName;
    }
    await user.save();

    if (user.isBanned) {
      throw Object.assign(
        new Error("Your account is banned. Please contact support."),
        { status: 403, bannedReason: user.bannedReason || "" }
      );
    }
    return { token: setUser(user), id: user._id };
  }

  // 5. Create a new Apple user
  user = await User.create({
    name: fullName || userEmail.split("@")[0],
    email: userEmail,
    appleId: appleUserId,
    emailVerified: true, // Apple has already verified it
  });

  return { token: setUser(user), id: user._id };
}

module.exports = { appleAuthService };
