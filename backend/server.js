/******************************
 *  SSL FIX (REMOVE IN PROD)
 ******************************/


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
// TEMPORARY DEBUG - HATA DENA BAAD MEIN
console.log("=== ENV CHECK ===");
console.log("BREVO_KEY:", process.env.BREVO_API_KEY ? "FOUND - " + process.env.BREVO_API_KEY.slice(0,15) : "❌ NOT FOUND");
console.log("EMAIL_USER:", process.env.EMAIL_USER || "❌ NOT FOUND");
console.log("=================");
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://nanakmaulik.github.io/KKhomoeocare_km_final";

const BACKEND_URL =
  process.env.BACKEND_URL || "https://kkhomoeocare-km-final-1.onrender.com";

/******************************
 * EXPRESS SETUP
 ******************************/
const app = express();
const corsOptions = {
  origin: [
    "http://127.0.0.1:5501",
    "http://localhost:5501",
    "https://dalbirsinghalgonkothi.online",
    "https://www.dalbirsinghalgonkothi.online",
    "https://nanakmaulik.github.io",
    "https://nanakmaulik.github.io/KKhomoeocare_km_final"
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
};

app.use(cors(corsOptions));
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

    // ✅ Render/live pe credentials missing hain, to Meet create try mat karo
    if (!fs.existsSync(CREDENTIALS_PATH)) {
      console.warn("credentials.json not found. Skipping Google Meet creation.");

      // temporary fallback
      return "https://meet.google.com/demo-link";
    }

    console.log("Trying to create meet for:", date, time);

    const link = await createMeetLink(date, time);

    console.log("REAL MEET LINK:", link);

    return link || "https://meet.google.com/demo-link";

  } catch (err) {
    console.error("Meet link generation failed:", err.message);

    // fallback, so appointment confirmation does not fail
    return "https://meet.google.com/demo-link";
  }
}

/******************************
 * EMAIL (GMAIL SMTP)
 ******************************/
/******************************
 * EMAIL (BREVO SMTP)
 ******************************/
