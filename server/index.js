
"use strict";

/**
 * WhatsApp Business Automation
 * Universal Auto Reply + Bulk Messaging
 */

const path = require("path");
const fs = require("fs");
const http = require("http");

const express = require("express");
const { Server } = require("socket.io");
const multer = require("multer");
const xlsx = require("xlsx");
const csvParser = require("csv-parser");
const qrcode = require("qrcode");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");

/* ============================================================
   1. AUTO REPLY CONFIGURATION
============================================================ */

const autoReplyRules = {};

let defaultReply = "Thanks for reaching out!";
let autoReplyEnabled = true;

/* ============================================================
   2. APP AND SERVER
============================================================ */

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "..", "public");
const UPLOAD_DIR = path.join(__dirname, "..", "uploads");
const AUTH_DIR = path.join(__dirname, "..", ".wwebjs_auth");
const DATA_DIR = path.join(__dirname, "..", "data");

const AUTOREPLY_FILE = path.join(DATA_DIR, "autoreply.json");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

/* ============================================================
   3. AUTO REPLY SAVE AND LOAD
============================================================ */

function saveAutoReply() {
  try {
    const payload = {
      enabled: autoReplyEnabled,
      defaultReply,
      rules: autoReplyRules
    };

    fs.writeFileSync(
      AUTOREPLY_FILE,
      JSON.stringify(payload, null, 2)
    );

    return true;
  } catch (err) {
    console.error("Save error:", err.message);
    return false;
  }
}

function loadAutoReply() {
  try {
    if (!fs.existsSync(AUTOREPLY_FILE)) return;

    const saved = JSON.parse(
      fs.readFileSync(AUTOREPLY_FILE, "utf8")
    );

    if (typeof saved.enabled === "boolean") {
      autoReplyEnabled = saved.enabled;
    }

    if (typeof saved.defaultReply === "string") {
      defaultReply = saved.defaultReply;
    }

    if (
      saved.rules &&
      typeof saved.rules === "object" &&
      !Array.isArray(saved.rules)
    ) {
      for (const key of Object.keys(autoReplyRules)) {
        delete autoReplyRules[key];
      }

      for (const [key, value] of Object.entries(saved.rules)) {
        if (typeof value === "string") {
          autoReplyRules[key] = value;
        }
      }
    }

    console.log("Auto-reply settings loaded.");
  } catch (err) {
    console.error("Load error:", err.message);
  }
}

loadAutoReply();

/* ============================================================
   4. CONNECTION STATE
============================================================ */

const state = {
  status: "initializing",
  qr: null,
  me: null
};

let bulkJobRunning = false;
let stopRequested = false;

function setStatus(status, extra = {}) {
  state.status = status;

  io.emit("status", {
    status,
    me: state.me,
    autoReplyEnabled,
    ...extra
  });
}

function log(level, message) {
  const entry = {
    level,
    text: message,
    time: new Date().toISOString()
  };

  io.emit("log", entry);

  console.log(`[${level.toUpperCase()}] ${message}`);
}

/* ============================================================
   5. WHATSAPP CLIENT
============================================================ */

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: AUTH_DIR
  }),

  puppeteer: {
    headless: true,

    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu"
    ]
  }
});

client.on("qr", async (qr) => {
  try {
    state.qr = await qrcode.toDataURL(qr, {
      margin: 1,
      width: 320
    });

    setStatus("qr");
    io.emit("qr", state.qr);

    log("info", "New QR code generated.");
  } catch (err) {
    log("error", `QR error: ${err.message}`);
  }
});

client.on("authenticated", () => {
  state.qr = null;
  setStatus("authenticated");

  log("success", "Authenticated with WhatsApp.");
});

client.on("auth_failure", (msg) => {
  setStatus("disconnected");
  log("error", `Authentication failed: ${msg}`);
});

