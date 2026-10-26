// backend/lib/officeHours.js
// Office hours for the after-hours holding reply (routes/sms-inbound.js):
// when a free-text message arrives while the office is closed, the customer
// is told so honestly instead of "someone will reach out shortly".
//
// Env OFFICE_HOURS, one string, default 'Mon-Fri 07:30-16:30' (Central;
// CJ to confirm the real hours with Amy). Forms accepted:
//   'Mon-Fri 07:30-16:30'          a day range
//   'Mon,Tue,Wed,Thu,Fri 8:00-17:00'  a day list
// Times are 24h Central. A malformed value falls back to the default, loudly.
// No holiday calendar: a holiday reads as an open day (the office alert
// still goes out; the customer just gets the regular holding line).

const CENTRAL = 'America/Chicago';
const DEFAULT_HOURS = 'Mon-Fri 07:30-16:30';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const LONG_DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayIndex(s) {
  const i = DAY_NAMES.findIndex((d) => d.toLowerCase() === String(s || '').trim().slice(0, 3).toLowerCase());
  return i;
}
function minutesOf(hhmm) {
  const m = String(hhmm || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

function parseOfficeHours(raw) {
  const text = String(raw || '').trim() || DEFAULT_HOURS;
  const m = text.match(/^(\S+)\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!m) return null;
  const days = new Set();
  const spec = m[1];
  if (spec.includes('-')) {
    const [a, b] = spec.split('-');
    const ai = dayIndex(a); const bi = dayIndex(b);
    if (ai < 0 || bi < 0) return null;
    for (let i = ai; ; i = (i + 1) % 7) { days.add(i); if (i === bi) break; }
  } else {
    for (const d of spec.split(',')) { const i = dayIndex(d); if (i < 0) return null; days.add(i); }
  }
  const open = minutesOf(m[2]); const close = minutesOf(m[3]);
  if (open == null || close == null || close <= open) return null;
  return { days, open, close, source: text };
}

let cached = null;
let cachedRaw;
function officeHours() {
  const raw = process.env.OFFICE_HOURS || '';
  if (cached && cachedRaw === raw) return cached;
  let parsed = parseOfficeHours(raw);
  if (!parsed) {
    if (raw) console.error('[office-hours] OFFICE_HOURS "' + raw + '" is not understood - using the default ' + DEFAULT_HOURS);
    parsed = parseOfficeHours(DEFAULT_HOURS);
  }
  cached = parsed;
  cachedRaw = raw;
  return parsed;
}

// Central weekday (0 = Sunday) and minutes since midnight of an instant.
function centralParts(now) {
  const d = now ? new Date(now) : new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: CENTRAL, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(d);
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  const hour = Number(get('hour')) % 24; // Intl gives 24 for midnight in some engines
  return { dow: dayIndex(get('weekday')), minutes: hour * 60 + Number(get('minute')) };
}

function isOfficeOpen(now) {
  const h = officeHours();
  const { dow, minutes } = centralParts(now);
  return h.days.has(dow) && minutes >= h.open && minutes < h.close;
}

// "later this morning" (before opening on a business day), "tomorrow
// morning" (the next business day is tomorrow), else "Monday morning" etc.
function nextOpenPhrase(now) {
  const h = officeHours();
  const { dow, minutes } = centralParts(now);
  if (h.days.has(dow) && minutes < h.open) return h.open < 12 * 60 ? 'later this morning' : 'later today';
  const when = h.open < 12 * 60 ? ' morning' : ' afternoon';
  for (let i = 1; i <= 7; i++) {
    const d = (dow + i) % 7;
    if (h.days.has(d)) return (i === 1 ? 'tomorrow' : LONG_DAY[d]) + when;
  }
  return 'soon';
}

module.exports = { DEFAULT_HOURS, parseOfficeHours, officeHours, isOfficeOpen, nextOpenPhrase, centralParts };
