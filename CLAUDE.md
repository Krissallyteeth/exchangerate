# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Static single-page app showing real-time USD/KRW, CNY/KRW, and USD/CNY exchange rates with 52-week high/low. Deployed on GitHub Pages at `https://krissallyteeth.github.io/exchangerate/`. No build step — open `index.html` directly in a browser to develop.

## Architecture

Two files only:

- **`index.html`** — all markup and CSS in one file. No external CSS dependencies (Tailwind was intentionally removed so the page works in China without a VPN).
- **`app.js`** — all JS: API fetching, state, rendering, clock, auto-refresh.

### Data flow in `app.js`

```
init()
  ├─ startClock()                  setInterval every 1s
  ├─ showSkeletons()
  ├─ fetchAllData()
  │    ├─ fetchLatest()            primary → fallback → localStorage
  │    ├─ fetchHistorical()        primary → localStorage cache (24h TTL)
  │    ├─ processLatest()          computes cny-krw = KRW / CNY (cross rate)
  │    └─ renderAllCards()         updates DOM + range bar position
  └─ scheduleRefresh()             re-runs fetchAllData every 5 min
```

### API resilience (China VPN-off support)

`fetchLatest()` tries five sources in order:
1. **Naver** (`m.stock.naver.com` front-api, `FX_USDKRW` + `FX_CNYKRW`) — 하나은행 매매기준율, exactly what Korean users see on Naver. `fetchNaver()` returns `{ KRW, CNY }` where `CNY = USDKRW/CNYKRW`, so `processLatest`'s `cny-krw = KRW/CNY` round-trips back to Naver's direct CNY/KRW. Sets `apiSource = 'naver'` (no footer badge — live).
2. **Yahoo Finance** chart API (`KRW=X`, `CNY=X`) — global mid-market, minute-level (closer to Google). Sets `apiSource = 'realtime'` (no badge).
3. `https://api.frankfurter.dev/v1/latest` (ECB **daily** reference rates, ~16:00 CET, weekdays only). Footer badge "ECB 일일고시".
4. `https://open.er-api.com/v6/latest/USD` (fallback, daily, more accessible in China).
5. `localStorage` key `er_latest` (1h TTL, used as last resort).

Sources 1–2 send no CORS headers, so requests are routed through a raced pool of public CORS proxies (`corsproxy.io` / `allorigins.win` / `codetabs.com`) via `fetchViaProxies()` (`Promise.any`). Best-effort: blocked in China → falls through. Naver values pass sanity-range guards so a format change falls back instead of rendering garbage.

> Note: sources 3–5 are daily, not real-time. Footer badge signals when a non-live source is in use so the user understands any gap vs Naver/Google's live rate.

`fetchHistorical()` for 52-week data:
1. `frankfurter.dev` time-series endpoint (only source with free historical data)
2. `localStorage` key `er_52w` (24h TTL, then expired cache as last resort)

Latest fetches use a 6s timeout for the realtime source (`RT_TIMEOUT_MS`, fail-fast so China falls back quickly) and a 7s timeout (`TIMEOUT_MS`) elsewhere, all via `AbortController`.

### Card state machine

Each card (`usd-krw`, `cny-krw`, `usd-cny`) has three mutually exclusive DOM groups toggled via `.hidden`:
- `.skeleton-group-{id}` — shown during loading
- `.data-group-{id}` — shown on success
- `.error-group-{id}` — shown on total failure

### CSS design tokens

Apple-style design, all written inline in `<style>`. Key values:
- Background: `#f5f5f7`, cards: `#ffffff`
- Accent: `#0071e3` (Apple blue)
- Responsive breakpoints: `≤860px` → 1-column grid; `≤580px` → mobile (stacked header)
- Font: `-apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC"`

## Adding a new currency pair

1. Add the pair ID string to `PAIRS` in `app.js`
2. Add a card block in `index.html` following the existing pattern (skeleton/data/error groups, IDs like `rate-{id}`, `bar-fill-{id}`, etc.)
3. Extend `processLatest()` in `app.js` to compute the new rate from the raw `KRW`/`CNY` values returned by the APIs
4. If the new currency isn't in the frankfurter.dev response, update both `fetchLatest()` and `fetchHistorical()` query strings and extend `compute52W()`
