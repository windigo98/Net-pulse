# Net Pulse

Phone-first Progressive Web App that checks **real internet connectivity**, **latency**, and a quick **download speed estimate**. Add it to your Home Screen on iPhone or Android so it feels like a native app.

**Live site:** https://windigo98.github.io/Net-pulse/

The in-app **Tip on Cash App** button goes to https://cash.app/$windigo98.

## What it tells you

The Live page shows **two separate indicators** side by side:

| | ① **Internet status** (reachability) | ② **Link type** (connection path) |
|---|---|---|
| Question | Can this device actually reach the internet? | Which path is it using? |
| Values | Online · Spotty · No internet · Offline | Wi‑Fi · Cellular · Ethernet · Unknown · Offline |
| Source | Live probes (+ `navigator.onLine`) | Browser's Network Information API `type` (+ `navigator.onLine`) |
| Look | Round orb, traffic-light colours (green / yellow / orange / red) | Rounded-square tile, own palette (cyan / violet / blue / grey / red) |

They're independent: e.g. **No internet** + **Wi‑Fi** = joined a Wi‑Fi with a captive portal or dead uplink. Below them, a two-row timeline shows each recent check's internet result (bars) and link type (colour ticks). History keeps both per check: the summary has separate *Internet status* and *Link type* rows, stretch cards label their *Internet* and *Link* lines, recent checks show a separate link chip, and the exported report has separate *Internet* and *Link* columns.

1. **Online** — probes can reach the public internet (not just “Wi‑Fi connected”).
2. **No internet** — the device thinks it’s on a network (`navigator.onLine`), but public probes fail (captive portal, DNS outage, dead uplink).
3. **Offline** — browser reports offline / probes fail with no usable network.
4. **Spotty** — intermittent probe failures or high latency jitter over recent checks.
5. **Latency** — median RTT across several endpoints, with Excellent / Good / Fair / Poor labels.
6. **Download** — short Mbps estimate from a known-size CDN download (~0.5 MB).

7. **History (compact archive)** — Spotty / failed periods are grouped into named **spotty stretches** and archived as tiny summaries (newest 300), with running totals and only the last 50 raw checks kept; one tap exports a compact plain-text report.
8. **Connection path & switches** — the Link type indicator shows **Wi‑Fi / Cellular / Ethernet / Unknown / Offline**; when it changes (e.g. Wi‑Fi drops and the phone moves to cellular) the indicator flashes and a *Switched: Wi‑Fi → Cellular · time* note appears. Every check stores its link type, and stretches record the link at start plus any switches during the stretch.

It also shows Network Information API fields when available (`effectiveType`, `downlink`, `rtt`) as supplemental hints — never as the sole source of truth.

## Connection path (Wi‑Fi / Cellular / Ethernet) — platform limits

Net Pulse shows the link type **only when the browser reports it**, via the Network Information API (`navigator.connection.type`), and reacts to `online` / `offline` and `navigator.connection` `change` events. It never guesses Wi‑Fi vs cellular, and `effectiveType` (“4g”, “3g”…) is a **speed class**, not the link, so it is never used as the link type.

| Platform | What you get |
|---|---|
| **Android Chrome** (and most Chromium-based Android browsers / installed PWAs) | Real `type`: **Wi‑Fi / Cellular / Ethernet / Bluetooth**, live `change` events → switches are detected and flashed right away. |
| **iPhone / iPad (Safari, and every iOS browser, since they all use WebKit)** | **No `navigator.connection` at all.** The badge reads **Unknown** (or **Offline** when the browser says so). Wi‑Fi ↔ cellular can't be named. |
| Desktop Chrome / Edge | `navigator.connection` exists but `type` is usually missing → **Unknown** (ChromeOS reports it). |
| Firefox, desktop Safari | No API → **Unknown** / **Offline**. |

**What iOS still shows.** On iPhone a switch shows up in two ways, and neither one names the link type:
- **A drop:** `Unknown → Offline → Unknown` when iOS fires `offline` / `online` during the handover. A seamless handover often fires nothing.
- **“New network”:** Net Pulse reads the public IP from the Cloudflare trace probe it already makes. If a check sees **only unfamiliar** prefixes (IPv4 /16, IPv6 /48), it marks the link as *Unknown (new network)*. That takes two checks in a row, or one check right after an online/offline/change event. This usually means Wi‑Fi ↔ cellular, but it can also be a different Wi‑Fi, a VPN toggling, or carrier NAT re‑addressing. It **cannot tell you which**. The IP prefixes stay **in memory only**: they're never stored or exported.

Expect iOS history to say “Unknown” most of the time. Wi‑Fi → Cellular labels need Android Chrome. iOS also suspends PWAs in the background, so a switch that happens while Net Pulse isn't on screen only shows up when you return, if at all.

Browsers also can't tell home **hardline Ethernet behind a Wi‑Fi router** from the Wi‑Fi itself: the phone only sees its own Wi‑Fi link.

Use the same app on any network:

