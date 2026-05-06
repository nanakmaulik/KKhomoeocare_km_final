/******************************
 *  SSL FIX (REMOVE IN PROD)
 ******************************/
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

import express from "express";
import cors from "cors";
import https from "https";
import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { authenticate } from "@google-cloud/local-auth";
import { google } from "googleapis";

dotenv.config();

/******************************
 * EXPRESS SETUP
 ******************************/
const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
/******************************
 * 
 * SUPABASE
 ******************************/

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
  {
    global: {
      fetch: (url, options = {}) => {
        return fetch(url, {
          ...options,
          agent: new https.Agent({ rejectUnauthorized: false })
        });
      }
    }
  }
);

/******************************
 * GOOGLE CALENDAR (MEET LINK)
 ******************************/
const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const CREDENTIALS_PATH = path.join(process.cwd(), "credentials.json");
const TOKEN_PATH = path.join(process.cwd(), "token.json");

let authClient = null;

async function getAuth() {
  if (authClient) return authClient;

  console.log("CREDENTIALS PATH:", CREDENTIALS_PATH);
  console.log("TOKEN PATH:", TOKEN_PATH);

  // ✅ Load credentials.json
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const { client_id, client_secret, redirect_uris } = credentials.installed;

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );

  // ✅ Load token.json if exists
  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    oAuth2Client.setCredentials(token);
    console.log("✅ TOKEN LOADED SUCCESSFULLY");
    authClient = oAuth2Client;
    return authClient;
  }

  console.log("❌ token.json not found. Please generate token first.");
  throw new Error("token.json missing. Run generateToken.js first.");
}

async function createMeetLink(date, time) {
  const auth = await getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const startDateTime = new Date(`${date}T${time}:00`);
  const endDateTime = new Date(startDateTime.getTime() + 30 * 60000);

  const event = {
    summary: "Doctor Consultation",
    start: {
      dateTime: startDateTime,
      timeZone: "Asia/Kolkata"
    },
    end: {
      dateTime: endDateTime,
      timeZone: "Asia/Kolkata"
    },
    conferenceData: {
      createRequest: {
        requestId: Math.random().toString(36).substring(2),
        conferenceSolutionKey: { type: "hangoutsMeet" }
      }
    }
  };

  const response = await calendar.events.insert({
    calendarId: "primary",
    resource: event,
    conferenceDataVersion: 1
  });

  return response.data.hangoutLink;
}

async function getMeetLinkSafely(date, time) {
  try {
    console.log("CREDENTIALS PATH:", CREDENTIALS_PATH);
    console.log("CREDENTIALS EXISTS:", fs.existsSync(CREDENTIALS_PATH));
    console.log("Trying to create meet for:", date, time);

    if (!fs.existsSync(CREDENTIALS_PATH)) {
      console.warn("credentials.json not found. Using demo meet link.");
      return "https://meet.google.com/demo-link";
    }

    const link = await createMeetLink(date, time);
    console.log("REAL MEET LINK:", link);

    return link || "https://meet.google.com/demo-link";
  } catch (err) {
    console.error("Meet link generation failed, using fallback link:");
    console.error(err);
    return "https://meet.google.com/demo-link";
  }
}

/******************************
 * EMAIL (GMAIL SMTP)
 ******************************/
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  },
  secure: false,
  tls: {
    rejectUnauthorized: false
  }
});
transporter.verify((error, success) => {
  if (error) {
    console.log("❌ SMTP ERROR:", error);
  } else {
    console.log("✅ SMTP READY");
  }
});

/******************************
 * ROUTES
 ******************************/
app.get("/", (req, res) => {
  res.send("MediSphere Backend Running 🚀");
});

/******** CHATBOT ********/
app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (!userMessage) {
      return res.status(400).json({ error: "Message required" });
    }

    const response = await openai.responses.create({
      model: "gpt-5.4",
      input: [
        {
          role: "system",
          content: `
You are the chatbot for Medi Sphere.
Answer briefly and clearly.
Only help with:
- website navigation
- appointments
- lab tests
- specialists
- contact details
Do not give emergency or definitive medical diagnosis.
If user has a serious emergency, ask them to contact a doctor or emergency services immediately.
          `
        },
        {
          role: "user",
          content: userMessage
        }
      ]
    });

    res.json({
      reply: response.output_text
    });
  } catch (err) {
    console.error("Chat API error:", err);
    res.status(500).json({
      error: err.message || "OpenAI request failed"
    });
  }
});

