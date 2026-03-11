require("dotenv").config();
const { MongoClient, ObjectId } = require("mongodb");
const twilio = require("twilio");
const axios = require("axios");
const fs = require("fs");

// ---------- ENV: Mongo ----------
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "fundraisingDB";
const NEW_DAYS = Number(process.env.NEW_DAYS || "30");

// contact id that must be excluded
const EXCLUDED_CONTACT_ID = "6959a331202a572ef92888d2";

if (!MONGODB_URI) {
  console.error("MONGODB_URI is missing in .env");
  process.exit(1);
}

// ---------- ENV: MWL Short URL API ----------
const MWL_SHORT_API_KEY = process.env.MWL_SHORT_API_KEY;
const MWL_SHORT_API_BASE = process.env.MWL_SHORT_API_BASE || "https://u.mwl.org/api.php";

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

// Safety controls
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";
const MAX_SMS = Number(process.env.MAX_SMS || "1");

// ---------- CSV OUTPUT ----------
const CSV_FILE = process.env.CSV_FILE || "donation_sms_report.csv";
function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}
function initCsvIfNeeded() {
  if (!fs.existsSync(CSV_FILE)) {
    const header = ["timestamp","donation_id","contact_id","userid","phone","eligible","reason","url_type","url","dry_run","twilio_sid"].map(csvEscape).join(",") + "\n";
    fs.writeFileSync(CSV_FILE, header, "utf8");
  }
}
function appendCsvRow(row) {
  const line = row.map(csvEscape).join(",") + "\n";
  fs.appendFileSync(CSV_FILE, line, "utf8");
}

// ---------- RULE 1: "NEW CREATED" ----------
function isNewDonation(donation) {
  const rawDate = donation.createdDate || donation.createdAt;
  if (!rawDate) return false;

  const created = new Date(rawDate);
  if (Number.isNaN(created.getTime())) return false;

  const now = new Date();
  const cutoff = new Date(now.getTime() - NEW_DAYS * 24 * 60 * 60 * 1000);

  return created >= cutoff;
}

// ---------- APPLY YOUR 4 RULES ----------
function checkEligibility(donation) {
  const stage = (donation.StageName || "").trim().toLowerCase();
  const source = (donation.Donation_Source__c || "").trim().toLowerCase();

  if (!isNewDonation(donation)) {
    return { ok: false, reason: "not_new" };
  }

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

  return { ok: true };
}

// ---------- FALLBACK LONG LINK (only used if MWL API fails) ----------
function buildLongUpdateLink(donation, contact) {
  const base = "https://mwl.org/update-address/";

  let donationId = donation && donation._id ? donation._id.toString() : "";
  let userId = "";

  if (contact) {
    if (contact.salesforceID) userId = contact.salesforceID;
    else if (contact.salesforceId) userId = contact.salesforceId;
    else if (contact._id) userId = contact._id.toString();
  }

  const params = [];
  if (userId) params.push("userid=" + encodeURIComponent(userId));
  if (donationId) params.push("donation=" + encodeURIComponent(donationId));

  return params.length ? base + "?" + params.join("&") : base;
}

// ---------- MWL SHORT URL CALL ----------
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

// ---------- BUILD SMS BODY ----------
function buildSmsBody(shortUrl) {
  return "Thanks for your donation. Please update your mailing address: " + shortUrl;
}

