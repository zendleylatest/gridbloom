const bcrypt = require("bcrypt");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { OAuth2Client } = require("google-auth-library");
const { setUser } = require("../services/userAuthService");
const { appleAuthService } = require("../services/appleAuthService");
const {
  sendOTPEmail,
  sendEmail,
  buildOtpEmailHtml,
  logOtp,
} = require("../services/emailService");
const User = require("../models/usersModel");
const AndroidDeviceUsage = require("../models/androidDeviceUsageModel");
const ChatSession = require("../models/chatModel");
const ChatUsage = require("../models/chatUsageModel");
const PromptGeneration = require("../models/promptGenerationModel");
const PushDeviceToken = require("../models/pushDeviceTokenModel");
const LunaCycleState = require("../models/lunaCycleStateModel");
const GameProgress = require("../models/gameProgressModel");
const Purchase = require("../models/purchaseModel");
const LeaderboardEntry = require("../models/leaderboardEntryModel");
const FriendProfile = require("../models/friendProfileModel");
const TournamentClaim = require("../models/tournamentClaimModel");
const {
  NETWORK_ERROR,
  SIGNED_UP,
  SIGN_UP_FAILED,
  USER_NOT_FOUND,
  WRONG_PASSWORD,
  LOGGED_IN,
  ALL_FILEDS_REQUIRED,
  NAME_REQUIRED,
  EMAIL_REQUIRED,
  PASSWORD_REQUIRED,
  OTP_SEND_FAILED,
  INVALID_OTP,
  EMAIL_NOT_VERIFIED,
  USER_ID_OTP_REQUIRED,
} = require("../messages/message");

// Accepted Google ID-token audiences: the web client ID the app signs in with,
// plus any extra client IDs (e.g. an iOS client) listed in GOOGLE_CLIENT_IDS.
const googleAudiences = [
  process.env.GOOGLE_CLIENT_ID,
  ...String(process.env.GOOGLE_CLIENT_IDS || "").split(","),
]
  .map((id) => (id || "").trim())
  .filter(Boolean);

const { methodConflict } = require("../services/authProviders");

const googleClient = process.env.GOOGLE_CLIENT_ID
  ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID)
  : null;

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const isValidOTP = (otp) => typeof otp === "string" && /^\d{6}$/.test(otp);

const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_RESEND_WINDOW_MS = 60 * 60 * 1000;
const OTP_RESEND_MAX_PER_WINDOW = 5;

const OTP_MAX_WRONG_ATTEMPTS = 5;
const TOO_MANY_ATTEMPTS_ERROR = "Too many incorrect attempts. Request a new code.";

const generateOtp = () => crypto.randomInt(100000, 1000000).toString();

// A double tap (or two devices) must not send two emails and leave the user
// holding the code that was overwritten. Single-process guard: the second
// request for the same user is refused while the first is still sending.
const otpSendsInFlight = new Set();

/**
 * Cooldown + hourly cap shared by every code-sending endpoint.
 * `window` is `{ count, windowStart }`; returns either `{ ok: true, count,
 * windowStart }` for the state to store after a successful send, or a
 * refusal with `retryAfterSeconds`.
 */
function checkOtpSendLimits({ sentAt, window }) {
  const now = Date.now();
  const sentAtMs = sentAt ? new Date(sentAt).getTime() : 0;
  if (sentAtMs && now - sentAtMs < OTP_RESEND_COOLDOWN_MS) {
    return {
      ok: false,
      status: 429,
      error: "Please wait before requesting another code.",
      retryAfterSeconds: Math.ceil((OTP_RESEND_COOLDOWN_MS - (now - sentAtMs)) / 1000),
    };
  }

  const windowStartMs = window?.windowStart ? new Date(window.windowStart).getTime() : 0;
  const windowOpen = Boolean(windowStartMs) && now - windowStartMs < OTP_RESEND_WINDOW_MS;
  const count = windowOpen ? window?.count || 0 : 0;
  if (count >= OTP_RESEND_MAX_PER_WINDOW) {
    return {
      ok: false,
      status: 429,
      error: "Too many code requests. Please try again later.",
      retryAfterSeconds: Math.ceil((OTP_RESEND_WINDOW_MS - (now - windowStartMs)) / 1000),
    };
  }

  const sentDate = new Date(now);
  return {
    ok: true,
    sentAt: sentDate,
    nextWindow: {
      count: count + 1,
      windowStart: windowOpen ? new Date(windowStartMs) : sentDate,
    },
  };
}

