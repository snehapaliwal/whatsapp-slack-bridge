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
const TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886";

// ☁️ Cloudinary config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

mongoose.set("bufferCommands", false);

// ─────────────────────────────────────────────
// 📦 SCHEMA 1: Messages
// ─────────────────────────────────────────────
const messageSchema = new mongoose.Schema({
    sender: String,
    from: String,
    message: String,
    mediaUrl: String,
    slackChannel: String,
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model("Message", messageSchema);

// ─────────────────────────────────────────────
// 📦 SCHEMA 2: Bridges (NEW)
// Stores which WhatsApp number is connected
// to which Slack channel
// ─────────────────────────────────────────────
const bridgeSchema = new mongoose.Schema({
    slackChannel: { type: String, required: true },   // e.g. C0APMTNQKUY
    slackChannelName: { type: String },                // e.g. new-channel
    whatsappNumber: { type: String, required: true },  // e.g. whatsapp:+918459679367
    invitedBy: { type: String },                       // Slack user ID
    status: { type: String, default: "active" },       // active / removed
    createdAt: { type: Date, default: Date.now }
});
const Bridge = mongoose.model("Bridge", bridgeSchema);

// ─────────────────────────────────────────────
// ✅ Emoji converter: :fire: → 🔥
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
    point_left: "👈", loudspeaker: "📢"
};

function convertSlackEmojis(text) {
    if (!text) return text;
    return text.replace(/:([a-zA-Z0-9_+\-]+):/g, (match, name) => {
        return emojiMap[name] || match;
    });
}

// ─────────────────────────────────────────────
// 🔧 Helper: get all active WA numbers for a channel
// ─────────────────────────────────────────────
async function getActiveBridges(slackChannel) {
    return await Bridge.find({ slackChannel, status: "active" });
}

// ─────────────────────────────────────────────
// 🔧 Helper: find which channel a WA number belongs to
// ─────────────────────────────────────────────
async function getChannelForNumber(whatsappNumber) {
    const bridge = await Bridge.findOne({
        whatsappNumber,
        status: "active"
    });
    return bridge ? bridge.slackChannel : null;
}

// ─────────────────────────────────────────────
// 🚀 Start server
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
        res.send(`❌ Slack ERROR: ${error.response?.data} | ${error.message}`);
    }
});

