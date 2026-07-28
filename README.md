# WA Console — WhatsApp Business Automation

A ready-to-run Node.js + Express dashboard for WhatsApp automation:

- **Live QR login** streamed to the browser with a real-time connection indicator
- **Bulk messaging** from an uploaded `.xlsx` / `.csv` file with `{name}` (and any column) placeholders
- **Anti-ban random delay** (default 12–25 s, configurable) between every message
- **Customizable auto-reply bot** with keyword rules and a fallback reply

Built with `whatsapp-web.js`, `multer`, `xlsx`, `csv-parser`, `socket.io`, and Tailwind CSS.

---

## Folder structure

```
whatsapp-automation/
├── package.json
├── README.md
├── .gitignore
├── sample-contacts.csv        # example file you can upload to test
├── server/
│   └── index.js               # Express + WhatsApp backend (all logic)
├── public/
│   └── index.html             # Tailwind dashboard (single file)
└── uploads/                   # temp storage for uploaded files (auto-cleaned)
```

`.wwebjs_auth/` (your saved WhatsApp session) is created automatically on first login.

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start          # or: npm run dev  (auto-restart via nodemon)

# 3. Open the dashboard
#    http://localhost:3000
```

On first run, a QR code appears in the dashboard. On your phone open
**WhatsApp → Settings → Linked devices → Link a device** and scan it.
The status pill turns green once connected; the session is remembered for next time.

> **Requirements:** Node.js 18+. `whatsapp-web.js` runs a headless Chromium via
> Puppeteer, so the first `npm install` downloads a browser. On minimal Linux
> servers you may need system libraries (e.g. `libnss3`, `libatk1.0-0`,
> `libgbm1`); on Debian/Ubuntu: `sudo apt-get install -y chromium-browser` and
> the usual Puppeteer dependencies.

---

## Contacts file format

The uploaded file needs a phone column named one of:
`number`, `phone`, `mobile`, `contact`, `whatsapp`, or `msisdn`.
Any other column becomes a template placeholder.

| name        | number        |
|-------------|---------------|
| Aarav Sharma| 919876543210  |
| Priya Patel | 919812345678  |

- Include the **country code** with no `+`, spaces, or dashes needed
  (they are stripped automatically — `+91 98765-43210` works too).
- In Excel, format the phone column as **Text** so long numbers keep every digit.
- A template of `Hi {name}, your code is {code}` pulls from the `name` and `code`
  columns for each row.

`sample-contacts.csv` is included so you can try it immediately. **Only send to
people who have agreed to hear from you** — bulk-messaging strangers gets numbers
banned regardless of delays.

---

## Customizing the auto-reply bot

Edit the `autoReplyRules` object near the top of **`server/index.js`**:

```js
const autoReplyRules = {
  hi:    'Hello! 👋 Reply "menu" to see options.',
  menu:  '1) Products  2) Pricing  3) Support',
  price: '💰 Plans start at $9/month.',
};
let defaultReply = 'Thanks! We will reply soon.';
```

Keywords are matched as **whole words**, case-insensitively; the first match wins.
Anything with no keyword match gets `defaultReply`. You can also edit the rules
and toggle the bot live from the dashboard (the **Auto-reply bot** card) without
restarting — those changes last until the server restarts, after which the code
values apply again.

---

## How the anti-ban delay works

After each message, the server pauses a **random** number of seconds between your
Min and Max delay before sending the next one (default 12–25 s, with a hard floor
of 5 s). The countdown is shown live in the dashboard. Randomized, human-like
spacing is what protects the account — sending hundreds of messages back-to-back
is the fastest way to a ban.

---

## API reference (for reference / integration)

| Method | Route              | Purpose                                             |
|--------|--------------------|-----------------------------------------------------|
| GET    | `/api/status`      | Connection state, session info, current QR, rules   |
| POST   | `/api/send-bulk`   | Multipart upload (`file`, `template`, delays)        |
| POST   | `/api/stop`        | Cancel the running bulk job                          |
| POST   | `/api/auto-reply`  | `{ enabled, rules, fallback }` — update the bot      |
| POST   | `/api/logout`      | Log out and clear the saved session                  |

Real-time events are pushed over Socket.IO: `status`, `qr`, `log`,
`bulk:start`, `bulk:progress`, `bulk:waiting`, `bulk:done`.

---

## Notes

- `whatsapp-web.js` is an unofficial library that automates WhatsApp Web. It is
  not affiliated with or endorsed by WhatsApp. Use it in line with WhatsApp's
  Terms of Service; for high-volume or commercial sending, the official
  **WhatsApp Business Platform (Cloud API)** is the compliant route.
- If the QR ever stops loading after a WhatsApp Web update, update the library:
  `npm install whatsapp-web.js@latest`.