/**
 * Which pending code (if any) a resend applies to.
 * - guest binding: the code lives in `pendingBinding` and goes to the new email
 * - signup / unverified login: the code lives in `otp` and goes to `email`
 */
function otpTargetFor(user) {
  if (user.pendingBinding?.otp) {
    return {
      kind: "binding",
      email: user.pendingBinding.email,
      sentAt: user.pendingBinding.requestedAt,
    };
  }
  if (!user.isGuest && user.emailVerified === false) {
    return { kind: "signup", email: user.email, sentAt: user.otpSentAt };
  }
  return null;
}

/**
 * Issues a fresh verification code (replacing the old one) and emails it,
 * enforcing a per-user cooldown and an hourly cap. State only changes after
 * the email was handed off, so a failed send never invalidates the old code.
 */
async function issueFreshOtp(user) {
  const target = otpTargetFor(user);
  if (!target) {
    return { ok: false, status: 400, error: "No pending verification for this account" };
  }

  const lockKey = String(user._id);
  if (otpSendsInFlight.has(lockKey)) {
    return {
      ok: false,
      status: 429,
      error: "Please wait before requesting another code.",
      retryAfterSeconds: 5,
    };
  }
  otpSendsInFlight.add(lockKey);
  try {
    const limits = checkOtpSendLimits({ sentAt: target.sentAt, window: user.otpResend });
    if (!limits.ok) return limits;

    const otp = generateOtp();
    try {
      await sendOTPEmail(target.email, otp);
    } catch (mailErr) {
      console.error("resend OTP email error:", mailErr);
      return { ok: false, status: 500, error: OTP_SEND_FAILED };
    }

    if (target.kind === "binding") {
      user.pendingBinding.otp = otp;
      // Restarts the 15-minute expiry window checked by verify-otp.
      user.pendingBinding.requestedAt = limits.sentAt;
    } else {
      user.otp = otp;
      user.otpSentAt = limits.sentAt;
    }
    user.otpAttempts = 0;
    user.otpResend = limits.nextWindow;
    await user.save();

    return { ok: true, cooldownSeconds: OTP_RESEND_COOLDOWN_MS / 1000 };
  } finally {
    otpSendsInFlight.delete(lockKey);
  }
}

function authResponse(user) {
  return {
    token: setUser(user),
    userId: user._id,
    id: user._id,
    username: user.name,
    useremail: user.isGuest ? null : user.email,
    isGuest: user.isGuest === true,
    androidId: user.androidId || null,
    androidIdHash: user.androidIdHash || null,
  };
}

function normalizeAndroidIdHash(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function normalizeAndroidId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{8,64}$/.test(normalized) ? normalized : null;
}

function readAndroidIdentity(body) {
  const androidId = normalizeAndroidId(body?.androidId);
  const sentHash = normalizeAndroidIdHash(body?.androidIdHash);
  if (!androidId) return { androidId: null, androidIdHash: sentHash };
  const packageName = process.env.ANDROID_PACKAGE_NAME || "com.speckpro.gridbloomgame.android";
  const calculatedHash = crypto
    .createHash("sha256")
    .update(`${packageName}:${androidId}`)
    .digest("hex");
  if (sentHash && sentHash !== calculatedHash) return null;
  return { androidId, androidIdHash: calculatedHash };
}

function applyAndroidIdentity(user, body) {
  const identity = readAndroidIdentity(body);
  if (!identity) return false;
  if (identity.androidId) user.androidId = identity.androidId;
  if (identity.androidIdHash) user.androidIdHash = identity.androidIdHash;
  return true;
}

function logAuthUser(label, user) {
  console.log(label, {
    userId: user?._id,
    name: user?.name,
    email: user?.email,
    isGuest: user?.isGuest === true,
    androidId: user?.androidId || null,
    androidIdHash: user?.androidIdHash || null,
  });
}