client.on("ready", () => {
  state.qr = null;

  const info = client.info || {};

  state.me = {
    name: info.pushname || "WhatsApp User",
    number:
      info.wid && info.wid.user
        ? info.wid.user
        : "unknown"
  };

  setStatus("connected");

  log(
    "success",
    `Connected as ${state.me.name} (${state.me.number}).`
  );
});

client.on("disconnected", (reason) => {
  state.me = null;
  state.qr = null;

  setStatus("disconnected");
  log("error", `Disconnected: ${reason}`);

  client.initialize().catch((err) => {
    log("error", `Re-init error: ${err.message}`);
  });
});

/* ============================================================
   6. UNIVERSAL AUTO REPLY
============================================================ */

const processedMessages = new Set();

client.on("message", async (message) => {
  try {
    if (!message) return;
    if (message.fromMe) return;
    if (!autoReplyEnabled) return;

    const from = message.from || "";

    if (!from) return;
    if (from === "status@broadcast") return;
    if (from.endsWith("@g.us")) return;

    if (
      !from.endsWith("@c.us") &&
      !from.endsWith("@lid")
    ) {
      return;
    }

    const messageId =
      message.id && message.id._serialized
        ? message.id._serialized
        : null;

    if (messageId) {
      if (processedMessages.has(messageId)) return;

      processedMessages.add(messageId);

      if (processedMessages.size > 2000) {
        const firstId = processedMessages.values().next().value;
        processedMessages.delete(firstId);
      }
    }

    log("info", `Incoming private message from ${from}`);

    const reply = defaultReply;

    if (
      typeof reply !== "string" ||
      !reply.trim()
    ) {
      log("error", "Fallback Reply is empty.");
      return;
    }

    log("info", `Attempting auto-reply to ${from}`);

    const sentMessage = await client.sendMessage(from, reply);

    log(
      "success",
      `Send accepted: ID=${sentMessage?.id?._serialized || "unknown"} | ACK=${sentMessage?.ack ?? "pending"} | TO=${from}`
    );

  } catch (err) {
    log(
      "error",
      `Auto-reply error: ${err.stack || err.message}`
    );
  }
});

/* ============================================================
   7. MESSAGE DELIVERY ACK DIAGNOSTICS
============================================================ */

client.on("message_ack", (message, ack) => {
  try {
    if (!message || !message.fromMe) return;

    const recipient = message.to || "unknown";
    const messageId =
      message.id?._serialized || "unknown";

    let status = "unknown";

    switch (ack) {
      case -1:
        status = "error";
        break;
      case 0:
        status = "pending";
        break;
      case 1:
        status = "server received";
        break;
      case 2:
        status = "delivered to device";
        break;
      case 3:
        status = "read";
        break;
      case 4:
        status = "played";
        break;
    }

    log(
      "info",
      `DELIVERY ACK=${ack} (${status}) | ID=${messageId} | TO=${recipient}`
    );

  } catch (err) {
    log("error", `ACK listener error: ${err.message}`);
  }
});

/* ============================================================
   8. INITIALIZE WHATSAPP
============================================================ */

client.initialize().catch((err) => {
  setStatus("disconnected");

  log(
    "error",
    `WhatsApp initialization error: ${err.message}`
  );
});

/* ============================================================
   9. FILE UPLOAD
============================================================ */

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },

  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]/g, "_");

    cb(
      null,
      `${Date.now()}-${file.fieldname}-${safe}`
    );
  }
});

const upload = multer({
  storage,

  limits: {
    fileSize: 64 * 1024 * 1024
  },

  fileFilter: (req, file, cb) => {
    if (file.fieldname === "file") {
      const ext = path.extname(file.originalname).toLowerCase();

      if ([".xlsx", ".xls", ".csv"].includes(ext)) {
        return cb(null, true);
      }

      return cb(
        new Error("Contacts file must be .xlsx, .xls, or .csv.")
      );
    }

    if (file.fieldname === "media") {
      return cb(null, true);
    }

    return cb(
      new Error(`Unexpected upload field: ${file.fieldname}`)
    );
  }
});

