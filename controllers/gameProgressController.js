const GameProgress = require("../models/gameProgressModel");
const { mergeGameData } = require("../services/gameProgressMerge");

const MAX_ATTEMPTS = 4;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function view(record) {
  return {
    progress: record?.progress ?? null,
    save: record?.save ?? null,
    revision: record?.revision ?? 0,
    schemaVersion: record?.schemaVersion ?? 1,
    updatedAt: record?.updatedAt ?? null,
  };
}

async function getGameProgress(req, res) {
  try {
    const record = await GameProgress.findOne({ userId: req.authUser._id }).lean();
    return res.json(view(record));
  } catch (error) {
    console.error("[game-progress:get]", error);
    return res.status(500).json({ error: "Could not load game data" });
  }
}

/**
 * Saves the player's game data. The client sends the revision it last saw;
 * if the server has moved on (another device saved), the two copies are
 * merged instead of one silently overwriting the other, and the merged copy
 * is returned for the client to adopt.
 */
async function saveGameProgress(req, res) {
  try {
    const { progress, save, baseRevision, clientUpdatedAt } = req.body || {};
    if (!isObj(progress)) {
      return res.status(400).json({ error: "progress object is required" });
    }
    if (save !== undefined && !isObj(save)) {
      return res.status(400).json({ error: "save must be an object" });
    }
    const incoming = {
      progress,
      save: save || {},
      clientUpdatedAt: clientUpdatedAt ? new Date(clientUpdatedAt) : new Date(),
    };
    const userId = req.authUser._id;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const existing = await GameProgress.findOne({ userId }).lean();
      if (!existing) {
        try {
          const created = await GameProgress.create({ userId, ...incoming, revision: 1 });
          return res.json({ ...view(created.toObject()), merged: false });
        } catch (err) {
          if (err?.code === 11000) continue; // another request created it first
          throw err;
        }
      }

      const inSync = Number(baseRevision) === existing.revision;
      const next = inSync ? incoming : { ...mergeGameData(existing, incoming), clientUpdatedAt: incoming.clientUpdatedAt };
      const updated = await GameProgress.findOneAndUpdate(
        { userId, revision: existing.revision },
        { $set: { ...next }, $inc: { revision: 1 } },
        { new: true }
      ).lean();
      if (updated) return res.json({ ...view(updated), merged: !inSync });
    }
    return res.status(409).json({ error: "Game data changed while saving. Try again." });
  } catch (error) {
    console.error("[game-progress:save]", error);
    return res.status(500).json({ error: "Could not save game data" });
  }
}

async function deleteGameProgress(req, res) {
  try {
    await GameProgress.deleteOne({ userId: req.authUser._id });
    return res.json({ ok: true });
  } catch (error) {
    console.error("[game-progress:delete]", error);
    return res.status(500).json({ error: "Could not delete game data" });
  }
}

module.exports = { getGameProgress, saveGameProgress, deleteGameProgress };
