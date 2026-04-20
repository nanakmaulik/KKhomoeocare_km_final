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

import path from "node:path";
import process from "node:process";
import fs from "node:fs";
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
let authClient = null;

async function getAuth() {
  if (!authClient) {
    authClient = await authenticate({
      scopes: SCOPES,
      keyfilePath: CREDENTIALS_PATH
    });
  }
  return authClient;
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

/******************************
 * START SERVER
 ******************************/
app.listen(5000, () => {
  console.log("Server running on port 5000 🚀");
});