// ─────────────────────────────────────────────
// 📩 WhatsApp → Slack (TEXT + IMAGE)
// Now dynamically finds the correct Slack channel
// ─────────────────────────────────────────────
app.post("/whatsapp", async (req, res) => {
    const message = req.body.Body;
    const from = req.body.From;          // e.g. whatsapp:+918459679367
    const numMedia = parseInt(req.body.NumMedia);

    console.log("📱 WhatsApp from:", from, "| text:", message, "| media:", numMedia);

    res.send("OK");

    try {
        // Find which Slack channel this number is connected to
        let slackChannel = await getChannelForNumber(from);

        // Fallback: if number not in DB, use default channel C0APMTNQKUY
        if (!slackChannel) {
            console.log("⚠️ Number not found in DB, using default channel");
            slackChannel = "C0APMTNQKUY";
        }

        console.log("📤 Sending to Slack channel:", slackChannel);

        if (numMedia > 0) {
            // ── 📸 IMAGE ──
            const mediaUrl = req.body.MediaUrl0;

            const response = await axios({
                url: mediaUrl,
                method: "GET",
                responseType: "arraybuffer",
                auth: { username: accountSid, password: authToken }
            });

            const uploadResult = await new Promise((resolve, reject) => {
                cloudinary.uploader.upload_stream(
                    { folder: "whatsapp_images", resource_type: "image" },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                ).end(response.data);
            });

            const publicUrl = uploadResult.secure_url;
            console.log("☁️ Cloudinary URL:", publicUrl);

            const captionText = (message && message.trim() !== "")
                ? `📸 *Image from ${from}*\n${message}`
                : `📸 *Image from ${from}*`;

            await axios.post(SLACK_WEBHOOK_URL, {
                channel: slackChannel,
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

            await Message.create({
                sender: "WhatsApp",
                from,
                message: message || null,
                mediaUrl: publicUrl,
                slackChannel
            });

            console.log("WhatsApp image → Slack ✅");

        } else {
            // ── 💬 TEXT ──
            if (!message || message.trim() === "") {
                console.log("⚠️ Empty message, skipping.");
                return;
            }

            await axios.post(SLACK_WEBHOOK_URL, {
                channel: slackChannel,
                text: `💬 *${from}*: ${message}`
            });

            await Message.create({
                sender: "WhatsApp",
                from,
                message,
                slackChannel
            });

            console.log("WhatsApp text → Slack ✅");
        }

    } catch (error) {
        console.error("❌ WhatsApp → Slack error:", error.response?.data || error.message);
    }
});

// ─────────────────────────────────────────────
// 💬 Slack → WhatsApp
// Now handles: invite / list / remove / message
// ─────────────────────────────────────────────
app.post("/slack", async (req, res) => {
    const rawText = req.body.text || "";
    const slackChannel = req.body.channel_id || "C0APMTNQKUY";
    const slackChannelName = req.body.channel_name || "unknown";
    const invitedBy = req.body.user_id || "unknown";

    console.log("Slack command | channel:", slackChannel, "| text:", rawText);

    const parts = rawText.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    // ─────────────────────────────────────────
    // 📌 /whatsapp invite +91xxxxxxxxxx
    // ─────────────────────────────────────────
    if (subcommand === "invite") {
        const number = parts[1];

        if (!number) {
            return res.send("❌ Usage: `/whatsapp invite +91xxxxxxxxxx`");
        }

        // Format number properly
        const formatted = number.startsWith("whatsapp:")
            ? number
            : `whatsapp:${number}`;

        // Check if already exists
        const existing = await Bridge.findOne({
            slackChannel,
            whatsappNumber: formatted,
            status: "active"
        });

        if (existing) {
            return res.send(`⚠️ *${number}* is already connected to this channel!`);
        }

        // Save to DB
        await Bridge.create({
            slackChannel,
            slackChannelName,
            whatsappNumber: formatted,
            invitedBy,
            status: "active"
        });

        console.log("✅ Bridge created:", formatted, "→", slackChannel);

        // Send welcome message to WhatsApp
        try {
            await client.messages.create({
                from: TWILIO_WHATSAPP_FROM,
                to: formatted,
                body: `👋 You have been invited to join a Slack channel (#${slackChannelName}). You can now send and receive messages here!`
            });
        } catch (err) {
            console.error("⚠️ Could not send WhatsApp invite message:", err.message);
        }

        return res.send(`✅ *${number}* invited successfully! They are now connected to *#${slackChannelName}*`);
    }

    // ─────────────────────────────────────────
    // 📋 /whatsapp list
    // ─────────────────────────────────────────
    if (subcommand === "list") {
        const bridges = await getActiveBridges(slackChannel);

        if (bridges.length === 0) {
            return res.send("📋 No WhatsApp numbers connected to this channel yet.\nUse `/whatsapp invite +91xxxxxxxxxx` to add someone.");
        }

        const list = bridges.map((b, i) =>
            `${i + 1}. ${b.whatsappNumber.replace("whatsapp:", "")} _(connected ${new Date(b.createdAt).toLocaleDateString()})_`
        ).join("\n");

        return res.send(`📋 *Connected WhatsApp numbers in #${slackChannelName}:*\n${list}`);
    }

    // ─────────────────────────────────────────
    // ❌ /whatsapp remove +91xxxxxxxxxx
    // ─────────────────────────────────────────
    if (subcommand === "remove") {
        const number = parts[1];

        if (!number) {
            return res.send("❌ Usage: `/whatsapp remove +91xxxxxxxxxx`");
        }

        const formatted = number.startsWith("whatsapp:")
            ? number
            : `whatsapp:${number}`;

        const bridge = await Bridge.findOneAndUpdate(
            { slackChannel, whatsappNumber: formatted, status: "active" },
            { status: "removed" }
        );

        if (!bridge) {
            return res.send(`⚠️ *${number}* is not connected to this channel.`);
        }

        // Notify the WhatsApp user
        try {
            await client.messages.create({
                from: TWILIO_WHATSAPP_FROM,
                to: formatted,
                body: `👋 You have been removed from the Slack channel #${slackChannelName}. You will no longer receive messages from this channel.`
            });
        } catch (err) {
            console.error("⚠️ Could not send removal notification:", err.message);
        }

        console.log("✅ Bridge removed:", formatted, "from", slackChannel);
        return res.send(`✅ *${number}* has been removed from *#${slackChannelName}*`);
    }

    // ─────────────────────────────────────────
    // ❓ /whatsapp help
    // ─────────────────────────────────────────
    if (subcommand === "help" || subcommand === "") {
        return res.send(
            `*WhatsApp Bridge Commands:*\n` +
            `• \`/whatsapp invite +91xxxxxxxxxx\` — Connect a WhatsApp number to this channel\n` +
            `• \`/whatsapp list\` — See all connected numbers\n` +
            `• \`/whatsapp remove +91xxxxxxxxxx\` — Disconnect a number\n` +
            `• \`/whatsapp [message]\` — Send a message to all connected numbers`
        );
    }

    // ─────────────────────────────────────────
    // 💬 /whatsapp [message] — send to all numbers
    // ─────────────────────────────────────────
    const text = convertSlackEmojis(rawText);
    console.log("Slack message → WhatsApp:", text);

    // Respond to Slack immediately
    res.send("Sending to WhatsApp... ✅");

    try {
        // Get all active bridges for this channel
        const bridges = await getActiveBridges(slackChannel);

        if (bridges.length === 0) {
            // No bridges — fallback to original hardcoded number
            console.log("⚠️ No bridges found, using fallback number");
            await client.messages.create({
                from: TWILIO_WHATSAPP_FROM,
                to: "whatsapp:+918459679367",
                body: text
            });
            await Message.create({ sender: "Slack", message: text, slackChannel });
            return;
        }

        // Send to ALL connected numbers
        for (const bridge of bridges) {
            try {
                const isImage = /\.(jpeg|jpg|png|gif)($|\?)/i.test(text);

                if (isImage) {
                    await client.messages.create({
                        from: TWILIO_WHATSAPP_FROM,
                        to: bridge.whatsappNumber,
                        mediaUrl: [text]
                    });
                    await Message.create({
                        sender: "Slack",
                        mediaUrl: text,
                        slackChannel
                    });
                } else {
                    await client.messages.create({
                        from: TWILIO_WHATSAPP_FROM,
                        to: bridge.whatsappNumber,
                        body: text
                    });
                    await Message.create({
                        sender: "Slack",
                        message: text,
                        slackChannel
                    });
                }

                console.log(`✅ Sent to ${bridge.whatsappNumber}`);

            } catch (err) {
                console.error(`❌ Failed to send to ${bridge.whatsappNumber}:`, err.message);
            }
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
        const slackChannel = event.channel || "C0APMTNQKUY";

        console.log("Slack file received:", fileUrl, "| channel:", slackChannel);

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

            // Send to all active bridges for this channel
            const bridges = await getActiveBridges(slackChannel);

            if (bridges.length === 0) {
                // Fallback to default number
                await client.messages.create({
                    from: TWILIO_WHATSAPP_FROM,
                    to: "whatsapp:+918459679367",
                    mediaUrl: [publicUrl]
                });
            } else {
                for (const bridge of bridges) {
                    await client.messages.create({
                        from: TWILIO_WHATSAPP_FROM,
                        to: bridge.whatsappNumber,
                        mediaUrl: [publicUrl]
                    });
                    console.log(`✅ Image sent to ${bridge.whatsappNumber}`);
                }
            }

            await Message.create({
                sender: "Slack",
                mediaUrl: publicUrl,
                slackChannel
            });

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