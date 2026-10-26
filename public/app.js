// Family wall calendar — front end (vanilla JS, no build step).
import { dayNum, fromDayNum, weekday, ymd, numFromKey, dayKeyFromNum, partsInTz } from './lib/tz.js';
import { todayBoard, upcomingCountdowns } from './lib/logic.js';

// ---------------- tiny DOM helper ----------------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv); }
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const $ = (s, el = document) => el.querySelector(s);
const E = (s) => h('span', { class: 'emoji' }, s);

// ---------------- state ----------------
const LS = { state: 'wc.state', events: 'wc.events', weather: 'wc.weather', hidden: 'wc.hiddenCals' };
const S = {
  status: null, state: null, events: [], evRange: null, weather: null,
  view: (location.hash || '#home').slice(1) || 'home',
  cal: { view: null, anchor: null }, calPerson: +localStorage.getItem('wc.calPerson') || null, album: null, hidden: new Set(JSON.parse(localStorage.getItem(LS.hidden) || '[]')),
  offline: false, lastOk: 0, lastEventsOk: 0, modalOpen: 0,
};
const TZ = () => (S.state && S.state.settings.tz) || 'America/Chicago';
const set = () => S.state.settings;

async function api(method, path, body, { retryParent = true } = {}) {
  const opt = { method, headers: { 'x-wc': '1' }, credentials: 'same-origin' };
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['content-type'] = 'application/json'; }
  const res = await fetch('/api' + path, opt);
  let data = {};
  try { data = await res.json(); } catch {}
  if (res.status === 403 && data.error === 'parent' && retryParent) {
    if (await askPin({ title: 'Parent PIN', sub: 'Enter the parent PIN to continue' })) return api(method, path, body, { retryParent: false });
    throw Object.assign(new Error('cancelled'), { cancelled: true });
  }
  if (res.status === 401 && (data.error === 'device' || data.error === 'setup')) { await boot(); throw Object.assign(new Error('locked'), { cancelled: true }); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Error ${res.status}`), { status: res.status });
  return data;
}
const handle = (e) => { if (!e || e.cancelled) return; toast(e.message || 'Something went wrong'); };

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms);
}

// ---------------- time formatting (always in the family's time zone) ----------------
const fmtCache = {};
function fmt(opts) { const k = JSON.stringify(opts) + TZ(); return (fmtCache[k] ||= new Intl.DateTimeFormat('en-US', { timeZone: TZ(), ...opts })); }
const todayKey = () => { const p = partsInTz(Date.now(), TZ()); return ymd(p.y, p.m, p.d); };
const keyOf = (ms) => { const p = partsInTz(ms, TZ()); return ymd(p.y, p.m, p.d); };
function timeStr(ms, short) {
  const p = partsInTz(ms, TZ());
  if (set().clock24) return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`;
  const hh = p.h % 12 || 12, ap = p.h < 12 ? 'am' : 'pm';
  return short && p.mi === 0 ? `${hh}${ap}` : `${hh}:${String(p.mi).padStart(2, '0')}${short ? ap : ' ' + ap.toUpperCase()}`;
}
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const civil = (n) => fromDayNum(n);
// start-of-day instant (UTC ms) of civil day n in TZ
function dayStartMs(n) {
  const c = civil(n); const guess = Date.UTC(c.y, c.m - 1, c.d);
  const p = partsInTz(guess, TZ()); const off = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - guess;
  let t = guess - off; const p2 = partsInTz(t, TZ());
  if (p2.h !== 0) t -= (p2.h > 12 ? p2.h - 24 : p2.h) * 3600e3;
  return t;
}
function ago(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`; return `${Math.round(s / 86400)} days ago`;
}
const isPhone = () => matchMedia('(max-width: 899px)').matches;

// ---------------- boot / auth ----------------
async function boot() {
  try {
    const r = await fetch('/api/status', { credentials: 'same-origin' });
    S.status = await r.json();
  } catch {
    S.status = { setup: true, device: true, parent: false };
    const cached = localStorage.getItem(LS.state);
    if (cached) { S.state = JSON.parse(cached); S.offline = true; loadCachedEvents(); applyTheme(); render(); startLoops(); return; }
    $('#app').replaceChildren(h('div', { class: 'boot' }, h('div', { class: 'boot-logo' }, '📡'), h('p', null, "Can't reach the calendar. Retrying…")));
    setTimeout(boot, 15000);
    return;
  }
  if (!S.status.setup) return firstRun();
  if (!S.status.device) return connectScreen();
  await refresh();
  startLoops();
}

function firstRun() {
  $('#app').replaceChildren(h('div', { class: 'boot', style: { maxWidth: '34rem', padding: '1rem' } },
    h('div', { class: 'boot-logo' }, '👋'), h('h1', null, 'Welcome to your family calendar'),
    h('p', null, 'First, choose a parent PIN (4 to 8 digits). It protects settings, rewards and photos. Kids can still tick off their own chores.'),
    h('button', { class: 'btn primary', onclick: async () => {
      const pin = await choosePin('Choose a parent PIN');
      if (!pin) return;
      try { await api('POST', '/setup', { pin }); toast('PIN saved'); S.view = 'settings'; history.replaceState(null, '', '#settings'); await boot(); } catch (e) { handle(e); }
    } }, 'Set parent PIN')));
}
function connectScreen() {
  $('#app').replaceChildren(h('div', { class: 'boot', style: { maxWidth: '34rem', padding: '1rem' } },
    h('div', { class: 'boot-logo' }, '🔒'), h('h1', null, 'Connect this screen'),
    h('p', null, 'Enter the parent PIN once to connect this screen or phone. It stays connected after that.'),
    h('button', { class: 'btn primary', onclick: async () => { if (await askPin({ title: 'Parent PIN', remember: true })) boot(); } }, 'Enter PIN')));
}

// PIN keypad; onDone(pin, remember) returns true when accepted or an error string.
function pinPad({ title, sub, onDone, remember }) {
  let val = '', rememberOn = false, busy = false;
  const dots = h('div', { class: 'dots' });
  const msg = h('div', { class: 'msg' });
  const draw = () => dots.replaceChildren(...Array.from({ length: Math.max(4, val.length) }, (_, i) => h('i', { class: i < val.length ? 'on' : '' })));
  const wrap = h('div', { class: 'pin' });
  const press = async (k) => {
    if (busy) return;
    if (k === 'del') val = val.slice(0, -1);
    else if (k === 'ok') {
      if (val.length < 4) { msg.textContent = 'At least 4 digits'; return; }
      busy = true; const res = await onDone(val, rememberOn); busy = false;
      if (res !== true) { msg.textContent = res || ''; msg.className = 'msg err'; wrap.classList.remove('shake'); void wrap.offsetWidth; wrap.classList.add('shake'); val = ''; }
    } else if (val.length < 8) val += k;
    draw();
  };
  draw();
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'];
  wrap.append(h('h2', null, title), sub ? h('p', { style: { color: 'var(--muted)', margin: 0 } }, sub) : null, dots,
    h('div', { class: 'pad' }, keys.map((k) => h('button', { class: k.length > 1 ? 'fn' : '', onclick: () => press(k), 'aria-label': k }, k === 'del' ? '⌫' : k === 'ok' ? 'OK' : k))),
    remember ? h('button', { class: 'toggle', style: { justifyContent: 'center', marginTop: '1rem' }, onclick: (e) => { rememberOn = !rememberOn; e.currentTarget.classList.toggle('on', rememberOn); } }, h('span', { class: 'knob' }), 'Keep parent mode on this phone (30 days)') : null,
    msg);
  const onKey = (e) => { if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del'); else if (e.key === 'Enter') press('ok'); };
  return { el: wrap, onKey };
}
function askPin({ title = 'Parent PIN', sub, remember = false } = {}) {
  return new Promise((resolve) => {
    let m;
    const pad = pinPad({ title, sub, remember: remember || isPhone(), onDone: async (pin, rem) => {
      const r = await fetch('/api/unlock', { method: 'POST', headers: { 'x-wc': '1', 'content-type': 'application/json' }, body: JSON.stringify({ pin, remember: rem }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return d.error || 'Try again';
      S.status = { ...S.status, device: true, parent: true };
      m.close(true); resolve(true); renderChrome();
      return true;
    } });
    m = modal(pad.el, { onClose: () => resolve(false), onKey: pad.onKey, cancel: true });
  });
}
function choosePin(title) {
  return new Promise((resolve) => {
    let m;
    const pad = pinPad({ title, sub: 'Use 4 to 8 digits', onDone: async (pin) => {
      m.close(true);
      let m2;
      const again = pinPad({ title: 'Type it again', onDone: async (p2) => { if (p2 !== pin) return "PINs didn't match"; m2.close(true); resolve(p2); return true; } });
      m2 = modal(again.el, { onKey: again.onKey, cancel: true, onClose: () => resolve(null) });
      return true;
    } });
    m = modal(pad.el, { onKey: pad.onKey, cancel: true, onClose: () => resolve(null) });
  });
}
async function needParent() {
  if (S.status && S.status.parent) return true;
  return askPin({ title: 'Parent PIN', sub: 'Parents only' });
}

// ---------------- modal ----------------
function modal(content, { onClose, onKey, cancel } = {}) {
  const back = h('div', { class: 'backdrop' });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' }, content);
  if (cancel) sheet.append(h('div', { class: 'actions', style: { justifyContent: 'center' } }, h('button', { class: 'btn', onclick: () => close() }, 'Cancel')));
  back.append(sheet);
  let closed = false;
  const keyH = (e) => { if (e.key === 'Escape') close(); else if (onKey && !(e.target && e.target.tagName === 'INPUT')) onKey(e); };
  function close(silent) { if (closed) return; closed = true; back.remove(); S.modalOpen--; document.removeEventListener('keydown', keyH); if (!silent && onClose) onClose(); }
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', keyH);
  $('#modals').append(back); S.modalOpen++;
  return { close, sheet };
}
function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(h('div', null, h('h2', null, title), text ? h('p', null, text) : null,
      h('div', { class: 'actions' }, h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => { done = true; m.close(); resolve(false); } }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { done = true; m.close(); resolve(true); } }, okLabel))), { onClose: () => { if (!done) resolve(false); } });
  });
}

// ---------------- generic form controls ----------------
const PALETTE = ['#E76F51', '#F4A261', '#E9C46A', '#2A9D8F', '#5B8DEF', '#8E7DFF', '#D16BA5', '#3BB273', '#EF476F', '#118AB2', '#8D6E63', '#607D8B'];
const EMOJI = {
  people: ['🙂', '😀', '😎', '🤓', '🥳', '👧', '👦', '👩', '👨', '👶', '🧒', '👸', '🤴', '🦸', '🧚', '🐶', '🐱', '🦊', '🐼', '🐨', '🦁', '🐯', '🐸', '🦄', '🐙', '🦖', '🐢', '🐝', '🦋', '🌻', '⚽', '🏀', '🎸', '🚀', '🌈', '⭐'],
  tasks: ['🛏️', '🌅', '🌙', '🪥', '🛁', '👕', '🧺', '🧹', '🍽️', '🗑️', '🐕', '🐈', '🌱', '📚', '✏️', '🎹', '🎻', '⚽', '🏃', '🥦', '💧', '🧸', '🎒', '🚗', '🙏', '😊', '🤝', '📵', '✅', '⏰', '🧼'],
  rewards: ['🎁', '🍦', '🍕', '🍩', '🎬', '🎮', '📱', '🛝', '🏊', '🎳', '🧁', '🍿', '📖', '🧸', '🎨', '🛍️', '💵', '🌟', '🏆', '🎟️', '🍔', '🌮', '⏰', '🚲'],
};
function field(label, control, help) { return h('div', { class: 'field' }, h('label', null, label), control, help ? h('div', { class: 'help' }, help) : null); }
function textInput(obj, key, attrs = {}) { return h('input', { type: 'text', value: obj[key] ?? '', ...attrs, oninput: (e) => { obj[key] = e.target.value; } }); }
function chipsInput(obj, key, options, { multi = false } = {}) {
  const box = h('div', { class: 'chips' });
  const draw = () => box.replaceChildren(...options.map((o) => {
    const on = multi ? (obj[key] || []).includes(o.value) : obj[key] === o.value;
    return h('button', { type: 'button', class: on ? 'on' : '', onclick: () => {
      if (multi) { const a = new Set(obj[key] || []); a.has(o.value) ? a.delete(o.value) : a.add(o.value); obj[key] = [...a]; } else obj[key] = o.value;
      draw(); box.dispatchEvent(new Event('change'));
    } }, o.emoji ? E(o.emoji) : null, o.label);
  }));
  draw(); return box;
}
function swatchInput(obj, key) {
  const box = h('div', { class: 'swatches' });
  const draw = () => box.replaceChildren(...PALETTE.map((c) => h('button', { type: 'button', 'aria-label': c, class: obj[key] && obj[key].toLowerCase() === c.toLowerCase() ? 'on' : '', style: { background: c }, onclick: () => { obj[key] = c; obj._colorTouched = true; draw(); } })));
  draw(); return box;
}
function emojiInput(obj, key, group) {
  const box = h('div', { class: 'emojis' });
  const own = h('input', { type: 'text', placeholder: 'Or type any emoji', value: '', oninput: (e) => { const v = e.target.value.trim(); if (v) { obj[key] = v; draw(); } }, style: { marginTop: '.4rem' } });
  const draw = () => box.replaceChildren(...EMOJI[group].map((em) => h('button', { type: 'button', class: obj[key] === em ? 'on' : '', onclick: () => { obj[key] = em; draw(); } }, em)));
  draw(); return h('div', null, box, h('div', { class: 'field', style: { margin: 0 } }, own));
}
function stepper(obj, key, min, max) {
  const out = h('output', null, obj[key]);
  const ch = (d) => { obj[key] = Math.max(min, Math.min(max, (+obj[key] || 0) + d)); out.textContent = obj[key]; };
  return h('div', { class: 'stepper' }, h('button', { type: 'button', 'aria-label': 'less', onclick: () => ch(-1) }, '−'), out, h('button', { type: 'button', 'aria-label': 'more', onclick: () => ch(1) }, '+'));
}
function toggleInput(obj, key, label) {
  const b = h('button', { type: 'button', class: 'toggle' + (obj[key] ? ' on' : ''), onclick: () => { obj[key] = !obj[key]; b.classList.toggle('on', !!obj[key]); } }, h('span', { class: 'knob' }), label);
  return b;
}
function formSheet(title, build, { onSave, onDelete, saveLabel = 'Save' }) {
  const errEl = h('div', { class: 'err' });
  let m;
  const saveBtn = h('button', { class: 'btn primary', onclick: async () => {
    errEl.textContent = ''; saveBtn.disabled = true;
    try { const r = await onSave(); if (r !== false) { m.close(true); await refresh(); } } catch (e) { if (!e.cancelled) errEl.textContent = e.message; } finally { saveBtn.disabled = false; }
  } }, saveLabel);
  const content = h('div', null, h('h2', null, title), build(), errEl,
    h('div', { class: 'actions' },
      onDelete ? h('button', { class: 'btn danger', onclick: async () => { try { if (await onDelete()) { m.close(true); await refresh(); } } catch (e) { handle(e); } } }, 'Delete') : null,
      h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), saveBtn));
  m = modal(content);
  return m;
}

// ---------------- data refresh ----------------
let refreshing = null;
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const st = await api('GET', '/state');
      const r = await fetch('/api/status', { credentials: 'same-origin' }); S.status = await r.json();
      if (window.__v && st.v !== window.__v) { location.reload(); return; }
      window.__v = st.v;
      const wxChanged = !S.state || JSON.stringify([S.state.settings.weather, S.state.settings.units]) !== JSON.stringify([st.settings.weather, st.settings.units]);
      const calsChanged = !S.state || S.state.calendars.map((c) => c.id + ':' + c.ok_at + ':' + c.enabled).join() !== st.calendars.map((c) => c.id + ':' + c.ok_at + ':' + c.enabled).join();
      S.state = st; S.offline = false; S.lastOk = Date.now();
      if (calsChanged) S.lastEventsOk = 0;
      if (wxChanged && startLoops.done) setTimeout(() => loadWeather(true), 0);
      try { localStorage.setItem(LS.state, JSON.stringify(st)); } catch {}
    } catch (e) {
      if (e.cancelled) return;
      const cached = localStorage.getItem(LS.state);
      if (!S.state && cached) S.state = JSON.parse(cached);
      S.offline = true;
    }
    if (!S.state) return;
    if (!S.cal.view) S.cal.view = isPhone() ? 'agenda' : set().default_view;
    await loadEvents();
    applyTheme();
    render();
  })();
  try { await refreshing; } finally { refreshing = null; }
}
function loadCachedEvents() { try { const c = JSON.parse(localStorage.getItem(LS.events) || 'null'); if (c) { S.events = c.events; S.evRange = [c.from, c.to]; S.lastEventsOk = c.at; } } catch {} }
async function loadEvents(force) {
  const t = numFromKey(todayKey());
  const want = viewRange();
  if (!force && S.evRange && S.evRange[0] <= want[0] && S.evRange[1] >= want[1] && Date.now() - S.lastEventsOk < 4 * 60e3) return;
  const from = Math.min(dayStartMs(t - 40), want[0]), to = Math.max(dayStartMs(t + 100), want[1]);
  try {
    const r = await api('GET', `/events?from=${from}&to=${to}`);
    S.events = r.events; S.evRange = [from, to]; S.lastEventsOk = Date.now();
    try { localStorage.setItem(LS.events, JSON.stringify({ events: r.events, from, to, at: Date.now() })); } catch {}
  } catch (e) { if (!S.events.length) loadCachedEvents(); }
}

// ---------------- weather (Open-Meteo, no key) ----------------
const WMO = { 0: ['☀️', 'Clear'], 1: ['🌤️', 'Mostly clear'], 2: ['⛅', 'Partly cloudy'], 3: ['☁️', 'Cloudy'], 45: ['🌫️', 'Fog'], 48: ['🌫️', 'Fog'], 51: ['🌦️', 'Drizzle'], 53: ['🌦️', 'Drizzle'], 55: ['🌧️', 'Drizzle'], 56: ['🌧️', 'Freezing drizzle'], 57: ['🌧️', 'Freezing drizzle'], 61: ['🌧️', 'Light rain'], 63: ['🌧️', 'Rain'], 65: ['🌧️', 'Heavy rain'], 66: ['🌧️', 'Freezing rain'], 67: ['🌧️', 'Freezing rain'], 71: ['🌨️', 'Light snow'], 73: ['🌨️', 'Snow'], 75: ['❄️', 'Heavy snow'], 77: ['🌨️', 'Snow grains'], 80: ['🌦️', 'Showers'], 81: ['🌧️', 'Showers'], 82: ['⛈️', 'Heavy showers'], 85: ['🌨️', 'Snow showers'], 86: ['❄️', 'Snow showers'], 95: ['⛈️', 'Thunderstorm'], 96: ['⛈️', 'Thunderstorm'], 99: ['⛈️', 'Thunderstorm'] };
const wmo = (c) => WMO[c] || ['🌡️', ''];
async function loadWeather(force) {
  if (!S.state) return;
  const w = set().weather;
  if (!w) { S.weather = null; renderTop(); return; }
  const key = `${w.lat},${w.lon},${set().units}`;
  const cached = JSON.parse(localStorage.getItem(LS.weather) || 'null');
  if (cached && cached.key === key) S.weather = cached; else S.weather = null;
  if (!force && cached && cached.key === key && Date.now() - cached.at < 25 * 60e3) { renderTop(); return; }
  try {
    const u = new URL('https://api.open-meteo.com/v1/forecast');
    u.search = new URLSearchParams({ latitude: w.lat, longitude: w.lon, current: 'temperature_2m,apparent_temperature,weather_code,is_day', daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max', timezone: 'auto', forecast_days: '6', temperature_unit: set().units === 'C' ? 'celsius' : 'fahrenheit' });
    const r = await fetch(u); if (!r.ok) throw new Error('weather ' + r.status);
    const d = await r.json();
    S.weather = { key, at: Date.now(), current: d.current, daily: d.daily };
    localStorage.setItem(LS.weather, JSON.stringify(S.weather));
  } catch {}
  renderTop();
}

// ---------------- theme / night / idle / burn-in ----------------
const minutesOf = (s) => { const [a, b] = String(s).split(':').map(Number); return a * 60 + b; };
function isNight() {
  if (!S.state) return false;
  const p = partsInTz(Date.now(), TZ()); const m = p.h * 60 + p.mi;
  const a = minutesOf(set().night_start), b = minutesOf(set().night_end);
  return a === b ? false : a < b ? m >= a && m < b : m >= a || m < b;
}
let wakeUntil = 0, lastTouch = Date.now();
function applyTheme() {
  if (!S.state) return;
  const night = isNight();
  const t = set().theme === 'auto' ? (night ? 'dark' : 'light') : set().theme;
  if (document.documentElement.dataset.theme !== t) document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#12171c' : '#f6f3ee';
  const dim = night && Date.now() > wakeUntil && !isPhone() ? (set().night_dim || 0) / 100 : 0;
  $('#dim').style.opacity = dim;
}
function onActivity() {
  lastTouch = Date.now();
  if (isNight()) { wakeUntil = Date.now() + 2 * 60e3; applyTheme(); }
  if (!$('#slideshow').hidden) stopSlideshow();
}
let driftStep = 0;
function drift() {
  if (!S.state || !set().drift || isPhone()) { $('#drift').style.transform = ''; return; }
  driftStep = (driftStep + 1) % 8;
  const pts = [[0, 0], [3, 1], [5, 3], [3, 5], [0, 6], [-3, 5], [-5, 3], [-3, 1]];
  $('#drift').style.transform = `translate(${pts[driftStep][0]}px, ${pts[driftStep][1]}px)`;
}

let slideTimer = null, slideIdx = 0;
const albumIdsOf = (pid) => (S.state.photo_albums || []).filter((r) => r[0] === pid).map((r) => r[1]);
const photosIn = (aid) => (aid ? S.state.photos.filter((p) => albumIdsOf(p.id).includes(aid)) : S.state.photos);
function slideshowPhotos() {
  const want = (set().slideshow_albums || []).filter((a) => (S.state.albums || []).some((x) => x.id === a));
  if (!want.length) return S.state.photos;
  const ps = S.state.photos.filter((p) => albumIdsOf(p.id).some((a) => want.includes(a)));
  return ps.length ? ps : S.state.photos;
}
function startSlideshow(list, startAt) {
  const photos = list || (S.state && slideshowPhotos());
  if (!photos || !photos.length) return;
  const ss = $('#slideshow'); ss.hidden = false; ss.replaceChildren();
  const bg = h('img', { class: 'bg', alt: '' }), fg = h('img', { alt: '' }), fg2 = h('img', { alt: '' });
  const ov = h('div', { class: 'ov' });
  ss.append(bg, fg, fg2, ov);
  let which = 0;
  const show = () => {
    const ps = photos.filter((p) => S.state.photos.includes(p) || S.state.photos.some((x) => x.id === p.id)); if (!ps.length) return stopSlideshow();
    slideIdx = (slideIdx + 1) % ps.length;
    const src = `/api/photos/${ps[slideIdx].id}`;
    const img = which ? fg2 : fg, other = which ? fg : fg2; which = 1 - which;
    img.onload = () => { img.classList.add('on'); other.classList.remove('on'); bg.src = src; bg.classList.add('on'); };
    img.src = src;
    const nx = nextEvent();
    ov.replaceChildren(h('div', { class: 't' }, timeStr(Date.now())), h('div', { class: 'd' }, fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())),
      nx ? h('div', { class: 'nx' }, 'Next: ', nx.a ? nx.t : `${timeStr(nx.s, true)} · ${nx.t}`) : null);
  };
  slideIdx = (startAt ?? Math.floor(Math.random() * photos.length)) - 1;
  show();
  slideTimer = setInterval(show, Math.max(4, set().slide_seconds) * 1000);
}
function stopSlideshow() { clearInterval(slideTimer); slideTimer = null; const ss = $('#slideshow'); ss.hidden = true; ss.replaceChildren(); }
function nextEvent() {
  const now = Date.now(), tk = todayKey();
  const list = visibleEvents().filter((e) => (e.a ? e.s <= tk && e.e > tk : e.s > now && e.s < now + 86400e3 * 2));
  return list.sort((a, b) => (b.a - a.a) || (a.s > b.s ? 1 : -1))[0];
}

const typing = () => { const a = document.activeElement; return !!(a && a.matches && a.matches('#view input, #view textarea') && a.value); };
function startLoops() {
  if (startLoops.done) return; startLoops.done = true;
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, onActivity, { passive: true, capture: true }));
  setInterval(() => { renderTop(); applyTheme(); }, 15e3);
  setInterval(() => { if (!S.modalOpen && document.visibilityState === 'visible' && !typing()) refresh(); }, 60e3);
  setInterval(() => loadEvents(true).then(() => { if (!S.modalOpen && !typing()) renderView(); }), 5 * 60e3);
  setInterval(() => loadWeather(), 10 * 60e3);
  setInterval(drift, 3 * 60e3);
  setInterval(() => {
    if (!S.state || isPhone() || S.modalOpen) return;
    const idle = set().idle_minutes;
    if (idle > 0 && !slideTimer && Date.now() - lastTouch > idle * 60e3 && !isNight() && S.state.photos.length) startSlideshow();
    if (S.view !== 'home' && Date.now() - lastTouch > 10 * 60e3) { S.cal.anchor = null; go('home'); }
  }, 20e3);
  scheduleDailyReload();
  window.addEventListener('online', () => refresh());
  window.addEventListener('offline', () => { S.offline = true; render(); });
  window.addEventListener('hashchange', () => { const v = location.hash.slice(1) || 'home'; if (v !== S.view) { S.view = v; render(); } });
  let w = innerWidth; window.addEventListener('resize', () => { if ((w < 900) !== (innerWidth < 900)) render(); w = innerWidth; });
  loadWeather();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
function scheduleDailyReload() { // reload around 3:10am so the kiosk picks up new versions and never goes stale
  const p = partsInTz(Date.now(), TZ());
  let mins = (3 * 60 + 10) - (p.h * 60 + p.mi); if (mins <= 0) mins += 1440;
  setTimeout(async () => { try { const r = await fetch('/api/ping', { cache: 'no-store' }); if (r.ok) location.reload(); else scheduleDailyReload(); } catch { setTimeout(scheduleDailyReload, 10 * 60e3); } }, mins * 60e3);
}

// ---------------- chrome ----------------
const NAV = [['home', '🏠', 'Home'], ['calendar', '📅', 'Calendar'], ['chores', '✅', 'Chores'], ['rewards', '🎁', 'Rewards'], ['lists', '🛒', 'Lists'], ['meals', '🍽️', 'Meals'], ['photos', '🖼️', 'Photos'], ['settings', '⚙️', 'Settings']];
const PHONE_TABS = ['home', 'calendar', 'chores', 'lists'];
function moreSheet() {
  let m;
  m = modal(h('div', null, h('h2', null, 'More'), h('div', { class: 'more-grid' }, NAV.filter((n) => !PHONE_TABS.includes(n[0])).map(([id, ico, label]) => h('button', { class: 'navbtn' + (S.view === id ? ' on' : ''), onclick: () => { m.close(true); go(id); } }, h('span', { class: 'ico' }, ico), label)))), { cancel: true });
}
function go(v) { S.view = v; if (location.hash !== '#' + v) history.replaceState(null, '', '#' + v); render(); }
function render() {
  if (!S.state) return;
  const navBtn = ([id, ico, label]) => h('button', { class: 'navbtn' + (S.view === id ? ' on' : ''), onclick: () => go(id) }, h('span', { class: 'ico' }, ico), label);
  $('#app').replaceChildren(
    h('nav', { class: 'rail' }, h('div', { class: 'brand' }, '📅'), NAV.map(navBtn), h('div', { class: 'spacer' }),
      h('button', { class: 'navbtn', id: 'lockbtn', onclick: lockToggle })),
    h('div', { class: 'main' },
      S.offline ? h('div', { class: 'offline-banner' }, `Offline · showing what was saved at ${S.state.now ? timeStr(S.state.now) : 'earlier'}`) : null,
      h('header', { class: 'topbar', id: 'topbar' }),
      h('section', { class: 'view', id: 'view' }),
      h('nav', { class: 'tabbar' }, NAV.filter((n) => PHONE_TABS.includes(n[0])).map(navBtn),
        h('button', { class: 'navbtn' + (PHONE_TABS.includes(S.view.split('/')[0]) ? '' : ' on'), onclick: moreSheet }, h('span', { class: 'ico' }, '☰'), 'More'))));
  renderChrome(); renderTop(); renderView();
}
function renderChrome() { const b = $('#lockbtn'); if (b && S.status) b.replaceChildren(h('span', { class: 'ico' }, S.status.parent ? '🔓' : '🔒'), S.status.parent ? 'Lock' : 'Parent'); }
async function lockToggle() {
  if (S.status.parent) { await fetch('/api/lock', { method: 'POST', headers: { 'x-wc': '1' } }); S.status.parent = false; toast('Locked'); await refresh(); }
  else if (await askPin({ title: 'Parent PIN' })) { toast('Unlocked for parents'); await refresh(); }
}
function renderTop() {
  const top = $('#topbar'); if (!top || !S.state) return;
  const p = partsInTz(Date.now(), TZ());
  const t = set().clock24 ? `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}` : `${p.h % 12 || 12}:${String(p.mi).padStart(2, '0')}`;
  const clock = h('div', { class: 'clock' }, h('div', { class: 'time' }, t, set().clock24 ? null : h('small', null, p.h < 12 ? 'AM' : 'PM')), h('div', { class: 'date' }, fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())));
  top.replaceChildren(clock, h('div', { class: 'grow' }), weatherBox(), syncBox());
}
function weatherBox() {
  if (!set().weather) return h('button', { class: 'wx empty', onclick: async () => { if (await needParent()) { go('settings'); editWeather(); } } }, E('🌤️'), ' Set weather location');
  const w = S.weather;
  if (!w || !w.current) return h('div', { class: 'wx' }, h('span', { class: 'hilo' }, 'Loading weather…'));
  const u = '°', c = w.current, d = w.daily;
  const [ico, label] = wmo(c.weather_code);
  const icoNow = c.is_day === 0 && c.weather_code <= 1 ? '🌙' : ico;
  return h('div', { class: 'wx', title: set().weather.name },
    h('div', { class: 'now' }, E(icoNow), h('div', null, h('div', { class: 'temp' }, Math.round(c.temperature_2m) + u),
      h('div', { class: 'hilo' }, `H ${Math.round(d.temperature_2m_max[0])}${u} · L ${Math.round(d.temperature_2m_min[0])}${u}`, h('br'), label))),
    h('div', { class: 'days' }, d.time.slice(1, 6).map((day, i) => {
      const n = numFromKey(day);
      return h('div', { class: 'day' }, h('b', null, DOW[weekday(n)]), E(wmo(d.weather_code[i + 1])[0]), h('b', null, Math.round(d.temperature_2m_max[i + 1]) + u), h('span', null, Math.round(d.temperature_2m_min[i + 1]) + u));
    })));
}
function syncBox() {
  const cals = S.state.calendars.filter((c) => c.enabled);
  let dot = '', text;
  if (!cals.length) text = 'No calendars yet';
  else {
    const oldest = Math.min(...cals.map((c) => c.ok_at || 0));
    const errs = cals.filter((c) => c.error);
    text = `Calendars synced ${ago(oldest)}`;
    if (errs.length) { dot = 'bad'; text = `${errs.length} calendar${errs.length > 1 ? 's' : ''} not syncing`; }
    else if (Date.now() - oldest > 30 * 60e3) dot = 'warn';
  }
  if (S.offline) { dot = 'bad'; text = 'Offline'; }
  return h('div', { class: 'sync' }, h('span', { class: 'dot ' + dot }), text);
}
function renderView() {
  const v = $('#view'); if (!v || !S.state) return;
  const st = v.scrollTop;
  if (S.view.startsWith('kid/')) { v.replaceChildren(kidView(+S.view.split('/')[1])); v.scrollTop = st; return; }
  const views = { home: homeView, calendar: () => h('div', { class: 'card', style: { height: '100%', minHeight: '30rem' } }, calendarPanel()), chores: choresView, rewards: rewardsView, lists: listsView, meals: mealsView, photos: photosView, settings: settingsView };
  v.replaceChildren((views[S.view] || homeView)());
  v.scrollTop = st;
  if (S.refocus) { const el = v.querySelector(S.refocus); S.refocus = null; if (el) el.focus({ preventScroll: true }); }
  const body = v.querySelector('.calbody');
  if (body && S.cal.view === 'day' && !body.dataset.scrolled) { const t = body.querySelector('.nowline') || body.querySelector('.ev'); if (t) body.scrollTop = Math.max(0, t.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight / 3); }
}

// ---------------- home ----------------
const kidsOf = () => S.state.people.filter((p) => p.role === 'kid');
const personById = (id) => S.state.people.find((p) => p.id === id);
function homeView() {
  const kids = kidsOf();
  const needsSetup = !S.state.people.length || !S.state.calendars.length || !set().weather;
  const side = h('div', { class: 'side' },
    needsSetup ? setupCard() : null,
    countdownsMini(),
    mealsMini(),
    kids.length ? h('div', { class: 'kids' }, todayBoard(S.state.tasks, S.state.completions, kids, todayKey()).map((b) => kidCard(b))) : null,
    listMini(),
    rewardsMini());
  if (isPhone()) return h('div', { class: 'home' }, side, h('div', { class: 'card' }, calendarPanel('agenda')));
  return h('div', { class: 'home' }, h('div', { class: 'card', style: { minHeight: 0 } }, calendarPanel()), side);
}
function setupCard() {
  const steps = [];
  const open = (fn) => async () => { if (await needParent()) { go('settings'); fn(); } };
  if (!S.state.people.length) steps.push(['👨‍👩‍👧‍👦', 'Add your family', open(() => editPerson(null))]);
  if (!S.state.calendars.length) steps.push(['📅', 'Add a calendar link', open(() => editCalendar(null))]);
  if (!set().weather) steps.push(['🌤️', 'Choose weather location', open(() => editWeather())]);
  return h('div', { class: 'card sbox' }, h('h3', null, E('✨'), 'Finish setting up'), h('div', { class: 'setup-list' }, steps.map(([e, t, f]) => h('button', { onclick: f }, E(e), t, h('span', { class: 'grow' }), '›'))));
}
function kidCard(b, opts = {}) {
  const showAll = !!opts.showAll;
  const p = b.person, items = b.items;
  const bal = S.state.balances[p.id] || 0;
  const allDone = items.length && b.doneCount === items.length;
  const card = h('div', { class: 'card kidcard', style: { '--c': p.color } },
    h('div', { class: 'kidhead' }, opts.head === false ? null : h('button', { class: 'kidlink', 'aria-label': `Open ${p.name}'s page`, onclick: () => go('kid/' + p.id) }, h('div', { class: 'avatar' }, p.emoji),
      h('div', { class: 'nm' }, p.name, h('small', null, items.length ? `${b.doneCount} of ${items.length} done today` : 'Nothing due today'))),
      opts.head === false ? h('div', { class: 'nm' }, opts.title || 'Chores', h('small', null, items.length ? `${b.doneCount} of ${items.length} done` : '')) : null,
      opts.head === false ? null : h('div', { class: 'stars', 'data-stars': p.id, title: 'Stars' }, E('⭐'), h('span', null, bal))));
  if (!items.length) card.append(h('div', { class: 'alldone' }, opts.empty || 'Free day! 🎈'));
  else if (allDone && !showAll) card.append(h('div', { class: 'alldone' }, E('🎉'), ' All done today!'));
  if (!allDone || showAll) for (const it of items) {
    const t = it.task, rt = t.kind === 'routine', nd = rt ? progOf(t.id, p.id).length : 0;
    card.append(h('button', { class: 'task ' + (it.status === 'todo' ? '' : it.status) + (rt ? ' rtask' : ''), 'data-task': t.id, onclick: (e) => tapTask(p, t, it, e.currentTarget) },
      h('span', { class: 'te' }, t.emoji),
      h('span', { class: 'tt' }, t.title, it.status === 'pending' ? h('small', null, 'Waiting for a parent') : rt ? h('small', null, `Routine · ${nd} of ${t.steps.length} steps`) : t.part !== 'any' ? h('small', null, t.part[0].toUpperCase() + t.part.slice(1)) : null),
      t.stars ? h('span', { class: 'sv' }, '+' + t.stars + ' ⭐') : null,
      h('span', { class: 'ck', style: rt && it.status === 'todo' && nd ? { background: `conic-gradient(var(--c) ${Math.round(nd / t.steps.length * 360)}deg, transparent 0)` } : null }, it.status === 'done' ? '✓' : it.status === 'pending' ? '⏳' : rt ? '›' : '')));
  }
  return card;
}
async function tapTask(person, task, it, el) {
  if (task.kind === 'routine') return openRoutine(person, task);
  try {
    if (it.status === 'todo') {
      const willBe = set().approval && !S.status.parent ? 'pending' : 'done';
      it.status = willBe; el.className = 'task ' + willBe;
      const r = await api('POST', '/complete', { task_id: task.id, person_id: person.id });
      if (r.status === 'done') { celebrate(el, task.stars, person); bumpStars(person.id, task.stars); await new Promise((res) => setTimeout(res, 900)); }
      else toast(`Nice! A parent will approve “${task.title}”.`);
    } else {
      const ok = await confirmBox(`Undo “${task.title}”?`, it.status === 'done' && task.stars ? `This takes back ${task.stars} star${task.stars > 1 ? 's' : ''} from ${person.name}.` : null, 'Undo');
      if (!ok) return;
      await api('POST', '/complete', { task_id: task.id, person_id: person.id, undo: true });
    }
  } catch (e) { handle(e); }
  await refresh();
}
function bumpStars(pid, n) {
  S.state.balances[pid] = (S.state.balances[pid] || 0) + n;
  document.querySelectorAll(`[data-stars="${pid}"]`).forEach((el) => { el.lastChild.textContent = S.state.balances[pid]; el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); });
}
function celebrate(el, stars, person) {
  const r = el.getBoundingClientRect();
  const box = $('#confetti');
  const cx = el === document.body ? innerWidth / 2 : r.left + r.width - 40, cy = el === document.body ? innerHeight / 2 : r.top + r.height / 2;
  const symbols = ['⭐', '✨', '🌟', '⭐', '🎉'];
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2, dist = 120 + Math.random() * 220;
    const s = h('span', { style: { left: cx + 'px', top: cy + 'px', '--dx': Math.cos(a) * dist + 'px', '--dy': Math.sin(a) * dist - 80 + 'px', '--rot': (Math.random() * 720 - 360) + 'deg', animationDelay: Math.random() * 120 + 'ms', fontSize: (1.2 + Math.random() * 1.6) + 'rem' } }, symbols[i % symbols.length]);
    box.append(s); setTimeout(() => s.remove(), 1700);
  }
  if (!person) return;
  const praise = ['Great job', 'Awesome', 'Way to go', 'Super star', 'Nice work', 'You did it'];
  const pop = h('div', { class: 'celebrate' }, h('div', { class: 'big' }, stars ? '⭐'.repeat(Math.min(stars, 5)) : '🎉'), h('b', null, `${praise[Math.floor(Math.random() * praise.length)]}, ${person.name}!`), stars ? h('div', null, `+${stars} star${stars > 1 ? 's' : ''}`) : null);
  document.body.append(pop); setTimeout(() => pop.remove(), 1600);
}
// ---------------- routines + kid pages ----------------
const progOf = (tid, pid) => ((S.state.routine_progress || []).find((r) => r.task_id === tid && r.person_id === pid) || {}).done || [];
function setProg(tid, pid, done) {
  const rp = (S.state.routine_progress ||= []);
  const r = rp.find((x) => x.task_id === tid && x.person_id === pid);
  if (r) r.done = done; else rp.push({ task_id: tid, person_id: pid, day: todayKey(), done });
}
const statusOf = (tid, pid) => { const c = S.state.completions.find((x) => x.task_id === tid && x.person_id === pid && x.day === todayKey()); return c ? c.status : 'todo'; };
function routinePanel(p, t, onChange) {
  const done = progOf(t.id, p.id), st = statusOf(t.id, p.id), pct = Math.round((done.length / t.steps.length) * 100);
  return h('div', { class: 'routine ' + st, style: { '--c': p.color }, 'data-routine': t.id },
    h('div', { class: 'rhead' }, h('span', { class: 'rte' }, t.emoji), h('div', { class: 'grow' }, h('b', null, t.title),
      h('small', null, `${done.length} of ${t.steps.length} steps${t.stars ? ` · +${t.stars} ⭐ when done` : ''}`))),
    h('div', { class: 'rbar' }, h('i', { style: { width: pct + '%', background: p.color } })),
    h('div', { class: 'steps' }, t.steps.map((x, i) => h('button', { class: 'step' + (done.includes(i) ? ' on' : ''), onclick: (e) => tapStep(p, t, i, onChange, e.currentTarget) },
      h('span', { class: 'sn' }, done.includes(i) ? '✓' : String(i + 1)), x.e ? h('span', { class: 'se' }, x.e) : null, h('span', { class: 'stt' }, x.t)))),
    st === 'done' ? h('div', { class: 'alldone' }, E('🎉'), ' All done!') : st === 'pending' ? h('div', { class: 'alldone' }, E('⏳'), ' Waiting for a parent') : null);
}
async function tapStep(p, t, i, onChange, el) {
  const done = progOf(t.id, p.id), on = !done.includes(i), st = statusOf(t.id, p.id);
  try {
    if (!on && st !== 'todo') {
      const ok = await confirmBox(`Undo “${t.title}”?`, st === 'done' && t.stars ? `This takes back ${t.stars} star${t.stars > 1 ? 's' : ''} from ${p.name}.` : null, 'Undo');
      if (!ok) return;
      await api('POST', '/complete', { task_id: t.id, person_id: p.id, undo: true });
      S.state.completions = S.state.completions.filter((c) => !(c.task_id === t.id && c.person_id === p.id && c.day === todayKey()));
    }
    setProg(t.id, p.id, on ? [...done, i].sort((a, b) => a - b) : done.filter((x) => x !== i)); onChange();
    const r = await api('POST', '/routine/step', { task_id: t.id, person_id: p.id, step: i, done: on });
    setProg(t.id, p.id, r.done);
    if (r.all && statusOf(t.id, p.id) === 'todo') {
      const c = await api('POST', '/complete', { task_id: t.id, person_id: p.id });
      S.state.completions.push({ id: c.completion_id, task_id: t.id, person_id: p.id, day: todayKey(), status: c.status, stars: t.stars });
      if (c.status === 'done') { celebrate(document.body, t.stars, p); bumpStars(p.id, t.stars); } else toast(`Great job! A parent will approve “${t.title}”.`);
    }
    onChange();
  } catch (e) { handle(e); }
  refresh();
}
function openRoutine(p, t) {
  const box = h('div');
  const paint = () => { box.replaceChildren(routinePanel(p, t, paint)); renderView(); };
  modal(h('div', { class: 'routine-sheet' }, h('div', { class: 'kidhead' }, h('div', { class: 'avatar', style: { '--c': p.color } }, p.emoji), h('div', { class: 'nm' }, p.name)), box), { cancel: true });
  box.replaceChildren(routinePanel(p, t, paint));
}
function kidView(id) {
  const p = personById(id);
  if (!p) { setTimeout(() => go('home')); return h('div'); }
  const today = todayKey();
  const board = todayBoard(S.state.tasks, S.state.completions, [p], today)[0];
  const routines = board.items.filter((it) => it.task.kind === 'routine'), others = board.items.filter((it) => it.task.kind !== 'routine');
  const bal = S.state.balances[p.id] || 0;
  const kids = kidsOf().filter((k) => k.id !== p.id);
  const out = h('div', { class: 'kidview', style: { '--c': p.color } });
  out.append(h('div', { class: 'card kv-head' },
    h('button', { class: 'btn small', onclick: () => go('home') }, '‹ Everyone'),
    h('div', { class: 'avatar big' }, p.emoji), h('div', { class: 'nm' }, h('h2', null, p.name), h('small', null, board.items.length ? `${board.doneCount} of ${board.items.length} done today` : 'Nothing due today')),
    h('div', { class: 'stars big', 'data-stars': p.id }, E('⭐'), h('span', null, bal)), h('span', { class: 'grow' }),
    kids.map((k) => h('button', { class: 'kidswitch', 'aria-label': `Switch to ${k.name}`, style: { '--c': k.color }, onclick: () => go('kid/' + k.id) }, h('div', { class: 'avatar' }, k.emoji), k.name))));
  const left = h('div', { class: 'kv-col' }), right = h('div', { class: 'kv-col' });
  left.append(h('div', { class: 'section-title' }, E('🌅'), 'Routines'));
  if (routines.length) for (const it of routines) left.append(h('div', { class: 'card' }, routinePanel(p, it.task, () => renderView())));
  else left.append(h('div', { class: 'card empty-note' }, 'No routines today. Parents can add a morning or bedtime routine on the Chores page.'));
  right.append(h('div', { class: 'section-title' }, E('✅'), 'Chores and habits'));
  right.append(kidCard({ person: p, items: others, doneCount: others.filter((i) => i.status === 'done').length }, { showAll: true, head: false, title: 'Today', empty: 'Nothing else today 🎈' }));
  const rws = [];
  for (const r of S.state.rewards.filter((x) => x.active)) {
    if (r.progress.scope === 'family') rws.push(miniRow(r, null, r.progress.have));
    else { const k = r.progress.kids.find((x) => x.person_id === p.id); if (k) rws.push(miniRow(r, p, k.have)); }
  }
  right.append(h('div', { class: 'section-title' }, E('🎁'), 'Rewards'));
  right.append(h('div', { class: 'card mini-rewards' }, rws.length ? rws.sort((a, b) => b.pct - a.pct).map((r) => r.el) : h('p', { class: 'empty-note' }, 'No rewards for ' + p.name + ' yet.')));
  const hist = S.state.ledger.filter((l) => l.person_id === p.id).slice(0, 6);
  if (hist.length) {
    right.append(h('div', { class: 'section-title' }, E('📜'), 'Recent stars'));
    right.append(h('div', { class: 'card hist' }, hist.map((l) => h('div', { class: 'hr' }, h('div', { class: 'grow' }, h('b', null, l.note || l.kind), h('br'), h('small', { style: { color: 'var(--muted)' } }, `${fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(l.created_at))} ${timeStr(l.created_at, true)}`)),
      h('span', { class: 'delta ' + (l.delta >= 0 ? 'plus' : 'minus') }, (l.delta > 0 ? '+' : '') + l.delta + ' ⭐')))));
  }
  out.append(h('div', { class: 'kv-grid' }, left, right));
  return out;
}
const ROUTINE_PRESETS = {
  morning: { title: 'Morning routine', emoji: '🌅', part: 'morning', steps: '🛏️ Make bed\n👕 Get dressed\n🥣 Eat breakfast\n🪥 Brush teeth\n💇 Brush hair\n🎒 Pack backpack' },
  bedtime: { title: 'Bedtime routine', emoji: '🌙', part: 'evening', steps: '🧸 Tidy toys\n🛁 Bath or shower\n🩳 Pajamas on\n🪥 Brush teeth\n📚 Read a book\n💡 Lights out' },
};
// ---------------- countdowns ----------------
EMOJI.countdowns = ['🎉', '🎂', '✈️', '🏖️', '🎄', '🎃', '🦃', '🐰', '🏕️', '🎢', '🏫', '🎓', '💍', '👶', '⚽', '🎭', '🚗', '🏔️', '🎁', '❤️'];
function cdLabel(c) {
  if (c.days === 0) return 'Today!';
  if (c.days === 1) return 'Tomorrow';
  return c.days < 0 ? 'Done' : `${c.days}`;
}
function cdRow(c) {
  const p = c.person_id ? personById(c.person_id) : null, d = civil(numFromKey(c.next));
  return h('button', { class: 'cd' + (c.days === 0 ? ' today' : '') + (c.days === 1 ? ' word' : '') + (c.days < 0 ? ' past' : ''), style: p ? { '--c': p.color } : null, 'data-cd': c.id, onclick: async () => { if (await needParent()) editCountdown(c); } },
    h('span', { class: 'cde' }, c.emoji),
    h('span', { class: 'cdt' }, c.title, h('small', null, `${DOW[weekday(numFromKey(c.next))]}, ${MON[d.m - 1].slice(0, 3)} ${d.d}${d.y !== +todayKey().slice(0, 4) ? ' ' + d.y : ''}${p ? ' · ' + p.name : ''}${c.yearly ? ' · every year' : ''}`)),
    h('span', { class: 'cdn' }, cdLabel(c), c.days > 1 ? h('small', null, 'days') : null));
}
function countdownsMini() {
  const list = upcomingCountdowns(S.state.countdowns || [], todayKey());
  const up = list.filter((c) => c.days >= 0), past = list.length - up.length;
  const add = h('button', { class: 'btn small', onclick: async () => { if (await needParent()) editCountdown(null); } }, '+ Add');
  return h('div', { class: 'card mini-cd' }, h('div', { class: 'section-title', style: { margin: '0 0 .3rem', fontSize: '1.15rem' } }, E('⏳'), 'Countdowns', h('span', { class: 'grow' }),
    list.length > 4 ? h('button', { class: 'btn small', onclick: () => allCountdowns() }, 'All') : null, add),
    up.length ? up.slice(0, 4).map(cdRow) : h('p', { class: 'empty-note' }, past ? 'Nothing coming up.' : 'Count down to birthdays, trips and holidays.'));
}
function allCountdowns() {
  modal(h('div', null, h('h2', null, 'Countdowns'), h('div', { class: 'mini-cd' }, upcomingCountdowns(S.state.countdowns, todayKey()).map(cdRow))), { cancel: true });
}
function editCountdown(c) {
  const f = c ? { title: c.title, emoji: c.emoji, date: c.date, yearly: !!c.yearly, person_id: c.person_id || 0 } : { title: '', emoji: '🎉', date: '', yearly: false, person_id: 0 };
  formSheet(c ? 'Edit countdown' : 'New countdown', () => h('div', null,
    field('What', textInput(f, 'title', { maxlength: 50, placeholder: "Disney trip, Emma's birthday…" })),
    field('Date', h('input', { type: 'date', value: f.date, onchange: (e) => (f.date = e.target.value), oninput: (e) => (f.date = e.target.value) }), 'For birthdays, any year works; tick “every year”.'),
    field('Repeats', toggleInput(f, 'yearly', 'Every year (birthdays, holidays)')),
    field('Icon', emojiInput(f, 'emoji', 'countdowns')),
    S.state.people.length ? field('Whose (optional)', chipsInput(f, 'person_id', [{ value: 0, label: 'Family', emoji: '👨‍👩‍👧‍👦' }, ...S.state.people.map((p) => ({ value: p.id, label: p.name, emoji: p.emoji }))])) : null), {
    onSave: async () => { await api(c ? 'PUT' : 'POST', c ? `/countdowns/${c.id}` : '/countdowns', f); toast('Saved'); },
    onDelete: c ? async () => confirmBox(`Delete “${c.title}”?`, null, 'Delete', true).then(async (ok) => { if (ok) await api('DELETE', `/countdowns/${c.id}`); return ok; }) : null,
  });
}
function rewardsMini() {
  const rows = [];
  for (const r of S.state.rewards.filter((x) => x.active)) {
    if (r.progress.scope === 'family') rows.push(miniRow(r, null, r.progress.have));
    else for (const k of r.progress.kids) { const p = personById(k.person_id); if (p) rows.push(miniRow(r, p, k.have)); }
  }
  if (!rows.length) return null;
  rows.sort((a, b) => b.pct - a.pct);
  return h('div', { class: 'card mini-rewards' }, h('div', { class: 'section-title', style: { margin: '0 0 .3rem', fontSize: '1.15rem' } }, E('🎁'), 'Rewards', h('span', { class: 'grow' }), h('button', { class: 'btn small', onclick: () => go('rewards') }, 'See all')), rows.slice(0, 6).map((r) => r.el));
}
function miniRow(r, person, have) {
  const pct = Math.min(100, Math.round((have / r.cost) * 100));
  return { pct, el: h('div', { class: 'mr' }, h('div', { class: 'row' }, E(person ? person.emoji : '👨‍👩‍👧‍👦'), h('span', { class: 'grow' }, `${r.emoji} ${r.name}`),
    have >= r.cost ? h('span', { class: 'ready-badge' }, 'Ready!') : h('span', { class: 'cnt' }, `${Math.min(have, r.cost)} / ${r.cost} ⭐`)), h('div', { class: 'rbar' }, h('i', { style: { width: pct + '%' } }))) };
}