async function findActiveDeviceGuest(device) {
  if (!device) return null;
  if (device.activeGuestUserId) {
    const active = await User.findOne({
      _id: device.activeGuestUserId,
      isGuest: true,
    });
    if (active) return active;
  }
  return User.findOne({
    $or: [
      { androidIdHash: device.androidIdHash },
      ...(device.guestUserIds?.length
        ? [{ _id: { $in: device.guestUserIds } }]
        : []),
    ],
    isGuest: true,
  }).sort({ updatedAt: -1 });
}

async function attachGuestToDevice(user, device) {
  if (!user || !device) return;
  if (
    user.androidIdHash !== device.androidIdHash ||
    (device.androidId && user.androidId !== device.androidId)
  ) {
    user.androidIdHash = device.androidIdHash;
    if (device.androidId) user.androidId = device.androidId;
    await user.save();
  }
  const existingUsed = Number(user?.careUsage?.totalMessagesUsed || 0);
  await AndroidDeviceUsage.updateOne(
    { _id: device._id },
    {
      $set: {
        activeGuestUserId: user._id,
        lastSeenAt: new Date(),
        ...(existingUsed > Number(device?.careUsage?.totalMessagesUsed || 0)
          ? {
              "careUsage.totalMessagesUsed": existingUsed,
              "careUsage.updatedAt": new Date(),
            }
          : {}),
      },
      $addToSet: { guestUserIds: user._id },
    }
  );
}

