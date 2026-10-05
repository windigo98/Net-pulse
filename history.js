/**
 * Net Pulse — lean "compact archive" history.
 *
 * What is persisted (localStorage):
 *   netpulse.stretches.v2  — up to MAX_STRETCHES packed spotty/outage stretch summaries (oldest dropped)
 *   netpulse.state.v2      — running totals (status counts, latency/speed histograms, blips) and the
 *                            currently open stretch, so summaries cover every check ever made
 *   netpulse.recent.v2     — only the last MAX_RECENT raw checks (for the live dots / recent list)
 *
 * Stretches are tracked incrementally as checks arrive, so they stay exact even though raw checks
 * are trimmed to a small window. Legacy v1 data (up to 500 raw checks) is migrated automatically.
 *
 * Link path: each check stores a 1-char link code `l` (w Wi‑Fi, c Cellular, e Ethernet, b Bluetooth,
 * u Unknown, x Offline) taken from the browser (Network Information API `type` / navigator.onLine),
 * plus `nc: 1` when Net Pulse saw the public network change while the type stayed the same (e.g. on
 * iOS where the type is never exposed). Stretches remember the link at start (`l`), the link just
 * before the stretch if it changed right as it began (`pl`) and up to MAX_SWITCHES switches (`x`).
 *
 * Exposed as window.NetPulseHistory (and module.exports for tests).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NetPulseHistory = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEYS = {
    recent: 'netpulse.recent.v2',
    stretches: 'netpulse.stretches.v2',
    state: 'netpulse.state.v2',
  };
  const LEGACY = { history: 'netpulse.history.v1', stretches: 'netpulse.stretches.v1' };

  /** Raw checks kept in storage (live dots + "recent checks" list). */
  const MAX_RECENT = 50;
  /** Stretch summaries kept (oldest dropped). ~70–90 bytes each packed. */
  const MAX_STRETCHES = 300;
  /** Recent checks included in the text report. */
  const REPORT_RECENT = 20;

  /** A stretch may contain up to this many good checks between bad ones… */
  const GOOD_TOLERANCE = 2;
  /** …and bad checks must be no more than this far apart to cluster. */
  const MAX_GAP_MS = 5 * 60 * 1000;
  /** A cluster needs at least this many bad checks to count as a stretch. */
  const MIN_BAD = 2;
  /** Link switches remembered per stretch (extra ones are only counted, plus the final link). */
  const MAX_SWITCHES = 4;

  /** Link codes → labels. Never derived from effectiveType (that is a speed class, not a link). */
  const LINK_LABEL = {
    w: 'Wi‑Fi',
    c: 'Cellular',
    e: 'Ethernet',
    b: 'Bluetooth',
    u: 'Unknown',
    x: 'Offline',
  };
  const LINK_FROM_TYPE = { wifi: 'w', cellular: 'c', ethernet: 'e', bluetooth: 'b', none: 'x' };

  /**
   * Map Network Information API `type` + navigator.onLine to a link code.
   * Missing / 'unknown' / 'other' / 'mixed' / 'wimax' → 'u' (we never guess Wi‑Fi vs cellular).
   */
  function linkFromType(type, onLine = true) {
    if (onLine === false) return 'x';
    return LINK_FROM_TYPE[String(type || '').toLowerCase()] || 'u';
  }
  const validLink = (c) => typeof c === 'string' && !!LINK_LABEL[c[0]] && (c.length === 1 || c === c[0] + '*');

  const STATUS_LABEL = {
    online: 'Online',
    spotty: 'Spotty',
    'no-internet': 'No internet',
    offline: 'Offline',
  };
  const isBad = (s) => s === 'spotty' || s === 'no-internet' || s === 'offline';
  const isFailed = (s) => s === 'no-internet' || s === 'offline';

  // ---------- storage ----------
  function getStore() {
    try {
      return typeof localStorage !== 'undefined' ? localStorage : null;
    } catch {
      return null; // access can throw (privacy modes)
    }
  }

  function readRaw(key) {
    const s = getStore();
    if (!s) return null;
    try {
      const raw = s.getItem(key);
      return raw == null ? null : JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function readArray(key) {
    const v = readRaw(key);
    return Array.isArray(v) ? v : [];
  }

  function writeJSON(key, value) {
    const s = getStore();
    if (!s) return false;
    let data = value;
    // On quota errors, drop the oldest half of arrays and retry a few times.
    for (let i = 0; i < 4; i++) {
      try {
        s.setItem(key, JSON.stringify(data));
        return true;
      } catch {
        if (!Array.isArray(data) || data.length < 2) return false;
        data = data.slice(Math.floor(data.length / 2));
      }
    }
    return false;
  }

  function removeKey(key) {
    const s = getStore();
    if (!s) return;
    try {
      s.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  /** Approximate bytes used by Net Pulse in localStorage (JSON characters). */
  function storageBytes() {
    const s = getStore();
    if (!s) return 0;
    let n = 0;
    for (const key of [...Object.values(KEYS), ...Object.values(LEGACY)]) {
      try {
        const v = s.getItem(key);
        if (v != null) n += key.length + v.length;
      } catch {
        /* ignore */
      }
    }
    return n;
  }

  function round(n, d) {
    if (n == null || !Number.isFinite(n)) return null;
    const f = 10 ** d;
    return Math.round(n * f) / f;
  }

  function clean(e) {
    const out = { t: Math.round(e.t || Date.now()), s: STATUS_LABEL[e.s] ? e.s : 'offline' };
    const ms = round(e.ms, 0);
    if (ms != null) out.ms = ms;
    const mbps = round(e.mbps, 2);
    if (mbps != null) out.mbps = mbps;
    if (e.src) out.src = String(e.src).slice(0, 12);
    if (e.probes) out.probes = String(e.probes).slice(0, 8);
    if (typeof e.l === 'string' && LINK_LABEL[e.l]) out.l = e.l;
    if (e.nc && out.l && out.l !== 'x') out.nc = 1;
    if (e.net && typeof e.net === 'object') {
      const n = {};
      if (e.net.eff) n.eff = String(e.net.eff).slice(0, 12);
      if (e.net.dl != null && Number.isFinite(+e.net.dl)) n.dl = +e.net.dl;
      if (e.net.rtt != null && Number.isFinite(+e.net.rtt)) n.rtt = +e.net.rtt;
      if (e.net.type) n.type = String(e.net.type).slice(0, 12);
      if (e.net.saveData) n.saveData = true;
      if (e.net.on === false) n.on = false;
      if (Object.keys(n).length) out.net = n;
    }
    return out;
  }

  const validEntry = (e) => e && typeof e.t === 'number' && STATUS_LABEL[e.s];

  // ---------- compact histograms (≈5% resolution, sparse) ----------
  const LOG_STEP = Math.log(1.1);
  function histAdd(h, v) {
    const i = Math.max(0, Math.floor(Math.log(Math.max(1, v)) / LOG_STEP));
    h[i] = (h[i] || 0) + 1;
  }
  function histQuantile(h, n, q) {
    if (!n) return null;
    const rank = Math.max(1, Math.ceil(q * n));
    let cum = 0;
    for (const k of Object.keys(h).map(Number).sort((a, b) => a - b)) {
      cum += h[k];
      if (cum >= rank) return Math.exp((k + 0.5) * LOG_STEP);
    }
    return null;
  }

  // ---------- running state ----------
  function emptyState() {
    return {
      v: 2,
      since: null, // first check counted
      last: null, // last check counted
      total: 0,
      counts: { online: 0, spotty: 0, 'no-internet': 0, offline: 0 },
      blips: 0,
      lat: {}, latN: 0, latMin: null, latMax: null, // latency histogram (ms)
      spd: {}, spdN: 0, spdMin: null, spdMax: null, // speed histogram (Mbps × 100)
      open: null, // stretch currently being built (not yet closed)
      goodRun: 0, // good checks since the open stretch's last bad check
      lk: null, lkT: null, // link code + time of the last check that carried one
      lc: {}, // checks per link code
      sw: 0, // link switches seen between consecutive checks (≤ MAX_GAP_MS apart)
    };
  }

  function loadState() {
    const v = readRaw(KEYS.state);
    if (!v || typeof v !== 'object' || v.v !== 2) return emptyState();
    const st = { ...emptyState(), ...v };
    st.counts = { ...emptyState().counts, ...(v.counts || {}) };
    st.lc = v.lc && typeof v.lc === 'object' ? { ...v.lc } : {};
    return st;
  }

  function addSpeed(state, mbps) {
    if (mbps == null || !Number.isFinite(mbps)) return;
    histAdd(state.spd, mbps * 100);
    state.spdN++;
    state.spdMin = state.spdMin == null ? mbps : Math.min(state.spdMin, mbps);
    state.spdMax = state.spdMax == null ? mbps : Math.max(state.spdMax, mbps);
  }

  function closeOpen(state, closedOut) {
    const cur = state.open;
    if (cur) {
      if (cur.bad >= MIN_BAD) closedOut.push({ ...cur });
      else state.blips++;
    }
    state.open = null;
    state.goodRun = 0;
  }

  /**
   * Fold one check into the running state. Closed stretches are pushed to closedOut.
   * Clustering rule: bad (Spotty / No internet / Offline) checks join the open stretch when
   * ≤ GOOD_TOLERANCE good checks and ≤ MAX_GAP_MS separate them; < MIN_BAD bad checks = "blip".
   */
  /** Remember one link switch on a stretch (first MAX_SWITCHES kept, the rest counted). */
  function addSwitch(o, code, t) {
    if (!o.x) o.x = [];
    if (o.x.length < MAX_SWITCHES) o.x.push([Math.max(0, Math.round((t - o.start) / 1000)), code]);
    else {
      o.xn = (o.xn || 0) + 1;
      o.le = code;
    }
  }

  /**
   * Link switch at this check vs the previous check (null if none / unknown / too far apart).
   * Returns the new code; 'w*' style = same type but a different network (nc flag).
   */
  function linkSwitch(state, e) {
    const lk = e.l;
    if (!lk || !state.lk || state.lkT == null || e.t - state.lkT > MAX_GAP_MS) return null;
    // "(new network)" adds information only when the type itself can't tell us (same / Unknown).
    if (lk !== state.lk) return e.nc && lk === 'u' ? 'u*' : lk;
    return e.nc ? `${lk}*` : null;
  }

  function step(state, e, closedOut) {
    const prevLink = state.lk;
    const sw = linkSwitch(state, e);
    if (e.l) {
      state.lk = e.l;
      state.lkT = e.t;
      state.lc[e.l] = (state.lc[e.l] || 0) + 1;
      if (sw) state.sw++;
    } else {
      state.lk = null; // legacy check without link info — don't bridge across it
    }
    state.total++;
    state.counts[e.s] = (state.counts[e.s] || 0) + 1;
    if (state.since == null || e.t < state.since) state.since = e.t;
    if (state.last == null || e.t > state.last) state.last = e.t;
    if (e.ms != null) {
      histAdd(state.lat, e.ms);
      state.latN++;
      state.latMin = state.latMin == null ? e.ms : Math.min(state.latMin, e.ms);
      state.latMax = state.latMax == null ? e.ms : Math.max(state.latMax, e.ms);
    }
    addSpeed(state, e.mbps);

    // Too long since the open stretch's last bad check → nothing more can join it.
    if (state.open && e.t - state.open.end > MAX_GAP_MS) closeOpen(state, closedOut);

    const cur = state.open;
    if (isBad(e.s)) {
      if (cur) {
        cur.checks += state.goodRun; // interleaved good checks count toward total
      } else {
        state.open = {
          start: e.t, end: e.t, bad: 0, failed: 0, spotty: 0, checks: 0, worstMs: null, recoveredAt: null,
        };
        if (e.l) state.open.l = sw || e.l;
        if (sw) state.open.pl = prevLink; // switched right as the stretch began
      }
      if (cur && sw) addSwitch(cur, sw, e.t);
      const o = state.open;
      o.end = e.t;
      o.bad++;
      o.checks++;
      if (isFailed(e.s)) o.failed++;
      else o.spotty++;
      if (e.ms != null && (o.worstMs == null || e.ms > o.worstMs)) o.worstMs = e.ms;
      o.recoveredAt = null;
      state.goodRun = 0;
    } else if (cur) {
      if (state.goodRun === 0) cur.recoveredAt = e.t;
      state.goodRun++;
      if (state.goodRun > GOOD_TOLERANCE) closeOpen(state, closedOut);
      else if (sw) addSwitch(cur, sw, e.t); // e.g. Wi‑Fi died → phone moved to cellular → recovered
    }
  }

  // ---------- stretch archive ----------
  function partOfDay(ts) {
    const h = new Date(ts).getHours();
    if (h >= 5 && h < 12) return 'Morning';
    if (h >= 12 && h < 17) return 'Afternoon';
    if (h >= 17 && h < 21) return 'Evening';
    return 'Overnight';
  }

  function kindOf(st) {
    if (st.failed > 0 && st.spotty === 0) return 'outage';
    if (st.failed === 0) return 'spotty stretch';
    return 'unstable stretch';
  }

  function finalize(st) {
    st.durationMs = st.end - st.start;
    st.kind = kindOf(st);
    const day = new Date(st.start).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    st.name = `${partOfDay(st.start)} ${st.kind} · ${day}`;
    st.id = String(st.start);
    return st;
  }

  /** Packed storage form: short keys, no derived fields (name/kind/duration are rebuilt on load). */
  function pack(st) {
    // d = duration (ms after start), r = recovery (ms after end) — deltas keep each record ~70 B.
    const p = { s: st.start, d: st.end - st.start, b: st.bad, f: st.failed, p: st.spotty, c: st.checks };
    if (st.worstMs != null) p.w = st.worstMs;
    if (st.recoveredAt != null) p.r = st.recoveredAt - st.end;
    // Link: l = at start, pl = just before (if it switched as the stretch began),
    // x = "c12,w*340" (code + seconds after start), xn/le = extra switches beyond MAX_SWITCHES.
    if (st.l) p.l = st.l;
    if (st.pl) p.pl = st.pl;
    if (st.x && st.x.length) p.x = st.x.map(([sec, c]) => `${c}${sec}`).join(',');
    if (st.xn) {
      p.xn = st.xn;
      p.le = st.le;
    }
    return p;
  }

  function unpack(x) {
    if (!x || typeof x !== 'object') return null;
    const legacy = typeof x.start === 'number'; // v1 archive objects
    const st = legacy
      ? {
          start: x.start, end: x.end, bad: x.bad | 0, failed: x.failed | 0, spotty: x.spotty | 0,
          checks: x.checks | 0, worstMs: x.worstMs ?? null, recoveredAt: x.recoveredAt ?? null,
        }
      : typeof x.s === 'number'
        ? {
            start: x.s, end: x.s + (+x.d || 0), bad: x.b | 0, failed: x.f | 0, spotty: x.p | 0,
            checks: x.c | 0, worstMs: x.w ?? null, recoveredAt: x.r == null ? null : x.s + (+x.d || 0) + x.r,
          }
        : null;
    if (!st || typeof st.end !== 'number') return null;
    const l = legacy ? null : x.l;
    if (validLink(l)) {
      st.l = l;
      if (validLink(x.pl)) st.pl = x.pl;
      if (typeof x.x === 'string' && x.x) {
        st.x = x.x.split(',').map((tok) => {
          const m = /^([a-z]\*?)(\d+)$/.exec(tok);
          return m && validLink(m[1]) ? [+m[2], m[1]] : null;
        }).filter(Boolean);
      }
      if (x.xn > 0 && validLink(x.le)) {
        st.xn = x.xn | 0;
        st.le = x.le;
      }
    }
    return st;
  }

  function loadArchive() {
    return readArray(KEYS.stretches).map(unpack).filter(Boolean).sort((a, b) => a.start - b.start);
  }

  const overlaps = (a, b) => a.start <= b.end && b.start <= a.end;

  /** Merge stretch lists; for overlapping records keep the more complete one. Trims to cap. */
  function mergeArchive(base, extra) {
    const out = base.map((s) => ({ ...s }));
    for (const c of extra) {
      const i = out.findIndex((a) => overlaps(a, c));
      if (i === -1) out.push({ ...c });
      else if (c.checks > out[i].checks) out[i] = { ...c };
    }
    out.sort((a, b) => a.start - b.start);
    return out.slice(-MAX_STRETCHES);
  }

  function saveArchive(list) {
    writeJSON(KEYS.stretches, list.slice(-MAX_STRETCHES).map(pack));
  }

  // ---------- migration from v1 (500 raw checks) ----------
  let lastMigration = null;

  /**
   * If legacy v1 data exists: derive stretches + running totals from the old raw checks, merge
   * with the old stretch archive, keep only the newest MAX_RECENT checks, delete the v1 keys.
   * Returns a small report (or null if nothing to migrate).
   */
  function migrate() {
    const s = getStore();
    if (!s) return null;
    let rawOld = null;
    let rawOldSt = null;
    try {
      rawOld = s.getItem(LEGACY.history);
      rawOldSt = s.getItem(LEGACY.stretches);
    } catch {
      return null;
    }
    if (rawOld == null && rawOldSt == null) return null;

    const bytesBefore = storageBytes();
    const parse = (raw) => {
      try {
        const v = JSON.parse(raw || '[]');
        return Array.isArray(v) ? v : [];
      } catch {
        return [];
      }
    };
    const oldEntries = parse(rawOld).filter(validEntry).map(clean).sort((a, b) => a.t - b.t);
    const oldArchive = parse(rawOldSt).map(unpack).filter(Boolean);

    const haveV2 = readRaw(KEYS.state) != null;
    let archive = mergeArchive(loadArchive(), oldArchive);
    if (!haveV2) {
      const state = emptyState();
      const closed = [];
      for (const e of oldEntries) step(state, e, closed);
      archive = mergeArchive(archive, closed);
      writeJSON(KEYS.state, state);
      writeJSON(KEYS.recent, oldEntries.slice(-MAX_RECENT));
    }
    saveArchive(archive);
    removeKey(LEGACY.history);
    removeKey(LEGACY.stretches);

    lastMigration = {
      checksBefore: oldEntries.length,
      checksAfter: haveV2 ? load().length : Math.min(oldEntries.length, MAX_RECENT),
      stretches: archive.length,
      bytesBefore,
      bytesAfter: storageBytes(),
    };
    return lastMigration;
  }

  function ready() {
    const s = getStore();
    if (!s) return;
    try {
      if (s.getItem(LEGACY.history) == null && s.getItem(LEGACY.stretches) == null) return;
    } catch {
      return;
    }
    migrate();
  }

  // ---------- public read/write ----------
  /** Recent raw checks (≤ MAX_RECENT), oldest first. */
  function load() {
    ready();
    return readArray(KEYS.recent).filter(validEntry).sort((a, b) => a.t - b.t);
  }

  /**
   * Record one check. Updates running totals + stretch tracking, keeps only the last
   * MAX_RECENT raw checks. Returns the recent list.
   * entry: { t, s, ms?, mbps?, src?, net?, probes? }
   */
  function append(entry) {
    ready();
    const e = clean(entry);
    // Re-read everything so multiple tabs don't clobber each other.
    const state = loadState();
    const closed = [];
    step(state, e, closed);
    if (closed.length) saveArchive(mergeArchive(loadArchive(), closed));
    writeJSON(KEYS.state, state);

    const recent = load();
    recent.push(e);
    recent.sort((a, b) => a.t - b.t);
    while (recent.length > MAX_RECENT) recent.shift();
    writeJSON(KEYS.recent, recent);
    return recent;
  }

  /**
   * Attach a download measurement to the most recent check if it is recent and has none;
   * otherwise record a new check carrying the last known status.
   */
  function attachSpeed(mbps, { maxAgeMs = 120000, fallbackStatus = 'online', net = null, l = null } = {}) {
    const recent = load();
    const last = recent[recent.length - 1];
    const age = last ? Date.now() - last.t : Infinity;
    if (last && age >= -5000 && age <= maxAgeMs && last.mbps == null) {
      last.mbps = round(mbps, 2);
      writeJSON(KEYS.recent, recent);
      const state = loadState();
      addSpeed(state, last.mbps);
      writeJSON(KEYS.state, state);
      return recent;
    }
    return append({
      t: Date.now(),
      s: last && Date.now() - last.t <= maxAgeMs ? last.s : fallbackStatus,
      mbps,
      src: 'speed',
      net,
      l,
    });
  }

  function clearAll() {
    for (const k of [...Object.values(KEYS), ...Object.values(LEGACY)]) removeKey(k);
  }

  /**
   * All stretches to show (archived + the open one if it qualifies), oldest first.
   * The open stretch is "ongoing" only if no good check followed it and its last bad check
   * is recent (otherwise the app was probably closed mid-stretch).
   */
  function allStretches({ now = Date.now() } = {}) {
    ready();
    const state = loadState();
    const stretches = loadArchive().map((s) => finalize({ ...s, closed: true, ongoing: false }));
    let blips = state.blips;
    let open = null;
    if (state.open) {
      if (state.open.bad >= MIN_BAD) {
        const stale = now - state.open.end > MAX_GAP_MS;
        open = finalize({
          ...state.open,
          closed: stale || state.goodRun > GOOD_TOLERANCE,
          ongoing: !stale && state.goodRun === 0,
        });
        stretches.push(open);
      } else if (now - state.open.end > MAX_GAP_MS) {
        blips++; // a lone bad check that can no longer grow
      }
    }
    return { stretches, blips, open, state };
  }

  /**
   * Pure helper (tests / analysis): cluster a list of checks into stretches using the same
   * incremental rules. Returns { stretches (oldest first), blips, tailOpen }.
   */
  function detectStretches(entries) {
    const state = emptyState();
    const closed = [];
    for (const e of [...entries].sort((a, b) => a.t - b.t)) step(state, e, closed);
    const stretches = closed.map((s) => finalize({ ...s, closed: true, ongoing: false }));
    let blips = state.blips;
    const tailOpen = !!state.open;
    if (state.open) {
      if (state.open.bad >= MIN_BAD) {
        stretches.push(finalize({ ...state.open, closed: false, ongoing: state.goodRun === 0 }));
      } else blips++;
    }
    return { stretches, blips, tailOpen };
  }

  /** Summary over every check ever counted (running totals) + the stretch archive. */
  function summarize({ now = Date.now() } = {}) {
    const info = allStretches({ now });
    const st = info.state;
    const lat = (q) => {
      const v = histQuantile(st.lat, st.latN, q);
      if (v == null) return null;
      return Math.round(Math.min(st.latMax ?? v, Math.max(st.latMin ?? v, v)));
    };
    const spd = (q) => {
      const v = histQuantile(st.spd, st.spdN, q);
      if (v == null) return null;
      return Math.min(st.spdMax, Math.max(st.spdMin, round(v / 100, 2)));
    };
    const stretches = info.stretches;
    return {
      total: st.total,
      from: st.since,
      to: st.last,
      counts: st.counts,
      pct: (k) => (st.total ? (100 * (st.counts[k] || 0)) / st.total : 0),
      latency: { median: lat(0.5), p90: lat(0.9), n: st.latN },
      speed: { n: st.spdN, median: spd(0.5), min: st.spdMin, max: st.spdMax },
      stretches,
      blips: info.blips,
      stretchTime: stretches.reduce((a, s) => a + s.durationMs, 0),
      archiveFrom: stretches.length ? stretches[0].start : null,
      recentCount: load().length,
      bytes: storageBytes(),
      links: { counts: { ...st.lc }, switches: st.sw || 0, current: st.lk },
      stretchSwitches: stretches.reduce((a, s) => a + (s.x ? s.x.length : 0) + (s.xn || 0) + (s.pl ? 1 : 0), 0),
    };
  }

  // ---------- formatting ----------
  function fmtDuration(ms) {
    if (ms == null || ms < 0) return '—';
    const s = Math.round(ms / 1000);
    if (s < 60) return s <= 0 ? '<1s' : `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    const h = Math.floor(m / 60);
    if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  }

  const pad = (n) => String(n).padStart(2, '0');
  function fmtStamp(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }
  function fmtDateTime(ts) {
    return new Date(ts).toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
    });
  }
  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  function sameDay(a, b) {
    return new Date(a).toDateString() === new Date(b).toDateString();
  }
  function fmtRange(a, b) {
    if (a === b) return fmtDateTime(a);
    return `${fmtDateTime(a)} → ${sameDay(a, b) ? fmtTime(b) : fmtDateTime(b)}`;
  }
  function fmtMbps(v) {
    if (v == null) return '';
    return `${v >= 10 ? v.toFixed(1) : v.toFixed(2)} Mbps`;
  }
  function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  }
  // ---------- link path formatting ----------
  /** 'w' → 'Wi‑Fi', 'w*' → 'Wi‑Fi (new network)', null → 'Not recorded'. */
  function linkLabel(code) {
    if (!validLink(code)) return 'Not recorded';
    const base = LINK_LABEL[code[0]];
    return code.length > 1 ? `${base} (new network)` : base;
  }

  /**
   * Link story of one stretch: chain of codes (start → … → last) and switch list with times.
   * Returns null for stretches recorded before link tracking existed.
   */
  function stretchLinks(st) {
    if (!st || !validLink(st.l)) return null;
    const chain = [];
    const switches = [];
    if (st.pl) {
      chain.push(st.pl);
      switches.push({ t: st.start, from: st.pl, to: st.l, atStart: true });
    }
    chain.push(st.l);
    let prev = st.l;
    for (const [sec, code] of st.x || []) {
      switches.push({ t: st.start + sec * 1000, from: prev, to: code });
      chain.push(code);
      prev = code;
    }
    const more = st.xn || 0;
    if (more && st.le) chain.push(st.le);
    return { chain, switches, more, switched: switches.length > 0 || more > 0 };
  }

  /** "Wi‑Fi → Offline → Cellular" (or "Cellular" when it stayed on one link). */
  function fmtLinkChain(st) {
    const info = stretchLinks(st);
    if (!info) return null;
    const labels = info.chain.map(linkLabel);
    if (info.more && labels.length > 1) {
      labels.splice(labels.length - 1, 0, `… (+${info.more} more)`);
    }
    return labels.join(' → ');
  }

  /** Switch between two consecutive recorded checks (same rule as stretch tracking), or null. */
  function checkSwitch(prev, e) {
    if (!prev || !e || !LINK_LABEL[prev.l] || !LINK_LABEL[e.l]) return null;
    if (e.t - prev.t > MAX_GAP_MS) return null;
    if (prev.l !== e.l) return { from: prev.l, to: e.nc && e.l === 'u' ? 'u*' : e.l };
    return e.nc ? { from: prev.l, to: `${e.l}*` } : null;
  }

  function fmtLinkCounts(lc) {
    const total = Object.values(lc || {}).reduce((a, b) => a + b, 0);
    if (!total) return '';
    return Object.keys(LINK_LABEL)
      .filter((k) => lc[k])
      .map((k) => `${LINK_LABEL[k]} ${Math.round((100 * lc[k]) / total)}%`)
      .join(' · ');
  }

  /** "Online 92% · Spotty 5% · No internet 2% · Offline 1%" (non-zero only). */
  function fmtStatusCounts(counts) {
    const total = Object.values(counts || {}).reduce((a, b) => a + b, 0);
    if (!total) return '';
    return Object.keys(STATUS_LABEL)
      .filter((k) => counts[k])
      .map((k) => `${STATUS_LABEL[k]} ${Math.round((100 * counts[k]) / total)}%`)
      .join(' · ');
  }

  /** Link label of one check ('Wi‑Fi', 'Unknown (new network)', '—' if not recorded). */
  function checkLink(e) {
    return e && LINK_LABEL[e.l] ? linkLabel(e.nc ? `${e.l}*` : e.l) : '—';
  }

  /** Network hints of one check. link:false omits the link type (shown separately). */
  function fmtNet(e, { link = true } = {}) {
    const parts = [];
    if (link && LINK_LABEL[e.l]) parts.push(checkLink(e));
    if (e.net) {
      if (e.net.on === false && e.l !== 'x') parts.push('browser offline');
      if (e.net.type && !(e.l && LINK_FROM_TYPE[e.net.type])) parts.push(e.net.type);
      if (e.net.eff) parts.push(e.net.eff);
      if (e.net.dl != null) parts.push(`~${e.net.dl} Mbps`);
      if (e.net.rtt != null) parts.push(`rtt ${e.net.rtt} ms`);
      if (e.net.saveData) parts.push('data saver');
    }
    if (e.probes) parts.push(`probes ${e.probes}`);
    return parts.join(', ');
  }
  function stretchCounts(st) {
    const bits = [];
    if (st.failed) bits.push(`${st.failed} failed`);
    if (st.spotty) bits.push(`${st.spotty} spotty`);
    return `${bits.join(' + ')} of ${st.checks} checks`;
  }
  function stretchFlag(st) {
    if (st.ongoing) return '  [ONGOING]';
    if (!st.closed) return '  [recovering]';
    return '';
  }

  // ---------- text report (compact archive) ----------
  function buildReport({ now = Date.now(), userAgent = '' } = {}) {
    const sum = summarize({ now });
    const recent = load();
    const L = [];
    const row = (k, v) => L.push(`  ${(k + ':').padEnd(22)}${v}`);
    const tz = (() => {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; }
    })();

    L.push('NET PULSE — CONNECTIVITY REPORT (compact archive)');
    L.push('='.repeat(64));
    const gen = new Date(now).toLocaleString(undefined, {
      weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    row('Generated', `${gen}${tz ? ` (${tz})` : ''}`);
    if (sum.total) row('Period covered', `${fmtRange(sum.from, sum.to)} (${fmtDuration(sum.to - sum.from)})`);
    if (sum.archiveFrom != null && sum.from != null && sum.archiveFrom < sum.from) {
      row('Stretch archive from', fmtDate(sum.archiveFrom));
    }
    if (userAgent) row('Device / browser', userAgent);
    row('Stored on device', `~${fmtBytes(sum.bytes)}`);
    L.push('');
    L.push(`  This is Net Pulse's lean archive: it keeps a summary of every spotty /`);
    L.push(`  outage stretch (newest ${MAX_STRETCHES}) plus running totals, and only the last`);
    L.push(`  ${MAX_RECENT} raw checks. Totals below cover every check since the period start.`);
    L.push('');

    L.push('SUMMARY');
    L.push('-'.repeat(64));
    if (!sum.total && !sum.stretches.length) {
      L.push('  No checks recorded yet.');
    } else {
      const pc = (k) => `${sum.counts[k] || 0} (${sum.pct(k).toFixed(1)}%)`;
      row('Checks counted', String(sum.total));
      L.push('  Internet status (reachability)');
      row('Online', pc('online'));
      row('Spotty', pc('spotty'));
      row('No internet', pc('no-internet'));
      row('Offline', pc('offline'));
      row(
        'Latency',
        sum.latency.n ? `median ~${sum.latency.median} ms, 90th pct ~${sum.latency.p90} ms` : 'not measured'
      );
      row(
        'Download',
        sum.speed.n
          ? `${sum.speed.n} test${sum.speed.n > 1 ? 's' : ''}, median ~${fmtMbps(sum.speed.median)} (min ${fmtMbps(sum.speed.min)}, max ${fmtMbps(sum.speed.max)})`
          : 'not measured'
      );
      row(
        'Spotty stretches',
        `${sum.stretches.length}${sum.stretches.length ? ` (total ${fmtDuration(sum.stretchTime)})` : ''}`
      );
      row('Isolated blips', `${sum.blips} (single bad checks)`);
      const lcText = fmtLinkCounts(sum.links.counts);
      L.push('  Link type (connection path)');
      row('Link types (checks)', lcText || 'not recorded');
      if (lcText) {
        row('Link switches', `${sum.links.switches} between checks · ${sum.stretchSwitches} during stretches`);
      }
    }
    L.push('');

    L.push(`SPOTTY / OUTAGE STRETCHES (newest first, all ${sum.stretches.length} archived)`);
    L.push('-'.repeat(64));
    if (!sum.stretches.length) {
      L.push('  None detected.');
    } else {
      const n = sum.stretches.length;
      [...sum.stretches].reverse().forEach((st, i) => {
        L.push(`  #${n - i}  ${st.name}${stretchFlag(st)}`);
        L.push(`       ${fmtRange(st.start, st.end)}  (${fmtDuration(st.durationMs)})`);
        const extra = [];
        if (st.worstMs != null) extra.push(`worst latency ${st.worstMs} ms`);
        if (st.recoveredAt) extra.push(`recovered ${fmtTime(st.recoveredAt)}`);
        L.push(`       Internet: ${stretchCounts(st)}${extra.length ? ' · ' + extra.join(' · ') : ''}`);
        const li = stretchLinks(st);
        if (li) {
          const chain = fmtLinkChain(st);
          if (!li.switched) {
            L.push(`       Link: ${chain} (no switch)${st.l === 'u' ? ' - type not reported by browser' : ''}`);
          } else {
            L.push(`       Link: ${chain}  [SWITCHED]`);
            const sws = li.switches.map(
              (w) => `${fmtTime(w.t)} ${linkLabel(w.from)} → ${linkLabel(w.to)}${w.atStart ? ' (as it began)' : ''}`
            );
            if (li.more) sws.push(`+${li.more} more`);
            L.push(`       Switches: ${sws.join(' · ')}`);
          }
        }
      });
    }
    L.push('');

    const shown = [...recent].reverse().slice(0, REPORT_RECENT);
    L.push(`RECENT CHECKS (newest ${shown.length}; only the last ${MAX_RECENT} are kept on device)`);
    L.push('-'.repeat(64));
    if (!shown.length) L.push('  None.');
    else {
      L.push(`  ${'Time'.padEnd(20)}${'Internet'.padEnd(13)}${'Link'.padEnd(23)}${'Latency'.padEnd(9)}${'Download'.padEnd(13)}Network hints`);
      const prevOf = new Map(recent.map((e, i) => [e, recent[i - 1]]));
      for (const e of shown) {
        const w = checkSwitch(prevOf.get(e), e);
        const swText = w ? `[SWITCH ${linkLabel(w.from)} → ${linkLabel(w.to)}]` : '';
        L.push(
          `  ${fmtStamp(e.t).padEnd(20)}${STATUS_LABEL[e.s].padEnd(13)}${checkLink(e).padEnd(23)}${(e.ms != null ? `${e.ms} ms` : '—').padEnd(9)}${(fmtMbps(e.mbps) || '—').padEnd(13)}${[swText, fmtNet(e, { link: false }), e.src && e.src !== 'auto' ? `[${e.src}]` : ''].filter(Boolean).join(' ')}`
        );
      }
    }
    L.push('');
    L.push('NOTES');
    L.push('-'.repeat(64));
    L.push('  - Two separate things are tracked per check: INTERNET STATUS (can the device');
    L.push('    reach the internet?) and LINK TYPE (which path: Wi-Fi / Cellular / Ethernet).');
    L.push('  - Status comes from live probes to public endpoints (Cloudflare, Google');
    L.push('    connectivity check, Firefox detectportal), not just "Wi-Fi connected".');
    L.push('  - Spotty = intermittent probe failures or high latency jitter.');
    L.push('    No internet = network present but internet probes failed.');
    L.push(`  - A stretch = ${MIN_BAD}+ bad checks, each within ${MAX_GAP_MS / 60000} min of the last, with at`);
    L.push(`    most ${GOOD_TOLERANCE} good checks between them.`);
    L.push('  - Latency / download medians are approximate (~5%) running estimates.');
    L.push('  - Checks only run while Net Pulse is open; gaps mean the app was closed.');
    L.push('  - Download figures are short (~0.5 MB) estimates, not a full speed test.');
    L.push('  - Link type (Wi-Fi / Cellular / Ethernet) is what the browser reports via the');
    L.push('    Network Information API (mostly Android Chrome). iPhone/iPad browsers do not');
    L.push('    expose it, so it shows as Unknown there - never guessed. "(new network)" means');
    L.push('    the public network changed while the type stayed the same/unknown (e.g. a');
    L.push('    Wi-Fi <-> cellular switch on iPhone); the public IP itself is never stored.');
    L.push('');
    L.push('You can attach this file to an email or message (e.g. for your ISP or IT).');
    // Plain ASCII hyphen in "Wi-Fi" for email clients (UI uses a non-breaking hyphen).
    return L.join('\n').replace(/\u2011/g, '-') + '\n';
  }

  function reportFilename(now = Date.now()) {
    const d = new Date(now);
    return `net-pulse-report-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`;
  }

  return {
    KEYS,
    LEGACY_KEYS: LEGACY,
    MAX_RECENT,
    MAX_STRETCHES,
    MAX_SWITCHES,
    MAX_GAP_MS,
    STATUS_LABEL,
    LINK_LABEL,
    linkFromType,
    linkLabel,
    stretchLinks,
    fmtLinkChain,
    fmtLinkCounts,
    fmtStatusCounts,
    checkLink,
    checkSwitch,
    isBad,
    load,
    append,
    attachSpeed,
    clearAll,
    migrate,
    getLastMigration: () => lastMigration,
    detectStretches,
    allStretches,
    summarize,
    storageBytes,
    buildReport,
    reportFilename,
    fmtDuration,
    fmtTime,
    fmtDateTime,
    fmtRange,
    fmtMbps,
    fmtBytes,
    fmtNet,
    stretchCounts,
  };
});