function uploadBulkFields(req, res, next) {
  const handler = upload.fields([
    { name: "file", maxCount: 1 },
    { name: "media", maxCount: 1 }
  ]);

  handler(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        ok: false,
        error: err.message
      });
    }

    next();
  });
}

/* ============================================================
   10. CONTACT FILE PARSERS
============================================================ */

function normalizeRow(row) {
  const out = {};

  for (const [key, value] of Object.entries(row)) {
    out[String(key).trim().toLowerCase()] = value;
  }

  return out;
}

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];

    fs.createReadStream(filePath)
      .pipe(
        csvParser({
          mapHeaders: ({ header }) =>
            header.trim().toLowerCase()
        })
      )
      .on("data", (data) => rows.push(data))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

function parseXLSX(filePath) {
  const workbook = xlsx.readFile(filePath);

  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  const json = xlsx.utils.sheet_to_json(sheet, {
    defval: ""
  });

  return json.map(normalizeRow);
}

async function parseContactsFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".csv") {
    return parseCSV(filePath);
  }

  return parseXLSX(filePath);
}

/* ============================================================
   11. PHONE NUMBERS
============================================================ */

const PHONE_KEYS = [
  "number",
  "phone",
  "mobile",
  "contact",
  "whatsapp",
  "msisdn",
  "phone number"
];

const DEFAULT_COUNTRY_CODE =
  process.env.COUNTRY_CODE || "";

function getPhone(row) {
  for (const key of PHONE_KEYS) {
    if (
      row[key] !== undefined &&
      String(row[key]).trim() !== ""
    ) {
      return String(row[key]);
    }
  }

  return "";
}

function sanitizeNumber(raw) {
  let digits = String(raw == null ? "" : raw).replace(/\D/g, "");

  if (!digits) return "";

  if (DEFAULT_COUNTRY_CODE) {
    digits = digits.replace(/^0+/, "");

    if (
      digits.length <= 10 &&
      !digits.startsWith(DEFAULT_COUNTRY_CODE)
    ) {
      digits = DEFAULT_COUNTRY_CODE + digits;
    }
  }

  return digits;
}

async function resolveChatId(raw) {
  const digits = sanitizeNumber(raw);

  if (!digits) {
    return {
      ok: false,
      digits: "",
      reason: "Empty or invalid number"
    };
  }

  try {
    const numberId = await client.getNumberId(digits);

    if (numberId && numberId._serialized) {
      return {
        ok: true,
        chatId: numberId._serialized,
        digits
      };
    }

    const chatId = `${digits}@c.us`;

    const registered = await client.isRegisteredUser(chatId);

    if (registered) {
      return {
        ok: true,
        chatId,
        digits
      };
    }

    return {
      ok: false,
      digits,
      reason: "Number is not registered on WhatsApp"
    };

  } catch (err) {
    return {
      ok: false,
      digits,
      reason: `Lookup failed: ${err.message}`
    };
  }
}

/* ============================================================
   12. BULK MESSAGE HELPERS
============================================================ */

function renderTemplate(template, row) {
  return template.replace(
    /\{\s*([\w .\-]+?)\s*\}/g,
    (match, key) => {
      const value = row[key.trim().toLowerCase()];

      return value === undefined || value === null
        ? ""
        : String(value);
    }
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(
    Math.random() * (max - min + 1) + min
  );
}

function safeUnlink(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlink(filePath, () => {});
  }
}

/* ============================================================
   13. API STATUS
============================================================ */

app.get("/api/status", (req, res) => {
  res.json({
    status: state.status,
    me: state.me,
    qr: state.qr,
    autoReplyEnabled,
    autoReplyRules,
    defaultReply,
    bulkJobRunning
  });
});

/* ============================================================
   14. AUTO REPLY SETTINGS
============================================================ */