// ---------------- calendar ----------------
const calById = (id) => S.state.calendars.find((c) => c.id === id);
const colorOf = (e) => { const c = calById(e.c); return c ? c.color : '#888'; };
const evPerson = (e) => (e.p !== undefined ? e.p : (calById(e.c) || {}).person_id || null);
const visibleEvents = () => S.events.filter((e) => (e.c === 0 || (!S.hidden.has(e.c) && calById(e.c))) && (!S.calPerson || evPerson(e) === S.calPerson));
function personFilter() {
  const ids = new Set(S.state.calendars.filter((c) => c.enabled && c.person_id).map((c) => c.person_id));
  for (const e of S.events) if (e.c === 0 && e.p) ids.add(e.p);
  const people = S.state.people.filter((p) => ids.has(p.id));
  if (S.calPerson && !people.some((p) => p.id === S.calPerson)) S.calPerson = null;
  if (!people.length) return null;
  const pick = (id) => { S.calPerson = id; localStorage.setItem('wc.calPerson', id || ''); renderView(); };
  return h('div', { class: 'pfilter', role: 'group', 'aria-label': 'Show calendar for' },
    h('button', { class: S.calPerson ? '' : 'on', onclick: () => pick(null) }, E('👨‍👩‍👧‍👦'), 'Everyone'),
    people.map((p) => h('button', { class: S.calPerson === p.id ? 'on' : '', style: { '--c': p.color }, onclick: () => pick(p.id) }, h('span', { class: 'pdot' }, p.emoji), p.name)));
}
function viewRange(viewOverride) {
  const v = viewOverride || S.cal.view || 'week';
  const a = S.cal.anchor ?? numFromKey(todayKey());
  const ws = set().week_start;
  let s, e;
  if (v === 'month') { const c = civil(a); const first = dayNum(c.y, c.m, 1); s = first - ((weekday(first) - ws + 7) % 7); e = s + 42; }
  else if (v === 'week') { s = a - ((weekday(a) - ws + 7) % 7); e = s + 7; }
  else if (v === 'day') { s = a; e = a + 1; }
  else { s = a; e = a + 21; }
  return [dayStartMs(s), dayStartMs(e), s, e];
}
function eventsByDay(s, e) {
  const map = new Map();
  for (let n = s; n < e; n++) map.set(n, []);
  for (const ev of visibleEvents()) {
    let a, b;
    if (ev.a) { a = numFromKey(ev.s); b = numFromKey(ev.e) - 1; }
    else { a = numFromKey(keyOf(ev.s)); b = numFromKey(keyOf(Math.max(ev.s, ev.e - 1))); }
    for (let n = Math.max(a, s); n <= Math.min(b, e - 1); n++) map.get(n).push(ev);
  }
  for (const list of map.values()) list.sort((x, y) => (y.a - x.a) || (x.a ? (x.s < y.s ? -1 : x.s > y.s ? 1 : 0) : x.s - y.s));
  return map;
}
function chip(ev, n, opts = {}) {
  const multi = !ev.a && keyOf(ev.s) !== keyOf(Math.max(ev.s, ev.e - 1));
  let t = '';
  if (!ev.a) t = multi && keyOf(ev.s) !== dayKeyFromNum(n) ? 'cont.' : timeStr(ev.s, true);
  const past = !ev.a && ev.e < Date.now();
  return h('div', { class: 'chip' + (ev.a ? ' allday' : '') + (past && opts.fadePast ? ' past' : ''), style: { '--c': colorOf(ev) }, title: ev.t, onclick: (e) => { e.stopPropagation(); showEvent(ev); } },
    t ? h('span', { class: 't' }, t) : null, h('span', { class: 'n' }, ev.t), opts.loc && ev.l ? h('span', { class: 'loc' }, ev.l) : null);
}
const fmtDay = (n) => { const c = civil(n); return `${DOW[weekday(n)]}, ${MON[c.m - 1].slice(0, 3)} ${c.d}`; };
function showEvent(ev) {
  const cal = calById(ev.c);
  let when;
  if (ev.a) { const s = numFromKey(ev.s), e = numFromKey(ev.e) - 1; when = e > s ? `${fmtDay(s)} – ${fmtDay(e)} (all day)` : `${fmtDay(s)} · all day`; }
  else when = `${fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(ev.s))} · ${timeStr(ev.s)} – ${timeStr(ev.e)}`;
  const m = modal(h('div', null, h('h2', null, ev.t), h('p', null, when), ev.l ? h('p', null, '📍 ', ev.l) : null,
    cal ? h('p', { style: { color: 'var(--muted)' } }, h('span', { style: { display: 'inline-block', width: '.8rem', height: '.8rem', borderRadius: '50%', background: cal.color, marginRight: '.4rem' } }), cal.name) : null,
    h('div', { class: 'actions' }, h('span', { class: 'grow' }), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Close'))));
}
function calendarPanel(forceView) {
  if (forceView) S.cal.view = forceView;
  else if (isPhone() && S.cal.view === 'week') S.cal.view = 'agenda';
  const view = S.cal.view;
  const today = numFromKey(todayKey());
  const a = S.cal.anchor ?? today;
  const [, , s, e] = viewRange();
  const c = civil(a);
  let title;
  if (view === 'month') title = `${MON[c.m - 1]} ${c.y}`;
  else if (view === 'week') { const c1 = civil(s), c2 = civil(e - 1); title = c1.m === c2.m ? `${MON[c1.m - 1]} ${c1.d}–${c2.d}` : `${MON[c1.m - 1].slice(0, 3)} ${c1.d} – ${MON[c2.m - 1].slice(0, 3)} ${c2.d}`; }
  else if (view === 'day') title = a === today ? `Today · ${MON[c.m - 1].slice(0, 3)} ${c.d}` : `${DOWL[weekday(a)]}, ${MON[c.m - 1].slice(0, 3)} ${c.d}`;
  else title = a === today ? 'Coming up' : `From ${fmtDay(a)}`;
  const rerender = () => { renderView(); loadEvents().then(renderView); };
  const step = (d) => {
    let n = a;
    if (view === 'month') { const cc = civil(a); const mi = cc.m - 1 + d; n = dayNum(cc.y + Math.floor(mi / 12), ((mi % 12) + 12) % 12 + 1, 1); }
    else n = a + d * (view === 'week' ? 7 : view === 'day' ? 1 : 21);
    S.cal.anchor = n; rerender();
  };
  const views = isPhone() ? [['agenda', 'List'], ['day', 'Day'], ['month', 'Month']] : [['month', 'Month'], ['week', 'Week'], ['day', 'Day'], ['agenda', 'List']];
  const bar = h('div', { class: 'calbar' },
    h('h2', null, title),
    h('button', { class: 'pill round', 'aria-label': 'Previous', onclick: () => step(-1) }, '‹'),
    h('button', { class: 'pill', onclick: () => { S.cal.anchor = null; rerender(); } }, 'Today'),
    h('button', { class: 'pill round', 'aria-label': 'Next', onclick: () => step(1) }, '›'),
    forceView ? null : h('div', { class: 'seg' }, views.map(([v, l]) => h('button', { class: view === v ? 'on' : '', onclick: () => { S.cal.view = v; rerender(); } }, l))));
  const cals = S.state.calendars.filter((x) => x.enabled);
  const legend = cals.length > 1 ? h('div', { class: 'legend' }, cals.map((x) => h('button', { class: S.hidden.has(x.id) ? 'off' : '', onclick: () => { S.hidden.has(x.id) ? S.hidden.delete(x.id) : S.hidden.add(x.id); localStorage.setItem(LS.hidden, JSON.stringify([...S.hidden])); renderView(); } }, h('i', { style: { background: x.color } }), x.name))) : null;
  let body;
  if (!cals.length) body = h('div', { class: 'empty-state' }, h('div', { class: 'big' }, '📅'), h('p', null, 'No calendars yet.'), h('button', { class: 'btn primary', onclick: async () => { if (await needParent()) { go('settings'); editCalendar(null); } } }, 'Add a calendar'));
  else if (view === 'month') body = monthView(s, e, a, today);
  else if (view === 'week') body = weekView(s, today);
  else if (view === 'day') body = dayView(a, today);
  else body = agendaView(s, e, today);
  const pf = cals.length ? personFilter() : null;
  return h('div', { class: 'cal' }, bar, pf || legend ? h('div', { class: 'calfilters' }, pf, legend) : null, h('div', { class: 'calbody' }, body));
}
function monthView(s, e, a, today) {
  const map = eventsByDay(s, e);
  const ws = set().week_start, m = civil(a).m, phone = isPhone();
  const grid = h('div', { class: 'month has-dow', style: { gridTemplateRows: `2rem repeat(6, minmax(${phone ? '3.8rem' : '5.5rem'}, 1fr))` } });
  for (let i = 0; i < 7; i++) grid.append(h('div', { class: 'dow' }, DOW[(i + ws) % 7]));
  const maxChips = 2; // a third row would be clipped at 1080p; the rest go in "+N more"
  for (let n = s; n < e; n++) {
    const list = map.get(n);
    const cell = h('div', { class: 'mcell' + (civil(n).m !== m ? ' other' : '') + (n === today ? ' today' : ''), onclick: () => { S.cal.anchor = n; S.cal.view = 'day'; renderView(); } },
      h('div', { class: 'mhead' }, h('div', { class: 'num' }, civil(n).d), list.length > maxChips ? h('div', { class: 'more' }, `+${list.length - maxChips} more`) : null));
    list.slice(0, maxChips).forEach((ev) => cell.append(phone ? h('div', { class: 'chip' + (ev.a ? ' allday' : ''), style: { '--c': colorOf(ev), padding: '0 .2rem', fontSize: '.68rem' } }, h('span', { class: 'n' }, ev.t)) : chip(ev, n)));
    grid.append(cell);
  }
  return grid;
}
function weekView(s, today) {
  const map = eventsByDay(s, s + 7);
  return h('div', { class: 'week' }, Array.from({ length: 7 }, (_, i) => {
    const n = s + i, list = map.get(n);
    return h('div', { class: 'wcol' + (n === today ? ' today' : ''), onclick: () => { S.cal.anchor = n; S.cal.view = 'day'; renderView(); } },
      h('div', { class: 'wh' }, h('div', { class: 'd' }, DOW[weekday(n)]), h('div', { class: 'n' }, civil(n).d)),
      list.length ? list.map((ev) => chip(ev, n, { fadePast: true })) : h('div', { class: 'empty' }, '—'));
  }));
}
function dayView(n, today) {
  const list = eventsByDay(n, n + 1).get(n);
  const allday = list.filter((x) => x.a), timed = list.filter((x) => !x.a);
  const d0 = dayStartMs(n), d1 = dayStartMs(n + 1);
  let startH = 7, endH = 21;
  for (const ev of timed) { startH = Math.min(startH, Math.max(0, Math.floor((Math.max(ev.s, d0) - d0) / 3600e3))); endH = Math.max(endH, Math.min(24, Math.ceil((Math.min(ev.e, d1) - d0) / 3600e3))); }
  const HR = 4 * parseFloat(getComputedStyle(document.documentElement).fontSize);
  const hours = h('div', { class: 'hours' }), lane = h('div', { class: 'lane' });
  for (let hh = startH; hh < endH; hh++) { hours.append(h('div', { class: 'hr' }, h('span', null, timeStr(d0 + hh * 3600e3, true)))); lane.append(h('div', { class: 'hl' })); }
  const items = timed.map((ev) => { const st = Math.max(ev.s, d0); return { ev, s: st, e: Math.max(Math.min(ev.e, d1), st + 20 * 60e3) }; }).sort((x, y) => x.s - y.s || y.e - x.e);
  let cols = [], group = [], groupEnd = 0;
  const flush = () => { const nCols = Math.max(...group.map((g) => g.col)) + 1; group.forEach((g) => (g.n = nCols)); group = []; cols = []; };
  for (const it of items) {
    if (group.length && it.s >= groupEnd) flush();
    let ci = cols.findIndex((end) => end <= it.s); if (ci < 0) { ci = cols.length; cols.push(0); }
    cols[ci] = it.e; it.col = ci; group.push(it); groupEnd = Math.max(groupEnd, it.e);
  }
  if (group.length) flush();
  for (const it of items) {
    const top = ((it.s - d0) / 3600e3 - startH) * HR, height = Math.max(HR / 3, ((it.e - it.s) / 3600e3) * HR - 3);
    lane.append(h('div', { class: 'ev', style: { '--c': colorOf(it.ev), top: top + 'px', height: height + 'px', left: `calc(${(it.col / it.n) * 100}% + 4px)`, width: `calc(${100 / it.n}% - 8px)` }, onclick: () => showEvent(it.ev) },
      h('b', null, it.ev.t), h('small', null, `${timeStr(it.ev.s, true)} – ${timeStr(it.ev.e, true)}${it.ev.l ? ' · ' + it.ev.l : ''}`)));
  }
  if (n === today) { const off = (Date.now() - d0) / 3600e3 - startH; if (off >= 0 && off <= endH - startH) lane.append(h('div', { class: 'nowline', style: { top: off * HR + 'px' } })); }
  return h('div', null,
    allday.length ? h('div', { class: 'dayv' }, h('div', { class: 'alld' }, allday.map((ev) => chip(ev, n)))) : null,
    h('div', { class: 'dayv' }, hours, lane),
    !list.length ? h('p', { class: 'empty-state' }, 'Nothing on the calendar.') : null);
}
function agendaView(s, e, today) {
  const map = eventsByDay(s, e);
  const out = h('div', { class: 'agenda' });
  for (let n = s; n < e; n++) {
    const list = map.get(n).filter((ev) => ev.a || n !== today || ev.e > Date.now() - 30 * 60e3);
    if (!list.length && n !== today) continue;
    const label = n === today ? 'Today' : n === today + 1 ? (isPhone() ? 'Tmrw' : 'Tomorrow') : DOW[weekday(n)];
    const c = civil(n);
    out.append(h('div', { class: 'ad' + (n === today ? ' today' : '') }, h('div', { class: 'dl' }, h('span', null, label), h('b', null, c.d), h('span', null, MON[c.m - 1].slice(0, 3))),
      h('div', { class: 'items' }, list.length ? list.map((ev) => chip(ev, n, { loc: true })) : h('div', { style: { color: 'var(--muted)', paddingTop: '.6rem' } }, 'Nothing else today'))));
  }
  if (!out.children.length) out.append(h('p', { class: 'empty-state' }, 'Nothing coming up.'));
  return out;
}

// ---------------- chores ----------------
const taskById = (id) => S.state.tasks.find((t) => t.id === id);
const RECUR_LABEL = (t) => t.recur === 'daily' ? 'Every day' : t.recur === 'weekdays' ? 'School days (Mon–Fri)' : t.recur === 'weekly' ? (t.days || []).map((d) => DOW[d]).join(', ') : t.recur === 'once' ? `Once · ${t.date}` : t.recur;
function choresView() {
  const kids = kidsOf();
  const out = h('div', null);
  const pending = S.state.completions.filter((c) => c.status === 'pending');
  if (pending.length) {
    out.append(h('div', { class: 'section-title' }, E('⏳'), `Waiting for a parent (${pending.length})`, h('span', { class: 'grow' }),
      h('button', { class: 'btn small primary', onclick: async () => { if (!(await needParent())) return; try { for (const c of pending) await api('POST', `/completions/${c.id}/approve`); toast('All approved'); } catch (e) { handle(e); } refresh(); } }, 'Approve all')));
    out.append(h('div', { class: 'card hist' }, pending.map((c) => {
      const p = personById(c.person_id), t = taskById(c.task_id);
      return h('div', { class: 'hr' }, E(p ? p.emoji : '🙂'), h('div', { class: 'grow' }, h('b', null, `${p ? p.name : '?'}: ${t ? t.emoji + ' ' + t.title : 'Task'}`), h('br'), h('small', null, `${c.day === todayKey() ? 'Today' : c.day} · ${c.stars} ⭐`)),
        h('button', { class: 'btn small', onclick: async () => { try { await api('POST', `/completions/${c.id}/reject`); } catch (e) { handle(e); } refresh(); } }, 'Not yet'),
        h('button', { class: 'btn small primary', onclick: async () => { try { await api('POST', `/completions/${c.id}/approve`); toast(`+${c.stars} ⭐ for ${p ? p.name : ''}`); } catch (e) { handle(e); } refresh(); } }, 'Approve'));
    })));
  }
  out.append(h('div', { class: 'section-title' }, E('✅'), 'Today', h('span', { class: 'grow' }),
    h('button', { class: 'btn small', onclick: async () => { if (await needParent()) editTask(null, { kind: 'routine' }); } }, '+ Add routine'),
    h('button', { class: 'btn small', onclick: async () => { if (await needParent()) editTask(null); } }, '+ Add chore or habit')));
  if (kids.length) out.append(h('div', { class: 'kidpick' }, kids.map((k) => h('button', { class: 'kidswitch', style: { '--c': k.color }, onclick: () => go('kid/' + k.id) }, h('div', { class: 'avatar' }, k.emoji), `${k.name}'s page`))));
  if (!kids.length) out.append(h('div', { class: 'card empty-state' }, h('div', { class: 'big' }, '🧒'), h('p', null, 'Add your kids in Settings to start tracking chores and habits.'), h('button', { class: 'btn primary', onclick: async () => { if (await needParent()) { go('settings'); editPerson(null); } } }, 'Add a kid')));
  else out.append(h('div', { class: 'chores-grid' }, todayBoard(S.state.tasks, S.state.completions, kids, todayKey()).map((b) => kidCard(b, { showAll: true }))));

  // all tasks
  if (S.state.tasks.length) {
    out.append(h('div', { class: 'section-title' }, E('📋'), 'All chores, habits and activities'));
    out.append(h('div', { class: 'card sbox' }, S.state.tasks.map((t) => h('div', { class: 'srow' }, h('span', { class: 'emoji', style: { fontSize: '1.8rem' } }, t.emoji),
      h('div', { class: 'grow' }, h('b', null, t.title, t.active ? '' : ' (paused)'), h('small', null, `${t.kind[0].toUpperCase() + t.kind.slice(1)} · ${RECUR_LABEL(t)} · ${t.stars} ⭐ · ${t.assignees.map((id) => (personById(id) || {}).name).filter(Boolean).join(', ') || 'nobody'}`)),
      h('button', { class: 'btn small', onclick: async () => { if (await needParent()) editTask(t); } }, 'Edit')))));
  }
  // history
  out.append(h('div', { class: 'section-title' }, E('📜'), 'Star history'));
  const hist = S.state.ledger.slice(0, 40);
  out.append(h('div', { class: 'card hist' }, hist.length ? hist.map((l) => {
    const p = personById(l.person_id);
    return h('div', { class: 'hr' }, E(p ? p.emoji : '👤'), h('div', { class: 'grow' }, h('b', null, p ? p.name : 'Removed'), ' · ', l.note || l.kind, h('br'), h('small', { style: { color: 'var(--muted)' } }, `${fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(l.created_at))} ${timeStr(l.created_at, true)} · ${l.kind === 'earn' ? 'earned' : l.kind === 'redeem' ? 'reward' : 'adjusted by a parent'}`)),
      h('span', { class: 'delta ' + (l.delta >= 0 ? 'plus' : 'minus') }, (l.delta > 0 ? '+' : '') + l.delta + ' ⭐'));
  }) : h('p', { class: 'empty-state' }, 'No stars yet. Tick off a chore to earn some!')));
  return out;
}

// ---------------- rewards ----------------
function rewardsView() {
  const out = h('div', null);
  const kids = kidsOf();
  out.append(h('div', { class: 'section-title' }, E('⭐'), 'Stars', h('span', { class: 'grow' }),
    kids.length ? h('button', { class: 'btn small', onclick: async () => { if (await needParent()) adjustStars(); } }, 'Add or remove stars') : null,
    h('button', { class: 'btn small', onclick: async () => { if (await needParent()) editReward(null); } }, '+ New reward')));
  if (kids.length) out.append(h('div', { class: 'card sbox', style: { display: 'flex', flexWrap: 'wrap', gap: '1.5rem' } }, kids.map((k) => h('div', { style: { display: 'flex', alignItems: 'center', gap: '.6rem' } }, h('div', { class: 'avatar', style: { '--c': k.color, background: k.color, width: '3rem', height: '3rem', borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: '1.6rem' } }, k.emoji), h('div', null, h('b', null, k.name), h('div', { class: 'stars', 'data-stars': k.id }, E('⭐'), h('span', null, S.state.balances[k.id] || 0)))))));
  const rewards = S.state.rewards;
  if (!rewards.length) out.append(h('div', { class: 'card empty-state' }, h('div', { class: 'big' }, '🎁'), h('p', null, 'No rewards yet. Make one, like “Ice cream trip, 10 stars” or “Movie night, 25 stars for the whole family”.'), h('button', { class: 'btn primary', onclick: async () => { if (await needParent()) editReward(null); } }, 'Create a reward')));
  else out.append(h('div', { class: 'rewards-grid' }, rewards.map(rewardCard)));
  if (S.state.redemptions.length) {
    out.append(h('div', { class: 'section-title' }, E('🧾'), 'Redeemed'));
    out.append(h('div', { class: 'card hist' }, S.state.redemptions.slice(0, 30).map((r) => { const p = r.person_id ? personById(r.person_id) : null;
      return h('div', { class: 'hr' }, E(p ? p.emoji : '👨‍👩‍👧‍👦'), h('div', { class: 'grow' }, h('b', null, r.reward_name), ' · ', p ? p.name : 'Family', h('br'), h('small', { style: { color: 'var(--muted)' } }, fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(r.created_at)))), h('span', { class: 'delta minus' }, (p ? '−' + r.cost : r.cost) + ' ⭐'));
    })));
  }
  return out;
}
function rewardCard(r) {
  const linked = r.task_ids.map(taskById).filter(Boolean);
  const meta = [r.scope === 'family' ? 'Family goal' : 'Per kid', `${r.cost} ⭐`, linked.length ? 'From: ' + linked.map((t) => t.title).join(', ') : 'Any stars'].join(' · ');
  const card = h('div', { class: 'card rcard' + (r.active ? '' : ' off') },
    h('div', { class: 'rh' }, h('span', { class: 're' }, r.emoji), h('div', { class: 'grow', style: { flex: 1 } }, h('h3', null, r.name, r.active ? '' : ' (paused)'), h('div', { class: 'meta' }, meta)),
      h('button', { class: 'btn small', onclick: async () => { if (await needParent()) editReward(r); } }, 'Edit')),
    r.description ? h('p', { style: { margin: 0 } }, r.description) : null);
  const redeemBtn = (person, have) => h('button', { class: 'btn small ' + (have >= r.cost ? 'primary' : ''), disabled: have < r.cost || !r.active, onclick: () => redeem(r, person) }, have >= r.cost ? 'Redeem' : `${r.cost - have} to go`);
  if (r.progress.scope === 'family') {
    const have = r.progress.have, pct = Math.min(100, (have / r.cost) * 100);
    card.append(h('div', { class: 'progress' }, h('i', { style: { width: pct + '%' } })), h('div', { class: 'row', style: { display: 'flex', alignItems: 'center', gap: '.6rem' } }, h('b', { style: { flex: 1 } }, `${Math.min(have, r.cost)} / ${r.cost} ⭐ together`), redeemBtn(null, have)));
  } else {
    if (!r.progress.kids.length) card.append(h('p', { class: 'meta' }, 'No kids picked for this reward.'));
    for (const k of r.progress.kids) {
      const p = personById(k.person_id); if (!p) continue;
      const pct = Math.min(100, (k.have / r.cost) * 100);
      card.append(h('div', { class: 'rk' }, h('div', { class: 'avatar', style: { background: p.color, borderRadius: '50%', display: 'grid', placeItems: 'center' } }, p.emoji),
        h('div', null, h('b', null, p.name, ' ', h('small', { style: { color: 'var(--muted)', fontWeight: 600 } }, `${Math.min(k.have, r.cost)} / ${r.cost}`)), h('div', { class: 'rbar' }, h('i', { style: { width: pct + '%', background: p.color } }))),
        redeemBtn(p, k.have)));
    }
  }
  return card;
}
async function redeem(r, person) {
  if (!(await needParent())) return;
  const who = person ? person.name : 'the family';
  const ok = await confirmBox(`Redeem “${r.name}” for ${who}?`, person ? `This uses ${r.cost} of ${person.name}'s stars.` : 'This resets the family goal. Personal star balances stay the same.', 'Redeem');
  if (!ok) return;
  try { await api('POST', `/rewards/${r.id}/redeem`, { person_id: person ? person.id : null }); celebrate(document.body, 0, null); toast(`🎉 Enjoy: ${r.name}!`); } catch (e) { handle(e); }
  refresh();
}
function adjustStars() {
  const kids = kidsOf();
  const f = { person_id: kids[0].id, delta: 1, note: '' };
  formSheet('Add or remove stars', () => h('div', null,
    field('Who', chipsInput(f, 'person_id', kids.map((k) => ({ value: k.id, label: k.name, emoji: k.emoji })))),
    field('How many', stepper(f, 'delta', -50, 50), 'Use minus to take stars away.'),
    field('Why (optional)', textInput(f, 'note', { maxlength: 80, placeholder: 'Helped a sibling' }))), {
    onSave: async () => { if (!f.delta) throw new Error('Pick a number other than 0'); await api('POST', '/stars/adjust', f); toast('Stars updated'); },
  });
}

// ---------------- photos ----------------
function photosView() {
  const out = h('div', null);
  const albums = S.state.albums || [];
  if (S.album && !albums.some((a) => a.id === S.album)) S.album = null;
  const album = albums.find((a) => a.id === S.album);
  const shown = photosIn(S.album);
  const input = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: (e) => uploadPhotos([...e.target.files], S.album) });
  out.append(input, h('div', { class: 'section-title' }, E('🖼️'), album ? `${album.name} (${shown.length})` : `Photos (${S.state.photos.length})`, h('span', { class: 'grow' }),
    shown.length ? h('button', { class: 'btn small', onclick: () => startSlideshow(shown) }, '▶ Slideshow') : null,
    album ? h('button', { class: 'btn small', onclick: async () => { if (await needParent()) editAlbum(album); } }, 'Edit album') : null,
    h('button', { class: 'btn small primary', onclick: async () => { if (await needParent()) input.click(); } }, album ? `+ Add to ${album.name}` : '+ Add photos')));
  out.append(h('div', { class: 'albumbar chips' },
    h('button', { class: S.album ? '' : 'on', onclick: () => { S.album = null; renderView(); } }, E('🖼️'), `All photos · ${S.state.photos.length}`),
    albums.map((a) => h('button', { class: S.album === a.id ? 'on' : '', 'data-album': a.id, onclick: () => { S.album = a.id; renderView(); } }, E(a.emoji), `${a.name} · ${photosIn(a.id).length}`)),
    h('button', { class: 'add', onclick: async () => { if (await needParent()) editAlbum(null); } }, '+ New album')));
  if (!shown.length) out.append(h('div', { class: 'card empty-state' }, h('div', { class: 'big' }, '📷'), h('p', null, album ? `No photos in ${album.name} yet. Add new ones here, or tag existing photos with 🏷 on All photos.` : 'Add family photos from a phone or computer. They show as a slideshow when the screen is idle.')));
  else out.append(h('div', { class: 'photos-grid' }, shown.map((p, i) => h('div', { class: 'ph' },
    h('img', { src: `/api/photos/${p.id}/thumb`, loading: 'lazy', alt: p.caption || 'Family photo', onclick: () => startSlideshow(shown, i) }),
    albumIdsOf(p.id).length ? h('div', { class: 'tags' }, albumIdsOf(p.id).map((id) => (albums.find((a) => a.id === id) || {}).emoji).filter(Boolean).join(' ')) : null,
    S.status.parent ? h('div', { class: 'tools' },
      albums.length ? h('button', { 'aria-label': 'Albums for this photo', onclick: () => photoAlbums(p) }, '🏷') : null,
      h('button', { 'aria-label': 'Delete photo', onclick: async () => { if (!(await confirmBox('Delete this photo?', null, 'Delete', true))) return; try { await api('DELETE', `/photos/${p.id}`); } catch (e) { handle(e); } refresh(); } }, '🗑')) : null))));
  if (albums.length) {
    const want = set().slideshow_albums || [];
    out.append(h('div', { class: 'section-title' }, E('▶️'), 'Idle slideshow shows'));
    out.append(h('div', { class: 'card sbox' }, h('div', { class: 'chips slidepick' },
      h('button', { class: want.length ? '' : 'on', onclick: async () => { if (await needParent()) saveSlideAlbums([]); } }, E('🖼️'), 'All photos'),
      albums.map((a) => h('button', { class: want.includes(a.id) ? 'on' : '', onclick: async () => { if (await needParent()) saveSlideAlbums(want.includes(a.id) ? want.filter((x) => x !== a.id) : [...want, a.id]); } }, E(a.emoji), a.name))),
      h('p', { class: 'help' }, want.length ? `${slideshowPhotos().length} photos from the picked albums.` : 'Every photo is used. Pick albums to limit it.')));
  }
  return out;
}
async function saveSlideAlbums(ids) {
  try { const r = await api('PUT', '/settings', { slideshow_albums: ids }); S.state.settings = r.settings; renderView(); } catch (e) { handle(e); }
}
EMOJI.albums = ['📁', '🏖️', '🎄', '🎂', '🏕️', '⚽', '🐶', '👶', '👵', '🏡', '✈️', '🎃', '🌸', '❄️', '🎓', '❤️'];
function editAlbum(a) {
  const f = a ? { ...a } : { name: '', emoji: '📁' };
  formSheet(a ? 'Edit album' : 'New album', () => h('div', null,
    field('Name', textInput(f, 'name', { maxlength: 40, placeholder: 'Summer 2026, Grandparents…' })),
    field('Icon', emojiInput(f, 'emoji', 'albums'))), {
    onSave: async () => { const r = await api(a ? 'PUT' : 'POST', a ? `/albums/${a.id}` : '/albums', f); if (!a) S.album = r.id; toast('Saved'); },
    onDelete: a ? async () => confirmBox(`Delete the album “${a.name}”?`, 'The photos stay in All photos.', 'Delete', true).then(async (ok) => { if (ok) await api('DELETE', `/albums/${a.id}`); return ok; }) : null,
  });
}
function photoAlbums(p) {
  const f = { ids: albumIdsOf(p.id) };
  formSheet('Albums for this photo', () => h('div', null, h('img', { src: `/api/photos/${p.id}/thumb`, alt: '', style: { maxHeight: '10rem', borderRadius: '12px', display: 'block', marginBottom: '1rem' } }),
    field('In albums', chipsInput(f, 'ids', S.state.albums.map((a) => ({ value: a.id, label: a.name, emoji: a.emoji })), { multi: true }))), {
    onSave: async () => { await api('PUT', `/photos/${p.id}/albums`, { album_ids: f.ids }); toast('Saved'); },
  });
}
async function resize(file, max, q) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(async () => {
    const img = new Image(); img.src = URL.createObjectURL(file); await img.decode(); return img;
  });
  const w0 = bmp.width, h0 = bmp.height, sc = Math.min(1, max / Math.max(w0, h0));
  const w = Math.round(w0 * sc), hh = Math.round(h0 * sc);
  const c = document.createElement('canvas'); c.width = w; c.height = hh;
  c.getContext('2d').drawImage(bmp, 0, 0, w, hh);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', q));
  return { blob, w, h: hh };
}
async function uploadPhotos(files, albumId) {
  let ok = 0;
  for (const [i, f] of files.entries()) {
    toast(`Uploading ${i + 1} of ${files.length}…`, 60000);
    try {
      let big = await resize(f, 1920, 0.85);
      if (big.blob.size > 1.4e6) big = await resize(f, 1600, 0.75);
      const th = await resize(f, 480, 0.7);
      const fd = new FormData();
      fd.append('photo', big.blob, 'photo.jpg'); fd.append('thumb', th.blob, 'thumb.jpg'); fd.append('w', big.w); fd.append('h', big.h); if (albumId) fd.append('album_id', albumId);
      await api('POST', '/photos', fd); ok++;
    } catch (e) { handle(e); if (e.cancelled) break; }
  }
  toast(`${ok} photo${ok === 1 ? '' : 's'} added`);
  refresh();
}

