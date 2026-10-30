"use strict";
/**
 * One account, one way to sign in. If an email already belongs to an account
 * that was made with a different method (Google, Apple, or email + password),
 * the other methods must not silently take it over: the app tells the player
 * which method to use instead.
 */
const LABELS = { google: "Google", apple: "Apple", password: "your email and password" };

/** Sign-in methods an existing account was created with. */
function providersOf(user) {
  const methods = [];
  if (user?.googleId) methods.push("google");
  if (user?.appleId) methods.push("apple");
  if (user?.password) methods.push("password");
  return methods.length ? methods : ["password"];
}

/**
 * null if [wanted] may sign in to [user]; otherwise the 409 body telling the
 * player which method that account uses.
 */
function methodConflict(user, wanted) {
  const have = providersOf(user);
  if (have.includes(wanted)) return null;
  const method = have[0];
  return {
    code: "EMAIL_EXISTS_OTHER_METHOD",
    method,
    error: `An account with this email already exists. Please continue with ${LABELS[method]}.`,
  };
}

module.exports = { providersOf, methodConflict, LABELS };
