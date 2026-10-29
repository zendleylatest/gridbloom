const express = require("express");
const {
  deleteLunaCycleState,
  getLunaCycleState,
  getLunaInsights,
  saveLunaCycleState,
} = require("../controllers/lunaCycleController");
const { authenticate } = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/state", authenticate, getLunaCycleState);
router.get("/insights", authenticate, getLunaInsights);
router.put("/state", authenticate, saveLunaCycleState);
router.delete("/state", authenticate, deleteLunaCycleState);

module.exports = router;