// const transporter = nodemailer.createTransport({
//   host: "smtp-relay.brevo.com",
//   port: 587,
//   secure: false,
//   auth: {
//     user: process.env.EMAIL_USER,
//     pass: process.env.EMAIL_PASS
//   },
//   connectionTimeout: 30000,
//   greetingTimeout: 30000,
//   socketTimeout: 30000
// });
// transporter.verify((error, success) => {
//   if (error) {
//     console.log("❌ SMTP ERROR:", error);
//   } else {
//     console.log("✅ SMTP READY");
//   }
// });
// Ye function replace karega transporter.sendMail()
async function sendEmail({ to, subject, html }) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": process.env.BREVO_API_KEY  // Brevo dashboard se lena
    },
    body: JSON.stringify({
      sender: { name: "MediSphere", email: process.env.EMAIL_USER },
      to: to.map(email => ({ email })),  // array of { email }
      subject,
      htmlContent: html
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(JSON.stringify(err));
  }

  return response.json();
}
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
        status: "confirmed"
      }
    ]);
    
    if (error) throw error;

    await supabase
      .from("slots")
      .update({ is_booked: true })
      .eq("id", slot_id);

    try {
      await sendEmail({
        from: process.env.EMAIL_USER,
        to: [email, doctor.email].filter(Boolean),
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

   

    await supabase
      .from("slots")
      .update({ is_booked: true })
      .eq("id", slot_id);

    try {
      await sendEmail({
        from: process.env.EMAIL_USER,
        to: [email, doctor.email].filter(Boolean),
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
/******** DOCTOR APPROVAL EMAIL ********/
/******** DOCTOR APPROVAL EMAIL ********/
app.post("/send-approval-email", async (req, res) => {
  try {
    const { email, name } = req.body;

    console.log("🔥 EMAIL API HIT");
    console.log("Email:", email, "Name:", name);

    if (!email) {
      return res.status(400).json({ error: "Email required" });
    }

    sendEmail({
      from: `"MediSphere" <${process.env.EMAIL_USER}>`,
      to: [email].filter(Boolean),

      subject: "Doctor Account Approved 🎉",
      html: `
        <div style="font-family: Arial; padding:20px;">
          <h2 style="color:#2879ff;">Welcome Dr. ${name || ""} 👨‍⚕️</h2>

          <p>Your registration request has been <b>approved by admin</b>.</p>

          <p>You can now login and start using <b>MediSphere</b>.</p>

          <a href="${FRONTEND_URL}/admin-login.html"
             style="display:inline-block; padding:10px 20px; background:#2879ff; color:white; text-decoration:none; border-radius:6px;">
             Login Now
          </a>

          <p style="margin-top:20px; font-size:12px; color:#777;">
            Thank you for joining our platform ❤️
          </p>
        </div>
      `
    })
      .then((info) => {
        console.log("Doctor approval email sent:", info.messageId);
      })
      .catch((emailErr) => {
        console.error("Approval email failed:", emailErr.message);
      });

    return res.json({ success: true });

  } catch (err) {
    console.error("Approval email route error:", err);
    return res.status(500).json({ error: "Approval email route failed" });
  }
});
  
app.post("/send-labtest-email", async (req, res) => {
  try {
    const { name, email, test, date, time, collectionType } = req.body;

    await sendEmail({
      from: `"MediSphere" <${process.env.EMAIL_USER}>`,
      to: [email].filter(Boolean),

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
        return_url: `${FRONTEND_URL}/payment-success.html?order_id=${order_id}`      }
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

    const { error: pendingInsertError } = await supabase
    .from("appointments")
    .insert([
      {
        patientname,
        patientemail: email,
        phone,
        appointmentdate,
        appointmenttime,
        doctor_id,
        slot_id,
        appointment_type: appointmentType,
        meet_link: null,
        status: "pending",
        payment_status: "pending",
        payment_order_id: order_id
      }
    ]);
  
  if (pendingInsertError) {
    console.error("Pending appointment insert error:", pendingInsertError);
    return res.status(500).json({
      success: false,
      message: "Could not create pending appointment"
    });
  }

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

    const { data: payment, error: paymentFetchError } = await supabase
    .from("appointments")
    .select("*")
    .eq("payment_order_id", order_id)
    .single();
  
  if (paymentFetchError || !payment) {
    console.error("Pending appointment not found:", paymentFetchError);
    return res.status(400).json({
      success: false,
      message: "Pending appointment not found for this payment."
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

    if (payment.appointment_type === "online") {
      meetLink = await getMeetLinkSafely(payment.appointmentdate, payment.appointmenttime);
    }
    // if (payment.appointmentType === "online" && !meetLink) {
    //   return res.status(500).json({
    //     success: false,
    //     message: "Meet link generation failed. Appointment not confirmed."
    //   });
    // }

    const { error: updateError } = await supabase
  .from("appointments")
  .update({
    status: "confirmed",
    payment_status: "paid",
    meet_link: meetLink
  })
  .eq("payment_order_id", order_id);

if (updateError) {
  throw updateError;
}
const { data: doctor, error: doctorFetchError } = await supabase
  .from("doctors")
  .select("name, email")
  .eq("id", payment.doctor_id)
  .single();

if (doctorFetchError) {
  console.error("Doctor fetch error:", doctorFetchError);
}
   
    await supabase
      .from("slots")
      .update({ is_booked: true })
      .eq("id", payment.slot_id);
      const recipients = [
        payment.email,
        doctor?.email
      ].filter(Boolean);
      
      console.log("Trying to send payment confirmation email to:", recipients);

      sendEmail({
        from: `"MediSphere" <${process.env.EMAIL_USER}>`,
        to: [payment.patientemail, doctor?.email].filter(Boolean),
        subject: "Appointment & Payment Confirmed ✅",
        html: `
          <h2>Your Appointment is Confirmed</h2>
          <p><strong>Payment:</strong> Confirmed</p>
          <p><strong>Patient:</strong> ${payment.patientname}</p>
          <p><strong>Doctor:</strong> ${doctor?.name || "Doctor"}</p>
          <p><strong>Date:</strong> ${payment.appointmentdate}</p>
          <p><strong>Time:</strong> ${payment.appointmenttime}</p>
          <p><strong>Type:</strong> ${payment.appointment_type}</p>
          ${
            meetLink
              ? `<p><strong>Meet Link:</strong> <a href="${meetLink}">${meetLink}</a></p>`
              : ""
          }
        `
      })
      .then(() => {
        console.log("Payment confirmation email sent successfully");
      })
      .catch((emailErr) => {
        console.error("Payment email failed, but appointment is confirmed:", emailErr.message);
      });

    

    return res.json({
      success: true,
      message: "Payment verified and appointment confirmed",
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
// app.post("/create-package-payment", async (req, res) => {
//   try {
//     const { packageName, amount, name, email, phone } = req.body;

//     if (!packageName || !amount || !name || !email || !phone) {
//       return res.status(400).json({
//         success: false,
//         message: "Missing package payment details"
//       });
//     }

//     const order_id = "pkg_order_" + Date.now();

//     const baseUrl =
//       process.env.CASHFREE_ENV === "production"
//         ? "https://api.cashfree.com/pg/orders"
//         : "https://sandbox.cashfree.com/pg/orders";

//     const paymentData = {
//       order_id,
//       order_amount: Number(amount),
//       order_currency: "INR",
//       customer_details: {
//         customer_id: "cust_" + Date.now(),
//         customer_email: email,
//         customer_name: name,
//         customer_phone: phone
//       },
//       order_meta: {
//         return_url: `${FRONTEND_URL}/package-payment-success.html?order_id=${order_id}`
//       }
//     };

//     const response = await fetch(baseUrl, {
//       method: "POST",
//       headers: {
//         "Content-Type": "application/json",
//         "x-api-version": "2023-08-01",
//         "x-client-id": process.env.CASHFREE_APP_ID,
//         "x-client-secret": process.env.CASHFREE_SECRET_KEY
//       },
//       body: JSON.stringify(paymentData)
//     });

//     const result = await response.json();

//     console.log("CASHFREE PACKAGE ORDER RESPONSE:", result);

//     if (!response.ok || !result.payment_session_id) {
//       return res.status(400).json({
//         success: false,
//         message: "Cashfree package payment session failed",
//         cashfreeError: result
//       });
//     }

//     const { error: pendingInsertError } = await supabase
//     .from("appointments")
//     .insert([
//       {
//         patientname,
//         patientemail: email,
//         phone,
//         appointmentdate,
//         appointmenttime,
//         doctor_id,
//         slot_id,
//         appointment_type: appointmentType,
//         meet_link: null,
//         status: "pending",
//         payment_status: "pending",
//         payment_order_id: order_id
//       }
//     ]);
  
//   if (pendingInsertError) {
//     console.error("Pending appointment insert error:", pendingInsertError);
//     return res.status(500).json({
//       success: false,
//       message: "Could not create pending appointment"
//     });
//   }
//     res.json({
//       success: true,
//       order_id,
//       payment_session_id: result.payment_session_id
//     });

//   } catch (err) {
//     console.error("Create package payment error:", err);
//     res.status(500).json({
//       success: false,
//       message: "Package payment creation failed"
//     });
//   }
// });
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
        return_url: `${FRONTEND_URL}/package-payment-success.html?order_id=${order_id}`
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

    // ✅ Sirf order_id aur session_id return karo
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

    const { data: payment, error: paymentFetchError } = await supabase
    .from("appointments")
    .select("*")
    .eq("payment_order_id", order_id)
    .single();
  
  if (paymentFetchError || !payment) {
    console.error("Pending appointment not found:", paymentFetchError);
    return res.status(400).json({
      success: false,
      message: "Pending appointment not found for this payment."
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

    sendEmail({
      from: `"MediSphere" <${process.env.EMAIL_USER}>`,
      to: [payment.patientemail].filter(Boolean),

      subject: "Package Payment Confirmed ✅",
      html: `
        <div style="font-family: Arial; padding:20px;">
          <h2>Package Payment Confirmed ✅</h2>
          <p><strong>Name:</strong> ${payment.name}</p>
          <p><strong>Email:</strong> ${payment.patientemail}</p>
          <p><strong>Phone:</strong> ${payment.phone}</p>
          <p><strong>Package:</strong> ${payment.packageName}</p>
          <p><strong>Amount Paid:</strong> ₹${payment.amount}</p>
          <p><strong>Payment Status:</strong> Confirmed</p>
          <p>Our team will contact you soon for the next steps.</p>
        </div>
      `
    })
    .then(() => {
      console.log("Package confirmation email sent successfully");
    })
    .catch((emailErr) => {
      console.error("Package email failed, but payment is confirmed:", emailErr.message);
    });

    

    res.json({
      success: true,
      message: "Package payment verified. Email attempted."
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
// Server start hone ke baad ye add karo temporarily
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} 🚀`);
  console.log("BREVO KEY CHECK:", process.env.BREVO_API_KEY ? process.env.BREVO_API_KEY.substring(0, 20) + "..." : "NOT FOUND");
});
