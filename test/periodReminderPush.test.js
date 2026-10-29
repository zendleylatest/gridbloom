const test = require("node:test");
const assert = require("node:assert/strict");
const { MESSAGES, resolveLanguage, reminderCopy } = require("../services/periodReminderMessages");
const {
  periodStartsFromLogs,
  nextPeriodStart,
  reminderDue,
  buildReminderMessage,
  sweepPeriodReminders,
  scheduleDebugReminder,
} = require("../services/periodReminderPushService");

const day = (s) => Date.parse(`${s}T00:00:00Z`);
const flow = (...keys) => Object.fromEntries(keys.map((k) => [k, { flow: "medium" }]));

// "now" helper: a UTC instant that is HH:MM on `date` for a given offset.
const at = (date, hh, offsetMin = 0) =>
  Date.parse(`${date}T${String(hh).padStart(2, "0")}:00:00Z`) - offsetMin * 60 * 1000;

test("period starts mirror the app: latest flow day of each block, newest first", () => {
  const logs = { ...flow("2026-09-03", "2026-10-01"), "2026-09-20": { flow: "none" } };
  assert.deepEqual(periodStartsFromLogs(logs), [day("2026-10-01"), day("2026-09-03")]);
});

test("next period is the first cycle date strictly after today", () => {
  const state = { cycleLength: 28, logs: flow("2026-10-01") };
  assert.equal(nextPeriodStart(state, day("2026-10-05")), day("2026-10-29"));
  assert.equal(nextPeriodStart(state, day("2026-10-29")), day("2026-11-26"));
  assert.equal(nextPeriodStart({ cycleLength: 28, logs: {} }, day("2026-10-05")), null);
});

test("reminder is due exactly 2 days before, from 9:00 local", () => {
  const state = { cycleLength: 28, logs: flow("2026-10-01"), periodReminders: true };
  // predicted start 2026-10-29 -> reminder day is 2026-10-27
  const due = reminderDue({ state, utcOffsetMinutes: 0, lastReminderFor: null, nowMs: at("2026-10-27", 9) });
  assert.deepEqual(due, { key: "2026-10-29" });
  assert.equal(reminderDue({ state, utcOffsetMinutes: 0, lastReminderFor: null, nowMs: at("2026-10-27", 8) }), null);
  assert.equal(reminderDue({ state, utcOffsetMinutes: 0, lastReminderFor: null, nowMs: at("2026-10-26", 12) }), null);
  assert.equal(reminderDue({ state, utcOffsetMinutes: 0, lastReminderFor: null, nowMs: at("2026-10-28", 12) }), null);
});

test("the user's timezone decides which local day and hour it is", () => {
  const state = { cycleLength: 28, logs: flow("2026-10-01"), periodReminders: true };
  // UTC+5: 9:00 local on the 27th is 04:00 UTC.
  const nowMs = Date.parse("2026-10-27T04:00:00Z");
  assert.ok(reminderDue({ state, utcOffsetMinutes: 300, lastReminderFor: null, nowMs }));
  // Same instant for a UTC user is only 04:00 -> too early.
  assert.equal(reminderDue({ state, utcOffsetMinutes: 0, lastReminderFor: null, nowMs }), null);
});

test("already-sent, opted-out and no-data cases are not due", () => {
  const base = { cycleLength: 28, logs: flow("2026-10-01"), periodReminders: true };
  const nowMs = at("2026-10-27", 10);
  assert.equal(reminderDue({ state: base, utcOffsetMinutes: 0, lastReminderFor: "2026-10-29", nowMs }), null);
  assert.equal(reminderDue({ state: { ...base, periodReminders: false }, utcOffsetMinutes: 0, lastReminderFor: null, nowMs }), null);
  assert.equal(reminderDue({ state: { cycleLength: 28, logs: {} }, utcOffsetMinutes: 0, lastReminderFor: null, nowMs }), null);
});

test("message hides period wording unless the user turned privacy off", () => {
  assert.equal(buildReminderMessage({}).title, "Lunear reminder");
  assert.equal(buildReminderMessage({ hideNotificationContent: true }).title, "Lunear reminder");
  const open = buildReminderMessage({ hideNotificationContent: false });
  assert.equal(open.title, "Period reminder");
  assert.match(open.body, /2 days/);
  assert.match(buildReminderMessage({}, { debug: true }).body, /\(debug test\)$/);
});

