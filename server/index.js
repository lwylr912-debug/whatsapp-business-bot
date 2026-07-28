/**
 * WhatsApp Business Automation — Backend
 * -------------------------------------------------------------
 * Features:
 *   1. QR-code login streamed live to the dashboard (Socket.IO)
 *   2. Bulk messaging from an uploaded .xlsx / .csv file with
 *      dynamic {placeholder} templating + optional media attachment
 *      (image / video / PDF / ZIP) sent as a caption
 *   3. Anti-ban random delay (default 12–25s) between messages
 *   4. Customizable keyword auto-reply bot with a fallback reply
 * -------------------------------------------------------------
 */

const path = require('path');
const fs = require('fs');
const http = require('http');

const express = require('express');
const { Server } = require('socket.io');
const multer = require('multer');
const xlsx = require('xlsx');
const csvParser = require('csv-parser');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

/* ============================================================
 * 1. AUTO-REPLY CONFIGURATION  ← EDIT ME
 * ------------------------------------------------------------
 * Keys are keywords (matched as whole words, case-insensitive).
 * Values are the replies that get sent back automatically.
 * The first matching keyword wins, so order them by priority.
 * ============================================================ */
const autoReplyRules = {
  hi: 'Hello! 👋 Thanks for messaging us. Reply "menu" to see what we offer.',
  hello: 'Hi there! 😊 How can we help you today? Reply "menu" for options.',
  menu:
    '📋 *Main Menu*\n' +
    '1️⃣ Reply "price" for our price list\n' +
    '2️⃣ Reply "hours" for opening times\n' +
    '3️⃣ Reply "support" to talk to a human',
  price: '💰 Our pricing starts at $9/month. Reply "menu" to go back.',
  hours: '🕒 We are open Mon–Sat, 9:00 AM – 7:00 PM.',
  support: '🧑‍💻 A team member will get back to you shortly. Thanks for your patience!',
  thanks: 'You are most welcome! 🙌',
  bye: 'Goodbye! 👋 Have a great day.',
};

// Sent when an incoming message matches none of the keywords above.
let defaultReply =
  'Thanks for reaching out! 🙏 We received your message and will reply soon. ' +
  'Meanwhile, reply "menu" to see our options.';

// Master on/off switch for the auto-reply bot (toggle from the dashboard).
let autoReplyEnabled = true;

/* ============================================================
 * 2. APP + SERVER + SOCKET.IO SETUP
 * ============================================================ */
const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const AUTH_DIR = path.join(__dirname, '..', '.wwebjs_auth');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ------------------------------------------------------------
 * Auto-reply persistence — saves the bot config to disk so edits
 * survive a server restart (previously they reset to code values).
 * All disk access is wrapped so a read/write error never crashes
 * the app or the auto-reply flow.
 * ------------------------------------------------------------ */
const DATA_DIR = path.join(__dirname, '..', 'data');
const AUTOREPLY_FILE = path.join(DATA_DIR, 'autoreply.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function saveAutoReply() {
  try {
    const payload = { enabled: autoReplyEnabled, defaultReply, rules: autoReplyRules };
    fs.writeFileSync(AUTOREPLY_FILE, JSON.stringify(payload, null, 2));
    return true;
  } catch (err) {
    console.error('Could not save auto-reply config:', err.message);
    return false;
  }
}

