require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const twilio = require("twilio");
const cloudinary = require("cloudinary").v2;
const mongoose = require("mongoose");

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// 🔐 Twilio credentials
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// 🔗 Slack config
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

// ☁️ Cloudinary config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// ✅ FIX 5: Define schema & model BEFORE startServer()
mongoose.set("bufferCommands", false);

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

// ✅ FIX 1: Only ONE app.listen() — inside startServer()
async function startServer() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log("MongoDB Connected ✅");

        app.listen(process.env.PORT || 3000, () => {
            console.log("Server running 🚀");
        });

    } catch (err) {
        console.error("DB Connection Error:", err.message);
        process.exit(1);
    }
}

startServer();

// ─────────────────────────────────────────────
// 📩 WhatsApp → Slack (TEXT + IMAGE)
// ─────────────────────────────────────────────
app.post("/whatsapp", async (req, res) => {
    const message = req.body.Body;
    const from = req.body.From;
    const numMedia = parseInt(req.body.NumMedia);

    console.log("WhatsApp message from:", from, "| text:", message, "| media count:", numMedia);

    // Send 200 to Twilio immediately
    res.send("OK");

    try {
        if (numMedia > 0) {
            // 📸 IMAGE: Download from Twilio → Upload to Cloudinary → Forward to Slack
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

            // Send image to Slack
            await axios.post(SLACK_WEBHOOK_URL, {
                text: `📸 Image from *${from}*`,
                attachments: [{ image_url: publicUrl }]
            });

            // Save to DB
            await Message.create({
                sender: "WhatsApp",
                from,
                mediaUrl: publicUrl
            });

            console.log("WhatsApp image → Slack ✅");

        } else {
            // ✅ FIX 2: TEXT case was completely missing — now forwarded to Slack
            if (!message) return;

            await axios.post(SLACK_WEBHOOK_URL, {
                text: `💬 *${from}*: ${message}`
            });

            await Message.create({
                sender: "WhatsApp",
                from,
                message
            });

            console.log("WhatsApp text → Slack ✅");
        }

    } catch (error) {
        console.error("WhatsApp → Slack error:", error.message);
    }
});

// ─────────────────────────────────────────────
// 💬 Slack → WhatsApp (TEXT via slash command)
// ─────────────────────────────────────────────
app.post("/slack", async (req, res) => {
    const text = req.body.text;

    console.log("Slack slash command text:", text);

    // Respond to Slack immediately (required within 3s)
    res.send("Sending to WhatsApp... ✅");

    try {
        if (!text) return;

        // Detect image URL
        const isImage = /\.(jpeg|jpg|png|gif)($|\?)/i.test(text) || text.startsWith("http");

        if (isImage) {
            await client.messages.create({
                from: "whatsapp:+14155238886",
                to: "whatsapp:+918459679367",
                mediaUrl: [text]
            });

            await Message.create({
                sender: "Slack",
                mediaUrl: text
            });

            console.log("Slack image → WhatsApp ✅");

        } else {
            await client.messages.create({
                from: "whatsapp:+14155238886",
                to: "whatsapp:+918459679367",
                body: text
            });

            await Message.create({
                sender: "Slack",
                message: text
            });

            console.log("Slack text → WhatsApp ✅");
        }

    } catch (error) {
        console.error("Slack → WhatsApp error:", error.message);
    }
});

// ─────────────────────────────────────────────
// 📸 Slack → WhatsApp (IMAGE via file upload event)
// ─────────────────────────────────────────────
app.post("/slack/events", async (req, res) => {
    const body = req.body;

    // Slack URL verification handshake
    if (body.type === "url_verification") {
        console.log("Slack URL verification ✅");
        return res.status(200).json({ challenge: body.challenge });
    }

    // Respond to Slack immediately (required within 3s)
    res.sendStatus(200);

    const event = body.event;

    // ✅ FIX 3 & 4: Send image to WhatsApp (not back to Slack), single DB save
    if (event && event.files && event.files.length > 0) {
        const file = event.files[0];
        const fileUrl = file.url_private;

        console.log("Slack file received:", fileUrl);

        try {
            // Download image from Slack (requires Bot Token for private URLs)
            const response = await axios({
                url: fileUrl,
                method: "GET",
                responseType: "stream",
                headers: {
                    Authorization: `Bearer ${SLACK_BOT_TOKEN}`
                }
            });

            // Upload to Cloudinary to get a public URL
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

            // ✅ FIX 3: Send to WhatsApp via Twilio (was incorrectly posting back to Slack)
            await client.messages.create({
                from: "whatsapp:+14155238886",
                to: "whatsapp:+918459679367",
                mediaUrl: [publicUrl]
            });

            // ✅ FIX 4: Single save with correct sender (was saving twice with wrong senders)
            await Message.create({
                sender: "Slack",
                mediaUrl: publicUrl
            });

            console.log("Slack image → WhatsApp ✅");

        } catch (error) {
            console.error("Slack image → WhatsApp error:", error.message);
        }
    }
});

// ✅ Health check route
app.get("/", (req, res) => {
    res.send("WhatsApp ↔ Slack Bridge is running ✅");
});

// ✅ FIX 1: REMOVED the duplicate app.listen() that was here originally