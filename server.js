'use strict';

// ─── Load env vars (Railway sets these automatically; locally use a .env file) ─
try { require('dotenv').config({ path: '.env' }); } catch(e) { /* dotenv optional on Railway */ }

const express    = require('express');
const bodyParser = require('body-parser');
const fs         = require('fs');
const path       = require('path');
const cron       = require('node-cron');
const twilio     = require('twilio');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Config ────────────────────────────────────────────────────────────────────
const API_KEY              = process.env.API_KEY || 'homebase-dev-key';
const TWILIO_ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM          = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const OWNER_WHATSAPP       = process.env.OWNER_WHATSAPP;    // e.g. whatsapp:+16135551234

// Gmail vendor auto-populate
const GMAIL_EMAIL          = process.env.GMAIL_EMAIL;       // e.g. home-mgmt@gmail.com
const GMAIL_APP_PASSWORD   = process.env.GMAIL_APP_PASSWORD;// 16-char Google App Password (no spaces)
const EMAIL_POLL_MINUTES   = parseInt(process.env.EMAIL_POLL_MINUTES || '15', 10);

// Data file — use Railway Volume path if /app/data exists, otherwise local dir
const DATA_DIR  = fs.existsSync('/app/data') ? '/app/data' : __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// Twilio client — only created if credentials are provided
const twilioClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(__dirname));   // serves homebase.html

// ─── Data helpers ──────────────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      // Ensure new fields exist (backwards-compatible upgrade)
      if (!d.vendors)        d.vendors = [];
      if (!d.pendingVendors) d.pendingVendors = [];
      if (!d.ignoredSenders) d.ignoredSenders = [];
      if (!d.emailState)     d.emailState = { processedUids: [], lastCheck: null };
      return d;
    }
  } catch (e) { console.error('loadData error:', e.message); }
  return {
    homes: [], bills: [], maint: [], events: [], systems: [], users: [], photos: {},
    vendors: [], pendingVendors: [], ignoredSenders: [],
    emailState: { processedUids: [], lastCheck: null }
  };
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) { console.error('saveData error:', e.message); }
}

// ─── API key guard ─────────────────────────────────────────────────────────────
function requireKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized — wrong API key' });
  next();
}

// ─── REST API ──────────────────────────────────────────────────────────────────

// Health check (no auth needed — Railway uses this)
app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Get all HomeBase data
app.get('/api/data', requireKey, (_req, res) => res.json(loadData()));

// Save all HomeBase data (the browser posts the full db object)
app.post('/api/data', requireKey, (req, res) => {
  const data = req.body;
  if (!data || !Array.isArray(data.homes)) return res.status(400).json({ error: 'Invalid data shape' });
  // Preserve server-side-only fields if the client didn't send them
  const existing = loadData();
  if (!data.pendingVendors) data.pendingVendors = existing.pendingVendors || [];
  if (!data.ignoredSenders) data.ignoredSenders = existing.ignoredSenders || [];
  if (!data.emailState)     data.emailState     = existing.emailState     || { processedUids: [], lastCheck: null };
  saveData(data);
  res.json({ ok: true });
});

