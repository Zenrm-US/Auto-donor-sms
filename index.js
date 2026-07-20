require("dotenv").config();

const { MongoClient, ObjectId } = require("mongodb");

const twilio = require("twilio");

const axios = require("axios");

const fs = require("fs");



// ENV

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



const DRY_RUN = false;

const MAX_SMS = 100;

const INTERVAL_MS = 5 * 60 * 1000;



// CSV

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

console.log("Mode:", DRY_RUN ? "DRY RUN" : "LIVE");

console.log("Checking every 30 seconds...");



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



// DATE

function resolveDate(raw) {

  if (!raw) return null;

  if (typeof raw === "object" && raw.$date) return new Date(raw.$date);

  return new Date(raw);

}



// ELIGIBILITY

function isNewDonation(donation) {

  const created = resolveDate(donation.CloseDate);

  if (!created || Number.isNaN(created.getTime())) return false;

  const cutoff = new Date(Date.now() - NEW_DAYS * 24 * 60 * 60 * 1000);

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



// URL

function buildLongUpdateLink(donation, contact) {

  const base = "https://mwl.org/update-address/";

  const donationId = donation?._id ? donation._id.toString() : "";

  let userId = "";

  if (contact) {

    userId = contact.salesforceID || contact.salesforceId || (contact._id ? contact._id.toString() : "");

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



function buildSmsBody(shortUrl) {

  return "Thanks for your donation! Please click the link below to get your receipt. Your donation is tax deductible. " + shortUrl;

}



// RUN ONCE

async function runOnce() {

  const clientMongo = new MongoClient(MONGODB_URI);

  try {

    await clientMongo.connect();



    const db = clientMongo.db(DB_NAME);

    const donationsColl = db.collection("donations");

    const contactsColl = db.collection("contacts");



    const todayStart = new Date();

    todayStart.setDate(todayStart.getDate() - 7);

    todayStart.setHours(0, 0, 0, 0);



    const todayEnd = new Date();

    todayEnd.setHours(23, 59, 59, 999);



    const cursor = donationsColl.find({

      StageName: "Closed Won",

      Donation_Source__c: "Fundraising App",

      smsSent: { $ne: true },

      CloseDate: { $gte: todayStart, $lte: todayEnd },

    });



    let sent = 0;

    let skipped = 0;



    while (await cursor.hasNext()) {

      const donation = await cursor.next();

      const donationId = donation._id.toString();



      const eligibility = checkEligibility(donation);

      if (!eligibility.ok) {

        console.log("[SKIP]", donationId, "reason:", eligibility.reason, "amount:", donation.Amount || donation.amount);

        appendCsvRow([new Date().toISOString(), donationId, donation.contact, "", "", "no", eligibility.reason, "", "", DRY_RUN, ""]);

        skipped++;

        continue;

      }



      const contact = await contactsColl.findOne({ _id: new ObjectId(donation.contact) });

      if (!contact) {

        console.log("[SKIP]", donationId, "reason: contact_not_found");

        appendCsvRow([new Date().toISOString(), donationId, donation.contact, "", "", "no", "contact_not_found", "", "", DRY_RUN, ""]);

        skipped++;

        continue;

      }



      const latestDonation = await donationsColl.findOne(

        { contact: donation.contact, StageName: "Closed Won", Donation_Source__c: "Fundraising App" },

        { sort: { CloseDate: -1 } }

      );



      if (!latestDonation || latestDonation._id.toString() !== donationId) {

        console.log("[SKIP]", donationId, "reason: not_latest_donation_for_contact");

        appendCsvRow([new Date().toISOString(), donationId, donation.contact, "", "", "no", "not_latest_donation_for_contact", "", "", DRY_RUN, ""]);

        skipped++;

        continue;

      }



      const phone = contact.Phone || contact.phone || contact.mobile;

      if (!phone) {

        console.log("[SKIP]", donationId, "reason: no_phone");

        appendCsvRow([new Date().toISOString(), donationId, donation.contact, "", "", "no", "no_phone", "", "", DRY_RUN, ""]);

        skipped++;

        continue;

      }



      const userid = contact.salesforceID || contact.salesforceId;

      if (!userid) {

        console.log("[SKIP]", donationId, "reason: no_salesforceID");

        appendCsvRow([new Date().toISOString(), donationId, donation.contact, "", "", "no", "no_salesforceID", "", "", DRY_RUN, ""]);

        skipped++;

        continue;

      }



      let url;

      let urlType;

      try {

        url = await getMwlShortUrl(userid, donationId);

        urlType = "short";

      } catch (e) {

        url = buildLongUpdateLink(donation, contact);

        urlType = "long";

      }



      const body = buildSmsBody(url);



      if (DRY_RUN) {

        console.log("[DRY RUN] WOULD SEND SMS to:", phone, "donation:", donationId);

        console.log("Message:", body);

        appendCsvRow([new Date().toISOString(), donationId, donation.contact, userid, phone, "yes", "dry_run_only", urlType, url, true, "DRY_RUN"]);

        sent++;

      } else {

        const message = await twilioClient.messages.create({ body, from: TWILIO_FROM, to: phone });

        console.log("[SENT]", donationId, "phone:", phone, "sid:", message.sid);

        appendCsvRow([new Date().toISOString(), donationId, donation.contact, userid, phone, "yes", "sent", urlType, url, false, message.sid]);

        await donationsColl.updateOne(

          { _id: donation._id },

          { $set: { smsSent: true, smsSentAt: new Date(), smsSid: message.sid, smsPhone: phone, smsUrl: url } }

        );

        sent++;

      }



      if (sent >= MAX_SMS) {

        console.log("[INFO] Reached MAX_SMS limit of", MAX_SMS);

        break;

      }

    }



    if (sent > 0 || skipped > 0) {

      console.log("Sent:", sent, "Skipped:", skipped);

    }



  } catch (err) {

    console.error("Error:", err.message);

  } finally {

    await clientMongo.close();

  }

}



// LOOP

async function main() {

  initCsv();

  console.log("Script started.");

  while (true) {

    await runOnce();

    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));

  }

}



main();