// ---------------- lists ----------------
const COMMON_GROCERIES = ['Milk', 'Eggs', 'Bread', 'Bananas', 'Apples', 'Butter', 'Cheese', 'Yogurt', 'Chicken', 'Ground beef', 'Rice', 'Pasta', 'Cereal', 'Berries', 'Lettuce', 'Tomatoes', 'Onions', 'Potatoes', 'Carrots', 'Coffee', 'Snacks', 'Paper towels', 'Toilet paper', 'Dish soap'];
EMOJI.lists = ['🛒', '📝', '✅', '🏠', '🧺', '🎒', '🎁', '🧳', '🛠️', '🐾', '💊', '🎄', '🎂', '📦', '🧽', '🌱'];
EMOJI.food = ['🍲', '🍝', '🌮', '🍕', '🍔', '🌭', '🥗', '🍛', '🍜', '🍣', '🍗', '🥩', '🐟', '🥘', '🌯', '🥪', '🍳', '🥞', '🧇', '🥣', '🍞', '🥔', '🌽', '🍚', '🍤', '🥟', '🍱', '🍽️'];
const itemsOf = (lid) => S.state.list_items.filter((i) => i.list_id === lid);
const openItemsOf = (lid) => itemsOf(lid).filter((i) => !i.done);
const groceryList = () => S.state.lists.find((l) => l.kind === 'grocery') || S.state.lists[0];
function listsView() {
  const lists = S.state.lists;
  const out = h('div', { class: 'listsv' });
  out.append(h('div', { class: 'section-title' }, E('🛒'), 'Lists', h('span', { class: 'grow' }),
    h('button', { class: 'btn small', onclick: async () => { if (await needParent()) editList(null); } }, '+ New list')));
  if (!lists.length) { out.append(h('div', { class: 'card empty-state' }, h('div', { class: 'big' }, '🛒'), h('p', null, 'No lists yet. Make a grocery list or a to-do list the whole family can add to.'), h('button', { class: 'btn primary', onclick: async () => { if (await needParent()) editList(null); } }, 'Create a list'))); return out; }
  if (isPhone()) {
    if (!lists.some((l) => l.id === S.listSel)) S.listSel = lists[0].id;
    out.append(h('div', { class: 'list-tabs' }, lists.map((l) => h('button', { class: l.id === S.listSel ? 'on' : '', onclick: () => { S.listSel = l.id; renderView(); } }, E(l.emoji), l.name, h('span', { class: 'cnt' }, openItemsOf(l.id).length)))));
    out.append(listCard(lists.find((l) => l.id === S.listSel)));
  } else out.append(h('div', { class: 'lists-grid' }, lists.map((l) => listCard(l))));
  return out;
}
function addBox(l, { onAdded, autofocus } = {}) {
  const input = h('input', { type: 'text', 'data-list': l.id, placeholder: l.kind === 'grocery' ? 'Add an item… (milk, eggs)' : 'Add a to-do…', maxlength: 300, autocomplete: 'off', enterkeyhint: 'done',
    onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } } });
  const add = async (text) => {
    const t = (text ?? input.value).trim(); if (!t) { input.focus(); return; }
    if (text == null) input.value = '';
    try { await api('POST', `/lists/${l.id}/items`, { text: t }); if (text == null) S.refocus = `input[data-list="${l.id}"]`; } catch (e) { handle(e); }
    if (onAdded) onAdded(); else refresh();
  };
  const box = h('div', { class: 'addrow' }, input, h('button', { class: 'btn primary', onclick: () => add() }, 'Add'));
  if (autofocus) setTimeout(() => input.focus(), 60);
  const open = new Set(openItemsOf(l.id).map((i) => i.text.toLowerCase()));
  const sugg = l.kind === 'grocery' ? COMMON_GROCERIES.filter((x) => !open.has(x.toLowerCase())).slice(0, isPhone() ? 8 : 10) : [];
  return h('div', null, box, sugg.length ? h('div', { class: 'sugg' }, sugg.map((x) => h('button', { onclick: (e) => { e.currentTarget.remove(); add(x); } }, '+ ', x))) : null);
}
function listCard(l) {
  const items = itemsOf(l.id), open = items.filter((i) => !i.done), done = items.filter((i) => i.done);
  return h('div', { class: 'card listcard' },
    h('div', { class: 'lhead' }, E(l.emoji), h('h3', null, l.name), h('span', { class: 'cnt' }, open.length ? `${open.length} to get`.replace('to get', l.kind === 'grocery' ? 'to get' : 'left') : 'All done'), h('span', { class: 'grow' }),
      done.length ? h('button', { class: 'btn small', onclick: () => clearDone(l) }, `Clear ${done.length} checked`) : null,
      h('button', { class: 'btn small', 'aria-label': `Edit ${l.name}`, onclick: async () => { if (await needParent()) editList(l); } }, '✏️')),
    addBox(l),
    h('div', { class: 'litems' }, open.map(itemRow), done.map(itemRow), !items.length ? h('p', { class: 'empty-note' }, l.kind === 'grocery' ? 'Nothing on the list. Tap a suggestion or type above.' : 'Nothing to do. Nice!') : null));
}
function itemRow(it) {
  return h('div', { class: 'li' + (it.done ? ' done' : '') },
    h('button', { class: 'lck', onclick: () => toggleItem(it) }, h('span', { class: 'box' }, it.done ? '✓' : ''), h('span', { class: 'lt' }, it.text, it.source ? h('small', null, it.source) : null)),
    h('button', { class: 'lx', 'aria-label': `Remove ${it.text}`, onclick: () => deleteItem(it) }, '✕'));
}
async function toggleItem(it) {
  it.done = !it.done; it.done_at = Date.now(); renderView();
  try { await api('PUT', `/items/${it.id}`, { done: it.done }); } catch (e) { handle(e); }
  refresh();
}
async function deleteItem(it) {
  S.state.list_items = S.state.list_items.filter((x) => x.id !== it.id); renderView();
  try { await api('DELETE', `/items/${it.id}`); } catch (e) { handle(e); }
  refresh();
}
async function clearDone(l) {
  S.state.list_items = S.state.list_items.filter((x) => !(x.list_id === l.id && x.done)); renderView();
  try { const r = await api('POST', `/lists/${l.id}/clear`); toast(`Cleared ${r.removed} checked item${r.removed === 1 ? '' : 's'}`); } catch (e) { handle(e); }
  refresh();
}
function editList(l) {
  const f = l ? { ...l } : { name: '', emoji: '📝', kind: 'todo' };
  formSheet(l ? `Edit ${l.name}` : 'New list', () => h('div', null,
    field('Name', textInput(f, 'name', { maxlength: 40, placeholder: 'Costco, Target, Chores to do…' })),
    field('Type', chipsInput(f, 'kind', [{ value: 'grocery', label: 'Shopping', emoji: '🛒' }, { value: 'todo', label: 'To-do', emoji: '📝' }]), 'Shopping lists show quick-add suggestions and can receive meal ingredients.'),
    field('Icon', emojiInput(f, 'emoji', 'lists'))), {
    onSave: async () => { if (!f.name.trim()) throw new Error('Give the list a name'); await api(l ? 'PUT' : 'POST', l ? `/lists/${l.id}` : '/lists', f); toast('Saved'); },
    onDelete: l ? async () => confirmBox(`Delete “${l.name}”?`, 'Everything on this list is deleted too.', 'Delete', true).then(async (ok) => { if (ok) await api('DELETE', `/lists/${l.id}`); return ok; }) : null,
  });
}
function quickAdd(l) {
  let m;
  const body = h('div', null);
  const draw = () => body.replaceChildren(h('h2', null, E(l.emoji), ' Add to ', l.name), addBox(l, { autofocus: !isPhone(), onAdded: async () => { await refresh(); toast('Added'); draw(); } }),
    h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { m.close(); go('lists'); } }, 'Open list'), h('span', { class: 'grow' }), h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done')));
  draw();
  m = modal(body);
}
function listMini() {
  const l = groceryList(); if (!l) return null;
  const open = openItemsOf(l.id);
  return h('div', { class: 'card mini-list' },
    h('div', { class: 'section-title mini-title' }, E(l.emoji), l.name, h('span', { class: 'badge' }, open.length), h('span', { class: 'grow' }),
      h('button', { class: 'btn small', onclick: () => quickAdd(l) }, '+ Add'), h('button', { class: 'btn small', onclick: () => go('lists') }, 'Open')),
    open.length ? h('div', { class: 'litems' }, open.slice(0, 6).map(itemRow), open.length > 6 ? h('button', { class: 'more-link', onclick: () => go('lists') }, `+${open.length - 6} more`) : null) : h('p', { class: 'empty-note' }, 'The list is empty.'));
}

