require("dotenv").config();
const { MongoClient, ObjectId } = require("mongodb");
const twilio = require("twilio");
const axios = require("axios");
const fs = require("fs");
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "fundraisingDB";
const NEW_DAYS = Number(process.env.NEW_DAYS || "30");
const EXCLUDED_CONTACT_ID = "6959a331202a572ef92888d2";
if (!MONGODB_URI) { console.error("MONGODB_URI missing"); process.exit(1); }
const MWL_SHORT_API_KEY = process.env.MWL_SHORT_API_KEY;
const MWL_SHORT_API_BASE = process.env.MWL_SHORT_API_BASE || "https://u.mwl.org/api.php";
if (!MWL_SHORT_API_KEY) { console.error("MWL_SHORT_API_KEY missing"); process.exit(1); }
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM = process.env.TWILIO_PHONE;
if (!TWILIO_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM) { console.error("Twilio env vars missing"); process.exit(1); }
const twilioClient = twilio(TWILIO_SID, TWILIO_AUTH_TOKEN);
//----------------DRY OR LIVE MODE------------------------
const DRY_RUN = true;
const MAX_SMS = 1000;
//---------------------------------------------------------
function getNextCsvFile() {
  const base = process.env.CSV_FILE || "donation_sms_report";
  const baseName = base.replace(/\.csv$/, "");
  let i = 1;
  let fileName = baseName + ".csv";
  while (fs.existsSync(fileName)) {
    fileName = baseName + "_" + i + ".csv";
    i++;
  }
  return fileName;
}
const CSV_FILE = getNextCsvFile();
console.log("CSV file:", CSV_FILE);
function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}
function initCsv() {
  const header = ["timestamp","donation_id","contact_id","userid","phone","eligible","reason","url_type","url","dry_run","twilio_sid"].map(csvEscape).join(",") + "\n";
  fs.writeFileSync(CSV_FILE, header, "utf8");
}
function appendCsvRow(row) {
  const line = row.map(csvEscape).join(",") + "\n";
  fs.appendFileSync(CSV_FILE, line, "utf8");
}
function isNewDonation(donation) {
  const rawDate = donation.CloseDate;
  if (!rawDate) return false;
  const created = new Date(rawDate);
  if (Number.isNaN(created.getTime())) return false;
  const now = new Date();
  const cutoff = new Date(now.getTime() - NEW_DAYS * 24 * 60 * 60 * 1000);
  return created >= cutoff;
}
function checkEligibility(donation) {
  const stage = (donation.StageName || "").trim().toLowerCase();
  const source = (donation.Donation_Source__c || "").trim().toLowerCase();
  const amount = Number(donation.Amount || donation.amount || 0);
  if (!isNewDonation(donation)) return { ok: false, reason: "not_new" };
  if (stage !== "closed won") return { ok: false, reason: "stage_not_closed_won" };
  if (source !== "fundraising app") return { ok: false, reason: "wrong_source" };
  if (amount < 50) return { ok: false, reason: "amount_below_50" };
  if (!donation.contact) return { ok: false, reason: "missing_contact" };
  if (donation.contact === EXCLUDED_CONTACT_ID) return { ok: false, reason: "excluded_contact" };
  return { ok: true };
}
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
async function getMwlShortUrl(userid, donationId) {
  const { data } = await axios.get(MWL_SHORT_API_BASE, {
    params: { auth: MWL_SHORT_API_KEY, userid, donation: donationId },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (!data || data.success !== true || !data.short_url) throw new Error("MWL API failed");
  return data.short_url;
}
//---------------THE TEXT MSG------------------------------
function buildSmsBody(shortUrl) {
  return "Thanks for your donation! Please click the link below to get your receipt. Your donation is tax deductible. " + shortUrl;
}
async function main() {
  initCsv();
  const clientMongo = new MongoClient(MONGODB_URI);
  try {
    console.log("Connecting to MongoDB...");
    await clientMongo.connect();
    console.log("MongoDB connected.");
    console.log("Mode: DRY RUN");
    const db = clientMongo.db(DB_NAME);
    const donationsColl = db.collection("donations");
    const contactsColl = db.collection("contacts");
    const cursor = donationsColl.find({
      StageName: "Closed Won",
      Donation_Source__c: "Fundraising App",
      smsSent: { $ne: true },
    });
    let sent = 0;
    let skipped = 0;
    while (await cursor.hasNext()) {
      const donation = await cursor.next();
      const eligibility = checkEligibility(donation);
      if (!eligibility.ok) {
        console.log("Skipped:", donation._id.toString(), "reason:", eligibility.reason, "amount:", donation.Amount || donation.amount);
        skipped++;
        continue;
      }
      const contact = await contactsColl.findOne({ _id: new ObjectId(donation.contact) });
      if (!contact) { console.log("Skipped:", donation._id.toString(), "reason: contact not found"); skipped++; continue; }
      const phone = contact.Phone || contact.phone || contact.mobile;
      if (!phone) { console.log("Skipped:", donation._id.toString(), "reason: no phone"); skipped++; continue; }
      const userid = contact.salesforceID || contact.salesforceId;
      if (!userid) { console.log("Skipped:", donation._id.toString(), "reason: no salesforceID"); skipped++; continue; }
      let url;
      let urlType;
      try {
        url = await getMwlShortUrl(userid, donation._id.toString());
        urlType = "short";
      } catch (e) {
        url = buildLongUpdateLink(donation, contact);
        urlType = "long";
      }
      const body = buildSmsBody(url);
      console.log("DRY RUN SMS to:", phone, "amount:", donation.Amount || donation.amount);
      console.log(body);
      appendCsvRow([new Date().toISOString(), donation._id.toString(), donation.contact, userid, phone, "true", "", urlType, url, "true", ""]);
      sent++;
      if (sent >= MAX_SMS) break;
    }
    //---------------OUTPUT MSG------------------
    console.log("Done. Would send:", sent, "Skipped:", skipped);
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await clientMongo.close();
  }
}
main();
