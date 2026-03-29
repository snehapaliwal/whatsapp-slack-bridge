require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const twilio = require("twilio");
const cloudinary = require("cloudinary").v2;

const app = express();

// 🔥 IMPORTANT
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// 🔐 Twilio credentials
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// 🔗 Slack Webhook URL
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

const mongoose = require("mongoose");

async function connectDB() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("MongoDB Connected ✅");
    } catch (err) {
        console.error("MongoDB Error:", err.message);
    }
}

connectDB();

const messageSchema = new mongoose.Schema({
    sender: String,
    from: String,
    message: String,
    mediaUrl: String,
    timestamp: {
        type: Date,
        default: Date.now
    }
});

const Message = mongoose.model("Message", messageSchema);

// ☁️ Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

app.post("/slack/events", async (req, res) => {
    const body = req.body;

    // 🔥 STEP 1: Slack verification
    if (body.type === "url_verification") {
        console.log("Slack verification received");

        return res.status(200).json({
            challenge: body.challenge
        });
    }

    // 🔥 STEP 2: Respond immediately
    res.sendStatus(200);

    const event = body.event;

    // 🔥 STEP 3: Check if file uploaded
    if (event && event.files && event.files.length > 0) {
        const file = event.files[0];
        const fileUrl = file.url_private;

        console.log("Slack file URL:", fileUrl);

        try {
            // 🔥 Step 4: Download from Slack
            const response = await axios({
                url: fileUrl,
                method: "GET",
                responseType: "stream",
                headers: {
                    Authorization: `Bearer ${SLACK_BOT_TOKEN}`
                }
            });

            // 🔥 Step 5: Upload to Cloudinary
            const uploadResult = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { folder: "slack_images" },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                response.data.pipe(stream);
            });

            const publicUrl = uploadResult.secure_url;

            console.log("Cloudinary URL:", publicUrl);

            // 🔥 Step 6: Send to WhatsApp
            await client.messages.create({
                from: "whatsapp:+14155238886",
                to: "whatsapp:+918459679367",
                mediaUrl: [publicUrl]
            });

            console.log("Image sent to WhatsApp 📸");
            await Message.create({
                sender: "Slack",
                mediaUrl: publicUrl
            });

        } catch (error) {
            console.error("Slack image error:", error.message);
        }
    }
});

// 📩 WhatsApp → Slack (TEXT + IMAGE)
app.post("/whatsapp", async (req, res) => {
    const message = req.body.Body;
    const from = req.body.From;
    const numMedia = parseInt(req.body.NumMedia);

    console.log("WhatsApp:", message);

    try {
        // 📸 IMAGE CASE
        if (numMedia > 0) {
            const mediaUrl = req.body.MediaUrl0;

            const response = await axios({
                url: mediaUrl,
                method: "GET",
                responseType: "stream",
                auth: {
                    username: accountSid,
                    password: authToken
                }
            });

            const uploadResult = await new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { folder: "whatsapp_images" },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                response.data.pipe(stream);
            });

            const publicUrl = uploadResult.secure_url;

            // ✅ Send to Slack
            await axios.post(SLACK_WEBHOOK_URL, {
                text: `📸 Image from ${from}\n${publicUrl}`
            });

            // ✅ Save to DB
            await Message.create({
                sender: "WhatsApp",
                from: from,
                mediaUrl: publicUrl
            });

        } else {
            // ✅ Send to Slack

            await axios.post(SLACK_WEBHOOK_URL, {
                text: `📱 ${from}: ${message}`
            });

            // ✅ Save to DB
            await Message.create({
                sender: "WhatsApp",
                from: from,
                message: message
            });

            await Message.create({
                sender: "Slack",
                mediaUrl: publicUrl
            });
        }


    } catch (error) {
        console.error("WhatsApp → Slack error:", error);
    }

    res.send("OK");
});

// 💬 Slack → WhatsApp (TEXT + IMAGE URL)
app.post("/slack", async (req, res) => {
    const text = req.body.text;

    console.log("Slack:", text);

    // 🔥 instant response
    res.send("Sending to WhatsApp...");

    try {
        if (!text) return;

        // 🔥 Detect image URL (jpg, png, jpeg)
        const isImage = text.match(/\.(jpeg|jpg|png|gif)$/i);

        if (isImage || text.includes("http")) {

            await client.messages.create({
                from: "whatsapp:+14155238886",
                to: "whatsapp:+918459679367",
                mediaUrl: [text]
            });

            // ✅ Save image
            await Message.create({
                sender: "Slack",
                mediaUrl: text
            });

        } else {

            await client.messages.create({
                from: "whatsapp:+14155238886",
                to: "whatsapp:+918459679367",
                body: text
            });

            // ✅ Save text
            await Message.create({
                sender: "Slack",
                message: text
            });
        }

    } catch (error) {
        console.error("Slack → WhatsApp ERROR:", error.message);
    }
});

// ✅ Test route
app.get("/", (req, res) => {
    res.send("Server is working ✅");
});

// 🚀 Start server
app.listen(process.env.PORT, () => {
    console.log("Server running on port 3000");
});