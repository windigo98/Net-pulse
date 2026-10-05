/**
 * Net Pulse — real reachability, latency, download estimate, spotty detection.
 * Probe endpoints are documented in README.md.
 */
(() => {
  'use strict';

  const HISTORY_LEN = 24;
  const AUTO_INTERVAL_MS = 10000; // 10s periodic checks
  const SPEED_BYTES = 500_000; // ~0.5 MB — keeps tests quick (~1–5s on typical links)
  const PROBE_TIMEOUT_MS = 6000;

  /** Reachability / latency probes (CORS-friendly or no-cors detectable). */
  const PROBES = [
    {
      name: 'cloudflare-trace',
      // Small text; Cloudflare often sends ACAO *
      url: () => `https://www.cloudflare.com/cdn-cgi/trace?np_probe=${Date.now()}`,
      mode: 'cors',
      trace: true, // body has ip=… → used (in memory only) to notice a public-network change
    },
    {
      name: 'cloudflare-ok',
      url: () => `https://cloudflare.com/cdn-cgi/trace?np_probe=${Date.now()}`,
      mode: 'cors',
      trace: true,
    },
    {
      name: 'gstatic-204',
      // Android-style connectivity check; often opaque under no-cors
      url: () => `https://connectivitycheck.gstatic.com/generate_204?np_probe=${Date.now()}`,
      mode: 'no-cors',
    },
    {
      name: 'firefox-portal',
      url: () => `https://detectportal.firefox.com/success.txt?np_probe=${Date.now()}`,
      mode: 'no-cors',
    },
  ];

  /** Download speed endpoints (need readable body / known size). */
  const SPEED_ENDPOINTS = [
    {
      name: 'cloudflare-down',
      url: (bytes) =>
        `https://speed.cloudflare.com/__down?bytes=${bytes}&np_probe=${Date.now()}`,
    },
    {
      name: 'httpbin-bytes',
      url: (bytes) => `https://httpbin.org/bytes/${bytes}?np_probe=${Date.now()}`,
    },
  ];

  const el = {
    orb: document.getElementById('statusOrb'),
    icon: document.getElementById('statusIcon'),
    label: document.getElementById('statusLabel'),
    sub: document.getElementById('statusSub'),
    history: document.getElementById('history'),
    linkStrip: document.getElementById('linkStrip'),
    internetInd: document.getElementById('internetInd'),
    latencyValue: document.getElementById('latencyValue'),
    latencyBadge: document.getElementById('latencyBadge'),
    speedValue: document.getElementById('speedValue'),
    speedBadge: document.getElementById('speedBadge'),
    navOnline: document.getElementById('navOnline'),
    effType: document.getElementById('effType'),
    downlink: document.getElementById('downlink'),
    apiRtt: document.getElementById('apiRtt'),
    lastCheck: document.getElementById('lastCheck'),
    jitter: document.getElementById('jitter'),
    linkPill: document.getElementById('linkPill'),
    linkIcon: document.getElementById('linkIcon'),
    linkText: document.getElementById('linkText'),
    linkNote: document.getElementById('linkNote'),
    linkSwitch: document.getElementById('linkSwitch'),
    linkType: document.getElementById('linkType'),
    linkSwitches: document.getElementById('linkSwitches'),
    checkBtn: document.getElementById('checkBtn'),
    speedBtn: document.getElementById('speedBtn'),
    toast: document.getElementById('toast'),
    installHint: document.getElementById('installHint'),
    // History view
    tabLive: document.getElementById('tabLive'),
    tabHistory: document.getElementById('tabHistory'),
    historyCount: document.getElementById('historyCount'),
    viewLive: document.getElementById('viewLive'),
    viewHistory: document.getElementById('viewHistory'),
    sumChecks: document.getElementById('sumChecks'),
    archiveNote: document.getElementById('archiveNote'),
    recentDetails: document.getElementById('recentDetails'),
    sumOnline: document.getElementById('sumOnline'),
    sumStretches: document.getElementById('sumStretches'),
    sumLatency: document.getElementById('sumLatency'),
    sumRange: document.getElementById('sumRange'),
    sumLinks: document.getElementById('sumLinks'),
    sumStatus: document.getElementById('sumStatus'),
    sumSplit: document.getElementById('sumSplit'),
    exportBtn: document.getElementById('exportBtn'),
    copyBtn: document.getElementById('copyBtn'),
    stretchList: document.getElementById('stretchList'),
    checkList: document.getElementById('checkList'),
    checksSub: document.getElementById('checksSub'),
    moreBtn: document.getElementById('moreBtn'),
    clearBtn: document.getElementById('clearBtn'),
  };

  /** Persistent history module (history.js). */
  const H = window.NetPulseHistory;

  /** Live sparkline: internet result + link code per check. @type {{ ok: boolean, rtt: number|null, t: number, l: string|null, sw: boolean }[]} */
  const history = [];
  let checking = false;
  let autoTimer = null;
  let lastMedianRtt = null;
  let lastStatusKey = null; // last recorded status: online | spotty | no-internet | offline
  let unloading = false; // set on pagehide so aborted fetches aren't saved as failures
  window.addEventListener('pagehide', () => { unloading = true; });
  window.addEventListener('pageshow', () => { unloading = false; });

  function showToast(msg, ms = 2400) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.toast.classList.remove('show'), ms);
  }

  function median(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function stddev(nums) {
    if (nums.length < 2) return 0;
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    const v = nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length;
    return Math.sqrt(v);
  }

  function latencyQuality(ms) {
    if (ms == null || !Number.isFinite(ms)) return { key: 'down', label: 'Down' };
    if (ms < 40) return { key: 'excellent', label: 'Excellent' };
    if (ms < 80) return { key: 'good', label: 'Good' };
    if (ms < 150) return { key: 'fair', label: 'Fair' };
    if (ms < 300) return { key: 'poor', label: 'Poor' };
    return { key: 'down', label: 'Very poor' };
  }

  function speedQuality(mbps) {
    if (mbps == null || !Number.isFinite(mbps)) return { key: 'down', label: 'Unavailable' };
    if (mbps >= 50) return { key: 'excellent', label: 'Excellent' };
    if (mbps >= 20) return { key: 'good', label: 'Good' };
    if (mbps >= 5) return { key: 'fair', label: 'Fair' };
    if (mbps >= 1) return { key: 'poor', label: 'Poor' };
    return { key: 'down', label: 'Very slow' };
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      promise.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); }
      );
    });
  }

  /**
   * Probe one endpoint. Returns { ok, rttMs } .
   * cors: success if response.ok or status 0–399 readable
   * no-cors: success if fetch resolves (opaque) — means TCP/TLS reached host
   */
  async function probeOne(probe) {
    const url = probe.url();
    const t0 = performance.now();
    try {
      const res = await withTimeout(
        fetch(url, {
          method: 'GET',
          cache: 'no-store',
          mode: probe.mode,
          credentials: 'omit',
        }),
        PROBE_TIMEOUT_MS
      );
      const rtt = performance.now() - t0;
      if (probe.mode === 'no-cors') {
        // Opaque response still means we reached the network path
        return { ok: true, rttMs: rtt, name: probe.name };
      }
      // Some endpoints return 204 / 200
      const ok = res.type === 'opaque' || (res.status >= 200 && res.status < 400) || res.status === 204;
      let ip = null;
      if (ok && probe.trace) {
        try {
          const body = await withTimeout(res.text(), 2000);
          const m = /^ip=([0-9a-fA-F:.]+)$/m.exec(body);
          if (m) ip = m[1];
        } catch { /* body unreadable — reachability still counts */ }
      }
      return { ok, rttMs: rtt, name: probe.name, ip };
    } catch {
      return { ok: false, rttMs: null, name: probe.name };
    }
  }

  async function runReachability() {
    const results = await Promise.all(PROBES.map(probeOne));
    const okOnes = results.filter((r) => r.ok && r.rttMs != null);
    const rtts = okOnes.map((r) => r.rttMs);
    const anyOk = okOnes.length > 0;
    return {
      reachable: anyOk,
      ips: results.map((r) => r.ip).filter(Boolean),
      medianRtt: median(rtts),
      rtts,
      results,
      successCount: okOnes.length,
      failCount: results.length - okOnes.length,
    };
  }

  async function runSpeedTest() {
    for (const ep of SPEED_ENDPOINTS) {
      const url = ep.url(SPEED_BYTES);
      const t0 = performance.now();
      try {
        const res = await withTimeout(
          fetch(url, { cache: 'no-store', mode: 'cors', credentials: 'omit' }),
          15000
        );
        if (!res.ok) continue;
        const buf = await res.arrayBuffer();
        const elapsedSec = (performance.now() - t0) / 1000;
        if (elapsedSec <= 0 || !buf.byteLength) continue;
        // Mbps = (bits) / seconds / 1e6
        const mbps = (buf.byteLength * 8) / elapsedSec / 1e6;
        return { mbps, bytes: buf.byteLength, seconds: elapsedSec, endpoint: ep.name };
      } catch {
        // try next
      }
    }
    return null;
  }

  function conn() {
    return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  }

  // ---------------- Link path (Wi‑Fi / Cellular / Ethernet / Unknown / Offline) ----------------
  const LINK_ICONS = {
    w: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M2 8.5c5.5-5 14.5-5 20 0"/><path d="M5.5 12.2c3.6-3.2 9.4-3.2 13 0"/><path d="M9 15.8c1.7-1.4 4.3-1.4 6 0"/><circle cx="12" cy="19.3" r="1.3" fill="currentColor" stroke="none"/></svg>',
    c: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="15" width="3.4" height="6" rx="1"/><rect x="8.2" y="11" width="3.4" height="10" rx="1"/><rect x="13.4" y="7" width="3.4" height="14" rx="1"/><rect x="18.6" y="3" width="3.4" height="18" rx="1" opacity=".45"/></svg>',
    e: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 18v-4h8v4M10 10h4"/></svg>',
    b: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 7l10 10-5 4V3l5 4L7 17"/></svg>',
    u: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M9.2 9a3 3 0 1 1 4.3 2.7c-.9.5-1.5 1.2-1.5 2.3"/><circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };
  const SWITCH_FRESH_MS = 8000;
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
    (/Macintosh/.test(navigator.userAgent || '') && navigator.maxTouchPoints > 1);

  /** Current link as far as the browser tells us. Never inferred from effectiveType. */
  function readLink() {
    const c = conn();
    const raw = c && typeof c.type === 'string' && c.type ? c.type : null;
    const code = H ? H.linkFromType(raw, navigator.onLine) : navigator.onLine ? 'u' : 'x';
    return { code, raw };
  }

  const linkLabel = (code) => (H ? H.linkLabel(code) : code);
  let liveLink = null; // { code, raw }
  let lastSwitch = null; // { from, to, t }
  let sessionSwitches = 0;
  let pendingDotSwitch = false; // mark the next sparkline dot as "after a switch"
  let pathEventHint = false; // online/offline/change fired since the last fingerprint check
  let switchFadeTimer = null;
  let linkCheckTimer = null;

  /** Short caption under the Link type indicator. */
  function linkNoteText(link) {
    if (link.code === 'x') return 'No network connection';
    if (link.raw && link.code !== 'u') return 'Reported by your browser';
    if (link.raw) return `Browser says “${link.raw}”`;
    return isIOS ? 'Hidden by iPhone/iPad browsers' : 'Not exposed by this browser';
  }

  /** Longer explanation (tooltip on the Link type indicator). */
  function linkTitleText(link) {
    if (link.code === 'x') return 'Browser reports no network connection (navigator.onLine = false)';
    if (link.raw && link.code !== 'u') return `Reported by your browser: navigator.connection.type = ${link.raw}`;
    if (link.raw) return `Browser reports link type “${link.raw}” — can't tell Wi‑Fi vs cellular`;
    return isIOS
      ? "iPhone/iPad browsers don't reveal Wi‑Fi vs cellular. Switches show up as a drop or “new network”."
      : "This browser doesn't reveal Wi‑Fi vs cellular. Switches show up as a drop or “new network”.";
  }

  function renderLink() {
    const link = liveLink || readLink();
    el.linkPill.dataset.link = link.code;
    el.linkIcon.innerHTML = LINK_ICONS[link.code] || LINK_ICONS.u;
    el.linkText.textContent = linkLabel(link.code);
    el.linkPill.title = linkTitleText(link);
    el.linkNote.textContent = linkNoteText(link);
    el.linkType.textContent = link.raw || 'Not exposed';
    el.linkSwitches.textContent = String(sessionSwitches);
    renderSwitchNote();
  }

  function renderSwitchNote() {
    if (!lastSwitch) {
      el.linkSwitch.hidden = true;
      return;
    }
    const fresh = Date.now() - lastSwitch.t < SWITCH_FRESH_MS;
    const when = H ? H.fmtTime(lastSwitch.t) : new Date(lastSwitch.t).toLocaleTimeString();
    const what = lastSwitch.from === lastSwitch.to[0] && lastSwitch.to.length > 1
      ? `Network changed · ${linkLabel(lastSwitch.to)}`
      : `${linkLabel(lastSwitch.from)} → ${linkLabel(lastSwitch.to)}`;
    el.linkSwitch.hidden = false;
    el.linkSwitch.classList.toggle('fresh', fresh);
    el.linkSwitch.textContent = `${fresh ? 'Switched: ' : 'Last switch: '}${what} · ${when}`;
  }

  function flashLink() {
    el.linkPill.classList.remove('flash');
    void el.linkPill.offsetWidth; // restart the animation
    el.linkPill.classList.add('flash');
    clearTimeout(switchFadeTimer);
    switchFadeTimer = setTimeout(() => {
      el.linkPill.classList.remove('flash');
      renderSwitchNote();
    }, SWITCH_FRESH_MS);
  }

  /** Show a switch on the main page (badge flash + note) and count it for this session. */
  function noteSwitch(from, to) {
    lastSwitch = { from, to, t: Date.now() };
    sessionSwitches++;
    pendingDotSwitch = true;
    renderLink();
    flashLink();
    if (navigator.vibrate && !document.hidden) {
      try { navigator.vibrate(40); } catch { /* ignore */ }
    }
  }

  /** Re-read the link; if it changed, flash it and (unless offline) re-check soon so it's recorded. */
  function refreshLink({ check = true } = {}) {
    const prev = liveLink;
    liveLink = readLink();
    if (prev && prev.code !== liveLink.code) {
      noteSwitch(prev.code, liveLink.code);
      if (check && liveLink.code !== 'x') scheduleLinkCheck();
    } else {
      renderLink();
    }
  }

  function scheduleLinkCheck(delay = 1200, tries = 5) {
    clearTimeout(linkCheckTimer);
    linkCheckTimer = setTimeout(() => {
      if (checking) {
        if (tries > 1) scheduleLinkCheck(2000, tries - 1);
        return;
      }
      fullCheck({ includeSpeed: false, src: 'link' });
    }, delay);
  }

  // ---- "New network" heuristic (works where the type is hidden, e.g. iOS) ----
  // Cloudflare's trace tells us our public IP. We keep only coarse prefixes (IPv4 /16, IPv6 /48)
  // in memory — never stored or exported. If a check sees only unfamiliar prefixes (twice in a row,
  // or once right after an online/offline/change event), the public network changed: typically a
  // Wi‑Fi ↔ cellular switch or a different Wi‑Fi. It cannot say WHICH, so the type stays as reported.
  const fp = { known: [], cand: null };

  function ipPrefix(ip) {
    if (!ip) return null;
    if (ip.includes(':')) {
      const [head, tail = ''] = ip.toLowerCase().split('::');
      const h = head ? head.split(':') : [];
      const t = ip.includes('::') && tail ? tail.split(':') : [];
      const full = ip.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
      return `6:${full.slice(0, 3).map((x) => parseInt(x || '0', 16)).join(':')}`;
    }
    const p = ip.split('.');
    return p.length === 4 ? `4:${p[0]}.${p[1]}` : null;
  }

  /** Feed one check's trace IPs; returns true when a public-network change is confirmed. */
  function updateFingerprint(ips) {
    const prefixes = [...new Set(ips.map(ipPrefix).filter(Boolean))];
    if (!prefixes.length) return false;
    const hint = pathEventHint;
    pathEventHint = false;
    if (!fp.known.length) {
      fp.known = prefixes;
      return false;
    }
    if (prefixes.some((p) => fp.known.includes(p))) {
      fp.cand = null;
      fp.known = [...new Set([...fp.known, ...prefixes])].slice(-8);
      return false;
    }
    if (hint || (fp.cand && prefixes.some((p) => fp.cand.includes(p)))) {
      fp.known = [...new Set([...(fp.cand || []), ...prefixes])];
      fp.cand = null;
      return true;
    }
    fp.cand = prefixes; // unfamiliar once — confirm on the next check
    return false;
  }

  function updateNetworkInfoApi() {
    el.navOnline.textContent = navigator.onLine ? 'Yes' : 'No';
    const c = conn();
    if (c) {
      el.effType.textContent = c.effectiveType || '—';
      el.downlink.textContent = c.downlink != null ? `${c.downlink} Mbps` : '—';
      el.apiRtt.textContent = c.rtt != null ? `${c.rtt} ms` : '—';
    } else {
      el.effType.textContent = 'Not available';
      el.downlink.textContent = '—';
      el.apiRtt.textContent = '—';
    }
  }

  /** Snapshot of browser network hints (Network Information API when available). */
  function networkHints() {
    const c = conn();
    const net = { on: navigator.onLine };
    if (c) {
      if (c.effectiveType) net.eff = c.effectiveType;
      if (c.downlink != null) net.dl = c.downlink;
      if (c.rtt != null) net.rtt = c.rtt;
      // Mapped types live in the check's link code `l`; keep only unusual raw values (other, mixed…)
      if (c.type && !/^(unknown|wifi|cellular|ethernet|bluetooth|none)$/.test(c.type)) net.type = c.type;
      if (c.saveData) net.saveData = true;
    }
    return net;
  }

  /** Save one check result to persistent history and refresh History UI. */
  function record({ status, ms = null, mbps = null, src = 'auto', reach = null, t = Date.now(), nc = false }) {
    // Fetches aborted by a reload / app being backgrounded look like failures — don't save those.
    if (unloading) return;
    if (src !== 'event' && document.hidden && (status === 'offline' || status === 'no-internet')) return;
    lastStatusKey = status;
    if (!H) return;
    try {
      H.append({
        t,
        s: status,
        ms,
        mbps,
        src,
        net: networkHints(),
        l: readLink().code,
        nc: nc ? 1 : 0,
        probes: reach ? `${reach.successCount}/${reach.results.length}` : null,
      });
    } catch {
      /* storage unavailable — live checks keep working */
    }
    onHistoryChanged();
  }

  function pushHistory(ok, rtt) {
    history.push({ ok, rtt, t: Date.now(), l: readLink().code, sw: pendingDotSwitch });
    pendingDotSwitch = false;
    while (history.length > HISTORY_LEN) history.shift();
    renderHistory();
  }

  function renderHistory() {
    el.history.innerHTML = '';
    el.linkStrip.innerHTML = '';
    const items = history.length
      ? history
      : Array.from({ length: 8 }, () => ({ ok: null, rtt: null, l: null }));
    for (const h of items) {
      // Row 2: link type of the same check (separate from the internet result above it)
      const tick = document.createElement('div');
      tick.className = 'tick';
      tick.dataset.link = h.l ? h.l[0] : '';
      if (h.l) tick.title = linkLabel(h.l);
      if (h.sw) tick.classList.add('sw');
      el.linkStrip.appendChild(tick);

      const d = document.createElement('div');
      d.className = 'dot';
      let height = 8;
      let cls = '';
      if (h.ok === null) {
        height = 8;
      } else if (!h.ok) {
        cls = 'fail';
        height = 10;
      } else if (h.rtt != null) {
        if (h.rtt < 80) { cls = 'ok'; height = 28; }
        else if (h.rtt < 150) { cls = 'fair'; height = 20; }
        else { cls = 'poor'; height = 14; }
      } else {
        cls = 'ok';
        height = 18;
      }
      d.classList.add(cls || 'idle');
      if (h.sw) {
        d.classList.add('sw');
        d.title = 'Connection switched before this check';
      }
      d.style.height = `${height}px`;
      if (h.ok !== null && !h.sw) d.title = h.ok ? (h.rtt != null ? `Reachable · ${Math.round(h.rtt)} ms` : 'Reachable') : 'Not reachable';
      el.history.appendChild(d);
    }
  }

  function computeSpotty() {
    if (history.length < 4) return false;
    const recent = history.slice(-8);
    const fails = recent.filter((h) => !h.ok).length;
    const rtts = recent.filter((h) => h.ok && h.rtt != null).map((h) => h.rtt);
    const jit = stddev(rtts);
    // Spotty if intermittent failures OR high jitter with mixed results
    if (fails >= 2 && fails < recent.length) return true;
    if (fails >= 1 && jit > 80) return true;
    if (rtts.length >= 4 && jit > 120) return true;
    return false;
  }

  function setStatus(state, label, sub) {
    el.orb.dataset.state = state;
    el.internetInd.dataset.state = state;
    el.label.textContent = label;
    el.sub.textContent = sub;
    const icons = {
      online: '✓',
      spotty: '~',
      'no-internet': '!',
      offline: '✕',
      checking: '…',
    };
    el.icon.textContent = icons[state] || '•';
  }

  function setLatency(ms) {
    lastMedianRtt = ms;
    if (ms == null) {
      el.latencyValue.innerHTML = `—<span class="unit">ms</span>`;
      el.latencyBadge.textContent = '—';
      el.latencyBadge.dataset.q = '';
      return;
    }
    el.latencyValue.innerHTML = `${Math.round(ms)}<span class="unit">ms</span>`;
    const q = latencyQuality(ms);
    el.latencyBadge.textContent = q.label;
    el.latencyBadge.dataset.q = q.key;
  }

  function setSpeed(mbps) {
    if (mbps == null) {
      el.speedValue.innerHTML = `—<span class="unit">Mbps</span>`;
      el.speedBadge.textContent = '—';
      el.speedBadge.dataset.q = '';
      return;
    }
    const shown = mbps >= 10 ? mbps.toFixed(1) : mbps.toFixed(2);
    el.speedValue.innerHTML = `${shown}<span class="unit">Mbps</span>`;
    const q = speedQuality(mbps);
    el.speedBadge.textContent = q.label;
    el.speedBadge.dataset.q = q.key;
  }

  function updateJitterDisplay() {
    const rtts = history.filter((h) => h.ok && h.rtt != null).map((h) => h.rtt).slice(-8);
    if (rtts.length < 2) {
      el.jitter.textContent = '—';
      return;
    }
    el.jitter.textContent = `${Math.round(stddev(rtts))} ms σ`;
  }

  async function fullCheck({ includeSpeed = true, src = 'auto' } = {}) {
    if (checking) return;
    checking = true;
    el.checkBtn.disabled = true;
    el.speedBtn.disabled = true;
    setStatus('checking', 'Checking…', 'Probing reachability & quality');
    updateNetworkInfoApi();
    refreshLink({ check: false });

    const browserOnline = navigator.onLine;

    try {
      if (!browserOnline) {
        // Still probe — navigator.onLine can be wrong, but usually correct when false
        const reach = await runReachability();
        pushHistory(reach.reachable, reach.medianRtt);
        if (!reach.reachable) {
          record({ status: 'offline', src, reach });
          setStatus('offline', 'Offline', 'No network — cannot reach the internet');
          setLatency(null);
          if (includeSpeed) setSpeed(null);
          el.lastCheck.textContent = new Date().toLocaleTimeString();
          updateJitterDisplay();
          return;
        }
        // Rare: browser says offline but probes worked
      }

      const reach = await runReachability();
      const tCheck = Date.now();
      refreshLink({ check: false });
      const nc = updateFingerprint(reach.ips);
      if (nc && liveLink && liveLink.code !== 'x') {
        const cur = liveLink.code;
        if (lastSwitch && lastSwitch.to === cur && lastSwitch.from !== cur && Date.now() - lastSwitch.t < 60000) {
          // Just came back from a drop: "Offline → Unknown" becomes "Offline → Unknown (new network)".
          // A known type ("Offline → Cellular") already says it all.
          if (cur === 'u') {
            lastSwitch.to = 'u*';
            renderLink();
            flashLink();
          }
        } else {
          noteSwitch(cur, `${cur}*`); // same / hidden type, different public network
        }
      }
      pushHistory(reach.reachable, reach.medianRtt);
      setLatency(reach.medianRtt);
      el.lastCheck.textContent = new Date().toLocaleTimeString();
      updateJitterDisplay();

      const spotty = computeSpotty();

      if (!reach.reachable) {
        record({ status: browserOnline ? 'no-internet' : 'offline', src, reach, t: tCheck, nc });
        if (browserOnline) {
          setStatus(
            'no-internet',
            'No internet',
            'Connected to a network, but internet probes failed (captive portal or outage?)'
          );
        } else {
          setStatus('offline', 'Offline', 'Device reports offline and probes failed');
        }
        if (includeSpeed) setSpeed(null);
        return;
      }

      if (spotty) {
        setStatus(
          'spotty',
          'Spotty',
          `Reachable but unstable · median ${Math.round(reach.medianRtt)} ms`
        );
      } else {
        const q = latencyQuality(reach.medianRtt);
        setStatus(
          'online',
          'Online',
          `Reachable · ${q.label.toLowerCase()} latency (${Math.round(reach.medianRtt)} ms)`
        );
      }

      const status = spotty ? 'spotty' : 'online';
      let mbps = null;
      if (includeSpeed) {
        const baseSub = el.sub.textContent || '';
        el.sub.textContent = baseSub + ' · measuring download…';
        const speed = await runSpeedTest();
        el.sub.textContent = baseSub;
        if (speed) {
          mbps = speed.mbps;
          setSpeed(speed.mbps);
        } else {
          setSpeed(null);
          el.speedBadge.textContent = 'Probe failed';
          el.speedBadge.dataset.q = 'down';
        }
      }
      record({ status, ms: reach.medianRtt, mbps, src, reach, t: tCheck, nc });
    } finally {
      checking = false;
      el.checkBtn.disabled = false;
      el.speedBtn.disabled = false;
      updateNetworkInfoApi();
    }
  }

  async function speedOnly() {
    if (checking) return;
    checking = true;
    el.checkBtn.disabled = true;
    el.speedBtn.disabled = true;
    showToast('Running speed test…');
    try {
      const speed = await runSpeedTest();
      if (speed) {
        setSpeed(speed.mbps);
        showToast(`Download ≈ ${speed.mbps.toFixed(1)} Mbps`);
        if (H) {
          try {
            H.attachSpeed(speed.mbps, { fallbackStatus: lastStatusKey || 'online', net: networkHints(), l: readLink().code });
          } catch { /* ignore */ }
          onHistoryChanged();
        }
      } else {
        setSpeed(null);
        el.speedBadge.textContent = 'Probe failed';
        el.speedBadge.dataset.q = 'down';
        showToast('Speed probe failed — try again');
      }
    } finally {
      checking = false;
      el.checkBtn.disabled = false;
      el.speedBtn.disabled = false;
    }
  }

  function startAuto() {
    stopAuto();
    autoTimer = setInterval(() => {
      if (document.hidden) return;
      // Periodic: reachability only (faster), full speed on manual / load
      fullCheck({ includeSpeed: false });
    }, AUTO_INTERVAL_MS);
  }

  function stopAuto() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
  }

  // Events
  el.checkBtn.addEventListener('click', () => fullCheck({ includeSpeed: true, src: 'manual' }));
  el.speedBtn.addEventListener('click', () => speedOnly());

  window.addEventListener('online', () => {
    showToast('Network event: online');
    pathEventHint = true;
    refreshLink({ check: false });
    if (checking) scheduleLinkCheck(1500);
    else fullCheck({ includeSpeed: false, src: 'event' });
  });
  window.addEventListener('offline', () => {
    showToast('Network event: offline');
    pathEventHint = true;
    refreshLink({ check: false });
    setStatus('offline', 'Offline', 'Browser reported offline');
    pushHistory(false, null);
    setLatency(null);
    record({ status: 'offline', src: 'event' });
  });

  // Network Information API change (Android Chrome etc.): fires on type AND on rtt/downlink
  // changes — refreshLink only flashes when the link type actually changed.
  const c0 = conn();
  if (c0 && typeof c0.addEventListener === 'function') {
    c0.addEventListener('change', () => {
      const before = liveLink && liveLink.code;
      updateNetworkInfoApi();
      refreshLink();
      if (liveLink && before && liveLink.code !== before) {
        pathEventHint = true;
        showToast(`Connection switched: ${linkLabel(before)} → ${linkLabel(liveLink.code)}`, 3500);
      }
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshLink({ check: false });
      fullCheck({ includeSpeed: false });
    }
  });

  // ---------------- History view ----------------
  const PAGE_SIZE = 15; // recent-check rows shown before "Show all" (storage keeps ≤ H.MAX_RECENT)
  let shownChecks = PAGE_SIZE;
  let historyRenderQueued = false;

  function isHistoryView() {
    return location.hash === '#history';
  }

  function applyRoute() {
    const hist = isHistoryView();
    el.viewLive.hidden = hist;
    el.viewHistory.hidden = !hist;
    el.tabLive.setAttribute('aria-selected', String(!hist));
    el.tabHistory.setAttribute('aria-selected', String(hist));
    if (hist) {
      shownChecks = PAGE_SIZE;
      renderHistoryView();
    }
    window.scrollTo(0, 0);
  }

  function onHistoryChanged() {
    updateHistoryCount();
    if (!isHistoryView() || historyRenderQueued) return;
    historyRenderQueued = true;
    requestAnimationFrame(() => {
      historyRenderQueued = false;
      renderHistoryView();
    });
  }

  function updateHistoryCount() {
    if (!H) return;
    const { stretches } = H.allStretches();
    const ongoing = stretches.some((s) => s.ongoing);
    el.historyCount.hidden = !stretches.length;
    el.historyCount.textContent = String(stretches.length);
    el.historyCount.classList.toggle('live', ongoing);
    el.historyCount.title = `${stretches.length} spotty stretch${stretches.length === 1 ? '' : 'es'}${ongoing ? ' (one ongoing)' : ''}`;
  }

  function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderHistoryView() {
    if (!H) {
      el.sumRange.textContent = 'History unavailable in this browser.';
      return;
    }
    const entries = H.load(); // last ≤ MAX_RECENT raw checks only
    const sum = H.summarize();
    const hasData = sum.total > 0 || sum.stretches.length > 0;

    el.sumStretches.textContent = String(sum.stretches.length);
    el.sumChecks.textContent = String(sum.total);
    el.sumOnline.textContent = sum.total ? `${Math.round(sum.pct('online'))}%` : '—';
    el.sumLatency.textContent = sum.latency.median != null ? `~${sum.latency.median} ms` : '—';
    el.sumRange.textContent = sum.total
      ? `${H.fmtRange(sum.from, sum.to)} · ${sum.blips} isolated blip${sum.blips === 1 ? '' : 's'}${sum.stretchTime ? ` · ${H.fmtDuration(sum.stretchTime)} in stretches` : ''}`
      : 'No checks recorded yet. Keep Net Pulse open and stretches will be archived here.';
    const lc = H.fmtLinkCounts(sum.links.counts);
    el.sumSplit.hidden = !sum.total;
    // keep "No internet 8%" / "Wi‑Fi 50%" together when the line wraps
    const nb = (t) => t.split(' · ').map((x) => x.replace(/ /g, '\u00a0')).join(' · ');
    el.sumStatus.textContent = nb(H.fmtStatusCounts(sum.counts)) || '—';
    el.sumLinks.textContent = lc
      ? `${nb(lc)} · ${sum.links.switches} switch${sum.links.switches === 1 ? '' : 'es'}` +
        (sum.stretchSwitches ? ` (${sum.stretchSwitches} in stretches)` : '')
      : 'Not recorded yet';
    el.archiveNote.textContent =
      `Compact archive: up to ${H.MAX_STRETCHES} stretch summaries + running totals + last ${H.MAX_RECENT} checks · ` +
      `${H.fmtBytes(sum.bytes)} used on this device`;
    el.exportBtn.disabled = !hasData;
    el.copyBtn.disabled = !hasData;
    el.clearBtn.disabled = !hasData && !entries.length;

    // Stretches (newest first) — the heart of the archive
    el.stretchList.innerHTML = '';
    if (!sum.stretches.length) {
      el.stretchList.appendChild(mk('p', 'empty', sum.total ? 'No spotty stretches detected. 🎉' : 'Nothing yet.'));
    } else {
      const n = sum.stretches.length;
      [...sum.stretches].reverse().forEach((st, i) => {
        const card = mk('article', `stretch ${st.kind.replace(/\s+/g, '-')}${st.ongoing ? ' ongoing' : ''}`);
        const head = mk('div', 'stretch-head');
        const links = H.stretchLinks(st);
        const nameEl = mk('span', 'stretch-name', `#${n - i} ${st.name}`);
        if (links && links.switched) nameEl.appendChild(mk('span', 'chip-switch', '⇄ switched'));
        head.appendChild(nameEl);
        const dur = H.fmtDuration(st.durationMs);
        head.appendChild(mk('span', 'stretch-dur', st.ongoing ? `ongoing · ${dur}` : !st.closed ? `recovering · ${dur}` : dur));
        card.appendChild(head);
        card.appendChild(mk('p', 'stretch-range', H.fmtRange(st.start, st.end)));
        const extra = [H.stretchCounts(st)];
        if (st.worstMs != null) extra.push(`worst ${st.worstMs} ms`);
        if (st.recoveredAt) extra.push(`recovered ${H.fmtTime(st.recoveredAt)}`);
        const ip = mk('p', 'stretch-meta');
        ip.appendChild(mk('span', 'dim-lbl dim-internet', 'Internet'));
        ip.appendChild(document.createTextNode(extra.join(' · ')));
        card.appendChild(ip);
        if (links) {
          const lp = mk('p', `stretch-link${links.switched ? ' switched' : ''}`);
          lp.appendChild(mk('span', 'dim-lbl dim-link', 'Link'));
          if (!links.switched) lp.appendChild(document.createTextNode('at start '));
          lp.appendChild(mk('strong', null, H.fmtLinkChain(st)));
          if (!links.switched) lp.appendChild(document.createTextNode(st.l === 'u' ? ' · no switch seen (type hidden by browser)' : ' · no switch'));
          card.appendChild(lp);
          if (links.switched) {
            const sws = links.switches.map(
              (w) => `${H.fmtTime(w.t)} ${H.linkLabel(w.from)} → ${H.linkLabel(w.to)}${w.atStart ? ' (as it began)' : ''}`
            );
            if (links.more) sws.push(`+${links.more} more`);
            card.appendChild(mk('p', 'stretch-switches', sws.join(' · ')));
          }
        }
        el.stretchList.appendChild(card);
      });
    }

    // Recent checks (short window, newest first)
    el.checkList.innerHTML = '';
    const prevOf = new Map(entries.map((e, i) => [e, entries[i - 1]]));
    const recent = [...entries].reverse();
    el.checksSub.textContent = recent.length ? `last ${recent.length} of max ${H.MAX_RECENT}` : '';
    for (const e of recent.slice(0, shownChecks)) {
      const w = H.checkSwitch(prevOf.get(e), e);
      const li = mk('li', `check s-${e.s}${w ? ' switched' : ''}`);
      li.appendChild(mk('span', 'check-dot'));
      const main = mk('div', 'check-main');
      const top = mk('div', 'check-top');
      const stEl = mk('span', 'check-status', H.STATUS_LABEL[e.s]);
      const lk = mk('span', 'link-chip', e.l ? H.linkLabel(e.nc ? `${e.l}*` : e.l) : 'Link n/a');
      lk.dataset.link = e.l || '';
      lk.title = 'Link type at this check';
      stEl.appendChild(lk);
      if (w) stEl.appendChild(mk('span', 'chip-switch', `⇄ ${H.linkLabel(w.from)} → ${H.linkLabel(w.to)}`));
      top.appendChild(stEl);
      const nums = [];
      if (e.ms != null) nums.push(`${e.ms} ms`);
      if (e.mbps != null) nums.push(H.fmtMbps(e.mbps));
      top.appendChild(mk('span', 'check-nums', nums.join(' · ') || '—'));
      main.appendChild(top);
      const hints = H.fmtNet(e, { link: false });
      const when = new Date(e.t).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
      });
      main.appendChild(mk('div', 'check-sub', [when, e.src && e.src !== 'auto' ? e.src : '', hints].filter(Boolean).join(' · ')));
      li.appendChild(main);
      el.checkList.appendChild(li);
    }
    if (!recent.length) el.checkList.appendChild(mk('li', 'empty', 'No checks yet.'));
    el.moreBtn.hidden = recent.length <= shownChecks;
    el.moreBtn.textContent = `Show all ${recent.length}`;
  }

  function buildReportText() {
    return H.buildReport({ userAgent: navigator.userAgent });
  }

  function isMobileDevice() {
    const ua = navigator.userAgent || '';
    if (navigator.userAgentData && navigator.userAgentData.mobile) return true;
    return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ||
      // iPadOS reports as Mac; detect touch
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  }

  function downloadText(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async function exportReport() {
    if (!H) return;
    const text = buildReportText();
    const filename = H.reportFilename();
    // Mobile: prefer the native share sheet with a real .txt file (Mail, Messages, Files…)
    if (isMobileDevice() && typeof File === 'function' && navigator.canShare) {
      try {
        const file = new File([text], filename, { type: 'text/plain' });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({
            files: [file],
            title: 'Net Pulse connectivity report',
            text: 'Net Pulse connectivity report — compact stretch archive (attached .txt).',
          });
          showToast('Report shared');
          return;
        }
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user closed the share sheet
        // otherwise fall through to download
      }
    }
    downloadText(text, filename);
    showToast(`Saved ${filename} — attach it to an email or message`, 4000);
  }

  async function copyReport() {
    if (!H) return;
    const text = buildReportText();
    try {
      await navigator.clipboard.writeText(text);
      showToast('Report copied — paste into an email or message');
    } catch {
      downloadText(text, H.reportFilename());
      showToast('Clipboard blocked — downloaded the .txt instead', 3500);
    }
  }

  el.exportBtn.addEventListener('click', exportReport);
  el.copyBtn.addEventListener('click', copyReport);
  el.moreBtn.addEventListener('click', () => {
    shownChecks = Infinity;
    renderHistoryView();
  });
  el.clearBtn.addEventListener('click', () => {
    if (!H) return;
    const n = H.allStretches().stretches.length;
    if (!window.confirm(`Clear the compact archive (${n} spotty stretch${n === 1 ? '' : 'es'}, running totals and recent checks)? This cannot be undone. Export first if you need it.`)) return;
    H.clearAll();
    onHistoryChanged();
    renderHistoryView();
    showToast('Archive cleared');
  });
  window.addEventListener('hashchange', applyRoute);
  // Another tab/window of the app wrote history
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key.startsWith('netpulse.')) onHistoryChanged();
  });

  // Install hint for iOS / Android
  function updateInstallHint() {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
    if (isStandalone) {
      el.installHint.textContent = 'Installed';
      return;
    }
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) {
      el.installHint.textContent = 'Share → Add to Home Screen';
    } else if (/Android/i.test(ua)) {
      el.installHint.textContent = 'Menu → Install app';
    } else {
      el.installHint.textContent = 'Installable PWA';
    }
  }

  // Service worker. Scope follows the page directory so /Net-pulse/ on GitHub Pages
  // (capital N in the repo name) is the app root, not the user site root.
  if ('serviceWorker' in navigator) {
    const basePath = (() => {
      let path = location.pathname;
      if (path.endsWith('/index.html')) path = path.slice(0, -'index.html'.length);
      if (!path.endsWith('/')) path += '/';
      return new URL(path, location.origin);
    })();
    navigator.serviceWorker.register(new URL('sw.js', basePath), { scope: basePath.href }).catch(() => {
      /* offline shell optional if SW fails */
    });
  }

  // Boot — seed the live sparkline with checks from the last few minutes
  if (H) {
    const cutoff = Date.now() - 5 * 60 * 1000;
    const all = H.load();
    all.forEach((e, i) => {
      if (e.t < cutoff) return;
      history.push({ ok: e.s === 'online' || e.s === 'spotty', rtt: e.ms ?? null, t: e.t, l: e.l || null, sw: !!H.checkSwitch(all[i - 1], e) });
    });
    while (history.length > HISTORY_LEN) history.shift();
  }
  // Legacy v1 (500 raw checks) is compacted on first load(); tell the user once.
  const mig = H && H.getLastMigration();
  if (mig && mig.checksBefore > mig.checksAfter) {
    setTimeout(() => showToast(
      `History compacted: ${mig.checksBefore} → ${mig.checksAfter} raw checks, ${mig.stretches} stretch${mig.stretches === 1 ? '' : 'es'} kept · ${H.fmtBytes(mig.bytesBefore)} → ${H.fmtBytes(mig.bytesAfter)}`,
      5000
    ), 600);
  }
  applyRoute();
  updateHistoryCount();
  renderHistory();
  updateNetworkInfoApi();
  refreshLink({ check: false });
  updateInstallHint();
  fullCheck({ includeSpeed: true, src: 'launch' }).then(startAuto);
})();
