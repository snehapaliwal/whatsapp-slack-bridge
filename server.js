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
    fromName: String,
    message: String,
    mediaUrl: String,
    slackChannel: String,
    timestamp: { type: Date, default: Date.now }
});
const Message = mongoose.model("Message", messageSchema);

// ─────────────────────────────────────────────
// 📦 SCHEMA 2: Bridges
// ─────────────────────────────────────────────
const bridgeSchema = new mongoose.Schema({
    slackChannel: { type: String, required: true },
    slackChannelName: { type: String },
    whatsappNumber: { type: String, required: true },
    name: { type: String, default: null },
    invitedBy: { type: String },
    status: { type: String, default: "active" },   // active / removed / stopped
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
// 🔧 Helpers
// ─────────────────────────────────────────────
function formatSender(bridge) {
    const number = bridge.whatsappNumber.replace("whatsapp:", "");
    if (bridge.name && bridge.name.trim() !== "") {
        return `${bridge.name} (${number})`;
    }
    return number;
}

async function getActiveBridges(slackChannel) {
    return await Bridge.find({ slackChannel, status: "active" });
}

async function getBridgeForNumber(whatsappNumber) {
    return await Bridge.findOne({ whatsappNumber, status: "active" });
}

// ─────────────────────────────────────────────
// ✅ NEW: STOP keyword list
// If WA user sends any of these → remove from DB
// ─────────────────────────────────────────────
const STOP_KEYWORDS = ["stop", "stopall", "unsubscribe", "cancel", "end", "quit"];
const START_KEYWORDS = ["start", "unstop", "yes"];

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
        if (!process.env.SLACK_WEBHOOK_URL)
            return res.send("❌ SLACK_WEBHOOK_URL is NOT set.");
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
// ─────────────────────────────────────────────
app.post("/whatsapp", async (req, res) => {
    const message = req.body.Body;
    const from = req.body.From;
    const numMedia = parseInt(req.body.NumMedia);

    console.log("📱 WhatsApp from:", from, "| text:", message, "| media:", numMedia);

    res.send("OK");

    try {
        const msgLower = (message || "").trim().toLowerCase();

        // ─────────────────────────────────────
        // ✅ FIX: STOP message → remove from DB
        // ─────────────────────────────────────
        if (STOP_KEYWORDS.includes(msgLower)) {
            // Mark ALL bridges for this number as stopped
            const result = await Bridge.updateMany(
                { whatsappNumber: from, status: "active" },
                { status: "stopped" }
            );

            console.log(`🛑 STOP received from ${from} — removed ${result.modifiedCount} bridge(s) from DB`);

            // Notify Slack that user opted out
            const bridge = await Bridge.findOne({ whatsappNumber: from });
            const displayName = bridge ? formatSender(bridge) : from.replace("whatsapp:", "");
            const slackChannel = bridge ? bridge.slackChannel : "C0APMTNQKUY";

            await axios.post(SLACK_WEBHOOK_URL, {
                channel: slackChannel,
                text: `🛑 *${displayName}* has opted out and is no longer connected to this channel.`
            });

            return; // Do not forward STOP message to Slack
        }

        // ─────────────────────────────────────
        // ✅ FIX: UNSTOP/START → re-activate in DB
        // ─────────────────────────────────────
        if (START_KEYWORDS.includes(msgLower)) {
            const result = await Bridge.updateMany(
                { whatsappNumber: from, status: "stopped" },
                { status: "active" }
            );

            console.log(`✅ START received from ${from} — re-activated ${result.modifiedCount} bridge(s)`);

            // Notify Slack that user is back
            const bridge = await Bridge.findOne({ whatsappNumber: from });
            const displayName = bridge ? formatSender(bridge) : from.replace("whatsapp:", "");
            const slackChannel = bridge ? bridge.slackChannel : "C0APMTNQKUY";

            await axios.post(SLACK_WEBHOOK_URL, {
                channel: slackChannel,
                text: `✅ *${displayName}* has rejoined and is now connected to this channel again.`
            });

            return; // Do not forward START message to Slack
        }

        // ─────────────────────────────────────
        // Normal message flow
        // ─────────────────────────────────────
        const bridge = await getBridgeForNumber(from);
        const displayName = bridge
            ? formatSender(bridge)
            : from.replace("whatsapp:", "");
        const slackChannel = bridge ? bridge.slackChannel : "C0APMTNQKUY";

        console.log("📤 Sender:", displayName, "| Channel:", slackChannel);

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

            const captionText = (message && message.trim() !== "")
                ? `📸 *Image from ${displayName}*\n${message}`
                : `📸 *Image from ${displayName}*`;

            await axios.post(SLACK_WEBHOOK_URL, {
                channel: slackChannel,
                blocks: [
                    { type: "section", text: { type: "mrkdwn", text: captionText } },
                    { type: "image", image_url: publicUrl, alt_text: message || "WhatsApp image" }
                ]
            });

            await Message.create({
                sender: "WhatsApp", from, fromName: displayName,
                message: message || null, mediaUrl: publicUrl, slackChannel
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
                text: `💬 *${displayName}*: ${message}`
            });

            await Message.create({
                sender: "WhatsApp", from, fromName: displayName, message, slackChannel
            });

            console.log("WhatsApp text → Slack ✅");
        }

    } catch (error) {
        console.error("❌ WhatsApp → Slack error:", error.response?.data || error.message);
    }
});

// ─────────────────────────────────────────────
// 💬 Slack → WhatsApp
// ─────────────────────────────────────────────
app.post("/slack", async (req, res) => {
    const rawText = req.body.text || "";
    const slackChannel = req.body.channel_id || "C0APMTNQKUY";
    const slackChannelName = req.body.channel_name || "unknown";
    const invitedBy = req.body.user_id || "unknown";

    console.log("Slack command | channel:", slackChannel, "| text:", rawText);

    const parts = rawText.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    // /whatsapp invite +91xxxx Sneha Paliwal
    if (subcommand === "invite") {
        const number = parts[1];
        const name = parts.slice(2).join(" ") || null;

        if (!number) {
            return res.send("❌ Usage: `/whatsapp invite +91xxxxxxxxxx Name`\nExample: `/whatsapp invite +918459679367 Sneha Paliwal`");
        }

        const formatted = number.startsWith("whatsapp:") ? number : `whatsapp:${number}`;

        const existing = await Bridge.findOne({ slackChannel, whatsappNumber: formatted, status: "active" });
        if (existing) {
            return res.send(`⚠️ *${number}* is already connected to this channel!`);
        }

        await Bridge.create({ slackChannel, slackChannelName, whatsappNumber: formatted, name, invitedBy, status: "active" });
        console.log("✅ Bridge created:", formatted, "name:", name, "→", slackChannel);

        try {
            const greeting = name ? `Hi ${name.split(" ")[0]}!` : "Hi!";
            await client.messages.create({
                from: TWILIO_WHATSAPP_FROM,
                to: formatted,
                body: `👋 ${greeting} You have been invited to join a Slack channel (#${slackChannelName}). You can now send and receive messages here!`
            });
        } catch (err) {
            console.error("⚠️ Could not send invite message:", err.message);
        }

        const displayName = name ? `*${name}* (${number})` : `*${number}*`;
        return res.send(`✅ ${displayName} invited successfully! Connected to *#${slackChannelName}*`);
    }

    // /whatsapp list
    if (subcommand === "list") {
        const bridges = await getActiveBridges(slackChannel);

        if (bridges.length === 0) {
            return res.send("📋 No WhatsApp numbers connected to this channel yet.\nUse `/whatsapp invite +91xxxxxxxxxx Name` to add someone.");
        }

        const list = bridges.map((b, i) => {
            const number = b.whatsappNumber.replace("whatsapp:", "");
            const nameStr = b.name ? ` — *${b.name}*` : "";
            const date = new Date(b.createdAt).toLocaleDateString();
            return `${i + 1}. ${number}${nameStr} _(connected ${date})_`;
        }).join("\n");

        return res.send(`📋 *Connected WhatsApp numbers in #${slackChannelName}:*\n${list}`);
    }

    // /whatsapp remove +91xxxxxxxxxx
    if (subcommand === "remove") {
        const number = parts[1];
        if (!number) return res.send("❌ Usage: `/whatsapp remove +91xxxxxxxxxx`");

        const formatted = number.startsWith("whatsapp:") ? number : `whatsapp:${number}`;
        const bridge = await Bridge.findOneAndUpdate(
            { slackChannel, whatsappNumber: formatted, status: "active" },
            { status: "removed" }
        );

        if (!bridge) return res.send(`⚠️ *${number}* is not connected to this channel.`);

        try {
            await client.messages.create({
                from: TWILIO_WHATSAPP_FROM, to: formatted,
                body: `👋 You have been removed from the Slack channel #${slackChannelName}.`
            });
        } catch (err) {
            console.error("⚠️ Could not send removal notification:", err.message);
        }

        const removedName = bridge.name ? `*${bridge.name}* (${number})` : `*${number}*`;
        return res.send(`✅ ${removedName} removed from *#${slackChannelName}*`);
    }

    // /whatsapp name +91xxxx New Name
    if (subcommand === "name") {
        const number = parts[1];
        const newName = parts.slice(2).join(" ");

        if (!number || !newName) {
            return res.send("❌ Usage: `/whatsapp name +91xxxxxxxxxx New Name`");
        }

        const formatted = number.startsWith("whatsapp:") ? number : `whatsapp:${number}`;
        const bridge = await Bridge.findOneAndUpdate(
            { slackChannel, whatsappNumber: formatted, status: "active" },
            { name: newName }, { new: true }
        );

        if (!bridge) return res.send(`⚠️ *${number}* is not connected. Invite them first.`);
        return res.send(`✅ Name updated! *${number}* will now show as *${newName}* in Slack.`);
    }

    // /whatsapp help
    if (subcommand === "help" || rawText.trim() === "") {
        return res.send(
            `*WhatsApp Bridge Commands:*\n` +
            `• \`/whatsapp invite +91xxxxxxxxxx Name\` — Connect a number\n` +
            `• \`/whatsapp list\` — See all connected numbers\n` +
            `• \`/whatsapp remove +91xxxxxxxxxx\` — Disconnect a number\n` +
            `• \`/whatsapp name +91xxxxxxxxxx New Name\` — Update contact name\n` +
            `• \`/whatsapp [message]\` — Send a message to all connected numbers`
        );
    }

    // /whatsapp [message]
    const text = convertSlackEmojis(rawText);
    res.send("Sending to WhatsApp... ✅");

    try {
        const bridges = await getActiveBridges(slackChannel);

        if (bridges.length === 0) {
            await client.messages.create({ from: TWILIO_WHATSAPP_FROM, to: "whatsapp:+918459679367", body: text });
            await Message.create({ sender: "Slack", message: text, slackChannel });
            return;
        }

        for (const bridge of bridges) {
            try {
                const isImage = /\.(jpeg|jpg|png|gif)($|\?)/i.test(text);
                if (isImage) {
                    await client.messages.create({ from: TWILIO_WHATSAPP_FROM, to: bridge.whatsappNumber, mediaUrl: [text] });
                    await Message.create({ sender: "Slack", mediaUrl: text, slackChannel });
                } else {
                    await client.messages.create({ from: TWILIO_WHATSAPP_FROM, to: bridge.whatsappNumber, body: text });
                    await Message.create({ sender: "Slack", message: text, slackChannel });
                }
                console.log(`✅ Sent to ${bridge.whatsappNumber} (${bridge.name || "no name"})`);
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
        return res.status(200).json({ challenge: body.challenge });
    }

    res.sendStatus(200);

    const event = body.event;
    if (event && event.files && event.files.length > 0) {
        const file = event.files[0];
        const fileUrl = file.url_private;
        const slackChannel = event.channel || "C0APMTNQKUY";

        try {
            const response = await axios({
                url: fileUrl, method: "GET", responseType: "arraybuffer",
                headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
            });

            const uploadResult = await new Promise((resolve, reject) => {
                cloudinary.uploader.upload_stream(
                    { folder: "slack_images", resource_type: "image" },
                    (error, result) => { if (error) reject(error); else resolve(result); }
                ).end(response.data);
            });

            const publicUrl = uploadResult.secure_url;
            const bridges = await getActiveBridges(slackChannel);

            if (bridges.length === 0) {
                await client.messages.create({ from: TWILIO_WHATSAPP_FROM, to: "whatsapp:+918459679367", mediaUrl: [publicUrl] });
            } else {
                for (const bridge of bridges) {
                    await client.messages.create({ from: TWILIO_WHATSAPP_FROM, to: bridge.whatsappNumber, mediaUrl: [publicUrl] });
                }
            }

            await Message.create({ sender: "Slack", mediaUrl: publicUrl, slackChannel });
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