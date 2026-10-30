const express = require("express");
const { verifyPurchase, getEntitlements, claimGrants } = require("../controllers/purchaseController");
const { authenticate } = require("../middlewares/authMiddleware");

const router = express.Router();

router.post("/verify", authenticate, verifyPurchase);
router.get("/entitlements", authenticate, getEntitlements);
router.post("/claim", authenticate, claimGrants);

module.exports = router;