function loadAutoReply() {
  try {
    if (!fs.existsSync(AUTOREPLY_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(AUTOREPLY_FILE, 'utf8'));
    if (typeof saved.enabled === 'boolean') autoReplyEnabled = saved.enabled;
    if (typeof saved.defaultReply === 'string' && saved.defaultReply.trim()) {
      defaultReply = saved.defaultReply;
    }
    if (saved.rules && typeof saved.rules === 'object' && !Array.isArray(saved.rules)) {
      for (const key of Object.keys(autoReplyRules)) delete autoReplyRules[key];
      for (const [k, v] of Object.entries(saved.rules)) {
        if (typeof v === 'string') autoReplyRules[String(k).toLowerCase()] = v;
      }
    }
    console.log('Loaded saved auto-reply config.');
  } catch (err) {
    console.error('Could not load auto-reply config:', err.message);
  }
}

loadAutoReply();

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

/* ============================================================
 * 3. SHARED CONNECTION STATE
 * ============================================================ */
const state = {
  status: 'initializing', // initializing | qr | authenticated | connected | disconnected
  qr: null,
  me: null,
};

let bulkJobRunning = false;
let stopRequested = false;

function setStatus(status, extra = {}) {
  state.status = status;
  io.emit('status', { status, me: state.me, autoReplyEnabled, ...extra });
}

function log(level, text) {
  const entry = { level, text, time: new Date().toISOString() };
  io.emit('log', entry);
  console.log(`[${level.toUpperCase()}] ${text}`);
}

/* ============================================================
 * 4. WHATSAPP CLIENT
 * ============================================================ */
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
  },
});

client.on('qr', async (qr) => {
  try {
    state.qr = await qrcode.toDataURL(qr, { margin: 1, width: 320 });
    setStatus('qr');
    io.emit('qr', state.qr);
    log('info', 'New QR code generated — scan it to log in.');
  } catch (err) {
    log('error', `Failed to render QR code: ${err.message}`);
  }
});

client.on('authenticated', () => {
  state.qr = null;
  setStatus('authenticated');
  log('success', 'Authenticated with WhatsApp.');
});

client.on('auth_failure', (msg) => {
  setStatus('disconnected');
  log('error', `Authentication failed: ${msg}`);
});

client.on('ready', () => {
  state.qr = null;
  const info = client.info || {};
  state.me = {
    name: info.pushname || 'WhatsApp User',
    number: info.wid && info.wid.user ? info.wid.user : 'unknown',
  };
  setStatus('connected');
  log('success', `Connected as ${state.me.name} (${state.me.number}).`);
});

client.on('disconnected', (reason) => {
  state.me = null;
  state.qr = null;
  setStatus('disconnected');
  log('error', `Client disconnected: ${reason}. Re-initializing…`);
  client.initialize().catch((e) => log('error', `Re-init failed: ${e.message}`));
});

/* ---------------- Auto-reply listener (FIXED) ----------------
 * Why the old version could stay silent:
 *   - it called message.getChat() just to detect groups; that call
 *     can be slow or throw, and the handler bailed before replying.
 *   - message.reply() can fail if the chat context isn't loaded.
 * Fixes here:
 *   - listen on 'message_create' (fires more reliably than 'message'
 *     across whatsapp-web.js versions) and ignore our own messages.
 *   - detect chat type from the JID suffix, no getChat() call.
 *   - reply with client.sendMessage(), which is more robust.
 * ------------------------------------------------------------- */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findAutoReply(text) {
  const body = (text || '').trim();
  if (!body) return null;
  for (const [keyword, response] of Object.entries(autoReplyRules)) {
    const pattern = new RegExp(`\\b${escapeRegExp(keyword.toLowerCase())}\\b`, 'i');
    if (pattern.test(body)) return response;
  }
  return defaultReply;
}

client.on('message_create', async (message) => {
  try {
    if (message.fromMe) return;              // ignore our own / outgoing messages
    if (!autoReplyEnabled) return;

    const from = message.from || '';
    if (from === 'status@broadcast') return; // ignore status updates
    if (from.endsWith('@g.us')) return;      // ignore group chats
    if (!from.endsWith('@c.us')) return;     // only reply in 1:1 chats

    const reply = findAutoReply(message.body);
    if (!reply) return;

    await client.sendMessage(from, reply);
    log('info', `Auto-replied to ${from}: "${(message.body || '').slice(0, 40)}"`);
  } catch (err) {
    log('error', `Auto-reply error: ${err.message}`);
  }
});

client.initialize().catch((err) => {
  setStatus('disconnected');
  log('error', `Failed to initialize WhatsApp client: ${err.message}`);
});

