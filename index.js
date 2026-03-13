require("dotenv").config();
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const twilio = require("twilio");
const axios = require("axios");
const fs = require("fs");

// ---------- ENV: Mongo ----------
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "fundraisingDB";
const NEW_DAYS = Number(process.env.NEW_DAYS || "30");
const PORT = Number(process.env.PORT || "3000");
const API_KEY = process.env.API_KEY || "";

// contact id that must be excluded
const EXCLUDED_CONTACT_ID = "6959a331202a572ef92888d2";

if (!MONGODB_URI) {
  console.error("MONGODB_URI is missing in .env");
  process.exit(1);
}

// ---------- ENV: MWL Short URL API ----------
const MWL_SHORT_API_KEY = process.env.MWL_SHORT_API_KEY;
const MWL_SHORT_API_BASE = process.env.MWL_SHORT_API_BASE || 
"https://u.mwl.org/api.php";

if (!MWL_SHORT_API_KEY) {
  console.error("MWL_SHORT_API_KEY is missing in .env");
  process.exit(1);
}

// ---------- ENV: Twilio ----------
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_PHONE;

if (!TWILIO_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM) {
  console.error("Twilio env vars missing: TWILIO_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE");
  process.exit(1);
}

// Twilio client
const client = twilio(TWILIO_SID, TWILIO_AUTH_TOKEN);

// ---------- Safety ----------
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";

// ---------- CSV OUTPUT ----------
const CSV_FILE = process.env.CSV_FILE || "donation_sms_report.csv";

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

function initCsvIfNeeded() {
  if (!fs.existsSync(CSV_FILE)) {
    const header = 
["timestamp","donation_id","contact_id","userid","phone","eligible","reason","url_type","url","dry_run","twilio_sid"].map(csvEscape).join(",") 
+ "\n";
    fs.writeFileSync(CSV_FILE, header, "utf8");
  }
}

function appendCsvRow(row) {
  const line = row.map(csvEscape).join(",") + "\n";
  fs.appendFileSync(CSV_FILE, line, "utf8");
}

// ---------- RULES ----------

function checkEligibility(donation) {
  const stage = (donation.StageName || "").trim().toLowerCase();
  const source = (donation.Donation_Source__c || "").trim().toLowerCase();

  if (stage !== "closed won") {
    return { ok: false, reason: "stage_not_closed_won" };
  }

  if (source !== "fundraising app") {
    return { ok: false, reason: "wrong_source" };
  }

  if (!donation.contact) {
    return { ok: false, reason: "missing_contact" };
  }

  if (donation.contact === EXCLUDED_CONTACT_ID) {
    return { ok: false, reason: "excluded_contact" };
  }

  if (donation.smsSent === true) {
    return { ok: false, reason: "already_sent" };
  }

  return { ok: true };
}

// ---------- LINKS ----------
function buildLongUpdateLink(donation, contact) {
  const base = "https://mwl.org/update-address/";

  let donationId = donation && donation._id ? donation._id.toString() : 
"";
  let userId = "";

  if (contact) {
    if (contact.salesforceID) userId = contact.salesforceID;
    else if (contact.salesforceId) userId = contact.salesforceId;
    else if (contact._id) userId = contact._id.toString();
  }

  const params = [];
  if (userId) params.push("userid=" + encodeURIComponent(userId));
  if (donationId) params.push("donation=" + 
encodeURIComponent(donationId));

  return params.length ? base + "?" + params.join("&") : base;
}

async function getMwlShortUrl(userid, donationId) {
  const { data } = await axios.get(MWL_SHORT_API_BASE, {
    params: {
      auth: MWL_SHORT_API_KEY,
      userid,
      donation: donationId,
    },
    timeout: 15000,
    validateStatus: () => true,
  });

  if (!data || data.success !== true || !data.short_url) {
    throw new Error("MWL API failed: " + JSON.stringify(data));
  }

  return data.short_url;
}

function buildSmsBody(shortUrl) {
  return "Thanks for your donation! Please click the link below to get your receipt. Your donation is tax deductible. " + shortUrl;
}

// ---------- DATABASE ----------
let mongoClient;
let db;
let donationsColl;
let contactsColl;