async function handleCreateGuest(req, res) {
  try {
    const guestKey = String(req.body?.guestKey || "").trim();
    const identity = readAndroidIdentity(req.body);
    if (!identity) {
      return res.status(400).json({ error: "Android device identity does not match its hash" });
    }
    const { androidId, androidIdHash } = identity;
    if (!androidIdHash && (guestKey.length < 16 || guestKey.length > 200)) {
      return res.status(400).json({
        error: "A valid Android device identity or guest key is required",
      });
    }

    let device = null;
    let user = null;
    if (androidIdHash) {
      device = await AndroidDeviceUsage.findOneAndUpdate(
        { androidIdHash },
        {
          $set: {
            lastSeenAt: new Date(),
            ...(androidId ? { androidId } : {}),
          },
          $setOnInsert: { androidIdHash },
        },
        { new: true, upsert: true }
      );
      user = await findActiveDeviceGuest(device);
    }
    if (!user && guestKey.length >= 16 && guestKey.length <= 200) {
      user = await User.findOne({
        guestKey,
        isGuest: true,
        ...(androidIdHash
          ? {
              $or: [
                { androidIdHash },
                { androidIdHash: null },
                { androidIdHash: { $exists: false } },
              ],
            }
          : {}),
      });
    }
    if (!user) {
      user = await User.create({
        name: "Guest",
        email: `guest_${crypto.randomUUID()}@gridbloom.invalid`,
        emailVerified: false,
        isGuest: true,
        ...(guestKey ? { guestKey } : {}),
        ...(androidIdHash ? { androidIdHash } : {}),
        ...(androidId ? { androidId } : {}),
        creationsPublic: false,
      });
    }
    await attachGuestToDevice(user, device);
    logAuthUser("[guest device]", user);

    return res.status(201).json(authResponse(user));
  } catch (err) {
    console.error("create guest error:", err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }
}

async function handleRestoreGuest(req, res) {
  try {
    const identity = readAndroidIdentity(req.body);
    if (!identity) {
      return res.status(400).json({ error: "Android device identity does not match its hash" });
    }
    const { androidId, androidIdHash } = identity;
    if (!androidIdHash) {
      return res.status(400).json({ error: "A valid Android device identity is required" });
    }

    const device = await AndroidDeviceUsage.findOne({ androidIdHash });
    if (!device) {
      return res.status(404).json({ registered: false });
    }
    if (androidId && device.androidId !== androidId) {
      device.androidId = androidId;
      device.lastSeenAt = new Date();
      await device.save();
    }

    const user = await findActiveDeviceGuest(device);
    if (!user) {
      device.lastSeenAt = new Date();
      await device.save();
      return res.status(404).json({
        registered: true,
        usage: {
          totalMessagesUsed: Number(device?.careUsage?.totalMessagesUsed || 0),
        },
      });
    }

    // Preview: tell the app a guest exists without signing it in or touching it.
    if (req.body?.previewOnly === true) {
      return res.json({ registered: true, guestExists: true });
    }

    await attachGuestToDevice(user, device);
    logAuthUser("[guest restore]", user);
    return res.json({ registered: true, ...authResponse(user) });
  } catch (err) {
    console.error("restore guest error:", err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }
}

async function handleUpdateGuestDevice(req, res) {
  try {
    const user = req.authUser;
    if (!user?.isGuest) {
      return res.status(409).json({ error: "Only guest sessions can change guest devices" });
    }

    const identity = readAndroidIdentity(req.body);
    if (!identity?.androidIdHash || !identity.androidId) {
      return res.status(400).json({ error: "A valid Android device identity is required" });
    }

    const previousAndroidId = normalizeAndroidId(req.body?.previousAndroidId);
    if (previousAndroidId && user.androidId && previousAndroidId !== user.androidId) {
      return res.status(409).json({ error: "The saved Android device does not match this guest" });
    }

    const previousHash = user.androidIdHash || null;
    if (previousHash === identity.androidIdHash) {
      user.androidId = identity.androidId;
      await user.save();
      const device = await AndroidDeviceUsage.findOneAndUpdate(
        { androidIdHash: identity.androidIdHash },
        {
          $set: {
            androidId: identity.androidId,
            activeGuestUserId: user._id,
            lastSeenAt: new Date(),
          },
          $addToSet: { guestUserIds: user._id },
        },
        { new: true, upsert: true }
      );
      await attachGuestToDevice(user, device);
      return res.json(authResponse(user));
    }

    const targetDevice = await AndroidDeviceUsage.findOne({
      androidIdHash: identity.androidIdHash,
    });
    if (targetDevice) {
      const targetGuest = await findActiveDeviceGuest(targetDevice);
      if (targetGuest && targetGuest._id.toString() !== user._id.toString()) {
        return res.status(409).json({
          error: "This Android device is already linked to another guest",
        });
      }
    }

    let device = targetDevice;
    const previousDevice = previousHash
      ? await AndroidDeviceUsage.findOne({ androidIdHash: previousHash })
      : null;
    if (!device && previousDevice) {
      previousDevice.androidId = identity.androidId;
      previousDevice.androidIdHash = identity.androidIdHash;
      previousDevice.activeGuestUserId = user._id;
      previousDevice.lastSeenAt = new Date();
      if (!previousDevice.guestUserIds.some((id) => id.toString() === user._id.toString())) {
        previousDevice.guestUserIds.push(user._id);
      }
      device = await previousDevice.save();
    } else if (!device) {
      device = await AndroidDeviceUsage.create({
        androidId: identity.androidId,
        androidIdHash: identity.androidIdHash,
        activeGuestUserId: user._id,
        guestUserIds: [user._id],
      });
    } else {
      await attachGuestToDevice(user, device);
      if (previousDevice && previousDevice._id.toString() !== device._id.toString()) {
        await AndroidDeviceUsage.updateOne(
          { _id: previousDevice._id, activeGuestUserId: user._id },
          { $set: { activeGuestUserId: null, lastSeenAt: new Date() } }
        );
      }
    }

    user.androidId = identity.androidId;
    user.androidIdHash = identity.androidIdHash;
    await user.save();
    await attachGuestToDevice(user, device);
    logAuthUser("[guest device changed]", user);
    return res.json(authResponse(user));
  } catch (err) {
    console.error("update guest device error:", err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }
}

async function handleBindGuestAccount(req, res) {
  try {
    const user = req.authUser;
    if (!user?.isGuest) {
      return res.status(409).json({ error: "This account is already bound" });
    }

    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (name.length < 2) return res.status(400).json({ error: NAME_REQUIRED });
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const existing = await User.exists({ email, _id: { $ne: user._id } });
    if (existing) {
      return res.status(409).json({ error: "User already exists" });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const hashed = await bcrypt.hash(password, 10);
    await sendOTPEmail(email, otp);

    user.pendingBinding = {
      name,
      email,
      password: hashed,
      otp,
      requestedAt: new Date(),
    };
    user.otpAttempts = 0;
    await user.save();

    return res.status(200).json({
      message: "Verification code sent. Your guest data will be preserved.",
      userId: user._id,
    });
  } catch (err) {
    console.error("bind guest account error:", err);
    return res.status(500).json({ error: OTP_SEND_FAILED });
  }
}

async function handleUserSignUp(req, res) {
  const body = req.body;
  if (!body) return res.status(400).json({ message: ALL_FILEDS_REQUIRED });
  if (!body.name) return res.status(400).json({ message: NAME_REQUIRED });
  if (!body.email) return res.status(400).json({ message: EMAIL_REQUIRED });
  if (!body.password) return res.status(400).json({ message: PASSWORD_REQUIRED });

  try {
    const email = String(body.email).trim().toLowerCase();
    const identity = readAndroidIdentity(body);
    if (!identity) {
      return res.status(400).json({ error: "Android device identity does not match its hash" });
    }
    const hashed = await bcrypt.hash(body.password, 10);
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const result = await User.create({
      name: body.name,
      email,
      profession: body.profession ?? undefined,
      password: hashed,
      image: req.file ? `/uploads/${req.file.filename}` : null,
      otp,
      otpSentAt: new Date(),
      emailVerified: false,
      ...(identity.androidId ? { androidId: identity.androidId } : {}),
      ...(identity.androidIdHash ? { androidIdHash: identity.androidIdHash } : {}),
    });

    try {
      await sendOTPEmail(email, otp);
    } catch (mailErr) {
      console.error("OTP email error:", mailErr);
      await User.findByIdAndDelete(result._id);
      return res.status(500).json({ error: OTP_SEND_FAILED });
    }

    logAuthUser("[user signup]", result);

    res.status(201).json({
      message: "User created. OTP sent to email.",
      userId: result._id,
      success: SIGNED_UP,
    });
  } catch (err) {
    console.error("DB create error:", err);
    res.status(500).json({ error: SIGN_UP_FAILED });
  }
}

async function handleVerifyOTP(req, res) {
  try {
    const { userId, otp } = req.body;
    if (
      userId == null ||
      otp === undefined ||
      otp === null ||
      String(otp).trim() === ""
    ) {
      return res.status(400).json({ error: USER_ID_OTP_REQUIRED });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(400).json({ error: USER_NOT_FOUND });
    }

    if ((user.otpAttempts || 0) >= OTP_MAX_WRONG_ATTEMPTS) {
      return res.status(429).json({
        error: TOO_MANY_ATTEMPTS_ERROR,
        tooManyAttempts: true,
      });
    }

    const pendingBinding = user.pendingBinding;
    if (pendingBinding?.otp) {
      const requestedAt = pendingBinding.requestedAt
        ? new Date(pendingBinding.requestedAt).getTime()
        : 0;
      if (!requestedAt || Date.now() - requestedAt > 15 * 60 * 1000) {
        user.pendingBinding = undefined;
        await user.save();
        return res.status(400).json({ error: "Verification code expired" });
      }
      if (pendingBinding.otp !== String(otp).trim()) {
        await User.updateOne({ _id: user._id }, { $inc: { otpAttempts: 1 } });
        return res.status(400).json({ error: INVALID_OTP });
      }

      const existing = await User.exists({
        email: pendingBinding.email,
        _id: { $ne: user._id },
      });
      if (existing) {
        return res.status(409).json({ error: "User already exists" });
      }

      user.name = pendingBinding.name;
      user.email = pendingBinding.email;
      user.password = pendingBinding.password;
      user.emailVerified = true;
      user.isGuest = false;
      user.guestKey = undefined;
      user.pendingBinding = undefined;
      user.otp = null;
      user.otpAttempts = 0;
      await user.save();

      if (user.androidIdHash) {
        await AndroidDeviceUsage.updateOne(
          { androidIdHash: user.androidIdHash, activeGuestUserId: user._id },
          { $set: { activeGuestUserId: null, lastSeenAt: new Date() } }
        );
      }

      return res.json({
        message: "Guest account bound successfully.",
        bound: true,
        ...authResponse(user),
      });
    }

    if (user.otp !== String(otp).trim()) {
      await User.updateOne({ _id: user._id }, { $inc: { otpAttempts: 1 } });
      return res.status(400).json({ error: INVALID_OTP });
    }

    user.emailVerified = true;
    user.otp = null;
    user.otpAttempts = 0;
    await user.save();

    res.json({ message: "Email verified successfully." });
  } catch (err) {
    console.error("verify OTP error:", err);
    res.status(500).json({ error: NETWORK_ERROR });
  }
}

async function handleUserLogin(req, res) {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: USER_NOT_FOUND });
    if (user.isBanned) {
      return res.status(403).json({
        error: "Your account is banned. Please contact support.",
        bannedReason: user.bannedReason || "",
      });
    }

    if (user.emailVerified === false) {
      // The app opens the OTP screen from this response, so it needs the
      // userId, and the user needs a code they can still use. Cooldown/limit
      // refusals are fine here: the OTP screen's Resend button covers them.
      try {
        await issueFreshOtp(user);
      } catch (otpErr) {
        console.error("login OTP issue error:", otpErr);
      }
      return res.status(400).json({ error: EMAIL_NOT_VERIFIED, userId: user._id });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: WRONG_PASSWORD });
    if (!applyAndroidIdentity(user, req.body)) {
      return res.status(400).json({ error: "Android device identity does not match its hash" });
    }
    await user.save();
    const token = setUser(user);

    res.json({
      success: LOGGED_IN,
      userId: user._id,
      token: token,
      username: user.name,
      useremail: user.email,
    });
  } catch (err) {
    res.status(500).json({ error: NETWORK_ERROR });
  }
}