function fakeSweep(docs, sendResult) {
  const sent = [];
  const claimed = new Set();
  const released = [];
  return {
    sent,
    released,
    run: (nowMs) =>
      sweepPeriodReminders({
        nowMs,
        cursor: async function* () {
          for (const d of docs) yield d;
        },
        claim: async (doc, key) => {
          const id = `${doc._id}:${key}`;
          if (claimed.has(id)) return null;
          claimed.add(id);
          return doc;
        },
        release: async (doc, previous) => released.push([doc._id, previous]),
        send: async (userId, message) => {
          sent.push({ userId, message });
          return sendResult;
        },
      }),
  };
}

const dueDoc = (overrides = {}) => ({
  _id: "c1",
  userId: "u1",
  utcOffsetMinutes: 0,
  lastPeriodReminderFor: null,
  state: { cycleLength: 28, logs: flow("2026-10-01"), periodReminders: true, hideNotificationContent: false },
  ...overrides,
});

test("sweep sends once per predicted period and not again", async () => {
  const f = fakeSweep([dueDoc()], { sent: 1 });
  const nowMs = at("2026-10-27", 9);
  const first = await f.run(nowMs);
  assert.deepEqual(first, { checked: 1, due: 1, sent: 1 });
  assert.equal(f.sent[0].message.data.periodStart, "2026-10-29");
  const second = await f.run(nowMs + 10 * 60 * 1000); // next sweep, same day
  assert.equal(second.sent, 0);
  assert.equal(f.sent.length, 1);
});

test("sweep skips users that are not due", async () => {
  const f = fakeSweep([dueDoc(), dueDoc({ _id: "c2", state: { cycleLength: 28, logs: {} } })], { sent: 1 });
  const r = await f.run(at("2026-10-20", 9));
  assert.deepEqual(r, { checked: 2, due: 0, sent: 0 });
  assert.equal(f.sent.length, 0);
});

test("when no device received the push, the claim is released so a later sweep retries", async () => {
  const f = fakeSweep([dueDoc()], { sent: 0, reason: "no_tokens" });
  const r = await f.run(at("2026-10-27", 9));
  assert.equal(r.sent, 0);
  assert.equal(f.released.length, 1);
});

test("a debug reminder replaces the previous pending one and clamps the delay", () => {
  const a = scheduleDebugReminder("user-x", 600, {});
  const b = scheduleDebugReminder("user-x", 999999, {});
  assert.equal(a.delaySeconds, 600);
  assert.equal(b.delaySeconds, 3600);
  const c = scheduleDebugReminder("user-x", "nonsense", {});
  assert.equal(c.delaySeconds, 600);
  // timers are unref'd, so the test process can exit without waiting
});

test("no reminder is sent after 21:00 local, even on the due day", () => {
  const state = { cycleLength: 28, logs: flow("2026-10-01"), periodReminders: true };
  assert.ok(reminderDue({ state, utcOffsetMinutes: 0, lastReminderFor: null, nowMs: at("2026-10-27", 20) }));
  assert.equal(reminderDue({ state, utcOffsetMinutes: 0, lastReminderFor: null, nowMs: at("2026-10-27", 21) }), null);
  assert.equal(reminderDue({ state, utcOffsetMinutes: 0, lastReminderFor: null, nowMs: at("2026-10-27", 23) }), null);
});

test("every supported language has complete private and detailed copy", () => {
  assert.equal(Object.keys(MESSAGES).length, 13);
  for (const [lang, copy] of Object.entries(MESSAGES)) {
    for (const kind of ["private", "detailed"]) {
      assert.ok(copy[kind].title && copy[kind].body, `${lang}.${kind} incomplete`);
    }
    // The private text must not mention periods/cycles in English.
    if (lang === "en") assert.doesNotMatch(copy.private.body + copy.private.title, /period|cycle/i);
  }
});

test("language codes are normalised and unknown ones fall back to English", () => {
  assert.equal(resolveLanguage("pt-BR"), "pt");
  assert.equal(resolveLanguage("ZH_cn"), "zh");
  assert.equal(resolveLanguage("xx"), "en");
  assert.equal(resolveLanguage(undefined), "en");
  assert.equal(reminderCopy("fr", { hideContent: false }).title, "Rappel de règles");
});

test("the push is written in the user's language and honours the privacy setting", () => {
  assert.equal(buildReminderMessage({ hideNotificationContent: false }, { languageCode: "de" }).title, "Perioden-Erinnerung");
  assert.equal(buildReminderMessage({}, { languageCode: "es" }).title, "Recordatorio de Lunear");
  assert.equal(buildReminderMessage({}, { languageCode: "nope" }).title, "Lunear reminder");
});