app.post("/api/auto-reply", (req, res) => {
  const {
    enabled,
    rules,
    fallback
  } = req.body || {};

  if (typeof enabled === "boolean") {
    autoReplyEnabled = enabled;
  }

  if (
    rules &&
    typeof rules === "object" &&
    !Array.isArray(rules)
  ) {
    for (const key of Object.keys(autoReplyRules)) {
      delete autoReplyRules[key];
    }

    for (const [key, value] of Object.entries(rules)) {
      if (typeof value === "string") {
        autoReplyRules[key.toLowerCase()] = value;
      }
    }
  }

  if (typeof fallback === "string") {
    defaultReply = fallback;
  }

  const saved = saveAutoReply();

  log(
    "info",
    `Auto-reply updated (enabled=${autoReplyEnabled})${saved ? " and saved." : "."}`
  );

  io.emit("status", {
    status: state.status,
    me: state.me,
    autoReplyEnabled
  });

  res.json({
    ok: true,
    autoReplyEnabled,
    autoReplyRules,
    defaultReply,
    saved
  });
});

/* ============================================================
   15. STOP BULK JOB
============================================================ */

app.post("/api/stop", (req, res) => {
  if (bulkJobRunning) {
    stopRequested = true;

    log(
      "info",
      "Stop requested. Finishing current message."
    );
  }

  res.json({ ok: true });
});

/* ============================================================
   16. LOGOUT
============================================================ */

