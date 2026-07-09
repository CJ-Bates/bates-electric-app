// frontend/weather.js
// Shared hero weather chip + greeting-by-hour, used by BOTH home.js (office/
// tech hub) and tech.js (My Day). Single copy so the two surfaces can't drift:
// geolocation (with a cached-location TTL), open-meteo fetch, reverse-geocode
// for the city, tap-to-enable retry. Call BatesWeather.mount({wrapEl, iconEl,
// tempEl, locEl}) once the target elements exist in the DOM.

(function () {
  'use strict';

  // WMO weather code -> { label, svg }
  const WEATHER_ICONS = {
    sun: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
    cloudSun: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/></svg>',
    cloud: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>',
    fog: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h18"/><path d="M5 14h14"/><path d="M3 18h18"/><path d="M5 6h14"/></svg>',
    rain: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/></svg>',
    snow: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 15h.01"/><path d="M8 19h.01"/><path d="M12 17h.01"/><path d="M12 21h.01"/><path d="M16 15h.01"/><path d="M16 19h.01"/></svg>',
    storm: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M19 16.9A5 5 0 0 0 18 7h-1.26a8 8 0 1 0-11.62 9"/><path d="m13 12-3 5h4l-3 5"/></svg>',
  };

  function weatherFromCode(code) {
    if (code === 0) return { icon: 'sun', label: 'Clear' };
    if (code <= 2) return { icon: 'cloudSun', label: 'Partly cloudy' };
    if (code === 3) return { icon: 'cloud', label: 'Cloudy' };
    if (code === 45 || code === 48) return { icon: 'fog', label: 'Foggy' };
    if (code >= 51 && code <= 67) return { icon: 'rain', label: 'Rain' };
    if (code >= 71 && code <= 77) return { icon: 'snow', label: 'Snow' };
    if (code >= 80 && code <= 82) return { icon: 'rain', label: 'Showers' };
    if (code >= 85 && code <= 86) return { icon: 'snow', label: 'Snow' };
    if (code >= 95) return { icon: 'storm', label: 'Storms' };
    return { icon: 'cloud', label: '' };
  }

  const LOC_CACHE_KEY = 'bates.weather.loc';
  const LOC_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  function readCachedLocation() {
    try {
      const raw = localStorage.getItem(LOC_CACHE_KEY);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || !Number.isFinite(j.lat) || !Number.isFinite(j.lon)) return null;
      if (Date.now() - (j.ts || 0) > LOC_CACHE_TTL_MS) return null;
      return j;
    } catch (e) { return null; }
  }

  function writeCachedLocation(loc) {
    try {
      localStorage.setItem(LOC_CACHE_KEY, JSON.stringify({ ...loc, ts: Date.now() }));
    } catch (e) { /* ignore */ }
  }

  function getBrowserPosition() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({ ok: false, reason: 'unsupported' });
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ ok: true, lat: pos.coords.latitude, lon: pos.coords.longitude }),
        (err) => resolve({ ok: false, reason: err && err.code === 1 ? 'denied' : 'error' }),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 5 * 60 * 1000 }
      );
    });
  }

  async function reverseGeocode(lat, lon) {
    try {
      const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const j = await res.json();
      return j.city || j.locality || j.principalSubdivision || null;
    } catch (e) { return null; }
  }

  async function fetchWeatherFor(loc) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const t = Math.round(json?.current?.temperature_2m);
    const code = json?.current?.weather_code;
    if (!Number.isFinite(t) || !Number.isFinite(code)) return null;
    return { t, code };
  }

  function renderWeather(els, loc, weather) {
    const w = weatherFromCode(weather.code);
    els.iconEl.innerHTML = WEATHER_ICONS[w.icon] || WEATHER_ICONS.cloud;
    els.tempEl.textContent = `${weather.t}°`;
    els.locEl.textContent = loc.city || '';
    els.wrapEl.title = w.label;
    els.wrapEl.hidden = false;
  }

  function renderEnablePrompt(els, message) {
    els.iconEl.innerHTML = '';
    els.tempEl.textContent = '';
    els.locEl.textContent = message;
    els.wrapEl.title = 'Tap to enable location';
    els.wrapEl.hidden = false;
  }

  async function tryRenderWith(els, loc) {
    const weather = await fetchWeatherFor(loc);
    if (!weather) return false;
    if (!loc.city) loc.city = await reverseGeocode(loc.lat, loc.lon);
    renderWeather(els, loc, weather);
    writeCachedLocation(loc);
    return true;
  }

  async function requestFreshLocation(els, { silent }) {
    const pos = await getBrowserPosition();
    if (!pos.ok) {
      if (!silent) {
        renderEnablePrompt(els, pos.reason === 'denied' ? 'Location off' : 'Tap to enable location');
      }
      return false;
    }
    const loc = { lat: pos.lat, lon: pos.lon, city: null };
    return tryRenderWith(els, loc);
  }

  async function loadWeather(els) {
    if (!els.wrapEl || !els.iconEl || !els.tempEl || !els.locEl) return;

    const cached = readCachedLocation();
    if (cached) {
      const ok = await tryRenderWith(els, { lat: cached.lat, lon: cached.lon, city: cached.city });
      if (ok) return;
    }

    let permState = null;
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const p = await navigator.permissions.query({ name: 'geolocation' });
        permState = p.state;
      }
    } catch (e) { /* not all browsers support this */ }

    if (permState === 'granted' || permState === 'prompt' || permState === null) {
      const ok = await requestFreshLocation(els, { silent: false });
      if (ok) return;
    }

    renderEnablePrompt(els, 'Tap to enable location');
  }

  function wireWeatherTileRetry(els) {
    if (!els.wrapEl) return;
    const handler = async (ev) => {
      ev.preventDefault();
      els.locEl.textContent = 'Locating…';
      await requestFreshLocation(els, { silent: false });
    };
    els.wrapEl.addEventListener('click', handler);
    els.wrapEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') handler(ev);
    });
  }

  // Wires the tap-to-enable retry and kicks off the initial load. `els` is
  // {wrapEl, iconEl, tempEl, locEl} — the hero weather chip's DOM nodes.
  function mount(els) {
    if (!els || !els.wrapEl) return;
    wireWeatherTileRetry(els);
    loadWeather(els);
  }

  function greetingForHour(h) {
    if (h < 5) return 'Working late';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 21) return 'Good evening';
    return 'Good evening';
  }

  window.BatesWeather = { mount, greetingForHour };
})();