async function handleResendOTP(req, res) {
  try {
    const userId = String(req.body?.userId ?? "").trim();
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: "userId is required" });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(400).json({ error: USER_NOT_FOUND });
    if (user.isBanned) {
      return res.status(403).json({ error: "Your account is banned. Please contact support." });
    }

    const result = await issueFreshOtp(user);
    if (!result.ok) {
      return res.status(result.status).json({
        error: result.error,
        ...(result.retryAfterSeconds ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
      });
    }
    return res.json({
      message: "Verification code sent.",
      cooldownSeconds: result.cooldownSeconds,
    });
  } catch (err) {
    console.error("resend OTP error:", err);
    return res.status(500).json({ error: NETWORK_ERROR });
  }
}

async function handleGoogleLogin(req, res) {
  try {
    if (!googleClient || !process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({ error: "Google sign-in is not configured" });
    }
    const { idToken } = req.body;
    if (!idToken) {
      return res.status(400).json({ error: "Google ID token required" });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: googleAudiences,
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({ error: "Invalid Google token" });
    }

    const { sub, email, name, email_verified, picture } = payload;

    let user = await User.findOne({ googleId: sub });
    if (!user) {
      const byEmail = await User.findOne({ email });
      if (byEmail) {
        // The email belongs to an account made another way (Apple, or email
        // + password): do not take it over, tell the player which to use.
        const conflict = methodConflict(byEmail, "google");
        if (conflict) return res.status(409).json(conflict);
        user = byEmail;
      }
    }

    if (!user) {
      user = await User.create({
        name: name || "Google User",
        email,
        googleId: sub,
        emailVerified: email_verified !== false,
        image: picture || undefined,
      });
    } else {
      let updated = false;
      if (!user.googleId) {
        user.googleId = sub;
        updated = true;
      }
      if (!user.image && picture) {
        user.image = picture;
        updated = true;
      }
      if (!user.emailVerified && email_verified) {
        user.emailVerified = true;
        updated = true;
      }
      if (updated) await user.save();
    }

    if (user.isBanned) {
      return res.status(403).json({
        error: "Your account is banned. Please contact support.",
        bannedReason: user.bannedReason || "",
      });
    }

    const token = setUser(user);
    res.json({
      token,
      id: user._id,
    });
  } catch (err) {
    console.error("Google login error:", err.message);
    res.status(500).json({ error: "Google authentication failed" });
  }
}

