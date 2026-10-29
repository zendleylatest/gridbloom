const express = require("express");
const c = require("../controllers/leaderboardController");
const { authenticate, optionalAuth } = require("../middlewares/authMiddleware");

const router = express.Router();

router.post("/submit", authenticate, c.submitRun);
router.get("/board", optionalAuth, c.getBoard);
router.get("/friends-board", authenticate, c.getFriendsBoard);
router.get("/tournament/prize", authenticate, c.getTournamentPrize);
router.post("/tournament/claim", authenticate, c.claimTournamentPrize);

router.get("/friends", authenticate, c.listFriends);
router.post("/friends", authenticate, c.addFriend);
router.delete("/friends/:userId", authenticate, c.removeFriend);

module.exports = router;