- **At home** — join home Wi‑Fi (or tether to a machine on the hardline). Net Pulse measures reachability and quality of *that* path to the internet.
- **At work** — join work Wi‑Fi. Same checks; useful for spotting captive portals, flaky APs, or slow uplink.
- **On cellular** — turn Wi‑Fi off; you’ll see mobile-path latency/speed.

If you need to verify a **wired modem/router**, run Net Pulse on a phone connected to that network’s Wi‑Fi, or open the app on a computer plugged into the hardline and served the same PWA.

## Start a local server

Serve over HTTP(S) so the service worker and “Add to Home Screen” work. From the repo root:

```bash
npx --yes serve -l 4173 .
```

Or with Python:

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173/` (or `http://<your-lan-ip>:4173/` from your phone on the same Wi‑Fi).

> **Note:** Installable PWAs and service workers prefer a **secure context** (HTTPS or `localhost`). For phones on your LAN, use a tunnel (e.g. `npx localtunnel --port 4173`) or host the folder on any static HTTPS host.

Helper script:

```bash
./serve.sh
```

## Tip

Net Pulse is free. If it is useful, tap **Tip on Cash App** at the top of the app, or open https://cash.app/$windigo98.

## Add to Home Screen

Open https://windigo98.github.io/Net-pulse/ (or your local server) and install it:

### iPhone / iPad (Safari)

1. Open the app URL in **Safari** (not Chrome).
2. Tap the **Share** button.
3. Tap **Add to Home Screen**.
4. Name it “Net Pulse” → **Add**.
5. Launch from the home screen icon (standalone, no browser chrome).

### Android (Chrome)

1. Open the app URL in **Chrome**.
2. Tap the **⋮** menu → **Install app** / **Add to Home Screen**.
3. Confirm. Launch from the icon.

Once installed, the offline service worker keeps the UI shell available so the app can still open and report that you’re offline.

## How probes work

| Purpose | Endpoints | Notes |
|--------|-----------|--------|
| Reachability + RTT | `https://www.cloudflare.com/cdn-cgi/trace` (CORS) | Cache-busted query `np_probe=` |
| Reachability fallback | `https://connectivitycheck.gstatic.com/generate_204` | `no-cors` — success = network path reachable |
| Reachability fallback | `https://detectportal.firefox.com/success.txt` | `no-cors` Firefox captive-portal check |
| Download Mbps | `https://speed.cloudflare.com/__down?bytes=500000` | Primary speed probe |
| Download fallback | `https://httpbin.org/bytes/500000` | Used if Cloudflare fails |

`navigator.onLine` alone is **not** trusted: captive portals and “connected but dead” uplinks often still report online. Net Pulse combines it with live fetches.

Periodic checks run about every **10 seconds** while the page is visible (reachability only). Tap **Check now** for a full pass including speed. **Speed test only** remeasures download without a full status cycle.

## History & export (compact archive)

Open the **History** tab (or the `History` app shortcut / `#history` URL). The badge on the tab shows how many spotty stretches are archived (red = one is ongoing).

History is a **lean, stretch-only archive** — it keeps what matters for an ISP/IT complaint (when it was bad, for how long, how bad) instead of hundreds of raw checks:

| localStorage key | What | Cap | Approx. size |
|---|---|---|---|
| `netpulse.stretches.v2` | Stretch summaries: start, duration, bad / failed / spotty / total check counts, worst latency, recovery time, **link at start** (`l`), link just before if it switched as the stretch began (`pl`), up to **4 switches** as `"c12,w340"` (code + seconds after start; extra switches only counted + final link) | newest **300** (oldest dropped) | ~80–100 B each; ~130 B with 4+ switches |
| `netpulse.state.v2` | Running totals over **every** check (counts per status, approximate latency & download histograms, blip count, first/last check, **checks per link type, switch count, last link**) + the currently open stretch (with its ongoing state) | fixed | < 1 KB |
| `netpulse.recent.v2` | Last raw checks (timestamp, status, latency, Mbps, **1‑char link code** `l` + `nc` “new network” flag, network hints, probe count, trigger) for the Live dots and the *Recent checks* list | newest **50** | ≤ ~9 KB |

**Worst case ≈ 30 KB total** with no switches, about 46 KB if all 300 stretches each held the maximum number of switches (typically a few KB). The old format used ~50–60 KB for just 500 checks (~80 min). The History card shows the live size.

Link codes: `w` Wi‑Fi, `c` Cellular, `e` Ethernet, `b` Bluetooth, `u` Unknown, `x` Offline. A trailing `*` in a stretch's switch list means “(new network)”. A switch is counted only between checks ≤ 5 min apart, so reopening the app somewhere else hours later isn't a “switch”.

- Periodic auto checks, **Check now**, launch checks and browser online/offline events all feed the stretch tracker and totals.
- Stretches are tracked **incrementally** as checks arrive, so a long outage stays exact even though only 50 raw checks are kept. If the app is closed mid-stretch, it shows as ended (not ongoing) and is archived on the next check.
- **Speed test only** attaches its Mbps to the most recent check (if < 2 min old), otherwise records a new check.
- Checks aborted by reloading / backgrounding the app are *not* saved as failures.
- Latency / download medians in the summary are approximate (≈5% resolution histogram).

