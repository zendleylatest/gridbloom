const test = require("node:test");
const assert = require("node:assert/strict");

// Stub the mailer and User model before the controller loads: no SMTP, no DB.
const sentVerification = [];
const sentReset = [];
let sendDelayMs = 0;
let failNextSend = false;
const emailPath = require.resolve("../services/emailService");
require.cache[emailPath] = {
  id: emailPath,
  filename: emailPath,
  loaded: true,
  exports: {
    sendOTPEmail: async (email, otp) => {
      if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs));
      if (failNextSend) {
        failNextSend = false;
        throw new Error("smtp down");
      }
      sentVerification.push({ email, otp });
    },
    sendEmail: async (email, subject, text) => {
      if (sendDelayMs) await new Promise((r) => setTimeout(r, sendDelayMs));
      if (failNextSend) {
        failNextSend = false;
        throw new Error("smtp down");
      }
      sentReset.push({ email, text });
    },
    buildOtpEmailHtml: () => "",
    logOtp: () => {},
  },
};

const User = require("../models/usersModel");
const users = new Map();
User.findById = async (id) => users.get(String(id)) || null;
User.findOne = async (q) => [...users.values()].find((u) => u.email === q.email) || null;
User.updateOne = async (filter, update) => {
  const u = users.get(String(filter._id));
  for (const [k, v] of Object.entries(update.$inc || {})) u[k] = (u[k] || 0) + v;
};

const {
  handleVerifyOTP,
  handleResendOTP,
  handleForgotPassword,
  handleResetPassword,
} = require("../controllers/userAuthControllers");

const ID = "64b7f0c2a1b2c3d4e5f60718";

function makeUser(overrides = {}) {
  const user = {
    _id: ID,
    email: "a@example.com",
    isGuest: false,
    emailVerified: false,
    otp: "111111",
    otpSentAt: new Date(Date.now() - 5 * 60 * 1000),
    otpAttempts: 0,
    saves: 0,
    async save() {
      this.saves += 1;
    },
    ...overrides,
  };
  users.set(ID, user);
  return user;
}

async function call(handler, body) {
  let status = 200;
  let json;
  const res = {
    status(code) {
      status = code;
      return this;
    },
    json(payload) {
      json = payload;
      return this;
    },
  };
  await handler({ body }, res);
  return { status, json };
}

test.beforeEach(() => {
  sentVerification.length = 0;
  sentReset.length = 0;
  sendDelayMs = 0;
  failNextSend = false;
  users.clear();
});

// ── verify-otp attempt limit ────────────────────────────────────────────────

test("wrong verification codes are counted", async () => {
  const user = makeUser();
  const r = await call(handleVerifyOTP, { userId: ID, otp: "000000" });
  assert.equal(r.status, 400);
  assert.equal(user.otpAttempts, 1);
});

test("after 5 wrong attempts even the right code is refused until a new one is sent", async () => {
  const user = makeUser({ otpAttempts: 5 });
  const locked = await call(handleVerifyOTP, { userId: ID, otp: "111111" });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.tooManyAttempts, true);
  assert.equal(user.emailVerified, false);

  // A resend issues a fresh code and unlocks verification.
  const resent = await call(handleResendOTP, { userId: ID });
  assert.equal(resent.status, 200);
  assert.equal(user.otpAttempts, 0);
  const ok = await call(handleVerifyOTP, { userId: ID, otp: sentVerification[0].otp });
  assert.equal(ok.status, 200);
  assert.equal(user.emailVerified, true);
});

test("a correct code verifies and clears the attempt counter", async () => {
  const user = makeUser({ otpAttempts: 3 });
  const r = await call(handleVerifyOTP, { userId: ID, otp: "111111" });
  assert.equal(r.status, 200);
  assert.equal(user.otpAttempts, 0);
  assert.equal(user.otp, null);
});

// ── simultaneous sends ──────────────────────────────────────────────────────

test("two simultaneous resends send only one email", async () => {
  makeUser();
  sendDelayMs = 30;
  const [a, b] = await Promise.all([
    call(handleResendOTP, { userId: ID }),
    call(handleResendOTP, { userId: ID }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 429]);
  assert.equal(sentVerification.length, 1);
  assert.equal(users.get(ID).otp, sentVerification[0].otp);
});

// ── forgot / reset password ─────────────────────────────────────────────────

test("forgot-password sends a code, stores it, and starts the cooldown", async () => {
  const user = makeUser({ emailVerified: true });
  const r = await call(handleForgotPassword, { email: "a@example.com" });
  assert.equal(r.status, 200);
  assert.equal(r.json.cooldownSeconds, 60);
  assert.equal(sentReset.length, 1);
  assert.match(user.resetOTP, /^\d{6}$/);
  assert.ok(sentReset[0].text.includes(user.resetOTP));

  const again = await call(handleForgotPassword, { email: "a@example.com" });
  assert.equal(again.status, 429);
  assert.ok(again.json.retryAfterSeconds > 0);
  assert.equal(sentReset.length, 1);
});

test("forgot-password hourly cap", async () => {
  makeUser({
    emailVerified: true,
    resetOtpSentAt: new Date(Date.now() - 5 * 60 * 1000),
    resetOtpResend: { count: 5, windowStart: new Date(Date.now() - 10 * 60 * 1000) },
  });
  const r = await call(handleForgotPassword, { email: "a@example.com" });
  assert.equal(r.status, 429);
  assert.equal(sentReset.length, 0);
});

test("a failed reset email keeps the previous reset code", async () => {
  const user = makeUser({ emailVerified: true, resetOTP: "123456" });
  failNextSend = true;
  const r = await call(handleForgotPassword, { email: "a@example.com" });
  assert.equal(r.status, 500);
  assert.equal(user.resetOTP, "123456");
});

test("reset-password counts wrong codes and locks after 5", async () => {
  const user = makeUser({ emailVerified: true, resetOTP: "123456", resetOtpAttempts: 0 });
  const body = { email: "a@example.com", newPassword: "newpass1" };
  for (let i = 0; i < 5; i++) {
    const r = await call(handleResetPassword, { ...body, otp: "000000" });
    assert.equal(r.status, 400);
  }
  assert.equal(user.resetOtpAttempts, 5);
  const locked = await call(handleResetPassword, { ...body, otp: "123456" });
  assert.equal(locked.status, 429);
  assert.equal(locked.json.tooManyAttempts, true);
  assert.equal(user.resetOTP, "123456");
});

test("reset-password with the right code works and clears state", async () => {
  const user = makeUser({ emailVerified: true, resetOTP: "123456", resetOtpAttempts: 2 });
  const r = await call(handleResetPassword, {
    email: "a@example.com",
    otp: "123456",
    newPassword: "newpass1",
  });
  assert.equal(r.status, 200);
  assert.equal(user.resetOTP, null);
  assert.equal(user.resetOtpAttempts, 0);
  assert.ok(user.password && user.password !== "newpass1");
});

test("reset-password with no outstanding code is refused", async () => {
  makeUser({ emailVerified: true, resetOTP: null });
  const r = await call(handleResetPassword, {
    email: "a@example.com",
    otp: "123456",
    newPassword: "newpass1",
  });
  assert.equal(r.status, 400);
});