// ---------- PROCESS ONE DONATION ----------
async function processDonation(donation, donationsColl, contactsColl) {
  const donationId = donation._id;
  const contactIdStr = donation.contact;

  const eligibility = checkEligibility(donation);
  if (!eligibility.ok) {
    console.log("Skip donation " + donationId + " (contact " + contactIdStr + "): " + eligibility.reason);
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, "", "", "false", eligibility.reason, "", "", String(DRY_RUN), ""]);
    return { processed: false, sent: false };
  }

  console.log("Donation " + donationId + " PASSED rules. contact=" + contactIdStr);

  let contactObjId;
  try {
    contactObjId = new ObjectId(contactIdStr);
  } catch (e) {
    console.log("  Invalid contact ObjectId string. Skipping.");
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, "", "", "false", "invalid_contact_objectid", "", "", String(DRY_RUN), ""]);
    return { processed: false, sent: false };
  }

  const contact = await contactsColl.findOne({ _id: contactObjId });
  if (!contact) {
    console.log("  No contact found for this id. Skipping.");
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, "", "", "false", "contact_not_found", "", "", String(DRY_RUN), ""]);
    return { processed: false, sent: false };
  }

  const phone = contact.Phone || contact.phone || contact.mobile || null;
  if (!phone) {
    console.log("  Contact has no phone field. Skipping.");
    const useridMissingPhone = contact.salesforceID || contact.salesforceId || "";
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, useridMissingPhone, "", "false", "missing_phone", "", "", String(DRY_RUN), ""]);
    return { processed: false, sent: false };
  }

  const userid = contact.salesforceID || contact.salesforceId || null;
  if (!userid) {
    console.log("  Missing Salesforce Contact ID on contact (salesforceID/salesforceId). Skipping.");
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, "", phone, "false", "missing_salesforce_userid", "", "", String(DRY_RUN), ""]);
    return { processed: false, sent: false };
  }

  const donationParam = donationId ? donationId.toString() : null;
  if (!donationParam) {
    console.log("  Missing donation _id. Skipping.");
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, userid, phone, "false", "missing_donation_id", "", "", String(DRY_RUN), ""]);
    return { processed: false, sent: false };
  }

  let shortUrl;
  let urlType = "short";
  try {
    shortUrl = await getMwlShortUrl(userid, donationParam);
    console.log("  Short URL generated:", shortUrl);
  } catch (err) {
    shortUrl = buildLongUpdateLink(donation, contact);
    urlType = "long_fallback";
    console.log("  MWL short URL failed. Using LONG link fallback.");
  }

  const body = buildSmsBody(shortUrl);

  if (DRY_RUN) {
    console.log("DRY RUN SMS to " + phone + ":");
    console.log("  " + body);
    appendCsvRow([new Date().toISOString(), donationId, contactIdStr, userid, phone, "true", "ok", urlType, shortUrl, String(DRY_RUN), ""]);
    return { processed: true, sent: false };
  } else {
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

      appendCsvRow([new Date().toISOString(), donationId, contactIdStr, userid, phone, "true", "sent", urlType, shortUrl, String(DRY_RUN), msg.sid]);
      return { processed: true, sent: true };
    } catch (err) {
      console.error("Twilio error for " + phone + ": " + err.message);
      appendCsvRow([new Date().toISOString(), donationId, contactIdStr, userid, phone, "true", "twilio_error", urlType, shortUrl, String(DRY_RUN), ""]);
      return { processed: true, sent: false };
    }
  }
}

// ---------- MAIN BATCH MODE ----------
async function main() {
  initCsvIfNeeded();
  const clientMongo = new MongoClient(MONGODB_URI);

  try {
    console.log("Connecting to MongoDB...");
    await clientMongo.connect();
    console.log("MongoDB connected.");

    const db = clientMongo.db(DB_NAME);
    const donationsColl = db.collection("donations");
    const contactsColl = db.collection("contacts");

    const baseQuery = {
      StageName: "Closed Won",
      Donation_Source__c: "Fundraising App",
      smsSent: { $ne: true },
    };

    console.log("Fetching donations with base query:", baseQuery);
    const cursor = donationsColl.find(baseQuery).sort({ createdDate: 1, createdAt: 1, _id: 1 });

    let total = 0;
    let passedRules = 0;
    let smsCandidates = 0;

    while (await cursor.hasNext()) {
      const donation = await cursor.next();
      total++;

      const result = await processDonation(donation, donationsColl, contactsColl);

      if (result.processed) {
        passedRules++;
        smsCandidates++;
      }

      if (smsCandidates >= MAX_SMS) {
        console.log("Reached MAX_SMS (" + MAX_SMS + "), stopping loop.");
        break;
      }
    }

    console.log("--- SUMMARY ---");
    console.log("Total donations scanned: " + total);
    console.log("Donations that passed rules: " + passedRules);
    console.log("SMS processed (real or dry-run): " + smsCandidates);
    console.log("CSV report saved to: " + CSV_FILE);
  } catch (err) {
    console.error("ERROR:", err.message || err);
  } finally {
    await clientMongo.close();
    console.log("MongoDB connection closed.");
  }
}

// ---------- LIVE WATCHER MODE ----------
async function watchDonations() {
  initCsvIfNeeded();
  const clientMongo = new MongoClient(MONGODB_URI);

  try {
    console.log("Connecting to MongoDB for watcher...");
    await clientMongo.connect();
    console.log("MongoDB watcher connected.");

    const db = clientMongo.db(DB_NAME);
    const donationsColl = db.collection("donations");
    const contactsColl = db.collection("contacts");

    const changeStream = donationsColl.watch(
      [{ $match: { operationType: "insert" } }],
      { fullDocument: "updateLookup" }
    );

    console.log("Watching for new donations...");

    changeStream.on("change", async (change) => {
      try {
        const donation = change.fullDocument;
        if (!donation) return;

        if (donation.StageName !== "Closed Won") return;
        if (donation.Donation_Source__c !== "Fundraising App") return;
        if (donation.smsSent === true) return;

        console.log("New donation detected: " + donation._id);
        await processDonation(donation, donationsColl, contactsColl);
      } catch (err) {
        console.error("Watcher error: " + err.message);
      }
    });
  } catch (err) {
    console.error("WATCHER ERROR:", err.message || err);
  }
}
