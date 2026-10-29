const express = require("express");
const { handleAppleNotification } = require("../controllers/appleNotificationController");

const router = express.Router();

router.post("/", handleAppleNotification);

module.exports = router;
