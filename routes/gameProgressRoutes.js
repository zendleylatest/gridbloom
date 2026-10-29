const express = require("express");
const {
  deleteGameProgress,
  getGameProgress,
  saveGameProgress,
} = require("../controllers/gameProgressController");
const { authenticate } = require("../middlewares/authMiddleware");
const { getDailyPuzzle } = require("../controllers/leaderboardController");

const router = express.Router();

router.get("/progress", authenticate, getGameProgress);
router.put("/progress", authenticate, saveGameProgress);
router.delete("/progress", authenticate, deleteGameProgress);
// The Daily puzzle is defined by the server so everyone, and the score checker, share it.
router.get("/daily/:key", getDailyPuzzle);

module.exports = router;