/**
 * POST /auth/apple
 * Body: { identity_token: string, email?: string, full_name?: string }
 *
 * Verifies the Apple identity token directly against Apple's JWKS (no
 * third-party service). Creates or finds the user and returns a JWT.
 */
async function handleAppleLogin(req, res) {
  try {
    if (!process.env.APPLE_BUNDLE_ID && !process.env.APPLE_SERVICE_ID) {
      return res.status(500).json({ error: "Apple sign-in is not configured on this server." });
    }

    const { identity_token, email, full_name } = req.body;
    if (!identity_token) {
      return res.status(400).json({ error: "Apple identity token required." });
    }

    const result = await appleAuthService(
      { identity_token, email, full_name },
      User,
      setUser
    );
    return res.json(result);
  } catch (err) {
    const status = err.status || 500;
    console.error("Apple login error:", err.message);
    return res.status(status).json({
      error: err.message || "Apple authentication failed.",
      ...(err.code ? { code: err.code, method: err.method } : {}),
      ...(err.bannedReason ? { bannedReason: err.bannedReason } : {}),
    });
  }
}

async function handleGetProfile(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid user ID" });
    }

    const user = await User.findById(id).select(
      "-otp -otpSentAt -otpResend -otpAttempts -resetOtpSentAt -resetOtpAttempts -resetOtpResend -resetOTP -password -emailVerified -guestKey -pendingBinding"
    );
    if (!user) return res.status(404).json({ error: "User not found" });

    const o = user.toObject();
    o.fullName = o.name;
    res.json(o);
  } catch (err) {
    console.error("getProfile error:", err);
    res.status(500).json({ error: NETWORK_ERROR });
  }
}

