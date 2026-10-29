const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildInsightsHash,
  buildStandardInsights,
} = require("../services/lunaInsightsService");

function flow(symptoms = []) {
  return { flow: "medium", symptoms };
}

test("buildStandardInsights derives averages and recent cycle comparisons", () => {
  const state = {
    logs: {
      "2026-01-01": flow(),
      "2026-01-02": flow(),
      "2026-01-03": flow(),
      "2026-01-29": flow(),
      "2026-01-30": flow(),
      "2026-01-31": flow(),
      "2026-02-01": flow(),
      "2026-02-02": flow(),
      "2026-02-27": flow(["cramps"]),
      "2026-02-28": flow(["cramps", "headache"]),
      "2026-03-01": flow(["headache"]),
    },
  };

  const result = buildStandardInsights(
    state,
    30,
    new Date("2026-03-10T12:00:00.000Z")
  );

  assert.equal(result.averageCycleLength, 28.5);
  assert.equal(result.averagePeriodLength, 3.7);
  assert.deepEqual(result.recentCycles.map((item) => item.days), [28, 29]);
  assert.deepEqual(result.symptoms, [
    { id: "cramps", count: 2 },
    { id: "headache", count: 2 },
  ]);
});

test("buildStandardInsights returns explicit empty-state values", () => {
  const result = buildStandardInsights({}, 90, new Date("2026-03-10T12:00:00Z"));
  assert.equal(result.averageCycleLength, null);
  assert.equal(result.averagePeriodLength, null);
  assert.deepEqual(result.recentCycles, []);
  assert.deepEqual(result.symptoms, []);
});

test("symptom range excludes older logs", () => {
  const result = buildStandardInsights(
    {
      logs: {
        "2026-01-01": { flow: "none", symptoms: ["cramps"] },
        "2026-03-05": { flow: "none", symptoms: ["fatigue"] },
      },
    },
    30,
    new Date("2026-03-10T12:00:00Z")
  );
  assert.deepEqual(result.symptoms, [{ id: "fatigue", count: 1 }]);
});

test("AI cache keys include the requested language", () => {
  const state = { logs: { "2026-03-05": flow(["cramps"]) } };
  assert.notEqual(
    buildInsightsHash(state, "en"),
    buildInsightsHash(state, "es")
  );
});