/* ============================================================
 * 5. FILE UPLOAD (multer) + PARSERS
 * ============================================================ */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]/g, '_');
    cb(null, `${Date.now()}-${file.fieldname}-${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 64 * 1024 * 1024 }, // 64 MB (covers most media)
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'file') {
      const ext = path.extname(file.originalname).toLowerCase();
      if (['.xlsx', '.xls', '.csv'].includes(ext)) return cb(null, true);
      return cb(new Error('Contacts file must be .xlsx, .xls, or .csv.'));
    }
    if (file.fieldname === 'media') {
      return cb(null, true); // accept any media type (image/video/pdf/zip/etc.)
    }
    return cb(new Error(`Unexpected upload field: ${file.fieldname}`));
  },
});

// Wrap multer so its errors return clean JSON instead of an HTML 500.
function uploadBulkFields(req, res, next) {
  const handler = upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'media', maxCount: 1 },
  ]);
  handler(req, res, (err) => {
    if (err) return res.status(400).json({ ok: false, error: err.message });
    next();
  });
}

function normalizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[String(k).trim().toLowerCase()] = v;
  return out;
}

function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];
    fs.createReadStream(filePath)
      .pipe(csvParser({ mapHeaders: ({ header }) => header.trim().toLowerCase() }))
      .on('data', (data) => rows.push(data))
      .on('end', () => resolve(rows))
      .on('error', reject);
  });
}

function parseXLSX(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const json = xlsx.utils.sheet_to_json(sheet, { defval: '' });
  return json.map(normalizeRow);
}

async function parseContactsFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') return parseCSV(filePath);
  return parseXLSX(filePath);
}

const PHONE_KEYS = ['number', 'phone', 'mobile', 'contact', 'whatsapp', 'msisdn', 'phone number'];
function getPhone(row) {
  for (const key of PHONE_KEYS) {
    if (row[key] !== undefined && String(row[key]).trim() !== '') return String(row[key]);
  }
  return '';
}

function renderTemplate(template, row) {
  return template.replace(/\{\s*([\w .\-]+?)\s*\}/g, (match, key) => {
    const value = row[key.trim().toLowerCase()];
    return value === undefined || value === null ? '' : String(value);
  });
}

/* ------------------------------------------------------------
 * Phone number handling  ← the usual cause of "Failed: 1"
 * ------------------------------------------------------------
 * Set DEFAULT_COUNTRY_CODE to your country's calling code (no +)
 * so that local numbers stored without it still resolve.
 *   India: '91'   USA/Canada: '1'   UK: '44'   UAE: '971'
 * Leave it '' to disable and require full international numbers.
 * ------------------------------------------------------------ */
const DEFAULT_COUNTRY_CODE = process.env.COUNTRY_CODE || ''; // e.g. '91'

// Strip +, spaces, dashes, brackets — keep digits only — then
// normalize with the default country code when one is configured.
function sanitizeNumber(raw) {
  let digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!digits) return '';

  if (DEFAULT_COUNTRY_CODE) {
    digits = digits.replace(/^0+/, ''); // drop national trunk prefix, e.g. 0 in 098765...
    // Prepend the country code only when the number looks local (<= 10 digits).
    if (digits.length <= 10 && !digits.startsWith(DEFAULT_COUNTRY_CODE)) {
      digits = DEFAULT_COUNTRY_CODE + digits;
    }
  }
  return digits;
}

// Return { ok, chatId, digits, reason }. Never throws.
async function resolveChatId(raw) {
  const digits = sanitizeNumber(raw);
  if (!digits) return { ok: false, digits: '', reason: 'Empty or invalid number' };

  try {
    // Preferred: resolves the real WhatsApp id AND confirms registration.
    const numberId = await client.getNumberId(digits);
    if (numberId && numberId._serialized) {
      return { ok: true, chatId: numberId._serialized, digits };
    }

    // Fallback: build the standard chatId and re-check registration directly.
    const chatId = `${digits}@c.us`;
    const registered = await client.isRegisteredUser(chatId);
    if (registered) return { ok: true, chatId, digits };

    return { ok: false, digits, reason: 'Number is not registered on WhatsApp' };
  } catch (err) {
    return { ok: false, digits, reason: `Lookup failed: ${err.message}` };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function safeUnlink(p) {
  if (p && fs.existsSync(p)) fs.unlink(p, () => {});
}

/* ============================================================
 * 6. ROUTES
 * ============================================================ */
app.get('/api/status', (req, res) => {
  res.json({
    status: state.status,
    me: state.me,
    qr: state.qr,
    autoReplyEnabled,
    autoReplyRules,
    defaultReply,
    bulkJobRunning,
  });
});

app.post('/api/auto-reply', (req, res) => {
  const { enabled, rules, fallback } = req.body || {};

  if (typeof enabled === 'boolean') autoReplyEnabled = enabled;

  if (rules && typeof rules === 'object' && !Array.isArray(rules)) {
    for (const key of Object.keys(autoReplyRules)) delete autoReplyRules[key];
    for (const [k, v] of Object.entries(rules)) {
      if (typeof v === 'string') autoReplyRules[String(k).toLowerCase()] = v;
    }
  }

  if (typeof fallback === 'string' && fallback.trim()) defaultReply = fallback;

  const saved = saveAutoReply();
  log('info', `Auto-reply updated (enabled=${autoReplyEnabled})${saved ? ' and saved.' : '.'}`);
  io.emit('status', { status: state.status, me: state.me, autoReplyEnabled });
  res.json({ ok: true, autoReplyEnabled, autoReplyRules, defaultReply, saved });
});

app.post('/api/stop', (req, res) => {
  if (bulkJobRunning) {
    stopRequested = true;
    log('info', 'Stop requested — finishing the current message, then halting.');
  }
  res.json({ ok: true });
});

app.post('/api/logout', async (req, res) => {
  try {
    await client.logout();
    state.me = null;
    setStatus('disconnected');
    log('info', 'Logged out. Re-initializing for a fresh QR…');
    client.initialize().catch((e) => log('error', `Re-init failed: ${e.message}`));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Bulk send with optional media. Responds immediately, streams progress via Socket.IO.
app.post('/api/send-bulk', uploadBulkFields, async (req, res) => {
  const contactsFile = req.files && req.files.file ? req.files.file[0] : null;
  const mediaFile = req.files && req.files.media ? req.files.media[0] : null;

  const cleanup = () => {
    safeUnlink(contactsFile && contactsFile.path);
    safeUnlink(mediaFile && mediaFile.path);
  };

  try {
    if (state.status !== 'connected') {
      cleanup();
      return res.status(400).json({ ok: false, error: 'WhatsApp is not connected. Scan the QR code first.' });
    }
    if (bulkJobRunning) {
      cleanup();
      return res.status(409).json({ ok: false, error: 'A bulk job is already running.' });
    }
    if (!contactsFile) {
      cleanup();
      return res.status(400).json({ ok: false, error: 'Please upload a .xlsx or .csv contacts file.' });
    }

    const template = (req.body.template || '').trim();
    if (!template && !mediaFile) {
      cleanup();
      return res.status(400).json({ ok: false, error: 'Write a message or attach a media file (or both).' });
    }

    let minDelay = parseInt(req.body.minDelay, 10);
    let maxDelay = parseInt(req.body.maxDelay, 10);
    if (!Number.isFinite(minDelay) || minDelay < 5) minDelay = 12;
    if (!Number.isFinite(maxDelay) || maxDelay < minDelay) maxDelay = Math.max(minDelay, 25);

    const rows = await parseContactsFile(contactsFile.path);
    if (!rows.length) {
      cleanup();
      return res.status(400).json({ ok: false, error: 'The contacts file has no rows.' });
    }
    if (!getPhone(rows[0]) && !PHONE_KEYS.some((k) => k in rows[0])) {
      cleanup();
      return res.status(400).json({ ok: false, error: 'No phone column found. Add a column named "number" or "phone".' });
    }

    const mediaMeta = mediaFile
      ? { path: mediaFile.path, name: mediaFile.originalname }
      : null;

    res.json({
      ok: true,
      started: true,
      total: rows.length,
      minDelay,
      maxDelay,
      media: mediaMeta ? mediaMeta.name : null,
    });

    runBulkJob(rows, template, minDelay, maxDelay, mediaMeta).finally(cleanup);
  } catch (err) {
    cleanup();
    log('error', `Bulk send failed to start: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
  }
});

