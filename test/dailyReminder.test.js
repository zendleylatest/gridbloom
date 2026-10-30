const test = require("node:test");
const assert = require("node:assert/strict");
const { parseTimes, dueSlots, sweepDailyReminders, CATCH_UP_MS } = require("../services/dailyReminderService");

const at = (h, m = 0) => Date.UTC(2026, 9, 30, h, m);
const times = parseTimes("09:00,18:00");

function harness(sendResult = { sent: 3, failed: 0 }, tokens = ["a", "b", "c"]) {
  const claimed = new Set();
  const calls = { sent: [], released: [], recorded: [] };
  return {
    calls,
    opts: {
      times,
      claim: async (s) => (claimed.has(s) ? false : (claimed.add(s), true)),
      release: async (s) => { claimed.delete(s); calls.released.push(s); },
      record: async (s, r) => calls.recorded.push([s, r]),
      tokensFn: async () => tokens,
      send: async (t, msg, data) => { calls.sent.push({ t, msg, data }); return sendResult; },
    },
  };
}

test("parseTimes keeps valid entries and falls back to the default", () => {
  assert.deepEqual(parseTimes("18:30, 7:05, nope, 25:00"), [{ hour: 7, minute: 5 }, { hour: 18, minute: 30 }]);
  assert.equal(parseTimes("garbage").length, 2);
});

test("nothing is due between slots, one slot is due right after its time", () => {
  assert.equal(dueSlots(at(8, 59), times).length, 0);
  assert.equal(dueSlots(at(12), times).length, 0);
  assert.deepEqual(dueSlots(at(9, 0), times).map((d) => d.slot), ["2026-10-30T09:00"]);
  assert.deepEqual(dueSlots(at(18, 5), times).map((d) => d.slot), ["2026-10-30T18:00"]);
});

test("a slot is dropped once the catch-up window has passed", () => {
  assert.equal(dueSlots(at(9, 0) + CATCH_UP_MS, times).length, 0);
});

test("a slot is sent once, even if the sweep runs many times", async () => {
  const h = harness();
  const first = await sweepDailyReminders({ ...h.opts, nowMs: at(9, 1) });
  const second = await sweepDailyReminders({ ...h.opts, nowMs: at(9, 2) });
  assert.equal(first.sent, 3);
  assert.equal(second.due, 0);
  assert.equal(h.calls.sent.length, 1);
  assert.equal(h.calls.sent[0].data.type, "daily_reminder");
});

test("morning and evening use different copy", async () => {
  const h = harness();
  await sweepDailyReminders({ ...h.opts, nowMs: at(9, 1) });
  await sweepDailyReminders({ ...h.opts, nowMs: at(18, 1) });
  assert.equal(h.calls.sent.length, 2);
  assert.notEqual(h.calls.sent[0].msg.title, h.calls.sent[1].msg.title);
});

test("a failed delivery releases the slot so the next sweep retries", async () => {
  const h = harness({ sent: 0, failed: 3 });
  await sweepDailyReminders({ ...h.opts, nowMs: at(9, 1) });
  assert.deepEqual(h.calls.released, ["2026-10-30T09:00"]);
  await sweepDailyReminders({ ...h.opts, nowMs: at(9, 2) });
  assert.equal(h.calls.sent.length, 2);
});

test("no tokens means nothing is sent", async () => {
  const h = harness({ sent: 0, failed: 0 }, []);
  const s = await sweepDailyReminders({ ...h.opts, nowMs: at(9, 1) });
  assert.equal(h.calls.sent.length, 0);
  assert.equal(s.sent, 0);
});
