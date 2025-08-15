/**
 * n8n WhatsApp Conversations Dashboard (single-file server + UI)
 * --------------------------------------------------------------
 * What it does
 *  - Accepts HTTP POST webhooks from n8n for incoming WhatsApp messages and your outgoing replies
 *  - Groups chats by phone number and shows them live in a simple web dashboard
 *  - Lets an agent type a reply; the server forwards { phone, message } as JSON to a configurable webhook (e.g. an n8n Webhook trigger)
 *  - Real-time updates via Server-Sent Events (SSE) — no extra frontend build or libraries
 *
 * How to run
 *  1) Node.js 18+ required (uses global fetch)
 *  2) npm i express cors
 *  3) node n8n-whatsapp-dashboard.js
 *  4) Open http://localhost:3000 (or your deployed URL)
 *
 * Environment variables (optional)
 *  - PORT: port to listen on (default 3000)
 *  - SEND_WEBHOOK_URL: default URL the dashboard will POST to when an agent sends a message
 *  - DASHBOARD_TOKEN: if set, all requests must include this token either via header X-Auth-Token or query ?token=...
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Optional shared token for very simple auth
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || null;
let SEND_WEBHOOK_URL = process.env.SEND_WEBHOOK_URL || '';

app.use(express.json({ limit: '1mb' }));
app.use(cors());

// --- Tiny auth middleware ---
function requireToken(req, res, next) {
  if (!DASHBOARD_TOKEN) return next(); // open mode
  const supplied = req.get('X-Auth-Token') || req.query.token;
  if (supplied === DASHBOARD_TOKEN) return next();
  res.status(401).send('Unauthorized');
}

// --- In-memory chat store ---
// chats: Map<phone, Array<{ body, direction: 'in'|'out'|'user', ts }>>
const chats = new Map();

function normalizePhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^\d+]/g, '');
}

function addMessage(phoneRaw, body, direction) {
  const phone = normalizePhone(phoneRaw);
  const msg = { body: String(body ?? ''), direction, ts: Date.now() };
  if (!chats.has(phone)) chats.set(phone, []);
  chats.get(phone).push(msg);
  broadcast('message', { phone, ...msg });
  return { phone, msg };
}

// --- SSE (Server-Sent Events) for live updates ---
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (_) {}
  }
}

app.get('/events', requireToken, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // for some proxies

  sseClients.add(res);

  // Send initial snapshot
  const snapshot = Object.fromEntries(chats.entries());
  res.write(`event: init\n` + `data: ${JSON.stringify({ chats: snapshot, sendWebhookUrl: SEND_WEBHOOK_URL })}\n\n`);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

// --- Webhook endpoints that n8n will call ---
// 1) Incoming message from WhatsApp trigger -> mark as direction 'in'
app.post('/webhook/incoming', requireToken, (req, res) => {
  const { phone, message, ts } = req.body || {};
  if (!phone || typeof message === 'undefined') {
    return res.status(400).json({ ok: false, error: 'Expected JSON: { phone, message }' });
  }
  const { phone: p } = addMessage(phone, message, 'in');
  return res.json({ ok: true, phone: p });
});

// 2) Outgoing message your automation sent -> mark as direction 'out'
app.post('/webhook/outgoing', requireToken, (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || typeof message === 'undefined') {
    return res.status(400).json({ ok: false, error: 'Expected JSON: { phone, message }' });
  }
  const { phone: p } = addMessage(phone, message, 'out');
  return res.json({ ok: true, phone: p });
});

// Optional: single generic endpoint if you prefer direction in payload
app.post('/webhook/message', requireToken, (req, res) => {
  const { phone, message, direction } = req.body || {};
  if (!phone || typeof message === 'undefined' || !['in', 'out'].includes(direction)) {
    return res.status(400).json({ ok: false, error: "Expected JSON: { phone, message, direction: 'in'|'out' }" });
  }
  const { phone: p } = addMessage(phone, message, direction);
  return res.json({ ok: true, phone: p });
});

// --- Settings for the agent-send webhook URL ---
app.get('/settings', requireToken, (req, res) => {
  res.json({ sendWebhookUrl: SEND_WEBHOOK_URL });
});

app.post('/settings/webhook', requireToken, (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'Provide { url } as a string.' });
  }
  SEND_WEBHOOK_URL = url.trim();
  broadcast('settings', { sendWebhookUrl: SEND_WEBHOOK_URL });
  res.json({ ok: true, sendWebhookUrl: SEND_WEBHOOK_URL });
});

// --- Agent sends a message from the dashboard ---
// This both (a) echoes into the chat immediately and (b) forwards JSON to the configured webhook
app.post('/send', requireToken, async (req, res) => {
  try {
    const { phone, message } = req.body || {};
    if (!phone || typeof message === 'undefined') {
      return res.status(400).json({ ok: false, error: 'Expected JSON: { phone, message }' });
    }
    if (!SEND_WEBHOOK_URL) {
      return res.status(400).json({ ok: false, error: 'No SEND_WEBHOOK_URL configured. Set it in the UI settings or env var.' });
    }

    // Show immediately in UI (direction 'user' to distinguish typed messages)
    const { phone: p } = addMessage(phone, message, 'user');

    // Forward to external automation
    const resp = await fetch(SEND_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(DASHBOARD_TOKEN ? { 'X-From-Dashboard': 'true' } : {}),
      },
      body: JSON.stringify({ phone: p, message }),
    });

    const text = await resp.text().catch(() => '');
    const ok = resp.ok;
    res.json({ ok, status: resp.status, response: text.slice(0, 1000) });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message || err) });
  }
});

// --- Minimal UI ---
app.get('/', requireToken, (req, res) => {
  const tokenQS = DASHBOARD_TOKEN ? `?token=${encodeURIComponent(req.query.token || '')}` : '';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>WhatsApp Chats Dashboard</title>
  <style>
    :root { --bg:#0f172a; --panel:#111827; --muted:#9ca3af; --in:#0ea5e9; --out:#22c55e; --user:#a78bfa; }
    *{ box-sizing:border-box; }
    body{ margin:0; font-family:system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, Helvetica, Arial, sans-serif; background:var(--bg); color:#e5e7eb; height:100vh; display:flex; }
    .sidebar{ width:320px; max-width:40vw; background:#0b1220; border-right:1px solid #1f2937; display:flex; flex-direction:column; }
    .sidebar header{ padding:12px; border-bottom:1px solid #1f2937; display:flex; gap:8px; align-items:center; }
    .search{ width:100%; padding:8px 10px; background:#0d1a2b; border:1px solid #1f2937; color:#e5e7eb; border-radius:8px; }
    .list{ overflow:auto; flex:1; }
    .item{ padding:12px; border-bottom:1px solid #1f2937; cursor:pointer; }
    .item.active{ background:#0d1a2b; }
    .phone{ font-weight:600; }
    .preview{ color:var(--muted); font-size:13px; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

    .main{ flex:1; display:flex; flex-direction:column; }
    .topbar{ padding:12px; border-bottom:1px solid #1f2937; display:flex; justify-content:space-between; align-items:center; }
    .chat{ flex:1; overflow:auto; padding:16px; display:flex; flex-direction:column; gap:10px; }
    .bubble{ max-width:70%; padding:10px 12px; border-radius:12px; line-height:1.3; white-space:pre-wrap; word-wrap:break-word; }
    .in{ background:rgba(14,165,233,.15); align-self:flex-start; border:1px solid rgba(14,165,233,.3); }
    .out{ background:rgba(34,197,94,.15); align-self:flex-end; border:1px solid rgba(34,197,94,.3); }
    .user{ background:rgba(167,139,250,.15); align-self:flex-end; border:1px solid rgba(167,139,250,.3); }
    .ts{ color:var(--muted); font-size:11px; margin-top:4px; }
    .composer{ display:flex; gap:8px; padding:12px; border-top:1px solid #1f2937; }
    .composer input{ flex:1; padding:10px; border-radius:8px; background:#0d1a2b; color:#e5e7eb; border:1px solid #1f2937; }
    .btn{ padding:10px 12px; border-radius:8px; background:#1f2937; color:#e5e7eb; border:1px solid #334155; cursor:pointer; }
    .btn:disabled{ opacity:.6; cursor:not-allowed; }
    .settings{ padding:12px; display:flex; gap:8px; align-items:center; }
    .settings input{ flex:1; padding:8px; border-radius:8px; background:#0d1a2b; color:#e5e7eb; border:1px solid #1f2937; }
    .token{ color:var(--muted); font-size:12px; }
  </style>
</head>
<body>
  <div class="sidebar">
    <header>
      <input id="search" class="search" placeholder="Search phone…" />
    </header>
    <div id="list" class="list"></div>
  </div>
  <div class="main">
    <div class="topbar">
      <div>
        <div id="title" style="font-weight:700">Select a chat</div>
        <div class="token">${DASHBOARD_TOKEN ? 'Token-protected' : 'Open access'}</div>
      </div>
      <div class="settings">
        <input id="hook" placeholder="Send Webhook URL (n8n webhook)" />
        <button class="btn" id="saveHook">Save</button>
      </div>
    </div>
    <div id="chat" class="chat"></div>
    <div class="composer">
      <input id="message" placeholder="Type a message…" />
      <button class="btn" id="send">Send</button>
    </div>
  </div>

  <script>
    const qs = new URLSearchParams(window.location.search);
    const token = qs.get('token') || '';
    const headers = token ? { 'X-Auth-Token': token, 'Content-Type':'application/json' } : { 'Content-Type': 'application/json' };

    let chats = {}; // { phone: [ { body, direction, ts }, ... ] }
    let selected = null;
    let sendWebhookUrl = '';

    const listEl = document.getElementById('list');
    const chatEl = document.getElementById('chat');
    const titleEl = document.getElementById('title');
    const hookEl = document.getElementById('hook');
    const searchEl = document.getElementById('search');

    function fmtTs(ts){
      const d = new Date(ts);
      return d.toLocaleString();
    }

    function renderList(){
      const q = (searchEl.value||'').toLowerCase();
      const phones = Object.keys(chats).sort((a,b)=>{
        const at = (chats[a].at(-1)?.ts)||0; const bt = (chats[b].at(-1)?.ts)||0; return bt-at;
      }).filter(p=>p.toLowerCase().includes(q));

      listEl.innerHTML = phones.map(p=>{
        const last = chats[p]?.at(-1);
        const preview = last ? last.body.replace(/\n/g,' ') : '';
        const active = p === selected ? 'item active' : 'item';
        return `<div class="${active}" data-phone="${p}">
          <div class="phone">${p}</div>
          <div class="preview">${preview}</div>
        </div>`;
      }).join('');
    }

    function renderChat(){
      chatEl.innerHTML = '';
      titleEl.textContent = selected ? selected : 'Select a chat';
      if (!selected) return;
      for (const m of (chats[selected] || [])){
        const div = document.createElement('div');
        div.className = 'bubble ' + (m.direction||'in');
        div.innerHTML = `${escapeHtml(m.body)}<div class="ts">${fmtTs(m.ts)}</div>`;
        chatEl.appendChild(div);
      }
      chatEl.scrollTop = chatEl.scrollHeight;
    }

    function escapeHtml(s){
      return String(s).replace(/[&<>\"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;','\'':'&#39;'}[m]));
    }

    listEl.addEventListener('click', (e)=>{
      const item = e.target.closest('.item');
      if (!item) return;
      selected = item.getAttribute('data-phone');
      renderList();
      renderChat();
    });

    document.getElementById('saveHook').onclick = async ()=>{
      const url = hookEl.value.trim();
      if (!url) { alert('Please enter a URL'); return; }
      const resp = await fetch('/settings/webhook' + (token ? `?token=${encodeURIComponent(token)}` : ''), {
        method:'POST', headers, body: JSON.stringify({ url })
      });
      const data = await resp.json().catch(()=>({}));
      if (data.ok) { alert('Saved'); } else { alert('Error: ' + (data.error||resp.status)); }
    };

    document.getElementById('send').onclick = async ()=>{
      if (!selected) { alert('Pick a chat first'); return; }
      const input = document.getElementById('message');
      const message = input.value.trim();
      if (!message) return;
      input.value = '';
      const resp = await fetch('/send' + (token ? `?token=${encodeURIComponent(token)}` : ''), {
        method:'POST', headers, body: JSON.stringify({ phone: selected, message })
      });
      const data = await resp.json().catch(()=>({}));
      if (!data.ok) alert('Send failed: ' + (data.error || data.response || data.status));
    };

    searchEl.addEventListener('input', renderList);

    async function refreshSettings(){
      const resp = await fetch('/settings' + (token ? `?token=${encodeURIComponent(token)}` : ''), { headers: token ? { 'X-Auth-Token': token } : {} });
      const data = await resp.json().catch(()=>({}));
      sendWebhookUrl = data.sendWebhookUrl || '';
      hookEl.value = sendWebhookUrl;
    }

    // Open SSE stream
    const es = new EventSource('/events' + (token ? `?token=${encodeURIComponent(token)}` : ''));
    es.addEventListener('init', (ev)=>{
      try {
        const payload = JSON.parse(ev.data);
        chats = payload.chats || {};
        sendWebhookUrl = payload.sendWebhookUrl || '';
        hookEl.value = sendWebhookUrl;
        renderList();
        renderChat();
      } catch {}
    });
    es.addEventListener('message', (ev)=>{
      try {
        const { phone, body, direction, ts } = JSON.parse(ev.data);
        if (!chats[phone]) chats[phone] = [];
        chats[phone].push({ body, direction, ts });
        if (!selected) selected = phone;
        renderList();
        if (selected === phone) renderChat();
      } catch {}
    });
    es.addEventListener('settings', (ev)=>{
      try {
        const { sendWebhookUrl: u } = JSON.parse(ev.data);
        sendWebhookUrl = u || '';
        hookEl.value = sendWebhookUrl;
      } catch {}
    });

    refreshSettings();
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`n8n WhatsApp Dashboard listening on http://localhost:${PORT}`);
});
