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

`fetchLatest()` tries three sources in order:
1. `https://api.frankfurter.dev/v1/latest` (primary, ECB data)
2. `https://open.er-api.com/v6/latest/USD` (fallback, more accessible in China)
3. `localStorage` key `er_latest` (1h TTL, used as last resort)

`fetchHistorical()` for 52-week data:
1. `frankfurter.dev` time-series endpoint (only source with free historical data)
2. `localStorage` key `er_52w` (24h TTL, then expired cache as last resort)

All fetches use `AbortController` with a 7-second timeout.

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