// ---------------- meal plan ----------------
const SLOT = { breakfast: ['🥞', 'Breakfast'], lunch: ['🥪', 'Lunch'], dinner: ['🍲', 'Dinner'] };
const mealSlots = () => (set().meal_slots && set().meal_slots.length ? set().meal_slots : ['dinner']);
const mealOf = (day, slot) => S.state.meals.find((x) => x.day === day && x.slot === slot);
function mealsView() {
  const today = numFromKey(todayKey());
  const start = S.mealStart ?? today;
  const slots = mealSlots();
  const days = Array.from({ length: 7 }, (_, i) => start + i);
  const c1 = civil(start), c2 = civil(start + 6);
  const label = start === today ? 'Next 7 days' : `${MON[c1.m - 1].slice(0, 3)} ${c1.d} – ${MON[c2.m - 1].slice(0, 3)} ${c2.d}`;
  const nav = (d) => { S.mealStart = Math.max(today - 14, Math.min(today + 35, start + d)); renderView(); };
  const out = h('div', { class: 'mealsv' });
  out.append(h('div', { class: 'section-title' }, E('🍽️'), 'Meal plan', h('span', { class: 'muted-title' }, label), h('span', { class: 'grow' }),
    h('button', { class: 'pill round', 'aria-label': 'Previous week', disabled: start <= today - 14, onclick: () => nav(-7) }, '‹'),
    h('button', { class: 'pill', onclick: () => { S.mealStart = null; renderView(); } }, 'Today'),
    h('button', { class: 'pill round', 'aria-label': 'Next week', disabled: start >= today + 35, onclick: () => nav(7) }, '›')));
  out.append(h('div', { class: 'meal-tools' },
    h('div', { class: 'chips' }, Object.entries(SLOT).map(([k, [ico, l]]) => h('button', { class: slots.includes(k) ? 'on' : '', onclick: async () => {
      if (!(await needParent())) return;
      const next = slots.includes(k) ? slots.filter((x) => x !== k) : [...slots, k];
      if (!next.length) return toast('Keep at least one meal');
      saveSettings({ meal_slots: next });
    } }, E(ico), l))),
    h('span', { class: 'grow' }),
    S.state.lists.length ? h('button', { class: 'btn small', onclick: () => mealsToList(days.map(dayKeyFromNum)) }, '🛒 Add this week’s ingredients to a list') : null));
  const grid = h('div', { class: 'meals-grid', style: { '--rows': slots.length } });
  for (const n of days) {
    const key = dayKeyFromNum(n), c = civil(n);
    const col = h('div', { class: 'mday' + (n === today ? ' today' : '') }, h('div', { class: 'mdh' }, h('b', null, n === today ? 'Today' : n === today + 1 ? 'Tomorrow' : DOWL[weekday(n)]), h('span', null, `${MON[c.m - 1].slice(0, 3)} ${c.d}`)));
    for (const slot of slots) {
      const ml = mealOf(key, slot);
      col.append(h('button', { class: 'meal' + (ml ? '' : ' empty'), onclick: () => (ml ? showMeal(key, slot) : editMeal(key, slot)) },
        slots.length > 1 ? h('span', { class: 'ms' }, SLOT[slot][1]) : null,
        ml ? [h('span', { class: 'me' }, ml.emoji || SLOT[slot][0]), h('span', { class: 'mt' }, ml.title), ml.ingredients.length ? h('small', null, `${ml.ingredients.length} ingredient${ml.ingredients.length === 1 ? '' : 's'}`) : null]
          : h('span', { class: 'madd' }, '+ Add')));
    }
    grid.append(col);
  }
  out.append(grid);
  return out;
}
function showMeal(day, slot) {
  const ml = mealOf(day, slot); if (!ml) return editMeal(day, slot);
  const n = numFromKey(day);
  let m;
  m = modal(h('div', null, h('div', { class: 'meal-hero' }, E(ml.emoji || SLOT[slot][0]), h('div', null, h('h2', null, ml.title), h('p', { class: 'muted' }, `${SLOT[slot][1]} · ${fmtDay(n)}`))),
    ml.note ? h('p', null, ml.note) : null,
    ml.ingredients.length ? h('div', null, h('b', null, 'Ingredients'), h('ul', { class: 'ing' }, ml.ingredients.map((x) => h('li', null, x)))) : h('p', { class: 'muted' }, 'No ingredients listed.'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: async () => { if (await needParent()) { m.close(true); editMeal(day, slot); } } }, 'Edit'),
      h('span', { class: 'grow' }),
      ml.ingredients.length && S.state.lists.length ? h('button', { class: 'btn primary', onclick: async () => { m.close(true); await mealsToList([day], slot); } }, '🛒 Add ingredients to list') : null,
      h('button', { class: 'btn', onclick: () => m.close() }, 'Close'))));
}
async function editMeal(day, slot) {
  if (!(await needParent())) return;
  const ml = mealOf(day, slot);
  const f = { day, slot, title: ml ? ml.title : '', emoji: ml ? ml.emoji : '', ingredients: ml ? ml.ingredients.join('\n') : '', note: ml ? ml.note : '' };
  const favs = [];
  for (const x of [...S.state.meals].reverse()) if (x.title && !favs.some((y) => y.title.toLowerCase() === x.title.toLowerCase())) favs.push(x);
  let titleEl, ingEl, emojiBox;
  formSheet(`${SLOT[slot][1]} · ${fmtDay(numFromKey(day))}`, () => {
    titleEl = textInput(f, 'title', { maxlength: 80, placeholder: 'Tacos, spaghetti, leftovers…' });
    ingEl = h('textarea', { rows: 5, placeholder: 'One per line, or separated by commas', oninput: (e) => (f.ingredients = e.target.value) }); ingEl.value = f.ingredients;
    emojiBox = h('div', null, emojiInput(f, 'emoji', 'food'));
    return h('div', null,
      favs.length ? field('Recent meals', h('div', { class: 'chips' }, favs.slice(0, 10).map((x) => h('button', { type: 'button', onclick: () => { f.title = x.title; f.emoji = x.emoji; f.ingredients = x.ingredients.join('\n'); titleEl.value = f.title; ingEl.value = f.ingredients; emojiBox.replaceChildren(emojiInput(f, 'emoji', 'food')); } }, x.emoji ? E(x.emoji) : null, x.title)))) : null,
      field('Meal', titleEl), field('Icon', emojiBox), field('Ingredients (optional)', ingEl, 'Send them to a shopping list from the meal or the week.'),
      field('Note (optional)', textInput(f, 'note', { maxlength: 200, placeholder: 'Thaw chicken in the morning' })));
  }, {
    onSave: async () => { if (!f.title.trim()) throw new Error('Type a meal, or use Delete to clear it'); await api('PUT', '/meals', f); toast('Meal saved'); },
    onDelete: ml ? async () => { await api('PUT', '/meals', { day, slot, title: '' }); toast('Meal cleared'); return true; } : null,
  });
}
async function pickList(title) {
  const lists = S.state.lists; if (lists.length <= 1) return lists[0] || null;
  return new Promise((resolve) => {
    let picked = null;
    const m = modal(h('div', null, h('h2', null, title), h('div', { class: 'setup-list' }, lists.map((l) => h('button', { onclick: () => { picked = l; m.close(); } }, E(l.emoji), l.name, h('span', { class: 'grow' }), h('small', null, `${openItemsOf(l.id).length} items`))))), { cancel: true, onClose: () => resolve(picked) });
  });
}
async function mealsToList(days, slot) {
  const want = S.state.meals.filter((x) => days.includes(x.day) && (!slot || x.slot === slot) && x.ingredients.length);
  if (!want.length) return toast('No ingredients on those meals yet');
  const l = await pickList('Add ingredients to which list?'); if (!l) return;
  try {
    const r = await api('POST', '/meals/to-list', { list_id: l.id, days, slot });
    toast(r.added ? `Added ${r.added} item${r.added === 1 ? '' : 's'} to ${r.list}${r.skipped ? ` (${r.skipped} already there)` : ''}` : `Everything is already on ${r.list}`, 4000);
  } catch (e) { handle(e); }
  refresh();
}
function mealsMini() {
  const t = numFromKey(todayKey()), slots = mealSlots();
  const rows = [0, 1, 2].map((d) => {
    const key = dayKeyFromNum(t + d);
    const ms = slots.map((sl) => [sl, mealOf(key, sl)]).filter(([, x]) => x);
    return h('button', { class: 'mm-row', onclick: () => (ms.length === 1 ? showMeal(key, ms[0][0]) : go('meals')) },
      h('span', { class: 'mm-day' }, d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : DOW[weekday(t + d)]),
      ms.length ? h('span', { class: 'mm-meals' }, ms.map(([sl, x]) => h('span', { class: 'mm-m' }, E(x.emoji || SLOT[sl][0]), ' ', x.title))) : h('span', { class: 'mm-none' }, 'Not planned'));
  });
  return h('div', { class: 'card mini-meals' }, h('div', { class: 'section-title mini-title' }, E('🍽️'), 'Meals', h('span', { class: 'grow' }), h('button', { class: 'btn small', onclick: () => go('meals') }, 'Plan')), rows);
}

