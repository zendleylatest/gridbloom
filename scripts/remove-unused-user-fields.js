// Removes user fields Gridbloom does not use (left over from the old app):
// openAiUsage, subscriptionPlan, isPro, subscription, careUsage, creationsPublic.
//
//   node scripts/remove-unused-user-fields.js          (dry run: only counts)
//   node scripts/remove-unused-user-fields.js --apply  (removes them)
require("dotenv").config();
const mongoose = require("mongoose");

const FIELDS = ["openAiUsage", "subscriptionPlan", "isPro", "subscription", "careUsage", "creationsPublic"];

(async () => {
  const apply = process.argv.includes("--apply");
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB_NAME || undefined,
  });
  const users = mongoose.connection.collection("users");
  const has = { $or: FIELDS.map((f) => ({ [f]: { $exists: true } })) };
  const total = await users.countDocuments({});
  const withFields = await users.countDocuments(has);
  console.log(`${mongoose.connection.name}: ${withFields} of ${total} users have unused fields`);
  if (apply) {
    const r = await users.updateMany(has, { $unset: Object.fromEntries(FIELDS.map((f) => [f, ""])) });
    console.log(`removed from ${r.modifiedCount} users`);
  } else {
    console.log("dry run: nothing changed. Add --apply to remove them.");
  }
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
