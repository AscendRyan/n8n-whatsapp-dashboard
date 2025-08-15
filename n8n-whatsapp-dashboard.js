/**
 * n8n WhatsApp Conversations Dashboard (single-file server + UI)
 * --------------------------------------------------------------
 * - Live dashboard grouped by phone number
 * - Two configurable webhooks:
 *    1) MESSAGE_WEBHOOK_URL: POST { phone, message } when an agent clicks "Send"
 *    2) ACTION_WEBHOOK_URL:  POST { phone } when an agent clicks "Send Phone"
 * - NEW: "Stop" button -> server posts { stop: "yes" } to MESSAGE_WEBHOOK_URL
 * - UI displays two copy-ready endpoints for your n8n HTTP Request nodes:
 *    - /webhook/incoming  (POST { phone, message })
 *    - /webhook/outgoing  (POST { phone, message })
 *
 * Env vars (optional)
 *  - PORT
 *  - DASHBOARD_TOKEN          // if set, require ?token=... or header X-Auth-Token
 *  - SEND_WEBHOOK_URL         // prefill Message Webhook (kept for compatibility)
 *  - ACTION_WEBHOOK_URL       // prefill Phone Button Webhook
 *
 * Run locally:
 *   npm i express cors
 *   node n8n-whatsapp-dashboard.js
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || null;
let MESSAGE_WEBHOOK_URL = process.env.SEND_WEBHOOK_URL || '';   // agent-typed message webhook
let ACTION_WEBHOOK_URL  = process.env.ACTION_WEBHOOK_URL || ''; // phone-button webhook

app.use(express.json({ limit: '1mb' }));
app.use(cors());

// --- Auth middleware (simple shared token) ---
function requireToken(req, res, next) {
  if (!DASHBOARD_TOKEN) return next(); // open mode
  const supplied = req.get('X-Auth-Token') || req.query.token;
  if (supplied === DASHBOARD_TOKEN) return next();
  res.status(401).send('Unauthorized');
}

// --- In-memory chat store ---
const chats = new Map(); // Map<phone, Array<{ body, direction: 'in'|'out'|'user', ts }>>

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

// --- SSE for live updates ---
const sseClients = new Set();
function broadcast(event, data) {
  const payload = 'event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n';
  for (const res of sseClients) { try { res.write(payload); } catch (_) {} }
}

app.get('/events', requireToken, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  sseClients.add(res);

  // Initial snapshot + settings
  const snapshot = Object.fromEntries(chats.entries());
  const settings = buildSettingsPayload(req);
  res.write('event: init\n' + 'data: ' + JSON.stringify({ chats: snapshot, ...settings }) + '\n\n');

  req.on('close', () => sseClients.delete(res));
});

// Build absolute endpoint URLs (and include token in QS if present on this request)
function buildSettingsPayload(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers['host'] || ('localhost:' + PORT);
  const base  = proto + '://' + host;

  const tokenFromQS = req.query && req.query.token ? String(req.query.token) : '';
  const tokenQS = (DASHBOARD_TOKEN && tokenFromQS) ? ('?token=' + encodeURIComponent(tokenFromQS)) : '';

  return {
    messageWebhookUrl: MESSAGE_WEBHOOK_URL,
    actionWebhookUrl: ACTION_WEBHOOK_URL,
    incomingEndpoint: base + '/webhook/incoming' + (tokenQS || ''),
    outgoingEndpoint: base + '/webhook/outgoing' + (tokenQS || ''),
    tokenRequired: !!DASHBOARD_TOKEN
  };
}

// --- Webhooks from n8n (to display in dashboard) ---
app.post('/webhook/incoming', requireToken, (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || typeof message === 'undefined') {
    return res.status(400).json({ ok: false, error: 'Expected JSON: { phone, message }' });
  }
  const { phone: p } = addMessage(phone, message, 'in');
  res.json({ ok: true, phone: p });
});

app.post('/webhook/outgoing', requireToken, (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || typeof message === 'undefined') {
    return res.status(400).json({ ok: false, error: 'Expected JSON: { phone, message }' });
  }
  const { phone: p } = addMessage(phone, message, 'out');
  res.json({ ok: true, phone: p });
});

// Optional single generic endpoint
app.post('/webhook/message', requireToken, (req, res) => {
  const { phone, message, direction } = req.body || {};
  if (!phone || typeof message === 'undefined' || !['in','out'].includes(direction)) {
    return res.status(400).json({ ok: false, error: "Expected JSON: { phone, message, direction: 'in'|'out' }" });
  }
  const { phone: p } = addMessage(phone, message, direction);
  res.json({ ok: true, phone: p });
});

// --- Settings (get/set both webhooks) ---
app.get('/settings', requireToken, (req, res) => {
  res.json(buildSettingsPayload(req));
});

app.post('/settings/webhooks', requireToken, (req, res) => {
  const { messageWebhookUrl, actionWebhookUrl } = req.body || {};
  if (typeof messageWebhookUrl !== 'string' || typeof actionWebhookUrl !== 'string') {
    return res.status(400).json({ ok: false, error: 'Provide both { messageWebhookUrl, actionWebhookUrl } as strings.' });
  }
  MESSAGE_WEBHOOK_URL = messageWebhookUrl.trim();
  ACTION_WEBHOOK_URL  = actionWebhookUrl.trim();
  broadcast('settings', { messageWebhookUrl: MESSAGE_WEBHOOK_URL, actionWebhookUrl: ACTION_WEBHOOK_URL });
  res.json({ ok: true, messageWebhookUrl: MESSAGE_WEBHOOK_URL, actionWebhookUrl: ACTION_WEBHOOK_URL });
});

// Back-compat: legacy single setter (sets message webhook)
app.post('/settings/webhook', requireToken, (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'Provide { url } as a string.' });
  }
  MESSAGE_WEBHOOK_URL = url.trim();
  broadcast('settings', { messageWebhookUrl: MESSAGE_WEBHOOK_URL });
  res.json({ ok: true, messageWebhookUrl: MESSAGE_WEBHOOK_URL });
});

// --- Agent actions ---
// 1) Send a message -> forwards { phone, message } to MESSAGE_WEBHOOK_URL
app.post('/send', requireToken, async (req, res) => {
  try {
    const { phone, message } = req.body || {};
    if (!phone || typeof message === 'undefined') {
      return res.status(400).json({ ok: false, error: 'Expected JSON: { phone, message }' });
    }
    if (!MESSAGE_WEBHOOK_URL) {
      return res.status(400).json({ ok: false, error: 'No Message Webhook configured. Set it in Settings.' });
    }
    const { phone: p } = addMessage(phone, message, 'user');
    const resp = await fetch(MESSAGE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(DASHBOARD_TOKEN ? { 'X-From-Dashboard': 'true' } : {}) },
      body: JSON.stringify({ phone: p, message })
    });
    const text = await resp.text().catch(() => '');
    res.json({ ok: resp.ok, status: resp.status, response: text.slice(0, 1000) });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
});

// 2) Send the phone only -> forwards { phone } to ACTION_WEBHOOK_URL
app.post('/action', requireToken, async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ ok: false, error: 'Expected JSON: { phone }' });
    if (!ACTION_WEBHOOK_URL) {
      return res.status(400).json({ ok: false, error: 'No Phone Button Webhook configured. Set it in Settings.' });
    }
    const resp = await fetch(ACTION_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(DASHBOARD_TOKEN ? { 'X-From-Dashboard': 'true' } : {}) },
      body: JSON.stringify({ phone: normalizePhone(phone) })
    });
    const text = await resp.text().catch(() => '');
    res.json({ ok: resp.ok, status: resp.status, response: text.slice(0, 1000) });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
});

// 3) NEW: "Stop" action -> forwards { stop: "yes" } to MESSAGE_WEBHOOK_URL
app.post('/stop', requireToken, async (req, res) => {
  try {
    if (!MESSAGE_WEBHOOK_URL) {
      return res.status(400).json({ ok: false, error: 'No Message Webhook configured. Set it in Settings.' });
    }
    const resp = await fetch(MESSAGE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(DASHBOARD_TOKEN ? { 'X-From-Dashboard': 'true' } : {}) },
      body: JSON.stringify({ stop: 'yes' })
    });
    const text = await resp.text().catch(() => '');
    res.json({ ok: resp.ok, status: resp.status, response: text.slice(0, 1000) });
  } catch (err) {
    res.status(500).json({ ok: false, error: String((err && err.message) || err) });
  }
});

// --- UI (script avoids inner backticks; uses classic strings only) ---
app.get('/', requireToken, (req, res) => {
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
    body{ margin:0; font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,Helvetica,Arial,sans-serif; background:var(--bg); color:#e5e7eb; height:100vh; display:flex; }
    .sidebar{ width:320px; max-width:40vw; background:#0b1220; border-right:1px solid #1f2937; display:flex; flex-direction:column; }
    .sidebar header{ padding:12px; border-bottom:1px solid #1f2937; display:flex; gap:8px; align-items:center; }
    .search{ width:100%; padding:8px 10px; background:#0d1a2b; border:1px solid #1f2937; color:#e5e7eb; border-radius:8px; }
    .list{ overflow:auto; flex:1; }
    .item{ padding:12px; border-bottom:1px solid #1f2937; cursor:pointer; }
    .item.active{ background:#0d1a2b; }
    .phone{ font-weight:600; }
    .preview{ color:var(--muted); font-size:13px; margin-top:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

    .main{ flex:1; display:flex; flex-direction:column; }
    .topbar{ padding:12px; border-bottom:1px solid #1f2937; display:flex; justify-content:space-between; align-items:center; gap:12px; }
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
    .settings{ display:flex; gap:8px; align-items:center; }
    .settings input{ flex:1; padding:8px; border-radius:8px; background:#0d1a2b; color:#e5e7eb; border:1px solid #1f2937; }
    .settings-grid{ display:grid; grid-template-columns:1fr 1fr auto; gap:8px; width:min(1024px, 100%); }
    .token{ color:var(--muted); font-size:12px; }
    .endpoints{ font-size:12px; color:#cbd5e1; display:grid; grid-template-columns:1fr auto; gap:6px; margin-top:8px; }
    .endpoints input{ width:100%; padding:6px; background:#0d1a2b; border:1px solid #1f2937; border-radius:6px; color:#e5e7eb; }
    .copy{ padding:6px 8px; }
    .row{ display:flex; flex-direction:column; gap:8px; }
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

      <div class="row" style="flex:1">
        <div class="settings-grid">
          <input id="hookMessage" placeholder="Message Webhook URL (receives {phone, message})" />
          <input id="hookAction"  placeholder="Phone Button Webhook URL (receives {phone})" />
          <button class="btn" id="saveHooks">Save</button>
        </div>
        <div class="endpoints" id="eps">
          <input id="incomingEp" readonly title="Incoming endpoint (POST { phone, message })" />
          <button class="btn copy" data-copy="incomingEp">Copy</button>
          <input id="outgoingEp" readonly title="Outgoing endpoint (POST { phone, message })" />
          <button class="btn copy" data-copy="outgoingEp">Copy</button>
        </div>
      </div>
    </div>

    <div id="chat" class="chat"></div>

    <div class="composer">
      <input id="message" placeholder="Type a message…" />
      <button class="btn" id="send">Send</button>
      <button class="btn" id="sendPhone">Send Phone</button>
      <button class="btn" id="stopBtn">Stop</button>
    </div>
  </div>

  <script>
    // (No backticks here — safe to embed inside server template literal)
    var qs = new URLSearchParams(window.location.search);
    var token = qs.get('token') || '';
    var headers = token ? { 'X-Auth-Token': token, 'Content-Type':'application/json' } : { 'Content-Type': 'application/json' };

    var chats = {};   // { phone: [ { body, direction, ts }, ... ] }
    var selected = null;

    var listEl = document.getElementById('list');
    var chatEl = document.getElementById('chat');
    var titleEl = document.getElementById('title');
    var searchEl = document.getElementById('search');

    var hookMessageEl = document.getElementById('hookMessage');
    var hookActionEl  = document.getElementById('hookAction');
    var incomingEpEl  = document.getElementById('incomingEp');
    var outgoingEpEl  = document.getElementById('outgoingEp');

    // Show defaults immediately (so boxes are never empty)
    var origin = window.location.origin;
    var defaultIncoming = origin + '/webhook/incoming' + (token ? ('?token=' + encodeURIComponent(token)) : '');
    var defaultOutgoing = origin + '/webhook/outgoing' + (token ? ('?token=' + encodeURIComponent(token)) : '');
    incomingEpEl.value = defaultIncoming;
    outgoingEpEl.value = defaultOutgoing;

    function fmtTs(ts){ var d = new Date(ts); return d.toLocaleString(); }
    function escapeHtml(s){
    return String(s).replace(/[&<>"']/g, function(m) {
    return {
    "&": "&amp;",
    "<": "&lt;",
    '"': "&quot;",
    "'": "&#39;"
    }[m];
    });
    }

    function renderList(){
      var q = (searchEl.value||'').toLowerCase();
      var phones = Object.keys(chats).sort(function(a,b){
        var aArr = chats[a]||[], bArr = chats[b]||[];
        var at = aArr.length ? aArr[aArr.length-1].ts : 0;
        var bt = bArr.length ? bArr[bArr.length-1].ts : 0;
        return bt - at;
      }).filter(function(p){ return p.toLowerCase().includes(q); });

      var html = phones.map(function(p){
        var arr = chats[p]||[];
        var last = arr.length ? arr[arr.length-1] : null;
        var preview = last ? String(last.body).replace(/\\n/g,' ') : '';
        var active = (p === selected) ? 'item active' : 'item';
        return '<div class="' + active + '" data-phone="' + p + '">' +
               '  <div class="phone">' + p + '</div>' +
               '  <div class="preview">' + preview + '</div>' +
               '</div>';
      }).join('');
      listEl.innerHTML = html;
    }

    function renderChat(){
      chatEl.innerHTML = '';
      titleEl.textContent = selected ? selected : 'Select a chat';
      if (!selected) return;
      var arr = chats[selected] || [];
      for (var i=0;i<arr.length;i++){
        var m = arr[i];
        var div = document.createElement('div');
        div.className = 'bubble ' + (m.direction||'in');
        div.innerHTML = escapeHtml(m.body) + '<div class="ts">' + fmtTs(m.ts) + '</div>';
        chatEl.appendChild(div);
      }
      chatEl.scrollTop = chatEl.scrollHeight;
    }

    listEl.addEventListener('click', function(e){
      var item = e.target.closest('.item');
      if (!item) return;
      selected = item.getAttribute('data-phone');
      renderList(); renderChat();
    });

    document.getElementById('saveHooks').onclick = function(){
      var msgUrl = (hookMessageEl.value||'').trim();
      var actUrl = (hookActionEl.value||'').trim();
      if (!msgUrl || !actUrl) { alert('Please fill both webhook URLs.'); return; }
      fetch('/settings/webhooks' + (token ? ('?token=' + encodeURIComponent(token)) : ''), {
        method:'POST', headers: headers, body: JSON.stringify({ messageWebhookUrl: msgUrl, actionWebhookUrl: actUrl })
      }).then(function(r){ return r.json().catch(function(){ return {}; }); })
        .then(function(d){ if (d.ok) alert('Saved'); else alert('Error: ' + (d.error||'Unknown')); });
    };

    document.getElementById('send').onclick = function(){
      if (!selected) { alert('Pick a chat first'); return; }
      var input = document.getElementById('message');
      var message = (input.value||'').trim();
      if (!message) return;
      input.value = '';
      fetch('/send' + (token ? ('?token=' + encodeURIComponent(token)) : ''), {
        method:'POST', headers: headers, body: JSON.stringify({ phone: selected, message: message })
      }).then(function(r){ return r.json().catch(function(){ return {}; }); })
        .then(function(d){ if (!d.ok) alert('Send failed: ' + (d.error||d.response||d.status)); });
    };

    document.getElementById('sendPhone').onclick = function(){
      if (!selected) { alert('Pick a chat first'); return; }
      fetch('/action' + (token ? ('?token=' + encodeURIComponent(token)) : ''), {
        method:'POST', headers: headers, body: JSON.stringify({ phone: selected })
      }).then(function(r){ return r.json().catch(function(){ return {}; }); })
        .then(function(d){ if (!d.ok) alert('Action failed: ' + (d.error||d.response||d.status)); });
    };

    // NEW: Stop button -> server proxies to MESSAGE_WEBHOOK_URL with { stop: "yes" }
    document.getElementById('stopBtn').onclick = function(){
      fetch('/stop' + (token ? ('?token=' + encodeURIComponent(token)) : ''), {
        method:'POST'
      }).then(function(r){ return r.json().catch(function(){ return {}; }); })
        .then(function(d){ if (!d.ok) alert('Stop failed: ' + (d.error||d.response||d.status)); else alert('Stop sent.'); });
    };

    document.getElementById('eps').addEventListener('click', function(e){
      var b = e.target.closest('button[data-copy]');
      if (!b) return;
      var id = b.getAttribute('data-copy');
      var inp = document.getElementById(id);
      inp.select(); inp.setSelectionRange(0, 99999);
      try { document.execCommand('copy'); } catch(_){}
      b.textContent = 'Copied';
      setTimeout(function(){ b.textContent = 'Copy'; }, 800);
    });

    // Fill settings/endpoints from server when available
    function applySettings(payload){
      if (!payload) return;
      if (typeof payload.messageWebhookUrl === 'string') hookMessageEl.value = payload.messageWebhookUrl;
      if (typeof payload.actionWebhookUrl === 'string')  hookActionEl.value  = payload.actionWebhookUrl;

      // Use server-provided endpoints if present; defaults already filled
      if (typeof payload.incomingEndpoint === 'string')  incomingEpEl.value = payload.incomingEndpoint;
      if (typeof payload.outgoingEndpoint === 'string')  outgoingEpEl.value = payload.outgoingEndpoint;
    }

    // Open SSE
    var es = new EventSource('/events' + (token ? ('?token=' + encodeURIComponent(token)) : ''));
    es.addEventListener('init', function(ev){
      try {
        var data = JSON.parse(ev.data);
        chats = data.chats || {};
        applySettings(data);
        renderList(); renderChat();
      } catch(e){}
    });
    es.addEventListener('message', function(ev){
      try {
        var obj = JSON.parse(ev.data);
        var phone = obj.phone, body = obj.body, direction = obj.direction, ts = obj.ts;
        if (!chats[phone]) chats[phone] = [];
        chats[phone].push({ body: body, direction: direction, ts: ts });
        if (!selected) selected = phone;
        renderList(); if (selected === phone) renderChat();
      } catch(e){}
    });
    es.addEventListener('settings', function(ev){
      try { applySettings(JSON.parse(ev.data)); } catch(e){}
    });

    // Initial GET /settings (builds absolute URLs from the server side)
    fetch('/settings' + (token ? ('?token=' + encodeURIComponent(token)) : ''), { headers: token ? { 'X-Auth-Token': token } : {} })
      .then(function(r){ return r.json().catch(function(){ return {}; }); })
      .then(function(d){ applySettings(d); });
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log('n8n WhatsApp Dashboard listening on http://localhost:' + PORT);
});