/******** OFFLINE APPOINTMENT ********/
app.post("/book-offline-appointment", async (req, res) => {
  try {
    const {
      patientname,
      email,
      phone,
      appointmentdate,
      appointmenttime,
      doctor_id,
      slot_id
    } = req.body;

    const { data: doctor, error: doctorError } = await supabase
      .from("doctors")
      .select("name, email")
      .eq("id", doctor_id)
      .single();

    if (doctorError || !doctor) {
      throw new Error("Doctor details not found");
    }

    const { error } = await supabase.from("appointments").insert([
      {
        patientname,
        patientemail: email,
        phone,
        appointmentdate,
        appointmenttime,
        doctor_id,
        slot_id,
        appointment_type: "offline",
        meet_link: null,
        status: "pending"
      }
    ]);

    if (error) throw error;

    await supabase
      .from("slots")
      .update({ is_booked: true })
      .eq("id", slot_id);

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: `${email},${doctor.email}`,
        subject: "Offline Appointment Confirmation",
        html: `
          <h2>Offline Appointment Confirmed</h2>
          <p><strong>Doctor:</strong> ${doctor.name}</p>
          <p><strong>Patient:</strong> ${patientname}</p>
          <p><strong>Date:</strong> ${appointmentdate}</p>
          <p><strong>Time:</strong> ${appointmenttime}</p>
          <p><strong>Mode:</strong> Offline Visit</p>
        `
      });
    } catch (mailErr) {
      console.error("Offline email send failed:", mailErr.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Offline booking error:", err);
    res.status(500).json({ error: err.message });
  }
});

