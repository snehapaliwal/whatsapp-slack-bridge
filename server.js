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

// ✅ Schema & model defined BEFORE startServer()
mongoose.set("bufferCommands", false);

const messageSchema = new mongoose.Schema({
    sender: String,
    from: String,
    message: String,
    mediaUrl: String,
    timestamp: { type: Date, default: Date.now }
});

const Message = mongoose.model("Message", messageSchema);

// ─────────────────────────────────────────────
// ✅ FIX 2: Slack emoji :code: → real emoji 😊
// ─────────────────────────────────────────────
const emojiMap = {
    smile: "😊", grinning: "😀", joy: "😂", heart: "❤️",
    fire: "🔥", "+1": "👍", thumbsup: "👍", "-1": "👎",
    thumbsdown: "👎", ok_hand: "👌", clap: "👏",
    raised_hands: "🙌", pray: "🙏", wave: "👋",
    eyes: "👀", thinking_face: "🤔", tada: "🎉",
    rocket: "🚀", star: "⭐", white_check_mark: "✅",
    check: "✅", x: "❌", warning: "⚠️", bulb: "💡",
    money_bag: "💰", phone: "📞", email: "📧",
    computer: "💻", hammer: "🔨", wrench: "🔧",
    lock: "🔒", key: "🔑", bell: "🔔", mega: "📣",
    slightly_smiling_face: "🙂", wink: "😉", sweat_smile: "😅",
    sob: "😭", angry: "😠", sunglasses: "😎", muscle: "💪",
    "100": "💯", dog: "🐶", cat: "🐱", pizza: "🍕",
    coffee: "☕", cake: "🎂", point_right: "👉",
    point_left: "👈", loudspeaker: "📢", chart_with_upwards_trend: "📈"
};

function convertSlackEmojis(text) {
    if (!text) return text;
    return text.replace(/:([a-zA-Z0-9_+\-]+):/g, (match, name) => {
        return emojiMap[name] || match;
    });
}

// ─────────────────────────────────────────────
// ✅ Only ONE app.listen() inside startServer()
// ─────────────────────────────────────────────
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
// 🔍 Test route
// ─────────────────────────────────────────────
app.get("/test-slack", async (req, res) => {
    try {
        if (!process.env.SLACK_WEBHOOK_URL) {
            return res.send("❌ SLACK_WEBHOOK_URL is NOT set.");
        }
        const slackRes = await axios.post(process.env.SLACK_WEBHOOK_URL, {
            text: "🔧 Test message from WhatsApp-Slack bridge"
        });
        res.send(`✅ Slack response: ${slackRes.status} | ${slackRes.data}`);
    } catch (error) {
        res.send(`❌ Slack ERROR: ${error.response?.status} | ${error.response?.data} | ${error.message}`);
    }
});

// ─────────────────────────────────────────────
// 📩 WhatsApp → Slack (TEXT + IMAGE)
// ─────────────────────────────────────────────
app.post("/whatsapp", async (req, res) => {
    const message = req.body.Body;
    const from = req.body.From;
    const numMedia = parseInt(req.body.NumMedia);

    console.log("📱 WhatsApp from:", from, "| text:", message, "| media:", numMedia);

    res.send("OK");

    try {
        if (numMedia > 0) {
            // ── 📸 IMAGE (with or without caption) ──
            const mediaUrl = req.body.MediaUrl0;
            console.log("📸 Media URL:", mediaUrl);

            const response = await axios({
                url: mediaUrl,
                method: "GET",
                responseType: "arraybuffer",
                auth: { username: accountSid, password: authToken }
            });

            console.log("📥 Download status:", response.status);

            const uploadResult = await new Promise((resolve, reject) => {
                cloudinary.uploader.upload_stream(
                    { folder: "whatsapp_images", resource_type: "image" },
                    (error, result) => {
                        if (error) { console.error("❌ Cloudinary error:", error.message); reject(error); }
                        else resolve(result);
                    }
                ).end(response.data);
            });

            const publicUrl = uploadResult.secure_url;
            console.log("☁️ Cloudinary URL:", publicUrl);

            // ✅ FIX 1: Caption add karo agar hai toh
            const captionText = (message && message.trim() !== "")
                ? `📸 *Image from ${from}*\n${message}`   // ← caption shown here
                : `📸 *Image from ${from}*`;

            const slackRes = await axios.post(SLACK_WEBHOOK_URL, {
                blocks: [
                    {
                        type: "section",
                        text: { type: "mrkdwn", text: captionText }
                    },
                    {
                        type: "image",
                        image_url: publicUrl,
                        alt_text: message || "WhatsApp image"
                    }
                ]
            });

            console.log("📨 Slack image response:", slackRes.status, slackRes.data);

            await Message.create({
                sender: "WhatsApp",
                from,
                message: message || null,
                mediaUrl: publicUrl
            });

            console.log("WhatsApp image → Slack ✅");

        } else {
            // ── 💬 TEXT ──
            if (!message || message.trim() === "") {
                console.log("⚠️ Empty message, skipping.");
                return;
            }

            const slackRes = await axios.post(SLACK_WEBHOOK_URL, {
                text: `💬 *${from}*: ${message}`
            });

            console.log("📨 Slack text response:", slackRes.status, slackRes.data);

            await Message.create({ sender: "WhatsApp", from, message });
            console.log("WhatsApp text → Slack ✅");
        }

    } catch (error) {
        console.error("❌ WhatsApp → Slack error:", error.response?.data || error.message);
    }
});

