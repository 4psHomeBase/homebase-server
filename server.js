'use strict';

// ─── Load env vars (Railway sets these automatically; locally use a .env file) ─
require('dotenv').config({ path: '.env' });

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
const DATA_FILE            = path.join(__dirname, 'data.json');

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
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) { console.error('loadData error:', e.message); }
  return { homes: [], bills: [], maint: [], events: [], systems: [], users: [], photos: {} };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
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
  saveData(data);
  res.json({ ok: true });
});

// ─── WhatsApp webhook (Twilio posts here) ─────────────────────────────────────
app.post('/api/whatsapp', (req, res) => {
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
// (mirrors the Geronimo logic in homebase.html, ported to Node)

function processMessage(msg) {
  const q  = msg.toLowerCase();
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
    let r = `🏠 *HomeBase Summary*\n\n`;
    r += `🏠 *${db.homes.length} home${db.homes.length !== 1 ? 's' : ''}:* ${db.homes.map(h => h.name).join(', ')}\n\n`;
    r += `💳 *Bills:* ${ob ? ob + ' overdue 🔴, ' : ''}${db30} due in 30 days, ${ppd} paid ✅\n\n`;
    r += `🔧 *Maintenance:* ${om ? om + ' overdue 🔴, ' : ''}${mm30} due in 30 days\n\n`;
    r += `📅 *Events:* ${ev7} in the next 7 days\n\n`;
    r += (ob || om) ? `⚠️ *Action needed!* Reply "bills" or "tasks" for details.` : '✅ Everything looks good — nothing overdue!';
    return r.trim();
  }

  // ── HELP ──
  if (/help|commands|what can/.test(q)) {
    return [
      '🏠 *Geronimo — HomeBase Commands*\n',
      '📊 *Check status:*',
      '• "summary" — full overview',
      '• "bills" — bills due',
      '• "tasks" — maintenance due\n',
      '✅ *Mark as done:*',
      '• "paid [name or #]" — mark bill paid',
      '• "done [name or #]" — mark task done\n',
      '➕ *Add items:*',
      '• "add task [name] at [home]"',
      '• "add bill [name] at [home]"\n',
      '💡 Tip: Reply "summary" to get started!'
    ].join('\n');
  }

  // ── Default ──
  return [
    '👋 Hi! I\'m Geronimo, your HomeBase assistant.\n',
    'Try:',
    '• "summary" — see what needs attention',
    '• "bills" — check due payments',
    '• "tasks" — check maintenance',
    '• "help" — see all commands'
  ].join('\n');
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

  // Only send if there's something to report
  if (!overdueB.length && !dueB3.length && !overdueM.length && !dueM7.length) {
    console.log('[Reminders] Nothing urgent today — no message sent.');
    return;
  }

  let msg = '🏠 *HomeBase Daily Reminder*\n\n';
  if (overdueB.length) msg += `🔴 *Overdue bills:*\n${overdueB.map((b,i)=>`${i+1}. ${b.name} — ${ghn(b.homeId)}`).join('\n')}\n\n`;
  if (dueB3.length)    msg += `🟠 *Bills due in 3 days:*\n${dueB3.map((b,i)=>`${i+1}. ${b.name} — ${dshort(calcNext(b,true))} (${ghn(b.homeId)})`).join('\n')}\n\n`;
  if (overdueM.length) msg += `🔴 *Overdue tasks:*\n${overdueM.map((m,i)=>`${i+1}. ${m.name} — ${ghn(m.homeId)}`).join('\n')}\n\n`;
  if (dueM7.length)    msg += `🟡 *Tasks due in 7 days:*\n${dueM7.map((m,i)=>`${i+1}. ${m.name} — ${dshort(calcNext(m,false))}`).join('\n')}\n\n`;
  msg += '_Reply "summary" for full details_';

  try {
    await twilioClient.messages.create({ body: msg, from: TWILIO_FROM, to: OWNER_WHATSAPP });
    console.log('[Reminders] Sent at', new Date().toISOString());
  } catch (e) {
    console.error('[Reminders] Failed:', e.message);
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`HomeBase server running on port ${PORT}`);
  console.log(`API key: ${API_KEY === 'homebase-dev-key' ? '⚠️  Using default key — set API_KEY in environment!' : '✅ Custom key set'}`);
  console.log(`Twilio: ${twilioClient ? '✅ Connected' : '⚠️  Not configured (set TWILIO_* env vars)'}`);
  console.log(`Reminders: ${OWNER_WHATSAPP ? '✅ Will send to ' + OWNER_WHATSAPP : '⚠️  Set OWNER_WHATSAPP to enable'}`);
});
