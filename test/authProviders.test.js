const test = require("node:test");
const assert = require("node:assert/strict");
const { providersOf, methodConflict } = require("../services/authProviders");

test("which methods an account was made with", () => {
  assert.deepEqual(providersOf({ googleId: "g" }), ["google"]);
  assert.deepEqual(providersOf({ appleId: "a" }), ["apple"]);
  assert.deepEqual(providersOf({ password: "hash" }), ["password"]);
  assert.deepEqual(providersOf({}), ["password"]);
  assert.deepEqual(providersOf({ googleId: "g", appleId: "a" }), ["google", "apple"]);
});

test("a different method on the same email is refused with the method to use", () => {
  const googleAccount = { googleId: "g" };
  const c = methodConflict(googleAccount, "apple");
  assert.equal(c.code, "EMAIL_EXISTS_OTHER_METHOD");
  assert.equal(c.method, "google");
  assert.match(c.error, /continue with Google/);
  assert.equal(methodConflict({ appleId: "a" }, "google").method, "apple");
  assert.equal(methodConflict({ password: "x" }, "apple").method, "password");
  assert.match(methodConflict({ password: "x" }, "google").error, /email and password/);
});

test("the same method is always allowed", () => {
  assert.equal(methodConflict({ googleId: "g" }, "google"), null);
  assert.equal(methodConflict({ appleId: "a" }, "apple"), null);
  assert.equal(methodConflict({ password: "x" }, "password"), null);
});
