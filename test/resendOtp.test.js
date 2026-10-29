const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// Stub the mailer and the User model before the controller loads, so these
// tests never touch SMTP or MongoDB.
const sent = [];
let failNextSend = false;
const emailPath = require.resolve("../services/emailService");
require.cache[emailPath] = {
  id: emailPath,
  filename: emailPath,
  loaded: true,
  exports: {
    sendOTPEmail: async (email, otp) => {
      if (failNextSend) {
        failNextSend = false;
        throw new Error("smtp down");
      }
      sent.push({ email, otp });
    },
    sendEmail: async () => {},
    buildOtpEmailHtml: () => "",
    logOtp: () => {},
  },
};

const User = require("../models/usersModel");
const users = new Map();
User.findById = async (id) => users.get(String(id)) || null;

const { handleResendOTP } = require("../controllers/userAuthControllers");

const ID = "64b7f0c2a1b2c3d4e5f60718";

function makeUser(overrides = {}) {
  const user = {
    _id: ID,
    email: "a@example.com",
    isGuest: false,
    emailVerified: false,
    otp: "111111",
    otpSentAt: new Date(Date.now() - 5 * 60 * 1000),
    otpResend: undefined,
    saves: 0,
    async save() {
      this.saves += 1;
    },
    ...overrides,
  };
  users.set(ID, user);
  return user;
}

async function call(body) {
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
  await handleResendOTP({ body }, res);
  return { status, json };
}

test.beforeEach(() => {
  sent.length = 0;
  failNextSend = false;
  users.clear();
});

test("rejects a missing or malformed userId", async () => {
  assert.equal((await call({})).status, 400);
  assert.equal((await call({ userId: "not-an-id" })).status, 400);
});

test("unknown user is rejected", async () => {
  assert.equal((await call({ userId: ID })).status, 400);
});

test("signup resend replaces the code, emails it, and records the send time", async () => {
  const user = makeUser();
  const { status, json } = await call({ userId: ID });
  assert.equal(status, 200);
  assert.equal(json.cooldownSeconds, 60);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].email, "a@example.com");
  assert.match(sent[0].otp, /^\d{6}$/);
  assert.equal(user.otp, sent[0].otp);
  assert.notEqual(user.otp, "111111");
  assert.equal(user.otpResend.count, 1);
  assert.equal(user.saves, 1);
});

test("guest binding resend goes to the pending email and restarts the expiry window", async () => {
  const old = new Date(Date.now() - 14 * 60 * 1000);
  const user = makeUser({
    isGuest: true,
    emailVerified: false,
    otp: null,
    pendingBinding: { email: "new@example.com", otp: "222222", requestedAt: old },
  });
  const { status } = await call({ userId: ID });
  assert.equal(status, 200);
  assert.equal(sent[0].email, "new@example.com");
  assert.equal(user.pendingBinding.otp, sent[0].otp);
  assert.ok(user.pendingBinding.requestedAt.getTime() > old.getTime());
});

test("a second request inside the cooldown is refused with retryAfterSeconds", async () => {
  makeUser({ otpSentAt: new Date(Date.now() - 10 * 1000) });
  const { status, json } = await call({ userId: ID });
  assert.equal(status, 429);
  assert.ok(json.retryAfterSeconds > 0 && json.retryAfterSeconds <= 50);
  assert.equal(sent.length, 0);
});

test("hourly cap stops a sixth resend", async () => {
  makeUser({ otpResend: { count: 5, windowStart: new Date(Date.now() - 10 * 60 * 1000) } });
  const { status, json } = await call({ userId: ID });
  assert.equal(status, 429);
  assert.ok(json.retryAfterSeconds > 0);
  assert.equal(sent.length, 0);
});

test("the cap resets once the hour window has passed", async () => {
  const user = makeUser({
    otpResend: { count: 5, windowStart: new Date(Date.now() - 61 * 60 * 1000) },
  });
  const { status } = await call({ userId: ID });
  assert.equal(status, 200);
  assert.equal(user.otpResend.count, 1);
});

test("a failed email send keeps the old code and does not count against the limit", async () => {
  const user = makeUser();
  failNextSend = true;
  const { status } = await call({ userId: ID });
  assert.equal(status, 500);
  assert.equal(user.otp, "111111");
  assert.equal(user.otpResend, undefined);
  assert.equal(user.saves, 0);
});

test("already-verified accounts and real guests have nothing to resend", async () => {
  makeUser({ emailVerified: true });
  assert.equal((await call({ userId: ID })).status, 400);
  makeUser({ isGuest: true, emailVerified: false, otp: null });
  assert.equal((await call({ userId: ID })).status, 400);
  assert.equal(sent.length, 0);
});