// ─────────────────────────────────────────────
// 💬 Slack → WhatsApp (TEXT via slash command)
// ─────────────────────────────────────────────
app.post("/slack", async (req, res) => {
    const rawText = req.body.text;

    // ✅ FIX 2: :fire: → 🔥 convert karo
    const text = convertSlackEmojis(rawText);

    console.log("Slack raw:", rawText, "→ converted:", text);

    res.send("Sending to WhatsApp... ✅");

    try {
        if (!text || text.trim() === "") return;

        const isImage = /\.(jpeg|jpg|png|gif)($|\?)/i.test(text) || text.startsWith("http");

        if (isImage) {
            await client.messages.create({
                from: "whatsapp:+14155238886",
                to: "whatsapp:+918459679367",
                mediaUrl: [text]
            });
            await Message.create({ sender: "Slack", mediaUrl: text });
            console.log("Slack image → WhatsApp ✅");

        } else {
            await client.messages.create({
                from: "whatsapp:+14155238886",
                to: "whatsapp:+918459679367",
                body: text   // ← real emojis included
            });
            await Message.create({ sender: "Slack", message: text });
            console.log("Slack text → WhatsApp ✅");
        }

    } catch (error) {
        console.error("Slack → WhatsApp error:", error.message);
    }
});

// ─────────────────────────────────────────────
// 📸 Slack → WhatsApp (IMAGE via file upload)
// ─────────────────────────────────────────────
app.post("/slack/events", async (req, res) => {
    const body = req.body;

    if (body.type === "url_verification") {
        console.log("Slack URL verification ✅");
        return res.status(200).json({ challenge: body.challenge });
    }

    res.sendStatus(200);

    const event = body.event;

    if (event && event.files && event.files.length > 0) {
        const file = event.files[0];
        const fileUrl = file.url_private;
        console.log("Slack file received:", fileUrl);

        try {
            const response = await axios({
                url: fileUrl,
                method: "GET",
                responseType: "arraybuffer",
                headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
            });

            const uploadResult = await new Promise((resolve, reject) => {
                cloudinary.uploader.upload_stream(
                    { folder: "slack_images", resource_type: "image" },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                ).end(response.data);
            });

            const publicUrl = uploadResult.secure_url;
            console.log("☁️ Cloudinary URL:", publicUrl);

            await client.messages.create({
                from: "whatsapp:+14155238886",
                to: "whatsapp:+918459679367",
                mediaUrl: [publicUrl]
            });

            await Message.create({ sender: "Slack", mediaUrl: publicUrl });
            console.log("Slack image → WhatsApp ✅");

        } catch (error) {
            console.error("Slack image → WhatsApp error:", error.message);
        }
    }
});

// ✅ Health check
app.get("/", (req, res) => {
    res.send("WhatsApp ↔ Slack Bridge is running ✅");
});