async function handleUpdateProfile(req, res) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid user ID" });
    }

    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (req.body.newPassword && !req.body.oldPassword) {
      return res.status(400).json({ message: "Old password required" });
    }

    if (req.body.oldPassword && req.body.newPassword) {
      const ok = await bcrypt.compare(req.body.oldPassword, user.password || "");
      if (!ok) {
        return res.status(400).json({ message: "Old password is incorrect" });
      }
    }

    const updates = {};
    const displayName = req.body.fullName ?? req.body.name;
    if (displayName) updates.name = displayName;
    if (req.body.newPassword) {
      updates.password = await bcrypt.hash(req.body.newPassword, 10);
    }
    if (req.file) {
      updates.image = `/uploads/profile/${req.file.filename}`;
    }

    const cp = req.body.creationsPublic;
    if (cp !== undefined && cp !== null && cp !== "") {
      if (cp === true || cp === "true" || cp === "1") {
        updates.creationsPublic = true;
      } else if (cp === false || cp === "false" || cp === "0") {
        updates.creationsPublic = false;
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No data to update" });
    }

    await User.findByIdAndUpdate(id, updates, { new: true });
    res.json("Your Information Updated");
  } catch (err) {
    console.error("updateProfile error:", err);
    res.status(500).json({ message: "Server error" });
  }
}

async function handleDeleteAccount(req, res) {
  try {
    const user = req.authUser;
    if (!user?._id) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!applyAndroidIdentity(user, req.body)) {
      return res.status(400).json({ error: "Android device identity does not match its hash" });
    }
    await user.save();

    const userId = user._id;
    const userEmail = user.email ? user.email.toString().trim().toLowerCase() : "";

    await Promise.all([
      ChatSession.deleteMany({ userId }),
      ChatUsage.deleteMany({ userId }),
      PromptGeneration.deleteMany({
        $or: [
          { userId },
          ...(userEmail ? [{ generatedBy: userEmail }] : []),
        ],
      }),
      PushDeviceToken.deleteMany({ userId: userId.toString() }),
      LunaCycleState.deleteOne({ userId }),
      GameProgress.deleteOne({ userId }),
      Purchase.deleteMany({ userId }),
      LeaderboardEntry.deleteMany({ userId }),
      TournamentClaim.deleteMany({ userId }),
      FriendProfile.deleteOne({ userId }),
      FriendProfile.updateMany({ friends: userId }, { $pull: { friends: userId } }),
      ...(user.androidIdHash
        ? [
            AndroidDeviceUsage.updateOne(
              { androidIdHash: user.androidIdHash, activeGuestUserId: userId },
              { $set: { activeGuestUserId: null, lastSeenAt: new Date() } }
            ),
          ]
        : []),
    ]);

    await User.deleteOne({ _id: userId });

    res.json({
      message: "Account permanently deleted.",
    });
  } catch (err) {
    console.error("deleteAccount error:", err);
    res.status(500).json({ error: NETWORK_ERROR });
  }
}