// ---------- MAIN LOGIC ----------
async function processDonation(donation) {
  const donationId = donation._id;
  const contactIdStr = donation.contact;

  const eligibility = checkEligibility(donation);
  if (!eligibility.ok) {
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, "", 
"", "false", eligibility.reason, "", "", String(DRY_RUN), ""]);
    return { success: false, reason: eligibility.reason };
  }

  let contactObjId;
  try {
    contactObjId = new ObjectId(contactIdStr);
  } catch (e) {
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, "", 
"", "false", "invalid_contact_objectid", "", "", String(DRY_RUN), ""]);
    return { success: false, reason: "invalid_contact_objectid" };
  }

  const contact = await contactsColl.findOne({ _id: contactObjId });
  if (!contact) {
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, "", 
"", "false", "contact_not_found", "", "", String(DRY_RUN), ""]);
    return { success: false, reason: "contact_not_found" };
  }

  const phone = contact.Phone || contact.phone || contact.mobile || null;
  if (!phone) {
    const useridMissingPhone = contact.salesforceID || 
contact.salesforceId || "";
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, 
useridMissingPhone, "", "false", "missing_phone", "", "", String(DRY_RUN), 
""]);
    return { success: false, reason: "missing_phone" };
  }

  const userid = contact.salesforceID || contact.salesforceId || null;
  if (!userid) {
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, "", 
phone, "false", "missing_salesforce_userid", "", "", String(DRY_RUN), 
""]);
    return { success: false, reason: "missing_salesforce_userid" };
  }

  const donationParam = donationId ? donationId.toString() : null;
  if (!donationParam) {
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, 
userid, phone, "false", "missing_donation_id", "", "", String(DRY_RUN), 
""]);
    return { success: false, reason: "missing_donation_id" };
  }

  let shortUrl;
  let urlType = "short";
  try {
    shortUrl = await getMwlShortUrl(userid, donationParam);
  } catch (err) {
    shortUrl = buildLongUpdateLink(donation, contact);
    urlType = "long_fallback";
  }

  const body = buildSmsBody(shortUrl);

  if (DRY_RUN) {
    console.log("DRY RUN SMS to " + phone + ":");
    console.log("  " + body);
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, 
userid, phone, "true", "ok", urlType, shortUrl, String(DRY_RUN), ""]);
    return { success: true, mode: "dry_run", phone, url: shortUrl };
  }

  try {
    const msg = await client.messages.create({
      body,
      from: TWILIO_FROM,
      to: phone,
    });

    console.log("SMS sent to " + phone + ". SID: " + msg.sid);

    await donationsColl.updateOne(
      { _id: donationId },
      {
        $set: {
          smsSent: true,
          smsSentAt: new Date(),
          smsSid: msg.sid,
          smsPhone: phone,
          smsUrl: shortUrl,
        },
      }
    );

    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, 
userid, phone, "true", "sent", urlType, shortUrl, String(DRY_RUN), 
msg.sid]);

    return { success: true, mode: "live", sid: msg.sid, phone, url: 
shortUrl };
  } catch (err) {
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, 
userid, phone, "true", "twilio_error", urlType, shortUrl, String(DRY_RUN), 
""]);
    return { success: false, reason: "twilio_error", error: err.message || 
String(err) };
  }
}

// ---------- SERVER ----------
async function start() {
  initCsvIfNeeded();

  mongoClient = new MongoClient(MONGODB_URI);
  await mongoClient.connect();

  db = mongoClient.db(DB_NAME);
  donationsColl = db.collection("donations");
  contactsColl = db.collection("contacts");

  const app = express();
  app.use(express.json());

  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      mode: DRY_RUN ? "dry_run" : "live",
      service: "donation-sms"
    });
  });

  app.post("/donation-created", async (req, res) => {
    try {
      if (API_KEY) {
        const incomingKey = req.headers["x-api-key"];
        if (incomingKey !== API_KEY) {
          return res.status(401).json({ success: false, error: 
"Unauthorized" });
        }
      }

      const incomingDonation = req.body;

      if (!incomingDonation || !incomingDonation._id) {
        return res.status(400).json({
          success: false,
          error: "Request body must include a donation object with _id"
        });
      }

      let donationObjectId;
      try {
        donationObjectId = new ObjectId(incomingDonation._id);
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: "Invalid donation _id"
        });
      }

      const donation = await donationsColl.findOne({ _id: donationObjectId 
});

      if (!donation) {
        return res.status(404).json({
          success: false,
          error: "Donation not found in database"
        });
      }

      const result = await processDonation(donation);

      return res.status(200).json({
        success: true,
        result
      });
    } catch (err) {
      console.error("Endpoint error:", err.message || err);
      return res.status(500).json({
        success: false,
        error: err.message || "Internal server error"
      });
    }
  });

  app.listen(PORT, () => {
    console.log("Server running on port " + PORT);
    console.log("Mode:", DRY_RUN ? "DRY RUN" : "LIVE SEND");
    console.log("POST endpoint: /donation-created");
  });
}

start().catch((err) => {
  console.error("Startup error:", err.message || err);
  process.exit(1);
});