// ---------------- settings ----------------
function settingsView() {
  if (!S.status.parent) return h('div', { class: 'card lockbar' }, E('🔒'), h('div', { class: 'grow' }, h('b', null, 'Settings are for parents'), h('br'), h('small', null, 'Enter the parent PIN to change family members, calendars, rewards and the display.')),
    h('button', { class: 'btn primary', onclick: async () => { if (await askPin()) refresh(); } }, 'Unlock'));
  const st = set();
  const box = (ico, title, action, ...rows) => h('div', { class: 'card sbox' }, h('h3', null, E(ico), title, h('span', { class: 'grow' }), action), ...rows);
  const people = S.state.people;
  const out = h('div', { class: 'settings' });
  out.append(box('👨‍👩‍👧‍👦', 'Family', h('button', { class: 'btn small', onclick: () => editPerson(null) }, '+ Add person'),
    h('p', { class: 'hint' }, 'Kids get chores, habits, stars and rewards. Parents can have a calendar color.'),
    people.length ? people.map((p) => h('div', { class: 'srow' }, h('div', { style: { width: '2.8rem', height: '2.8rem', borderRadius: '50%', background: p.color, display: 'grid', placeItems: 'center', fontSize: '1.5rem' } }, p.emoji),
      h('div', { class: 'grow' }, h('b', null, p.name), h('small', null, p.role === 'kid' ? `Kid · ${S.state.balances[p.id] || 0} ⭐` : 'Parent')),
      h('button', { class: 'btn small', onclick: () => editPerson(p) }, 'Edit'))) : h('p', null, 'Nobody yet.')));
  out.append(box('📅', 'Calendars', h('span', null, h('button', { class: 'btn small', onclick: async () => { toast('Syncing…'); try { const r = await api('POST', '/sync'); const bad = r.results.filter((x) => x.error); toast(bad.length ? `${bad.length} calendar(s) failed` : 'Calendars synced'); } catch (e) { handle(e); } await loadEvents(true); refresh(); } }, 'Sync now'), ' ', h('button', { class: 'btn small', onclick: () => editCalendar(null) }, '+ Add')),
    h('p', { class: 'hint' }, 'Paste a private calendar link (iCloud public calendar or Google “secret address in iCal format”). The screen checks for changes every 10 minutes.'),
    S.state.calendars.length ? S.state.calendars.map((c) => h('div', { class: 'srow' }, h('span', { style: { width: '1.4rem', height: '1.4rem', borderRadius: '50%', background: c.color, flex: 'none' } }),
      h('div', { class: 'grow' }, h('b', null, c.name, c.enabled ? '' : ' (hidden)'), h('small', { style: c.error ? { color: 'var(--bad)' } : null }, c.error ? `⚠ ${c.error}` : `${c.event_count} events · synced ${ago(c.ok_at)}`)),
      h('button', { class: 'btn small', onclick: () => editCalendar(c) }, 'Edit'))) : h('p', null, 'No calendars yet.')));
  out.append(box('✅', 'Chores & habits', h('button', { class: 'btn small', onclick: () => editTask(null) }, '+ Add'),
    h('p', { class: 'hint' }, `${S.state.tasks.length} set up. Manage them on the Chores page.`),
    h('div', { class: 'srow' }, h('div', { class: 'grow' }, h('b', null, 'Parent approval for stars'), h('small', null, 'When on, kids\u2019 taps wait for a parent before stars are added.')),
      settingToggle('approval')),
    h('button', { class: 'btn small', onclick: () => go('chores') }, 'Open Chores')));
  out.append(box('🎁', 'Rewards', h('button', { class: 'btn small', onclick: () => editReward(null) }, '+ Add'),
    S.state.rewards.length ? S.state.rewards.map((r) => h('div', { class: 'srow' }, h('span', { class: 'emoji', style: { fontSize: '1.7rem' } }, r.emoji), h('div', { class: 'grow' }, h('b', null, r.name), h('small', null, `${r.cost} ⭐ · ${r.scope === 'family' ? 'Family goal' : 'Per kid'}${r.active ? '' : ' · paused'}`)), h('button', { class: 'btn small', onclick: () => editReward(r) }, 'Edit'))) : h('p', null, 'No rewards yet.')));
  out.append(box('🌤️', 'Weather', h('button', { class: 'btn small', onclick: editWeather }, st.weather ? 'Change' : 'Set location'),
    h('div', { class: 'srow' }, h('div', { class: 'grow' }, h('b', null, st.weather ? [st.weather.name, st.weather.region].filter(Boolean).join(', ') : 'No location yet'), h('small', null, 'Forecast from Open-Meteo')),
      seg(st.units, [['F', '°F'], ['C', '°C']], (v) => saveSettings({ units: v })))));
  out.append(box('🖥️', 'Display', h('button', { class: 'btn small', onclick: editDisplay }, 'Change'),
    h('div', { class: 'srow' }, h('div', { class: 'grow' }, h('b', null, 'Theme'), h('small', null, 'Auto is light by day and dark at night.')), seg(st.theme, [['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']], (v) => saveSettings({ theme: v }))),
    h('div', { class: 'srow' }, h('div', { class: 'grow' }, h('b', null, 'Night'), h('small', null, `${st.night_start} – ${st.night_end}, dims ${st.night_dim}%`))),
    h('div', { class: 'srow' }, h('div', { class: 'grow' }, h('b', null, 'Photo slideshow'), h('small', null, st.idle_minutes ? `After ${st.idle_minutes} min idle, ${st.slide_seconds}s per photo` : 'Off'))),
    h('div', { class: 'srow' }, h('div', { class: 'grow' }, h('b', null, 'Time zone'), h('small', null, st.tz)))));
  out.append(box('🔑', 'Security', null,
    h('div', { class: 'srow' }, h('div', { class: 'grow' }, h('b', null, 'Parent PIN'), h('small', null, 'Needed for settings, rewards and photos.')), h('button', { class: 'btn small', onclick: changePin }, 'Change PIN')),
    h('div', { class: 'srow' }, h('div', { class: 'grow' }, h('b', null, 'Connected screens and phones'), h('small', null, 'Disconnect every other device. They will need the PIN again.')),
      h('button', { class: 'btn small danger', onclick: async () => { if (await confirmBox('Disconnect all other devices?', 'This screen stays connected.', 'Disconnect', true)) { try { await api('POST', '/devices/revoke'); toast('Other devices disconnected'); } catch (e) { handle(e); } } } }, 'Disconnect others')),
    h('div', { class: 'srow' }, h('div', { class: 'grow' }, h('b', null, 'Version'), h('small', null, S.state.v)))));
  return out;
}
function seg(cur, opts, onPick) { return h('div', { class: 'seg' }, opts.map(([v, l]) => h('button', { class: cur === v ? 'on' : '', onclick: () => onPick(v) }, l))); }
function settingToggle(key) {
  const b = h('button', { class: 'toggle' + (set()[key] ? ' on' : ''), 'aria-label': key, onclick: () => saveSettings({ [key]: !set()[key] }) }, h('span', { class: 'knob' }));
  return b;
}
async function saveSettings(patch) {
  try { const r = await api('PUT', '/settings', patch); S.state.settings = r.settings; if ('units' in patch || 'weather' in patch) loadWeather(true); applyTheme(); render(); refresh(); } catch (e) { handle(e); }
}