app.post("/api/logout", async (req, res) => {
  try {
    await client.logout();

    state.me = null;

    setStatus("disconnected");

    log("info", "Logged out. Re-initializing.");

    client.initialize().catch((err) => {
      log("error", `Re-init error: ${err.message}`);
    });

    res.json({ ok: true });

  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* ============================================================
   17. BULK SEND ROUTE
============================================================ */

app.post(
  "/api/send-bulk",
  uploadBulkFields,
  async (req, res) => {
    const contactsFile =
      req.files && req.files.file
        ? req.files.file[0]
        : null;

    const mediaFile =
      req.files && req.files.media
        ? req.files.media[0]
        : null;

    const cleanup = () => {
      safeUnlink(contactsFile && contactsFile.path);
      safeUnlink(mediaFile && mediaFile.path);
    };

    try {
      if (state.status !== "connected") {
        cleanup();

        return res.status(400).json({
          ok: false,
          error: "WhatsApp is not connected."
        });
      }

      if (bulkJobRunning) {
        cleanup();

        return res.status(409).json({
          ok: false,
          error: "A bulk job is already running."
        });
      }

      if (!contactsFile) {
        cleanup();

        return res.status(400).json({
          ok: false,
          error: "Please upload a contacts file."
        });
      }

      const template = (req.body.template || "").trim();

      if (!template && !mediaFile) {
        cleanup();

        return res.status(400).json({
          ok: false,
          error: "Write a message or attach media."
        });
      }

      let minDelay = parseInt(req.body.minDelay, 10);
      let maxDelay = parseInt(req.body.maxDelay, 10);

      if (!Number.isFinite(minDelay) || minDelay < 5) {
        minDelay = 12;
      }

      if (!Number.isFinite(maxDelay) || maxDelay < minDelay) {
        maxDelay = Math.max(minDelay, 25);
      }

      const rows = await parseContactsFile(contactsFile.path);

      if (!rows.length) {
        cleanup();

        return res.status(400).json({
          ok: false,
          error: "The contacts file has no rows."
        });
      }

      if (
        !getPhone(rows[0]) &&
        !PHONE_KEYS.some((key) => key in rows[0])
      ) {
        cleanup();

        return res.status(400).json({
          ok: false,
          error: 'No phone column found. Add "number" or "phone".'
        });
      }

      const mediaMeta = mediaFile
        ? {
            path: mediaFile.path,
            name: mediaFile.originalname
          }
        : null;

      res.json({
        ok: true,
        started: true,
        total: rows.length,
        minDelay,
        maxDelay,
        media: mediaMeta ? mediaMeta.name : null
      });

      runBulkJob(
        rows,
        template,
        minDelay,
        maxDelay,
        mediaMeta
      ).finally(cleanup);

    } catch (err) {
      cleanup();

      log("error", `Bulk send error: ${err.message}`);

      if (!res.headersSent) {
        res.status(500).json({
          ok: false,
          error: err.message
        });
      }
    }
  }
);

/* ============================================================
   18. BACKGROUND BULK SENDER
============================================================ */

async function runBulkJob(
  rows,
  template,
  minDelay,
  maxDelay,
  mediaMeta
) {
  bulkJobRunning = true;
  stopRequested = false;

  let sent = 0;
  let failed = 0;

  const total = rows.length;

  let media = null;

  if (mediaMeta) {
    try {
      media = MessageMedia.fromFilePath(mediaMeta.path);

      log("info", `Media attached: ${mediaMeta.name}`);

    } catch (err) {
      log("error", `Media error: ${err.message}`);
    }
  }

  io.emit("bulk:start", {
    total,
    minDelay,
    maxDelay,
    media: mediaMeta ? mediaMeta.name : null
  });

  log(
    "info",
    `Bulk job started: ${total} contacts.`
  );

  try {
    for (let i = 0; i < total; i++) {
      if (stopRequested) {
        log("info", "Bulk job cancelled.");
        break;
      }

      if (state.status !== "connected") {
        log("error", "Connection lost. Stopping bulk job.");
        break;
      }

      const row = rows[i];
      const rawPhone = getPhone(row);

      const name =
        row.name ||
        row["full name"] ||
        "";

      const resolved = await resolveChatId(rawPhone);

      if (!resolved.ok) {
        failed++;

        const shown = resolved.digits || rawPhone || "(blank)";

        io.emit("bulk:progress", {
          index: i + 1,
          total,
          name,
          to: shown,
          status: "failed",
          reason: resolved.reason,
          sent,
          failed
        });

        log(
          "error",
          `Skipped ${shown}: ${resolved.reason}`
        );

        continue;
      }

      try {
        const body = renderTemplate(template, row);

        if (media) {
          await client.sendMessage(
            resolved.chatId,
            media,
            { caption: body || "" }
          );
        } else {
          await client.sendMessage(
            resolved.chatId,
            body
          );
        }

        sent++;

        io.emit("bulk:progress", {
          index: i + 1,
          total,
          name,
          to: resolved.digits,
          status: "sent",
          sent,
          failed
        });

        log(
          "success",
          `Sent to ${name || resolved.digits}.`
        );

      } catch (err) {
        failed++;

        io.emit("bulk:progress", {
          index: i + 1,
          total,
          name,
          to: resolved.digits,
          status: "failed",
          reason: err.message,
          sent,
          failed
        });

        log(
          "error",
          `Send failed: ${err.message}`
        );
      }

      const isLast = i === total - 1;

      if (!isLast && !stopRequested) {
        const wait = randomInt(minDelay, maxDelay);

        io.emit("bulk:waiting", {
          index: i + 1,
          total,
          seconds: wait
        });

        await sleep(wait * 1000);
      }
    }

  } catch (err) {
    log("error", `Bulk job error: ${err.message}`);

  } finally {
    bulkJobRunning = false;
    stopRequested = false;

    io.emit("bulk:done", {
      total,
      sent,
      failed
    });

    log(
      "success",
      `Bulk job finished. Sent: ${sent}, Failed: ${failed}.`
    );
  }
}

/* ============================================================
   19. SOCKET.IO
============================================================ */

io.on("connection", (socket) => {
  socket.emit("status", {
    status: state.status,
    me: state.me,
    autoReplyEnabled
  });

  if (state.qr) {
    socket.emit("qr", state.qr);
  }
});

/* ============================================================
   20. START SERVER
============================================================ */

server.listen(PORT, () => {
  console.log(
    `WhatsApp Automation dashboard running on port ${PORT}`
  );
});

/* ============================================================
   21. SHUTDOWN
============================================================ */

process.on("SIGINT", async () => {
  console.log("Shutting down...");

  try {
    await client.destroy();
  } catch (_) {}

  process.exit(0);
});