**Link switches in History.** Stretch cards show `Link Wi‑Fi → Offline → Cellular` with a **⇄ switched** chip and the time of each switch (e.g. *6:01:50 PM Wi‑Fi → Offline (as it began) · 6:02:10 PM Offline → Cellular*). Switches on the good checks right after a stretch count too, because that's usually where the phone fixed the problem by moving to cellular. Recent checks show their link type and a **⇄ Wi‑Fi → Cellular** chip on the check where the link changed. The summary card lists the share of checks per link type and how many switches were seen. On the Live page, the sparkline dot right after a switch gets a yellow ring.

**Spotty stretches.** Bad checks (Spotty, No internet, Offline) are clustered into a stretch when each is within **5 min** of the previous bad check with at most **2 good checks** in between; a stretch needs **2+ bad checks** (singletons count as "isolated blips"). Each stretch shows a name (e.g. *Evening outage · Mon, Oct 5*; kinds: *outage* = all failed, *spotty stretch* = all spotty, *unstable stretch* = mixed), start → end, duration, `N failed + M spotty of T checks`, worst latency, and recovery time.

**Migration.** On first launch after updating, old v1 history (`netpulse.history.v1`, up to 500 raw checks, plus `netpulse.stretches.v1`) is converted automatically: stretches and totals are derived from the old checks, merged with the old stretch archive, only the newest 50 checks are kept, and the v1 keys are deleted. A toast shows the before → after size.

**Export as text.** Builds `net-pulse-report-YYYY-MM-DD-HHMM.txt` labelled *compact archive*: summary (period, % per status, approx. median/p90 latency, download stats, stretch totals, **link types + switch counts**, storage used), **all archived stretches** (newest first, each with `Link: Wi-Fi → Offline → Cellular [SWITCHED]` and a timed `Switches:` line), the newest 20 raw checks (with `[SWITCH Wi-Fi → Cellular]` markers), and methodology notes, including the iOS limitation.
- **Phones/tablets:** opens the native share sheet with the `.txt` file attached (Mail, Messages, Files, Drive…) when the Web Share API supports files; otherwise downloads it.
- **Desktop:** downloads the file. Attach it to an email or message for your ISP/IT.
- **Copy** puts the same report on the clipboard (falls back to download if clipboard is blocked).

**Clear history** asks for confirmation, then deletes the stretch archive, totals and recent checks on this device.

## Quality labels (approx.)

**Latency (median RTT)**

| Label | RTT |
|-------|-----|
| Excellent | &lt; 40 ms |
| Good | &lt; 80 ms |
| Fair | &lt; 150 ms |
| Poor | &lt; 300 ms |
| Very poor | ≥ 300 ms |

**Download**

| Label | Mbps |
|-------|------|
| Excellent | ≥ 50 |
| Good | ≥ 20 |
| Fair | ≥ 5 |
| Poor | ≥ 1 |
| Very slow | &lt; 1 |

These are UX heuristics for phone browsing / video — not SLA guarantees.

## Files

```
./
├── index.html
├── styles.css
├── app.js
├── history.js        # compact archive: stretch tracking, totals, migration, text report
├── sw.js
├── manifest.webmanifest
├── serve.sh
├── README.md
└── icons/
    ├── icon.svg
    ├── icon-192.png
    ├── icon-512.png
    └── apple-touch-icon.png
```

Asset links are relative (`./`) and the service worker scope follows the page directory, so the app works as a GitHub Pages project site at `/Net-pulse/` (the capital N in the repo name is part of that path).

## Limitations

- Speed is a **short estimate** (~0.5 MB), not a full multi-threaded speedtest.net run.
- Some corporate networks block third-party probes; the app will show No internet / probe failed even if intranet works.
- CORS / opaque responses: `no-cors` probes can only confirm that a host was reachable, not read body contents.
- Link type comes from the browser. **iOS never exposes it**, so iPhone shows *Unknown* and switches show up only as a drop or a heuristic *(new network)*. Android Chrome reports Wi‑Fi / Cellular / Ethernet. Nobody can see wired hardline behind a Wi‑Fi router. See *Connection path* above.
- True background monitoring is limited on iOS PWAs while the app is suspended — **history only covers time the app was open**; gaps mean it was closed/backgrounded.
- Only the last 50 raw checks (~8 min at 10 s) are kept; long-term history is the stretch archive (newest 300 stretches) plus running totals.
- History lives in this browser's localStorage only: it's per device + per browser, isn't synced, and is wiped if site data is cleared (iOS may also evict data for PWAs not opened for a long time). Export to keep a copy.
- Web Share with files depends on the browser (iOS Safari 15+, Android Chrome); others fall back to download. In iOS, a downloaded `.txt` opens in a preview — use its Share button to save/attach.

## Privacy

Checks run entirely in your browser against public connectivity/CDN endpoints. No analytics backend, no accounts, no API keys. History stays on the device unless you export/share it yourself.