/******** ONLINE APPOINTMENT ********/
app.post("/book-online-appointment", async (req, res) => {
  try {
    const {
      patientname,
      email,
      phone,
      appointmentdate,
      appointmenttime,
      doctor_id,
      slot_id
    } = req.body;

    const { data: doctor, error: doctorError } = await supabase
      .from("doctors")
      .select("name, email")
      .eq("id", doctor_id)
      .single();

    if (doctorError || !doctor) {
      throw new Error("Doctor details not found");
    }

    const meetLink = await getMeetLinkSafely(
      appointmentdate,
      appointmenttime
    );

    const { error } = await supabase.from("appointments").insert([
      {
        patientname,
        patientemail: email,
        phone,
        appointmentdate,
        appointmenttime,
        doctor_id,
        slot_id,
        appointment_type: "online",
        meet_link: meetLink,
        status: "confirmed"
      }
    ]);

    if (error) throw error;

    await supabase
      .from("slots")
      .update({ is_booked: true })
      .eq("id", slot_id);

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: `${email},${doctor.email}`,
        subject: "Online Appointment Confirmation",
        html: `
          <h2>Online Appointment Confirmed</h2>
          <p><strong>Doctor:</strong> ${doctor.name}</p>
          <p><strong>Patient:</strong> ${patientname}</p>
          <p><strong>Date:</strong> ${appointmentdate}</p>
          <p><strong>Time:</strong> ${appointmenttime}</p>
          <p><strong>Meet Link:</strong> <a href="${meetLink}">${meetLink}</a></p>
        `
      });
    } catch (mailErr) {
      console.error("Online email send failed:", mailErr.message);
    }

    res.json({
      success: true,
      meetLink
    });
  } catch (err) {
    console.error("Online booking error:", err);
    res.status(500).json({
      error: err.message
    });
  }
});
/******** DOCTOR APPROVAL EMAIL ********/
app.post("/send-approval-email", async (req, res) => {
  try {
    const { email, name } = req.body;
    console.log("🔥 EMAIL API HIT");
console.log("Email:", email, "Name:", name);

    if (!email) {
      return res.status(400).json({ error: "Email required" });
    }

    await transporter.sendMail({
      from: `"MediSphere" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Doctor Account Approved 🎉",
      html: `
        <div style="font-family: Arial; padding:20px;">
          
          <h2 style="color:#2879ff;">Welcome Dr. ${name} 👨‍⚕️</h2>

          <p>Your registration request has been <b>approved by admin</b>.</p>

          <p>You can now login and start using <b>MediSphere</b>.</p>

          <a href="http://localhost:5500/admin-login.html"
             style="display:inline-block; padding:10px 20px; background:#2879ff; color:white; text-decoration:none; border-radius:6px;">
             Login Now
          </a>

          <p style="margin-top:20px; font-size:12px; color:#777;">
            Thank you for joining our platform ❤️
          </p>

        </div>
      `
    });

    res.json({ success: true });

  } catch (err) {
    console.error("Approval email error:", err);
    res.status(500).json({ error: "Email sending failed" });
  }
});
app.post("/send-labtest-email", async (req, res) => {
  try {
    const { name, email, test, date, time, collectionType } = req.body;

    await transporter.sendMail({
      from: `"MediSphere" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: "Lab Test Booking Confirmation 🧪",
      html: `
        <h2>Lab Test Booked Successfully</h2>

        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Test:</strong> ${test}</p>
        <p><strong>Date:</strong> ${date}</p>
        <p><strong>Time Slot:</strong> ${time || "N/A"}</p>
        <p><strong>Collection Type:</strong> ${collectionType}</p>

        <p>Our team will contact you soon.</p>

        <p>Thanks for choosing MediSphere ❤️</p>
      `
    });

    res.json({ success: true });

  } catch (err) {
    console.error("Lab Test email error:", err);
    res.status(500).json({ error: "Email failed" });
  }
});
app.post("/create-payment", async (req, res) => {
  try {
    const {
      patientname,
      email,
      phone,
      appointmentdate,
      appointmenttime,
      appointmentType,
      doctor_id,
      slot_id,
      amount
    } = req.body;

    const order_id = "order_" + Date.now();

    const baseUrl =
      process.env.CASHFREE_ENV === "production"
        ? "https://api.cashfree.com/pg/orders"
        : "https://sandbox.cashfree.com/pg/orders";

    const paymentData = {
      order_id,
      order_amount: Number(amount),
            order_currency: "INR",
      customer_details: {
        customer_id: "cust_" + Date.now(),
        customer_email: email,
        customer_name: patientname,
        customer_phone: phone
      },
      order_meta: {
       return_url: `http://127.0.0.1:5501/KKhomoeocare_km_final-newbranch%20(1)%202/payment-success.html?order_id=${order_id}`
      }
    };

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-version": "2023-08-01",
        "x-client-id": process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY
      },
      body: JSON.stringify(paymentData)
    });

    const result = await response.json();
    console.log("CASHFREE ORDER RESPONSE:", result);

    global.paymentStore = global.paymentStore || {};
    global.paymentStore[order_id] = {
      patientname,
      email,
      phone,
      appointmentdate,
      appointmenttime,
      appointmentType,
      doctor_id,
      slot_id,
      amount
    };

    res.json({
      success: true,
      order_id: result.order_id,
      payment_session_id: result.payment_session_id
    });
  } catch (err) {
    console.error("Create payment error:", err);
    res.status(500).json({ success: false, message: "Payment creation failed" });
  }
});
app.post("/verify-payment", async (req, res) => {
  try {
    const { order_id } = req.body;

    const payment = global.paymentStore?.[order_id];

    if (!payment) {
      return res.status(400).json({
        success: false,
        message: "Payment data not found"
      });
    }

    const baseUrl =
      process.env.CASHFREE_ENV === "production"
        ? `https://api.cashfree.com/pg/orders/${order_id}`
        : `https://sandbox.cashfree.com/pg/orders/${order_id}`;

    const cfRes = await fetch(baseUrl, {
      method: "GET",
      headers: {
        "x-api-version": "2023-08-01",
        "x-client-id": process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY
      }
    });

    const cfData = await cfRes.json();
    console.log("CASHFREE VERIFY RESPONSE:", cfData);

    if (cfData.order_status !== "PAID") {
      return res.status(400).json({
        success: false,
        message: "Payment not completed"
      });
    }

    let meetLink = null;

    if (payment.appointmentType === "online") {
      meetLink = await getMeetLinkSafely(payment.appointmentdate, payment.appointmenttime);
    }

    const { data: doctor } = await supabase
      .from("doctors")
      .select("name, email")
      .eq("id", payment.doctor_id)
      .single();

    const { error } = await supabase.from("appointments").insert([
      {
        patientname: payment.patientname,
        patientemail: payment.email,
        phone: payment.phone,
        appointmentdate: payment.appointmentdate,
        appointmenttime: payment.appointmenttime,
        doctor_id: payment.doctor_id,
        slot_id: payment.slot_id,
        appointment_type: payment.appointmentType,
        meet_link: meetLink,
        status: "confirmed",
        payment_status: "paid",
        payment_order_id: order_id
      }
    ]);

    if (error) throw error;

    await supabase
      .from("slots")
      .update({ is_booked: true })
      .eq("id", payment.slot_id);

    await transporter.sendMail({
      from: `"MediSphere" <${process.env.EMAIL_USER}>`,
      to: `${payment.email},${doctor?.email || ""}`,
      subject: "Appointment & Payment Confirmed ✅",
      html: `
        <h2>Your Appointment is Confirmed</h2>
        <p><strong>Payment:</strong> Confirmed</p>
        <p><strong>Patient:</strong> ${payment.patientname}</p>
        <p><strong>Doctor:</strong> ${doctor?.name || "Doctor"}</p>
        <p><strong>Date:</strong> ${payment.appointmentdate}</p>
        <p><strong>Time:</strong> ${payment.appointmenttime}</p>
        <p><strong>Type:</strong> ${payment.appointmentType}</p>
        ${
          meetLink
            ? `<p><strong>Meet Link:</strong> <a href="${meetLink}">${meetLink}</a></p>`
            : ""
        }
      `
    });

    delete global.paymentStore[order_id];

    res.json({
      success: true,
      meetLink
    });
  } catch (err) {
    console.error("Verify payment error:", err);
    res.status(500).json({
      success: false,
      message: "Appointment confirmation failed"
    });
  }
});
app.post("/create-package-payment", async (req, res) => {
  try {
    const { packageName, amount, name, email, phone } = req.body;

    if (!packageName || !amount || !name || !email || !phone) {
      return res.status(400).json({
        success: false,
        message: "Missing package payment details"
      });
    }

    const order_id = "pkg_order_" + Date.now();

    const baseUrl =
      process.env.CASHFREE_ENV === "production"
        ? "https://api.cashfree.com/pg/orders"
        : "https://sandbox.cashfree.com/pg/orders";

    const paymentData = {
      order_id,
      order_amount: Number(amount),
      order_currency: "INR",
      customer_details: {
        customer_id: "cust_" + Date.now(),
        customer_email: email,
        customer_name: name,
        customer_phone: phone
      },
      order_meta: {
        return_url: `http://127.0.0.1:5501/KKhomoeocare_km_final-newbranch%20(1)%202/package-payment-success.html?order_id=${order_id}`
      }
    };

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-version": "2023-08-01",
        "x-client-id": process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY
      },
      body: JSON.stringify(paymentData)
    });

    const result = await response.json();

    console.log("CASHFREE PACKAGE ORDER RESPONSE:", result);

    if (!response.ok || !result.payment_session_id) {
      return res.status(400).json({
        success: false,
        message: "Cashfree package payment session failed",
        cashfreeError: result
      });
    }

    global.packagePaymentStore = global.packagePaymentStore || {};

    global.packagePaymentStore[order_id] = {
      packageName,
      amount,
      name,
      email,
      phone
    };

    res.json({
      success: true,
      order_id,
      payment_session_id: result.payment_session_id
    });

  } catch (err) {
    console.error("Create package payment error:", err);
    res.status(500).json({
      success: false,
      message: "Package payment creation failed"
    });
  }
});
app.post("/verify-package-payment", async (req, res) => {
  try {
    const { order_id } = req.body;

    if (!order_id) {
      return res.status(400).json({
        success: false,
        message: "Order ID missing"
      });
    }

    const payment = global.packagePaymentStore?.[order_id];

    if (!payment) {
      return res.status(400).json({
        success: false,
        message: "Package payment data not found"
      });
    }

    const baseUrl =
      process.env.CASHFREE_ENV === "production"
        ? `https://api.cashfree.com/pg/orders/${order_id}`
        : `https://sandbox.cashfree.com/pg/orders/${order_id}`;

    const cfRes = await fetch(baseUrl, {
      method: "GET",
      headers: {
        "x-api-version": "2023-08-01",
        "x-client-id": process.env.CASHFREE_APP_ID,
        "x-client-secret": process.env.CASHFREE_SECRET_KEY
      }
    });

    const cfData = await cfRes.json();

    console.log("CASHFREE PACKAGE VERIFY RESPONSE:", cfData);

    if (cfData.order_status !== "PAID") {
      return res.status(400).json({
        success: false,
        message: "Payment not completed"
      });
    }

    await transporter.sendMail({
      from: `"MediSphere" <${process.env.EMAIL_USER}>`,
      to: payment.email,
      subject: "Package Payment Confirmed ✅",
      html: `
        <div style="font-family: Arial; padding:20px;">
          <h2>Package Payment Confirmed ✅</h2>

          <p><strong>Name:</strong> ${payment.name}</p>
          <p><strong>Email:</strong> ${payment.email}</p>
          <p><strong>Phone:</strong> ${payment.phone}</p>
          <p><strong>Package:</strong> ${payment.packageName}</p>
          <p><strong>Amount Paid:</strong> ₹${payment.amount}</p>
          <p><strong>Payment Status:</strong> Confirmed</p>

          <p>Our team will contact you soon for the next steps.</p>

          <p>Thank you for choosing MediSphere ❤️</p>
        </div>
      `
    });

    delete global.packagePaymentStore[order_id];

    res.json({
      success: true,
      message: "Package payment verified and email sent"
    });

  } catch (err) {
    console.error("Verify package payment error:", err);
    res.status(500).json({
      success: false,
      message: "Package payment verification failed"
    });
  }
});
/******************************
 * START SERVER
 ******************************/
app.listen(5000, () => {
  console.log("Server running on port 5000 🚀");
});
