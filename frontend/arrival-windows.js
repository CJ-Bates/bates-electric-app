// frontend/arrival-windows.js
// Arrival windows — the 2-hour windows Amy books generator visits in (never
// exact clock times). Browser-side MIRROR of the backend's single source of
// truth, backend/lib/generator-catalog.js ARRIVAL_WINDOWS (no bundler and the
// backend deploys separately, so the list can't be require()d here) — edit
// BOTH files together. Loaded by generator-care.html, my.html, and tech.html
// before their page scripts; exposes window.BatesArrivalWindows.
//
//   code  — what's stored in generator_service_visits.arrival_window and in
//           preference slots ({date, window}).
//   label — the human-facing text every surface shows.
//   start — HH:MM the booking control turns into appointment_at (the window's
//           start on the booked date, viewer-local), keeping the timestamp
//           the sortable machine key.
(function () {
  'use strict';

  const WINDOWS = [
    { code: '7-9',   label: '7:00–9:00 AM',       start: '07:00', end: '09:00' },
    { code: '8-10',  label: '8:00–10:00 AM',      start: '08:00', end: '10:00' },
    { code: '10-12', label: '10:00 AM–12:00 PM',  start: '10:00', end: '12:00' },
    { code: '12-2',  label: '12:00–2:00 PM',      start: '12:00', end: '14:00' },
    { code: '1-3',   label: '1:00–3:00 PM',       start: '13:00', end: '15:00' },
  ];

  const byCode = {};
  WINDOWS.forEach((w) => { byCode[w.code] = w; });

  // Preference slots submitted before the arrival-window change stored
  // 'AM'/'PM'; keep them readable until they age out of pending.
  const LEGACY_LABELS = { AM: 'Morning (8–12)', PM: 'Afternoon (12–4)' };

  // Label for a window code; falls back to legacy AM/PM labels, then to the
  // raw code so an unknown value still renders something.
  function label(code) {
    if (byCode[code]) return byCode[code].label;
    return LEGACY_LABELS[code] || (code || '');
  }

  window.BatesArrivalWindows = { WINDOWS, byCode, label, LEGACY_LABELS };
})();