function editPerson(p) {
  const f = p ? { ...p } : { name: '', role: 'kid', emoji: '🙂', color: PALETTE[S.state.people.length % PALETTE.length], sort: S.state.people.length };
  formSheet(p ? `Edit ${p.name}` : 'Add a person', () => h('div', null,
    field('Name', textInput(f, 'name', { maxlength: 30, placeholder: 'Name', autocomplete: 'off' })),
    field('Who is this?', chipsInput(f, 'role', [{ value: 'kid', label: 'Kid', emoji: '🧒' }, { value: 'parent', label: 'Parent', emoji: '🧑' }])),
    field('Color', swatchInput(f, 'color')),
    field('Avatar', emojiInput(f, 'emoji', 'people'))), {
    onSave: async () => { if (!f.name.trim()) throw new Error('Name is required'); await api(p ? 'PUT' : 'POST', p ? `/people/${p.id}` : '/people', f); toast('Saved'); },
    onDelete: p ? async () => confirmBox(`Remove ${p.name}?`, 'Their stars and chore history are deleted too.', 'Remove', true).then(async (ok) => { if (ok) await api('DELETE', `/people/${p.id}`); return ok; }) : null,
  });
}
function editCalendar(c) {
  const f = c ? { name: c.name, url: c.url || '', color: c.color, person_id: c.person_id, enabled: !!c.enabled } : { name: '', url: '', color: PALETTE[(S.state.calendars.length * 4 + 4) % PALETTE.length], person_id: null, enabled: true };
  const help = h('details', { class: 'help' }, h('summary', null, 'Where do I find the link?'),
    h('p', null, h('b', null, 'iPhone / iCloud: '), 'Open the Calendar app → Calendars → tap ⓘ next to the calendar → turn on Public Calendar → Share Link → Copy. (Or on icloud.com/calendar: share icon → Public Calendar.) It starts with webcal://.'),
    h('p', null, h('b', null, 'Google: '), 'On a computer open calendar.google.com → Settings → pick the calendar → Integrate calendar → copy “Secret address in iCal format”. It ends in .ics.'),
    h('p', null, 'Anyone with the link can see that calendar, so keep it private.'));
  formSheet(c ? 'Edit calendar' : 'Add a calendar', () => h('div', null,
    field('Name', textInput(f, 'name', { maxlength: 40, placeholder: 'Mom' })),
    field('Calendar link', textInput(f, 'url', { placeholder: 'webcal://… or https://….ics', autocomplete: 'off', spellcheck: 'false', inputmode: 'url' }), help),
    S.state.people.length ? field('Belongs to', chipsInput(f, 'person_id', [{ value: null, label: 'Everyone' }, ...S.state.people.map((p) => ({ value: p.id, label: p.name, emoji: p.emoji }))])) : null,
    field('Color', swatchInput(f, 'color')),
    c ? field('Show on screen', toggleInput(f, 'enabled', 'Visible')) : null), {
    saveLabel: c ? 'Save' : 'Add and sync',
    onSave: async () => {
      if (f.person_id && !f._colorTouched && !c) { const p = personById(f.person_id); if (p) f.color = p.color; }
      if (!f.name.trim() && f.person_id) f.name = (personById(f.person_id) || {}).name || '';
      const r = await api(c ? 'PUT' : 'POST', c ? `/calendars/${c.id}` : '/calendars', f);
      if (r.sync && r.sync.error) toast(`Saved, but syncing failed: ${r.sync.error}`, 6000); else toast(r.sync ? `Synced ${r.sync.count ?? ''} events` : 'Saved');
      await loadEvents(true);
    },
    onDelete: c ? async () => confirmBox(`Remove ${c.name}?`, 'This only removes it from the wall calendar.', 'Remove', true).then(async (ok) => { if (ok) await api('DELETE', `/calendars/${c.id}`); return ok; }) : null,
  });
}
function editTask(t, preset = {}) {
  const kids = kidsOf(), everyone = kids.length ? kids : S.state.people;
  const stepsText = (x) => (x.steps || []).map((st) => (st.e ? st.e + ' ' : '') + st.t).join('\n');
  const f = t ? { ...t, days: [...t.days], assignees: [...t.assignees], active: !!t.active, steps: stepsText(t) } : { title: '', emoji: '🛏️', kind: 'chore', stars: 1, recur: 'daily', days: [], date: todayKey(), assignees: everyone.map((p) => p.id), part: 'any', active: true, steps: '', ...preset };
  if (!t && f.kind === 'routine') Object.assign(f, { ...ROUTINE_PRESETS.morning, stars: 3 });
  let daysWrap, dateWrap, stepsWrap, stepsArea;
  const syncVis = () => { daysWrap.hidden = f.recur !== 'weekly'; dateWrap.hidden = f.recur !== 'once'; stepsWrap.hidden = f.kind !== 'routine'; };
  formSheet(t ? 'Edit' : f.kind === 'routine' ? 'New routine' : 'New chore, habit or activity', () => {
    stepsArea = h('textarea', { rows: 7, placeholder: '🪥 Brush teeth\n👕 Get dressed', oninput: (e) => { f.steps = e.target.value; } });
    stepsArea.value = f.steps || '';
    const usePreset = (k) => { const pr = ROUTINE_PRESETS[k]; f.steps = pr.steps; stepsArea.value = pr.steps; if (!t) { f.title = pr.title; f.part = pr.part; f.emoji = pr.emoji; const ti = stepsWrap.closest('.sheet').querySelector('input[type=text]'); if (ti) ti.value = pr.title; } };
    stepsWrap = field('Steps (one per line, emoji optional)', h('div', null, h('div', { class: 'chips', style: { marginBottom: '.5rem' } },
      h('button', { type: 'button', onclick: () => usePreset('morning') }, E('🌅'), 'Morning example'), h('button', { type: 'button', onclick: () => usePreset('bedtime') }, E('🌙'), 'Bedtime example')), stepsArea),
      'Kids tick each step; the stars are earned when every step is done.');
    const recur = chipsInput(f, 'recur', [{ value: 'daily', label: 'Every day' }, { value: 'weekdays', label: 'School days' }, { value: 'weekly', label: 'Some days' }, { value: 'once', label: 'Just once' }]);
    recur.addEventListener('change', syncVis);
    daysWrap = field('Which days', chipsInput(f, 'days', DOW.map((d, i) => ({ value: i, label: d })), { multi: true }));
    dateWrap = field('Date', h('input', { type: 'date', value: f.date || todayKey(), onchange: (e) => (f.date = e.target.value) }));
    const kindChips = chipsInput(f, 'kind', [{ value: 'chore', label: 'Chore', emoji: '🧹' }, { value: 'habit', label: 'Habit', emoji: '🌙' }, { value: 'activity', label: 'Activity', emoji: '⚽' }, { value: 'routine', label: 'Routine', emoji: '🌅' }]);
    kindChips.addEventListener('change', syncVis);
    const el = h('div', null,
      field('Name', textInput(f, 'title', { maxlength: 60, placeholder: 'Make bed, Good bedtime, Piano practice…' })),
      field('Type', kindChips), stepsWrap,
      field('Icon', emojiInput(f, 'emoji', 'tasks')),
      field('Stars earned', stepper(f, 'stars', 0, 20)),
      field('How often', recur), daysWrap, dateWrap,
      field('Time of day', chipsInput(f, 'part', [{ value: 'any', label: 'Any time' }, { value: 'morning', label: 'Morning' }, { value: 'afternoon', label: 'Afternoon' }, { value: 'evening', label: 'Evening' }])),
      field('Who', S.state.people.length ? chipsInput(f, 'assignees', S.state.people.map((p) => ({ value: p.id, label: p.name, emoji: p.emoji })), { multi: true }) : h('p', null, 'Add people in Settings first.')),
      t ? field('Active', toggleInput(f, 'active', 'Show on the board')) : null);
    syncVis();
    return el;
  }, {
    onSave: async () => { await api(t ? 'PUT' : 'POST', t ? `/tasks/${t.id}` : '/tasks', f); toast('Saved'); },
    onDelete: t ? async () => confirmBox(`Delete “${t.title}”?`, 'Stars already earned stay.', 'Delete', true).then(async (ok) => { if (ok) await api('DELETE', `/tasks/${t.id}`); return ok; }) : null,
  });
}
function editReward(r) {
  const kids = kidsOf();
  const f = r ? { ...r, person_ids: [...r.person_ids], task_ids: [...r.task_ids], active: !!r.active } : { name: '', description: '', emoji: '🎁', cost: 5, scope: 'kid', person_ids: [], task_ids: [], active: true };
  formSheet(r ? 'Edit reward' : 'New reward', () => h('div', null,
    field('Reward', textInput(f, 'name', { maxlength: 60, placeholder: 'Ice cream trip' })),
    field('Details (optional)', textInput(f, 'description', { maxlength: 200, placeholder: 'Pick any flavor at the shop' })),
    field('Icon', emojiInput(f, 'emoji', 'rewards')),
    field('Star cost', h('input', { type: 'number', min: 1, max: 500, value: f.cost, inputmode: 'numeric', oninput: (e) => (f.cost = +e.target.value) })),
    field('Who earns it', chipsInput(f, 'scope', [{ value: 'kid', label: 'Each kid on their own', emoji: '🧒' }, { value: 'family', label: 'Whole family together', emoji: '👨‍👩‍👧‍👦' }]), 'Per-kid rewards use that kid\u2019s stars. Family goals add up everyone\u2019s stars and don\u2019t use up personal balances.'),
    kids.length ? field('Which kids', chipsInput(f, 'person_ids', kids.map((k) => ({ value: k.id, label: k.name, emoji: k.emoji })), { multi: true }), 'None picked means all kids.') : null,
    S.state.tasks.length ? field('Earned by (optional)', chipsInput(f, 'task_ids', S.state.tasks.map((t) => ({ value: t.id, label: t.title, emoji: t.emoji })), { multi: true }), 'Pick chores or habits to count only those stars, like “Good bedtime”. Leave empty to count any stars.') : null,
    r ? field('Active', toggleInput(f, 'active', 'Show this reward')) : null), {
    onSave: async () => { await api(r ? 'PUT' : 'POST', r ? `/rewards/${r.id}` : '/rewards', f); toast('Saved'); },
    onDelete: r ? async () => confirmBox(`Delete “${r.name}”?`, 'Past redemptions stay in the history.', 'Delete', true).then(async (ok) => { if (ok) await api('DELETE', `/rewards/${r.id}`); return ok; }) : null,
  });
}
function editWeather() {
  const q = { text: '' };
  const results = h('div', { class: 'results' });
  let timer, m;
  const search = async () => {
    const t = q.text.trim(); if (t.length < 2) { results.replaceChildren(); return; }
    try {
      const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=${encodeURIComponent(t)}`);
      const d = await r.json();
      results.replaceChildren(...(d.results || []).map((x) => h('button', { onclick: async () => {
        await saveSettings({ weather: { name: x.name, region: x.admin1 || '', country: x.country || '', lat: x.latitude, lon: x.longitude, tz: x.timezone } });
        m.close(true); toast(`Weather set to ${x.name}`);
      } }, h('b', null, x.name), ' ', h('small', null, [x.admin1, x.country].filter(Boolean).join(', ')))));
      if (!(d.results || []).length) results.replaceChildren(h('p', { class: 'help' }, 'No places found. Try just the city name.'));
    } catch { results.replaceChildren(h('p', { class: 'err' }, "Couldn't search right now.")); }
  };
  const input = h('input', { type: 'search', placeholder: 'City or town, e.g. Naperville', autocomplete: 'off', oninput: (e) => { q.text = e.target.value; clearTimeout(timer); timer = setTimeout(search, 350); } });
  m = modal(h('div', null, h('h2', null, 'Weather location'), field('Search', input), results,
    set().weather ? h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: async () => { await saveSettings({ weather: null }); m.close(true); } }, 'Remove'), h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => m.close() }, 'Close')) : h('div', { class: 'actions' }, h('span', { class: 'grow' }), h('button', { class: 'btn', onclick: () => m.close() }, 'Close'))));
  setTimeout(() => input.focus(), 50);
}
function editDisplay() {
  const st = set();
  const f = { family_name: st.family_name, night_start: st.night_start, night_end: st.night_end, night_dim: st.night_dim, idle_minutes: st.idle_minutes, slide_seconds: st.slide_seconds, week_start: st.week_start, clock24: st.clock24, default_view: st.default_view, drift: st.drift, tz: st.tz };
  formSheet('Display', () => h('div', null,
    field('Night starts', h('input', { type: 'time', value: f.night_start, onchange: (e) => (f.night_start = e.target.value) })),
    field('Night ends', h('input', { type: 'time', value: f.night_end, onchange: (e) => (f.night_end = e.target.value) })),
    field('Dim at night (%)', stepperBy(f, 'night_dim', 0, 85, 5), 'Tapping the screen wakes it for 2 minutes.'),
    field('Slideshow after idle (minutes, 0 = off)', stepper(f, 'idle_minutes', 0, 120)),
    field('Seconds per photo', stepperBy(f, 'slide_seconds', 4, 300, 2)),
    field('Calendar opens in', chipsInput(f, 'default_view', [{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }, { value: 'day', label: 'Day' }, { value: 'agenda', label: 'List' }])),
    field('Week starts on', chipsInput(f, 'week_start', [{ value: 0, label: 'Sunday' }, { value: 1, label: 'Monday' }])),
    field('Clock', toggleInput(f, 'clock24', '24-hour clock')),
    field('Burn-in protection', toggleInput(f, 'drift', 'Shift the screen a few pixels every few minutes')),
    field('Time zone', textInput(f, 'tz', { placeholder: 'America/Chicago' }), 'IANA name, e.g. America/Chicago.')), {
    onSave: async () => { const r = await api('PUT', '/settings', f); S.state.settings = r.settings; S.cal.view = null; toast('Saved'); },
  });
}
function stepperBy(obj, key, min, max, by) {
  const out = h('output', null, obj[key]);
  const ch = (d) => { obj[key] = Math.max(min, Math.min(max, (+obj[key] || 0) + d * by)); out.textContent = obj[key]; };
  return h('div', { class: 'stepper' }, h('button', { type: 'button', onclick: () => ch(-1) }, '−'), out, h('button', { type: 'button', onclick: () => ch(1) }, '+'));
}
async function changePin() {
  let m;
  const cur = await new Promise((resolve) => {
    const pad = pinPad({ title: 'Current PIN', onDone: async (p) => { m.close(true); resolve(p); return true; } });
    m = modal(pad.el, { onKey: pad.onKey, cancel: true, onClose: () => resolve(null) });
  });
  if (!cur) return;
  const next = await choosePin('New parent PIN');
  if (!next) return;
  try { await api('PUT', '/pin', { current: cur, pin: next }); toast('PIN changed'); } catch (e) { handle(e); }
}

boot();