// ─── WhatsApp webhook (Twilio posts here) ─────────────────────────────────────
app.post('/api/whatsapp', async (req, res) => {
  // Validate Twilio signature when credentials are set
  if (twilioClient) {
    const sig = req.headers['x-twilio-signature'] || '';
    const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    if (!twilio.validateRequest(TWILIO_AUTH_TOKEN, sig, url, req.body)) {
      return res.status(403).send('Forbidden');
    }
  }

  const incomingMsg = (req.body.Body || '').trim();
  const from        = req.body.From  || '';
  console.log(`[WhatsApp] From: ${from}  Msg: ${incomingMsg}`);

  const reply = processMessage(incomingMsg);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

// ─── Natural-language processor ───────────────────────────────────────────────

function processMessage(msg) {
  const q  = msg.toLowerCase().trim();
  const db = loadData();

  // ── date helpers ──
  const todayStr = () => new Date().toISOString().split('T')[0];
  const addD = (s, n) => {
    const d = new Date(s + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toISOString().split('T')[0];
  };
  const ddays = s => {
    if (!s) return 9999;
    const d = new Date(s + 'T00:00:00'), now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.round((d - now) / 86400000);
  };
  const dshort = s => {
    if (!s) return '–';
    return new Date(s + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const FREQS = [
    { v: 'weekly', d: 7 }, { v: 'biweekly', d: 14 }, { v: 'monthly', d: 30 },
    { v: 'bimonthly', d: 60 }, { v: 'quarterly', d: 91 }, { v: 'semiannual', d: 182 },
    { v: 'annual', d: 365 }, { v: 'oneoff', d: null }
  ];
  const nextDue = (last, fv) => {
    if (!last || !fv) return null;
    const f = FREQS.find(x => x.v === fv);
    return (f && f.d) ? addD(last, f.d) : null;
  };
  const calcNext = (item, isBill) => isBill
    ? item.nextDue || nextDue(item.lastPaid || item.startDate, item.frequency)
    : item.nextDue || nextDue(item.lastDone, item.frequency);
  const paidThisPeriod = b => {
    if (!b.lastPaid) return false;
    const nd = calcNext(b, true);
    if (!nd) return false;
    const f = FREQS.find(x => x.v === b.frequency);
    if (!f || !f.d) return false;
    return b.lastPaid >= addD(nd, -f.d) && b.lastPaid <= todayStr();
  };
  const ghn = id => { const h = db.homes.find(h => h.id === id); return h ? h.name : 'Unknown'; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).substr(2, 5);

  // ── VENDOR CONFIRMATION — bare number reply when a pending vendor exists ──
  // Example prompts the server sends assign: 1=first home, 2=second, … N=all homes, 0=skip
  if (/^\d{1,2}$/.test(q) && db.pendingVendors && db.pendingVendors.length > 0) {
    const choice  = parseInt(q, 10);
    const pending = db.pendingVendors[0];
    const homes   = db.homes;

    if (choice === 0) {
      // Skip — add to ignored list so we don't re-prompt
      if (!db.ignoredSenders.includes(pending.email.toLowerCase())) {
        db.ignoredSenders.push(pending.email.toLowerCase());
      }
      db.pendingVendors.shift();
      saveData(db);
      const next = db.pendingVendors[0];
      let r = `⏭️ Skipped *${pending.name || pending.email}*. Won't ask again.`;
      if (next) r += '\n\n' + vendorPromptText(next, homes);
      return r;
    }

    // Handle "all homes" choice (N+1 when there are multiple homes, or 2 when there's 1 home? No — see prompt text)
    const allIdx = homes.length + 1;
    let assignedHomeIds = [];

    if (choice === allIdx && homes.length > 1) {
      assignedHomeIds = homes.map(h => h.id);
    } else if (choice >= 1 && choice <= homes.length) {
      assignedHomeIds = [homes[choice - 1].id];
    } else {
      return `❌ That number isn't an option.\n\n${vendorPromptText(pending, homes)}`;
    }

    // Add to vendors list
    db.vendors.push({
      id: uid(),
      name: pending.name || pending.email.split('@')[0],
      email: pending.email,
      phone: '',
      category: guessCategory(pending.name, pending.email, pending.subject),
      homeIds: assignedHomeIds,
      rating: 0,
      notes: `Auto-added from email on ${todayStr()}. Subject: "${pending.subject || ''}"`,
      addedAt: new Date().toISOString()
    });
    db.pendingVendors.shift();
    saveData(db);

    const homeNames = assignedHomeIds.map(id => ghn(id)).join(', ');
    let r = `✅ Added *${pending.name || pending.email}* to ${homeNames}.\nOpen the app to set category/phone/rating.`;
    const next = db.pendingVendors[0];
    if (next) r += '\n\n' + vendorPromptText(next, homes);
    return r;
  }

  // ── VPENDING command — see what vendors are waiting ──
  if (/^vpending$|^pending$|^pending vendors?$/.test(q)) {
    if (!db.pendingVendors.length) return '✅ No vendors waiting for review.';
    let r = `📧 *${db.pendingVendors.length} vendor(s) pending:*\n\n`;
    db.pendingVendors.forEach((p, i) => {
      r += `${i + 1}. ${p.name || '(no name)'} — ${p.email}\n`;
    });
    r += '\n' + vendorPromptText(db.pendingVendors[0], db.homes);
    return r;
  }

  // ── VENDORS command — list current vendors ──
  if (/^vendors?$/.test(q)) {
    if (!db.vendors.length) return '📇 No vendors yet. They\'ll be added automatically when you forward or receive emails to your home-management address.';
    let r = `📇 *Your Vendors (${db.vendors.length}):*\n\n`;
    db.vendors.slice(0, 15).forEach((v, i) => {
      const homes = (v.homeIds || []).map(ghn).join(', ') || '—';
      r += `${i + 1}. *${v.name}* (${v.category || 'Other'}) — ${homes}\n   ${v.email || v.phone || ''}\n`;
    });
    if (db.vendors.length > 15) r += `\n_…and ${db.vendors.length - 15} more. Open the app to see all._`;
    return r;
  }

  // ── DONE command: "done [task name or number]" ──
  if (/^done\s+/i.test(msg)) {
    const query = msg.replace(/^done\s+/i, '').trim();
    const num   = parseInt(query);
    let task    = null;
    if (!isNaN(num) && num > 0) {
      const list = [
        ...db.maint.filter(m => ddays(calcNext(m, false)) < 0),
        ...db.maint.filter(m => { const d = ddays(calcNext(m, false)); return d >= 0 && d <= 30; })
      ];
      task = list[num - 1] || null;
    } else {
      task = db.maint.find(m => m.name.toLowerCase().includes(query.toLowerCase()));
    }
    if (!task) return `❌ Can't find a task matching "${query}"\nReply *tasks* to see your list.`;
    task.lastDone = todayStr();
    task.nextDue  = nextDue(task.lastDone, task.frequency);
    saveData(db);
    return `✅ *${task.name}* marked as done!\nNext due: ${task.nextDue ? dshort(task.nextDue) : 'N/A'}`;
  }

  // ── PAID command: "paid [bill name or number]" ──
  if (/^paid\s+/i.test(msg)) {
    const query = msg.replace(/^paid\s+/i, '').trim();
    const num   = parseInt(query);
    let bill    = null;
    if (!isNaN(num) && num > 0) {
      const list = [
        ...db.bills.filter(b => ddays(calcNext(b, true)) < 0 && !paidThisPeriod(b)),
        ...db.bills.filter(b => { const d = ddays(calcNext(b, true)); return d >= 0 && d <= 14 && !paidThisPeriod(b); })
      ];
      bill = list[num - 1] || null;
    } else {
      bill = db.bills.find(b => b.name.toLowerCase().includes(query.toLowerCase()));
    }
    if (!bill) return `❌ Can't find a bill matching "${query}"\nReply *bills* to see your list.`;
    bill.lastPaid = todayStr();
    bill.nextDue  = nextDue(bill.lastPaid, bill.frequency);
    saveData(db);
    return `✅ *${bill.name}* marked as paid!\nNext due: ${bill.nextDue ? dshort(bill.nextDue) : 'N/A'}`;
  }

  // ── ADD TASK: "add task [name] at [home]" ──
  if (/^add task\s+/i.test(msg)) {
    const rest      = msg.replace(/^add task\s+/i, '');
    const atIdx     = rest.toLowerCase().lastIndexOf(' at ');
    const name      = atIdx > -1 ? rest.slice(0, atIdx).trim() : rest.trim();
    const homePart  = atIdx > -1 ? rest.slice(atIdx + 4).trim() : '';
    const home      = db.homes.find(h => h.name.toLowerCase().includes(homePart.toLowerCase())) || db.homes[0];
    if (!home) return '❌ No homes found — add one in the app first.';
    db.maint.push({ id: uid(), name, homeId: home.id, category: 'Other', frequency: 'monthly', lastDone: '', nextDue: null, notes: '' });
    saveData(db);
    return `✅ Task *"${name}"* added to ${home.name}\nOpen the app to set the frequency and due date.`;
  }

  // ── ADD BILL: "add bill [name] at [home]" ──
  if (/^add bill\s+/i.test(msg)) {
    const rest      = msg.replace(/^add bill\s+/i, '');
    const atIdx     = rest.toLowerCase().lastIndexOf(' at ');
    const name      = atIdx > -1 ? rest.slice(0, atIdx).trim() : rest.trim();
    const homePart  = atIdx > -1 ? rest.slice(atIdx + 4).trim() : '';
    const home      = db.homes.find(h => h.name.toLowerCase().includes(homePart.toLowerCase())) || db.homes[0];
    if (!home) return '❌ No homes found — add one in the app first.';
    db.bills.push({ id: uid(), name, homeId: home.id, category: 'Other', frequency: 'monthly', amount: null, nextDue: null, lastPaid: null, notes: '' });
    saveData(db);
    return `✅ Bill *"${name}"* added to ${home.name}\nOpen the app to set the amount and due date.`;
  }

  // ── BILLS query ──
  if (/bill|payment|pay|due|owe|unpaid|overdue|mortgage|utilities/.test(q)) {
    const overdue = db.bills.filter(b => ddays(calcNext(b, true)) < 0 && !paidThisPeriod(b));
    const soon    = db.bills.filter(b => { const d = ddays(calcNext(b, true)); return d >= 0 && d <= 14 && !paidThisPeriod(b); });
    const paid    = db.bills.filter(b => paidThisPeriod(b));
    if (!overdue.length && !soon.length)
      return '✅ No bills overdue or due in the next 2 weeks. All caught up!\n\n' + (paid.length ? `Already paid: ${paid.map(b => b.name).join(', ')}` : '');
    let r = '💳 *Bills Update*\n\n';
    if (overdue.length) {
      r += `🔴 *Overdue (${overdue.length}):*\n`;
      overdue.forEach((b, i) => r += `${i + 1}. ${b.name} — ${ghn(b.homeId)}${b.amount ? ' ($' + parseFloat(b.amount).toFixed(2) + ')' : ''}\n`);
      r += '\n';
    }
    if (soon.length) {
      r += `🟠 *Due soon (${soon.length}):*\n`;
      soon.forEach((b, i) => r += `${i + 1}. ${b.name} — ${dshort(calcNext(b, true))} (${ghn(b.homeId)})\n`);
      r += '\n';
    }
    r += '_Reply "paid 1" or "paid [name]" to mark as paid_';
    return r.trim();
  }

  // ── MAINTENANCE query ──
  if (/maint|task|fix|service|repair|hvac|filter|gutter|season|inspection|todo/.test(q)) {
    const overdue = db.maint.filter(m => ddays(calcNext(m, false)) < 0);
    const soon    = db.maint.filter(m => { const d = ddays(calcNext(m, false)); return d >= 0 && d <= 30; });
    if (!overdue.length && !soon.length)
      return '✅ No maintenance tasks overdue or due in the next 30 days. All good!';
    let r = '🔧 *Maintenance Update*\n\n';
    if (overdue.length) {
      r += `🔴 *Overdue (${overdue.length}):*\n`;
      overdue.forEach((m, i) => r += `${i + 1}. ${m.name} — ${ghn(m.homeId)}\n`);
      r += '\n';
    }
    if (soon.length) {
      r += `🟡 *Due in 30 days (${soon.length}):*\n`;
      soon.forEach((m, i) => r += `${i + 1}. ${m.name} — ${dshort(calcNext(m, false))} (${ghn(m.homeId)})\n`);
      r += '\n';
    }
    r += '_Reply "done 1" or "done [name]" to mark as complete_';
    return r.trim();
  }

  // ── SUMMARY ──
  if (/summar|overview|status|report|all|everything/.test(q)) {
    const ob   = db.bills.filter(b => ddays(calcNext(b, true)) < 0 && !paidThisPeriod(b)).length;
    const db30 = db.bills.filter(b => { const d = ddays(calcNext(b, true)); return d >= 0 && d <= 30 && !paidThisPeriod(b); }).length;
    const ppd  = db.bills.filter(b => paidThisPeriod(b)).length;
    const om   = db.maint.filter(m => ddays(calcNext(m, false)) < 0).length;
    const mm30 = db.maint.filter(m => { const d = ddays(calcNext(m, false)); return d >= 0 && d <= 30; }).length;
    const ev7  = db.events.filter(e => e.date >= todayStr() && ddays(e.date) <= 7).length;
    const pend = db.pendingVendors.length;
    let r = `🏠 *HomeBase Summary*\n\n`;
    r += `🏠 *${db.homes.length} home${db.homes.length !== 1 ? 's' : ''}:* ${db.homes.map(h => h.name).join(', ')}\n\n`;
    r += `💳 *Bills:* ${ob ? ob + ' overdue 🔴, ' : ''}${db30} due in 30 days, ${ppd} paid ✅\n\n`;
    r += `🔧 *Maintenance:* ${om ? om + ' overdue 🔴, ' : ''}${mm30} due in 30 days\n\n`;
    r += `📅 *Events:* ${ev7} in the next 7 days\n\n`;
    r += `📇 *Vendors:* ${db.vendors.length}${pend ? `, ${pend} awaiting review 📧` : ''}\n\n`;
    r += (ob || om) ? `⚠️ *Action needed!* Reply "bills" or "tasks" for details.` : '✅ Everything looks good — nothing overdue!';
    if (pend) r += '\nReply *vpending* to review new vendors.';
    return r.trim();
  }

  // ── HELP ──
  if (/help|commands|what can/.test(q)) {
    return [
      '🏠 *Geronimo — HomeBase Commands*\n',
      '📊 *Check status:*',
      '• "summary" — full overview',
      '• "bills" — bills due',
      '• "tasks" — maintenance due',
      '• "vendors" — list your vendors',
      '• "vpending" — review new vendors from email\n',
      '✅ *Mark as done:*',
      '• "paid [name or #]" — mark bill paid',
      '• "done [name or #]" — mark task done\n',
      '➕ *Add items:*',
      '• "add task [name] at [home]"',
      '• "add bill [name] at [home]"\n',
      '💡 Tip: When a new vendor emails your home inbox, I\'ll ask you here. Just reply with a number.'
    ].join('\n');
  }

  // ── Default ──
  return [
    '👋 Hi! I\'m Geronimo, your HomeBase assistant.\n',
    'Try:',
    '• "summary" — see what needs attention',
    '• "bills" — check due payments',
    '• "tasks" — check maintenance',
    '• "vendors" — list your vendors',
    '• "help" — see all commands'
  ].join('\n');
}

// ─── Vendor prompt helper (used in processMessage + email poller) ─────────────

function vendorPromptText(pending, homes) {
  let r = `📧 *New vendor detected*\nName: ${pending.name || '(no name)'}\nEmail: ${pending.email}`;
  if (pending.subject) r += `\nSubject: "${pending.subject}"`;
  r += '\n\nAdd to which home?\n';
  homes.forEach((h, i) => { r += `${i + 1}) ${h.name}\n`; });
  if (homes.length > 1) r += `${homes.length + 1}) Both/all homes\n`;
  r += '0) Skip (don\'t ask again)\n\n_Reply with just the number_';
  return r;
}

function guessCategory(name, email, subject) {
  const text = [(name || ''), (email || ''), (subject || '')].join(' ').toLowerCase();
  const map = [
    ['plumb',        'Plumbing'],
    ['electric',     'Electrical'],
    ['hvac',         'HVAC'],
    ['heat|furnace|boiler|cooling|air cond', 'HVAC'],
    ['roof',         'Roofing'],
    ['landscap|lawn|garden|tree',    'Landscaping'],
    ['clean|maid',                   'Cleaning'],
    ['paint',                        'Painting'],
    ['pest|bug|exterminat|termite',  'Pest Control'],
    ['snow|plow',                    'Snow Removal'],
    ['pool|spa|hot tub',             'Pool'],
    ['appliance',                    'Appliance'],
    ['handyman|general contract',    'Handyman'],
    ['insur',                        'Insurance'],
    ['security|alarm',               'Security']
  ];
  for (const [pat, cat] of map) {
    if (new RegExp(pat).test(text)) return cat;
  }
  return 'Other';
}

// ─── Helper: send a WhatsApp message to the owner ─────────────────────────────

async function sendOwnerWhatsApp(body) {
  if (!twilioClient || !OWNER_WHATSAPP) {
    console.log('[WhatsApp out] Skipped — Twilio not configured.');
    return;
  }
  try {
    await twilioClient.messages.create({ body, from: TWILIO_FROM, to: OWNER_WHATSAPP });
    console.log('[WhatsApp out] Sent at', new Date().toISOString());
  } catch (e) {
    console.error('[WhatsApp out] Failed:', e.message);
  }
}

// ─── Gmail IMAP poller — finds new senders and queues them as pending vendors ─

let ImapFlow, simpleParser;
try {
  ImapFlow     = require('imapflow').ImapFlow;
  simpleParser = require('mailparser').simpleParser;
} catch (e) {
  console.log('[Gmail] imapflow/mailparser not installed — email polling disabled.');
}

async function pollGmail() {
  if (!GMAIL_EMAIL || !GMAIL_APP_PASSWORD || !ImapFlow) {
    return; // silently skip when not configured
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: GMAIL_EMAIL, pass: GMAIL_APP_PASSWORD },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');

    try {
      const db = loadData();
      const processed = new Set(db.emailState.processedUids || []);
      const ignored   = new Set((db.ignoredSenders || []).map(s => s.toLowerCase()));
      const ownEmail  = GMAIL_EMAIL.toLowerCase();
      const existingVendorEmails = new Set(
        (db.vendors || []).map(v => (v.email || '').toLowerCase()).filter(Boolean)
      );
      const pendingEmails = new Set(
        (db.pendingVendors || []).map(p => p.email.toLowerCase())
      );

      // Fetch only recent-ish messages (last 14 days) to avoid ancient mail flood on first run
      const since = new Date(Date.now() - 14 * 86400 * 1000);
      const newPending = [];

      for await (const msg of client.fetch({ since }, { envelope: true, uid: true, source: false })) {
        const uidKey = String(msg.uid);
        if (processed.has(uidKey)) continue;

        const env = msg.envelope || {};
        const fromArr = env.from || [];
        const sender  = fromArr[0] || {};
        const emailAddr = (sender.address || '').toLowerCase();

        // Always mark as processed so we don't re-scan
        processed.add(uidKey);

        if (!emailAddr)                        continue;
        if (emailAddr === ownEmail)            continue;  // ignore messages we sent
        if (ignored.has(emailAddr))            continue;
        if (existingVendorEmails.has(emailAddr)) continue;
        if (pendingEmails.has(emailAddr))      continue;

        // Skip obvious non-vendor senders
        if (/no-?reply|do-?not-?reply|mailer-daemon|postmaster/.test(emailAddr)) {
          ignored.add(emailAddr);
          continue;
        }

        const pending = {
          id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
          name:    sender.name || '',
          email:   sender.address,
          subject: env.subject || '',
          detectedAt: new Date().toISOString()
        };
        newPending.push(pending);
        pendingEmails.add(emailAddr);
      }

      // Cap processed UID list to last 500 to keep data.json small
      const processedArr = Array.from(processed).slice(-500);

      db.emailState = { processedUids: processedArr, lastCheck: new Date().toISOString() };
      db.ignoredSenders = Array.from(ignored);
      if (newPending.length) {
        db.pendingVendors = (db.pendingVendors || []).concat(newPending);
      }
      saveData(db);

      // If we just added new pending AND nothing was pending before, prompt the owner now
      if (newPending.length) {
        console.log(`[Gmail] Queued ${newPending.length} new vendor candidate(s).`);
        const firstInQueue = db.pendingVendors[0];
        // Only send a prompt if the newly queued batch contains the head of the queue
        // (i.e. there was nothing pending before this poll)
        if (newPending.find(p => p.id === firstInQueue.id)) {
          await sendOwnerWhatsApp(vendorPromptText(firstInQueue, db.homes));
        } else {
          // queued silently behind existing pending — tell the user count changed
          await sendOwnerWhatsApp(`📧 ${newPending.length} more vendor(s) arrived. Reply *vpending* after handling the current one.`);
        }
      }
    } finally {
      lock.release();
    }
  } catch (e) {
    console.error('[Gmail] Poll failed:', e.message);
  } finally {
    try { await client.logout(); } catch (e) { /* ignore */ }
  }
}

// ─── Daily reminder scheduler (runs at 9am every day) ─────────────────────────
cron.schedule('0 9 * * *', async () => {
  if (!twilioClient || !OWNER_WHATSAPP) {
    console.log('[Reminders] Skipped — Twilio not configured.');
    return;
  }

  const db      = loadData();
  const today   = new Date().toISOString().split('T')[0];
  const addD    = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().split('T')[0]; };
  const ddays   = s => { if (!s) return 9999; const d = new Date(s + 'T00:00:00'), now = new Date(); now.setHours(0,0,0,0); return Math.round((d-now)/86400000); };
  const dshort  = s => !s ? '–' : new Date(s+'T00:00:00').toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const FREQS   = [{v:'weekly',d:7},{v:'biweekly',d:14},{v:'monthly',d:30},{v:'bimonthly',d:60},{v:'quarterly',d:91},{v:'semiannual',d:182},{v:'annual',d:365},{v:'oneoff',d:null}];
  const nextDue = (last, fv) => { if (!last||!fv) return null; const f=FREQS.find(x=>x.v===fv); return (f&&f.d)?addD(last,f.d):null; };
  const calcNext= (item, isBill) => isBill ? item.nextDue||nextDue(item.lastPaid||item.startDate,item.frequency) : item.nextDue||nextDue(item.lastDone,item.frequency);
  const paidThisPeriod = b => {
    if (!b.lastPaid) return false;
    const nd = calcNext(b,true); if (!nd) return false;
    const f = FREQS.find(x=>x.v===b.frequency); if (!f||!f.d) return false;
    return b.lastPaid >= addD(nd,-f.d) && b.lastPaid <= today;
  };
  const ghn = id => { const h=db.homes.find(h=>h.id===id); return h?h.name:'Unknown'; };

  const overdueB = db.bills.filter(b => ddays(calcNext(b,true)) < 0 && !paidThisPeriod(b));
  const dueB3    = db.bills.filter(b => { const d=ddays(calcNext(b,true)); return d>=0&&d<=3&&!paidThisPeriod(b); });
  const overdueM = db.maint.filter(m => ddays(calcNext(m,false)) < 0);
  const dueM7    = db.maint.filter(m => { const d=ddays(calcNext(m,false)); return d>=0&&d<=7; });
  const pending  = (db.pendingVendors || []).length;

  // Only send if there's something to report
  if (!overdueB.length && !dueB3.length && !overdueM.length && !dueM7.length && !pending) {
    console.log('[Reminders] Nothing urgent today — no message sent.');
    return;
  }

  let msg = '🏠 *HomeBase Daily Reminder*\n\n';
  if (overdueB.length) msg += `🔴 *Overdue bills:*\n${overdueB.map((b,i)=>`${i+1}. ${b.name} — ${ghn(b.homeId)}`).join('\n')}\n\n`;
  if (dueB3.length)    msg += `🟠 *Bills due in 3 days:*\n${dueB3.map((b,i)=>`${i+1}. ${b.name} — ${dshort(calcNext(b,true))} (${ghn(b.homeId)})`).join('\n')}\n\n`;
  if (overdueM.length) msg += `🔴 *Overdue tasks:*\n${overdueM.map((m,i)=>`${i+1}. ${m.name} — ${ghn(m.homeId)}`).join('\n')}\n\n`;
  if (dueM7.length)    msg += `🟡 *Tasks due in 7 days:*\n${dueM7.map((m,i)=>`${i+1}. ${m.name} — ${dshort(calcNext(m,false))}`).join('\n')}\n\n`;
  if (pending)         msg += `📧 *${pending} new vendor(s) waiting.* Reply *vpending* to review.\n\n`;
  msg += '_Reply "summary" for full details_';

  await sendOwnerWhatsApp(msg);
});

// ─── Gmail poll schedule — every N minutes ────────────────────────────────────
if (GMAIL_EMAIL && GMAIL_APP_PASSWORD) {
  // Run once shortly after boot, then on interval
  setTimeout(() => { pollGmail().catch(e => console.error('[Gmail] boot poll error:', e.message)); }, 10_000);
  cron.schedule(`*/${EMAIL_POLL_MINUTES} * * * *`, () => {
    pollGmail().catch(e => console.error('[Gmail] cron poll error:', e.message));
  });
  console.log(`[Gmail] Polling ${GMAIL_EMAIL} every ${EMAIL_POLL_MINUTES} minutes.`);
}

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`HomeBase server running on port ${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
  console.log(`API key: ${API_KEY === 'homebase-dev-key' ? '⚠️  Using default key — set API_KEY in environment!' : '✅ Custom key set'}`);
  console.log(`Twilio: ${twilioClient ? '✅ Connected' : '⚠️  Not configured (set TWILIO_* env vars)'}`);
  console.log(`Reminders: ${OWNER_WHATSAPP ? '✅ Will send to ' + OWNER_WHATSAPP : '⚠️  Set OWNER_WHATSAPP to enable'}`);
  console.log(`Gmail: ${(GMAIL_EMAIL && GMAIL_APP_PASSWORD) ? '✅ ' + GMAIL_EMAIL : '⚠️  Not configured (set GMAIL_EMAIL + GMAIL_APP_PASSWORD)'}`);
});