/* ---------------- Background bulk sender ---------------- */
async function runBulkJob(rows, template, minDelay, maxDelay, mediaMeta) {
  bulkJobRunning = true;
  stopRequested = false;

  let sent = 0;
  let failed = 0;
  const total = rows.length;

  // Load the media once (reused for every recipient).
  let media = null;
  if (mediaMeta) {
    try {
      media = MessageMedia.fromFilePath(mediaMeta.path);
      log('info', `Media attached: ${mediaMeta.name}`);
    } catch (e) {
      log('error', `Could not read media file: ${e.message}. Sending text only.`);
    }
  }

  io.emit('bulk:start', { total, minDelay, maxDelay, media: mediaMeta ? mediaMeta.name : null });
  log('info', `Bulk job started: ${total} contacts, delay ${minDelay}-${maxDelay}s.`);

  for (let i = 0; i < total; i++) {
    if (stopRequested) {
      log('info', 'Bulk job cancelled by user.');
      break;
    }
    if (state.status !== 'connected') {
      log('error', 'Connection lost — stopping bulk job.');
      break;
    }

    const row = rows[i];
    const rawPhone = getPhone(row);
    const name = row.name || row['full name'] || '';

    // 1) Sanitize + 2) verify the number is on WhatsApp, all without throwing.
    const resolved = await resolveChatId(rawPhone);
    if (!resolved.ok) {
      failed++;
      const shown = resolved.digits || rawPhone || '(blank)';
      io.emit('bulk:progress', { index: i + 1, total, name, to: shown, status: 'failed', reason: resolved.reason, sent, failed });
      log('error', `Skipped ${name || shown} (${shown}): ${resolved.reason}`);
      continue; // move on — one bad number never stops the job
    }

    // 3) resolved.chatId is already in the correct "number@c.us" format.
    try {
      const body = renderTemplate(template, row);

      if (media) {
        await client.sendMessage(resolved.chatId, media, { caption: body || '' });
      } else {
        await client.sendMessage(resolved.chatId, body);
      }

      sent++;
      io.emit('bulk:progress', { index: i + 1, total, name, to: resolved.digits, status: 'sent', sent, failed });
      log('success', `Sent to ${name || resolved.digits} (${resolved.digits})${media ? ' with media' : ''}.`);
    } catch (err) {
      failed++;
      io.emit('bulk:progress', { index: i + 1, total, name, to: resolved.digits, status: 'failed', reason: err.message, sent, failed });
      log('error', `Send failed for ${resolved.digits}: ${err.message}`);
    }

    const isLast = i === total - 1;
    if (!isLast && !stopRequested) {
      const wait = randomInt(minDelay, maxDelay);
      io.emit('bulk:waiting', { index: i + 1, total, seconds: wait });
      await sleep(wait * 1000);
    }
  }

  bulkJobRunning = false;
  stopRequested = false;
  io.emit('bulk:done', { total, sent, failed });
  log('success', `Bulk job finished. Sent: ${sent}, Failed: ${failed}.`);
}

/* ============================================================
 * 7. SOCKET.IO — push current state to newly connected clients
 * ============================================================ */
io.on('connection', (socket) => {
  socket.emit('status', { status: state.status, me: state.me, autoReplyEnabled });
  if (state.qr) socket.emit('qr', state.qr);
});

/* ============================================================
 * 8. START SERVER
 * ============================================================ */
server.listen(PORT, () => {
  console.log(`\n  WhatsApp Automation dashboard running at http://localhost:${PORT}\n`);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down…');
  try {
    await client.destroy();
  } catch (_) {}
  process.exit(0);
});