async function handleForgotPassword(req, res) {
  const lockKey = { current: null };
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email required" });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    lockKey.current = `reset:${user._id}`;
    if (otpSendsInFlight.has(lockKey.current)) {
      lockKey.current = null; // not ours to release
      return res.status(429).json({
        error: "Please wait before requesting another code.",
        retryAfterSeconds: 5,
      });
    }
    otpSendsInFlight.add(lockKey.current);

    const limits = checkOtpSendLimits({
      sentAt: user.resetOtpSentAt,
      window: user.resetOtpResend,
    });
    if (!limits.ok) {
      return res.status(limits.status).json({
        error: limits.error,
        retryAfterSeconds: limits.retryAfterSeconds,
      });
    }

    const otp = generateOtp();
    logOtp(email, otp, "password reset");
    await sendEmail(
      email,
      "Reset your Gridbloom password",
      `Your Gridbloom password reset code is: ${otp}`,
      {
        html: buildOtpEmailHtml({
          title: "Reset your password",
          preheader: `Your Gridbloom password reset code is ${otp}.`,
          otp,
          message:
            "Use this one-time code to reset your Gridbloom password and get back into your account.",
        }),
      }
    );

    // Only replace the stored code once the email was handed off.
    user.resetOTP = otp;
    user.resetOtpSentAt = limits.sentAt;
    user.resetOtpAttempts = 0;
    user.resetOtpResend = limits.nextWindow;
    await user.save();

    res.json({ message: "OTP sent", cooldownSeconds: OTP_RESEND_COOLDOWN_MS / 1000 });
  } catch (err) {
    console.error("forgotPassword error:", err);
    res.status(500).json({ error: NETWORK_ERROR });
  } finally {
    if (lockKey.current) otpSendsInFlight.delete(lockKey.current);
  }
}

async function handleResetPassword(req, res) {
  try {
    const { email, otp, newPassword } = req.body;
    if (!email || !otp || !newPassword) {
      return res.status(400).json({ error: "All fields required" });
    }
    if (!isValidOTP(String(otp).trim())) {
      return res.status(400).json({ error: "Invalid OTP format" });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const user = await User.findOne({ email });
    if (!user || !user.resetOTP) {
      return res.status(400).json({ error: "Invalid OTP" });
    }
    if ((user.resetOtpAttempts || 0) >= OTP_MAX_WRONG_ATTEMPTS) {
      return res.status(429).json({
        error: TOO_MANY_ATTEMPTS_ERROR,
        tooManyAttempts: true,
      });
    }
    if (user.resetOTP !== String(otp).trim()) {
      await User.updateOne({ _id: user._id }, { $inc: { resetOtpAttempts: 1 } });
      return res.status(400).json({ error: "Invalid OTP" });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.resetOTP = null;
    user.resetOtpAttempts = 0;
    await user.save();

    res.json({ message: "Password reset successful" });
  } catch (err) {
    console.error("resetPassword error:", err);
    res.status(500).json({ error: NETWORK_ERROR });
  }
}

module.exports = {
  handleCreateGuest,
  handleRestoreGuest,
  handleUpdateGuestDevice,
  handleBindGuestAccount,
  handleUserSignUp,
  handleUserLogin,
  handleVerifyOTP,
  handleResendOTP,
  handleGoogleLogin,
  handleAppleLogin,
  handleGetProfile,
  handleUpdateProfile,
  handleDeleteAccount,
  handleForgotPassword,
  handleResetPassword,
};
