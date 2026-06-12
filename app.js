// ── Constants ──────────────────────────────────────────────
const PRIMARY_URL   = 'https://api.frankfurter.dev/v1';
const FALLBACK_URL  = 'https://open.er-api.com/v6/latest/USD';
const TIMEOUT_MS    = 7000;
const RT_TIMEOUT_MS = 6000;   // realtime source: fail fast so we fall back quickly (e.g. in China)
const HIST_TIMEOUT_MS = 12000; // 52-week history: larger payload, allow more time (mobile)

// Realtime sources (routed through a raced pool of public CORS proxies, since
// neither Naver nor Yahoo sends CORS headers). If all proxies fail (e.g. blocked
// in China) we transparently fall back to the ECB/er-api daily sources below.
//   - Naver Finance: 하나은행 매매기준율 — exactly what Naver shows Korean users.
//   - Yahoo Finance:  global mid-market rate, minute-level.
const NAVER_BASE    = 'https://m.stock.naver.com/front-api/marketIndex/prices?category=exchange&page=1&reutersCode=';
const NAVER_HIST    = 'https://m.stock.naver.com/front-api/marketIndex/prices?category=exchange&page=1&pageSize=366&reutersCode=';  // ~1y daily history
const YAHOO_BASE    = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const STOOQ_BASE    = 'https://stooq.com/q/d/l/?i=d&s=';  // daily OHLC CSV (52-week history)
// MSN Money quotes — returns 52-week high/low directly (one call). Public apikey
// embedded in MSN's own pages; instrument ids are per currency pair.
const MSN_KEY       = '0QfOX3Vn51YCzitbLaRkTTBadtWpgTN8NZLW0C1SEM';
const MSN_QUOTES    = `https://assets.msn.com/service/finance/quotes?apikey=${MSN_KEY}&wrapodata=false&ids=`;
const MSN_IDS       = { 'usd-krw': 'avyoyc', 'usd-cny': 'avym77', 'cny-krw': 'av4yvh' };
const CORS_PROXIES  = [
  'https://corsproxy.io/?url=',
  'https://api.allorigins.win/raw?url=',
  'https://api.codetabs.com/v1/proxy/?quest=',
];
const REFRESH_MS    = 5 * 60 * 1000;   // 5 minutes
const CACHE_52W_TTL       = 24 * 60 * 60 * 1000;  // 24 hours (cache usable as fallback)
const CACHE_52W_FETCH_TTL = 6 * 60 * 60 * 1000;   // 6 hours (re-pull history at most this often)
const CACHE_NOW_TTL       = 60 * 60 * 1000;       // 1 hour
const CACHE_52W_KEY       = 'er_52w_v3';          // bumped: drop old Yahoo/ECB caches so MSN is tried

const PAIRS = ['usd-krw', 'cny-krw', 'usd-cny'];
const BUILD = 'msn6';  // shown in footer so the live build is unambiguous (cache check)

// ── State ──────────────────────────────────────────────────
const state = {
  latestData:      null,  // { 'usd-krw': n, 'usd-cny': n, 'cny-krw': n }
  historicalData:  null,  // { 'usd-krw': {low,high}, ... } | null
  lastUpdated:     null,
  nextRefreshAt:   null,
  refreshTimer:    null,
  countdownTimer:  null,
  clockTimer:      null,
  isLoading:       false,
  apiSource:       null,  // 'naver' | 'realtime' | 'primary' | 'fallback' | 'cache'
  h52wSource:      null,  // 'msn' | 'naver' | 'stooq' | 'yahoo' | 'ecb' | 'expired-cache' | 'none'
  h52wDiag:        '',    // TEMP: MSN failure reason for footer
};

// ── Clock ──────────────────────────────────────────────────
function startClock() {
  function tick() {
    const now = new Date();
    document.getElementById('clock').textContent =
      now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    document.getElementById('date-display').textContent =
      now.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  }
  tick();
  state.clockTimer = setInterval(tick, 1000);
}

// ── Visibility helpers ────────────────────────────────────
function showSkeletons() {
  PAIRS.forEach(id => { show(`skeleton-group-${id}`); hide(`data-group-${id}`); hide(`error-group-${id}`); });
}

function showData() {
  PAIRS.forEach(id => { hide(`skeleton-group-${id}`); show(`data-group-${id}`); hide(`error-group-${id}`); });
}

function showErrorState() {
  PAIRS.forEach(id => { hide(`skeleton-group-${id}`); hide(`data-group-${id}`); show(`error-group-${id}`); });
}

function show(cls) { document.querySelectorAll(`.${cls}`).forEach(el => el.classList.remove('hidden')); }
function hide(cls) { document.querySelectorAll(`.${cls}`).forEach(el => el.classList.add('hidden')); }

// ── LocalStorage cache ────────────────────────────────────
function saveCache(key, data) {
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), d: data })); } catch (_) {}
}

function loadCache(key, ttl, allowExpired = false) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const { t, d } = JSON.parse(raw);
    const expired = Date.now() - t > ttl;
    if (expired && !allowExpired) return null;
    return { data: d, expired };
  } catch (_) { return null; }
}

// ── Network helpers ───────────────────────────────────────
function formatDate(date) { return date.toISOString().slice(0, 10); }

async function fetchWithTimeout(url, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Same as fetchWithTimeout but returns the raw body text (for CSV sources).
async function fetchTextWithTimeout(url, ms = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Race a target URL across all CORS proxies: resolve with the first proxy
// whose `extract` returns a usable value, reject (AggregateError) only if all
// fail. `extract` must throw if the response is unusable.
function fetchViaProxies(target, extract, ms = RT_TIMEOUT_MS) {
  const attempts = CORS_PROXIES.map(async (proxy) => {
    const json = await fetchWithTimeout(proxy + encodeURIComponent(target), ms);
    return extract(json);
  });
  return Promise.any(attempts);
}

function asRate(value) {
  if (typeof value !== 'number' || !(value > 0)) throw new Error('No usable value in response');
  return value;
}

// Readable reason for a failure. Promise.any rejects with an AggregateError
// whose `.errors` holds each proxy's cause.
function diagMsg(e) {
  if (e && e.errors && e.errors.length) {
    return e.errors.map((x) => (x && (x.message || String(x))) || '?').join(' | ');
  }
  return (e && (e.message || String(e))) || '?';
}

// ── Fetch: realtime rates (Naver — 하나은행 매매기준율) ──
// reutersCode "FX_USDKRW" → USD/KRW, "FX_CNYKRW" → CNY/KRW (직접 호가).
async function fetchNaverPrice(reutersCode) {
  return fetchViaProxies(NAVER_BASE + reutersCode, (json) => {
    // front-api returns { result: [{ closePrice }] }; older api returns { closePrice }.
    const node = (json && json.result && json.result[0]) || json;
    const raw  = node && node.closePrice;
    return asRate(parseFloat(String(raw).replace(/[^0-9.]/g, '')));  // strip thousands separators
  });
}

async function fetchNaver() {
  const [usdKrw, cnyKrw] = await Promise.all([
    fetchNaverPrice('FX_USDKRW'),
    fetchNaverPrice('FX_CNYKRW'),
  ]);
  // Sanity guards: if Naver changes its format and we mis-parse, fall back to
  // another source instead of rendering a garbage number.
  if (!(usdKrw > 500 && usdKrw < 3000)) throw new Error('USD/KRW out of sane range');
  if (!(cnyKrw > 80  && cnyKrw < 500))  throw new Error('CNY/KRW out of sane range');
  // Keep the { KRW, CNY } shape: processLatest derives cny-krw = KRW / CNY,
  // which round-trips back to Naver's CNY/KRW exactly.
  return { KRW: usdKrw, CNY: usdKrw / cnyKrw };
}

// ── Fetch: realtime rates (Yahoo Finance via CORS proxy) ──
// Symbol "KRW=X" → USD/KRW, "CNY=X" → USD/CNY.
async function fetchYahooSymbol(symbol) {
  const target = `${YAHOO_BASE}${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  return fetchViaProxies(target, (json) =>
    asRate(json && json.chart && json.chart.result && json.chart.result[0]
      && json.chart.result[0].meta && json.chart.result[0].meta.regularMarketPrice));
}

async function fetchRealtime() {
  const [KRW, CNY] = await Promise.all([
    fetchYahooSymbol('KRW=X'),
    fetchYahooSymbol('CNY=X'),
  ]);
  return { KRW, CNY };
}

// ── Fetch: current rates ──────────────────────────────────
async function fetchLatest() {
  // 0a. Naver (하나은행 매매기준율) — matches what Korean users see on Naver
  try {
    const rates = await fetchNaver();
    saveCache('er_latest', rates);
    state.apiSource = 'naver';
    return rates;
  } catch (e) {
    console.warn('Realtime (Naver) failed:', e.message);
  }

  // 0b. Yahoo Finance (global mid-market, minute-level) — best effort, racey
  try {
    const rates = await fetchRealtime();
    saveCache('er_latest', rates);
    state.apiSource = 'realtime';
    return rates;
  } catch (e) {
    console.warn('Realtime (Yahoo) failed:', e.message);
  }

  // 1. Primary API (frankfurter.dev — ECB daily reference rates)
  try {
    const json = await fetchWithTimeout(`${PRIMARY_URL}/latest?from=USD&to=KRW,CNY`);
    const rates = { KRW: json.rates.KRW, CNY: json.rates.CNY };
    saveCache('er_latest', rates);
    state.apiSource = 'primary';
    return rates;
  } catch (e) {
    console.warn('Primary API failed:', e.message);
  }

  // 2. Fallback API (open.er-api.com — more accessible from China)
  try {
    const json = await fetchWithTimeout(FALLBACK_URL);
    const rates = { KRW: json.rates.KRW, CNY: json.rates.CNY };
    saveCache('er_latest', rates);
    state.apiSource = 'fallback';
    return rates;
  } catch (e) {
    console.warn('Fallback API failed:', e.message);
  }

  // 3. LocalStorage cache (last resort)
  const cached = loadCache('er_latest', CACHE_NOW_TTL, true);
  if (cached) {
    state.apiSource = 'cache';
    return cached.data;
  }

  throw new Error('All current rate sources exhausted');
}

// ── Fetch: 52-week historical ─────────────────────────────
const minOf = (arr) => Math.min(...arr.filter(Number.isFinite));
const maxOf = (arr) => Math.max(...arr.filter(Number.isFinite));

// Build the 52-week ranges from two daily OHLC series (USD/KRW and USD/CNY).
// Daily high/low capture true intraday extremes (unlike ECB's single fixing),
// so the range matches what Google/Morningstar show. `_src` tags the source.
function build52W(krw, cny, src) {
  const usdKrw = { low: minOf(krw.low), high: maxOf(krw.high) };
  const usdCny = { low: minOf(cny.low), high: maxOf(cny.high) };
  // cny-krw: KRW/CNY per day from closes (ratio extremes ≠ ratios of extremes),
  // index-aligned across the two series.
  const cnyKrw = [];
  const n = Math.min(krw.close.length, cny.close.length);
  for (let i = 0; i < n; i++) {
    const k = krw.close[i], c = cny.close[i];
    if (Number.isFinite(k) && Number.isFinite(c) && c > 0) cnyKrw.push(k / c);
  }
  if (!cnyKrw.length) throw new Error('Empty history');
  const data = {
    'usd-krw': usdKrw,
    'usd-cny': usdCny,
    'cny-krw': { low: Math.min(...cnyKrw), high: Math.max(...cnyKrw) },
    _src: src,
  };
  // Sanity guards: bail (→ try next source) if anything is non-finite/absurd.
  if (!(usdKrw.low > 500 && usdKrw.high < 3000 && usdKrw.low <= usdKrw.high)) {
    throw new Error('USD/KRW 52w out of sane range');
  }
  if (!(usdCny.low > 3 && usdCny.high < 12 && usdCny.low <= usdCny.high)) {
    throw new Error('USD/CNY 52w out of sane range');
  }
  return data;
}

// --- Yahoo daily OHLC (global mid; often blocked from proxy IPs, so secondary)
async function fetchYahooHistory(symbol) {
  const target = `${YAHOO_BASE}${encodeURIComponent(symbol)}?interval=1d&range=1y`;
  return fetchViaProxies(target, (json) => {
    const r = json && json.chart && json.chart.result && json.chart.result[0];
    const q = r && r.indicators && r.indicators.quote && r.indicators.quote[0];
    if (!q || !Array.isArray(q.high) || !Array.isArray(q.low) || !Array.isArray(q.close)) {
      throw new Error('No OHLC in Yahoo history');
    }
    return { high: q.high, low: q.low, close: q.close };
  }, HIST_TIMEOUT_MS);
}

async function fetch52WFromYahoo() {
  const [krw, cny] = await Promise.all([
    fetchYahooHistory('KRW=X'),  // USD/KRW
    fetchYahooHistory('CNY=X'),  // USD/CNY
  ]);
  return build52W(krw, cny, 'yahoo');
}

// --- Stooq daily OHLC CSV (Date,Open,High,Low,Close) — proxy-friendly
function parseStooqCsv(csv) {
  const lines = String(csv).trim().split('\n');
  if (lines.length < 30 || !/date/i.test(lines[0])) throw new Error('Bad Stooq CSV');
  const high = [], low = [], close = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    high.push(parseFloat(c[2]));
    low.push(parseFloat(c[3]));
    close.push(parseFloat(c[4]));
  }
  return { high, low, close };
}

async function fetchStooqHistory(symbol, range) {
  const target = `${STOOQ_BASE}${symbol}${range}`;
  const attempts = CORS_PROXIES.map(async (proxy) => {
    const csv = await fetchTextWithTimeout(proxy + encodeURIComponent(target), HIST_TIMEOUT_MS);
    return parseStooqCsv(csv);
  });
  return Promise.any(attempts);
}

async function fetch52WFromStooq() {
  const d2 = new Date();
  const d1 = new Date(d2.getTime() - 365 * 24 * 60 * 60 * 1000);
  const ymd = (d) => formatDate(d).replace(/-/g, '');
  const range = `&d1=${ymd(d1)}&d2=${ymd(d2)}`;
  const [krw, cny] = await Promise.all([
    fetchStooqHistory('usdkrw', range),  // USD/KRW
    fetchStooqHistory('usdcny', range),  // USD/CNY
  ]);
  return build52W(krw, cny, 'stooq');
}

// --- Naver daily history (matches what users see on Naver; uses the same proxy
// path that already works for the live Naver rate). Rows give closePrice and,
// when present, intraday highPrice/lowPrice.
const naverNum = (s) => parseFloat(String(s).replace(/[^0-9.]/g, ''));

async function fetchNaverHistory(reutersCode) {
  return fetchViaProxies(NAVER_HIST + reutersCode, (json) => {
    const rows = json && json.result;
    if (!Array.isArray(rows) || rows.length < 180) throw new Error('Naver history too short');
    const high = [], low = [], close = [];
    for (const r of rows) {
      const c = naverNum(r.closePrice);
      if (!Number.isFinite(c)) continue;
      const h = r.highPrice != null ? naverNum(r.highPrice) : c;  // fall back to close
      const l = r.lowPrice  != null ? naverNum(r.lowPrice)  : c;
      close.push(c);
      high.push(Number.isFinite(h) ? h : c);
      low.push(Number.isFinite(l) ? l : c);
    }
    if (close.length < 180) throw new Error('Naver history too short');
    return { high, low, close };
  }, HIST_TIMEOUT_MS);
}

async function fetch52WFromNaver() {
  // FX_USDKRW and FX_CNYKRW are both Naver-native (하나은행 기준).
  const [usdkrw, cnykrw] = await Promise.all([
    fetchNaverHistory('FX_USDKRW'),
    fetchNaverHistory('FX_CNYKRW'),
  ]);
  const usdKrw = { low: minOf(usdkrw.low), high: maxOf(usdkrw.high) };
  const cnyKrw = { low: minOf(cnykrw.low), high: maxOf(cnykrw.high) };  // direct, matches Naver
  // usd-cny: USDKRW / CNYKRW per day, index-aligned.
  const usdCnyVals = [];
  const n = Math.min(usdkrw.close.length, cnykrw.close.length);
  for (let i = 0; i < n; i++) {
    const k = usdkrw.close[i], c = cnykrw.close[i];
    if (Number.isFinite(k) && Number.isFinite(c) && c > 0) usdCnyVals.push(k / c);
  }
  if (!usdCnyVals.length) throw new Error('Empty Naver history');
  const data = {
    'usd-krw': usdKrw,
    'cny-krw': cnyKrw,
    'usd-cny': { low: Math.min(...usdCnyVals), high: Math.max(...usdCnyVals) },
    _src: 'naver',
  };
  if (!(usdKrw.low > 500 && usdKrw.high < 3000 && usdKrw.low <= usdKrw.high)) {
    throw new Error('USD/KRW 52w out of sane range');
  }
  if (!(cnyKrw.low > 80 && cnyKrw.high < 500 && cnyKrw.low <= cnyKrw.high)) {
    throw new Error('CNY/KRW 52w out of sane range');
  }
  return data;
}

// --- MSN Money: 52-week high/low straight from the quote (one call, no history
// to compute). Each pair has its own instrument id.
async function fetch52WFromMsn() {
  const ids = [MSN_IDS['usd-krw'], MSN_IDS['usd-cny'], MSN_IDS['cny-krw']].join(',');
  return fetchViaProxies(MSN_QUOTES + ids, (json) => {
    const arr = Array.isArray(json) ? json : (json && (json.value || json.Quotes || json.quotes));
    if (!Array.isArray(arr) || !arr.length) throw new Error('No MSN quotes');
    const byId = {};
    for (const q of arr) { if (q && q.id) byId[q.id] = q; }
    // MSN field names for 52w high/low vary; try common ones, then scan keys.
    const toNum = (v) => {
      if (typeof v === 'number') return v;
      if (typeof v === 'string') return parseFloat(v.replace(/,/g, ''));
      return NaN;
    };
    const msnField = (q, kind) => {
      const explicit = kind === 'high'
        ? [q.fiftyTwoWeekHigh, q.priceFiftyTwoWeekHigh, q.yearHigh, q.high52Week, q.fiftyTwoWeekHighPrice]
        : [q.fiftyTwoWeekLow,  q.priceFiftyTwoWeekLow,  q.yearLow,  q.low52Week,  q.fiftyTwoWeekLowPrice];
      for (const v of explicit) { const n = toNum(v); if (Number.isFinite(n)) return n; }
      const reKind = new RegExp(kind, 'i');  // broadened scan: catch any 52w/year/week high|low key
      for (const k in q) {
        const lk = k.toLowerCase();
        if (reKind.test(lk) && /52|fiftytwo|year|week|wk/.test(lk)) {
          const n = toNum(q[k]); if (Number.isFinite(n)) return n;
        }
      }
      return undefined;
    };
    const range = (pair) => {
      const q = byId[MSN_IDS[pair]] || {};
      const high = msnField(q, 'high');
      const low  = msnField(q, 'low');
      if (!(Number.isFinite(high) && Number.isFinite(low) && low <= high && high > 0)) {
        // TEMP: dump the actual keys so we can see MSN's real field names.
        throw new Error('MSNkeys[' + pair + ']:' + Object.keys(q).join(',').slice(0, 280));
      }
      return { low, high };
    };
    const data = {
      'usd-krw': range('usd-krw'),
      'usd-cny': range('usd-cny'),
      'cny-krw': range('cny-krw'),
      _src: 'msn',
    };
    // Sanity guards: bail (→ next source) on absurd values.
    if (!(data['usd-krw'].low > 500 && data['usd-krw'].high < 3000)) throw new Error('USD/KRW 52w out of range');
    if (!(data['usd-cny'].low > 3 && data['usd-cny'].high < 12)) throw new Error('USD/CNY 52w out of range');
    if (!(data['cny-krw'].low > 80 && data['cny-krw'].high < 500)) throw new Error('CNY/KRW 52w out of range');
    return data;
  }, HIST_TIMEOUT_MS);
}

function compute52W(json) {
  const usdKrw = [], usdCny = [], cnyKrw = [];
  for (const rates of Object.values(json.rates)) {
    if (rates.KRW && rates.CNY) {
      usdKrw.push(rates.KRW);
      usdCny.push(rates.CNY);
      cnyKrw.push(rates.KRW / rates.CNY);
    }
  }
  if (!usdKrw.length) throw new Error('Empty historical data');
  return {
    'usd-krw': { low: Math.min(...usdKrw), high: Math.max(...usdKrw) },
    'usd-cny': { low: Math.min(...usdCny), high: Math.max(...usdCny) },
    'cny-krw': { low: Math.min(...cnyKrw), high: Math.max(...cnyKrw) },
  };
}

// 52W ranges from intraday OHLC (Stooq/Yahoo) are accurate; ECB daily fixings
// are a narrower approximation. h52wSource carries the actual source so the
// footer can flag the ECB fallback.
const ACCURATE_52W = new Set(['msn', 'naver', 'stooq', 'yahoo']);
const h52wFromCache = (data) => (data && ACCURATE_52W.has(data._src)) ? data._src : 'ecb';

async function fetchHistorical() {
  // 0. Reuse a recent *MSN* cache (the top, most accurate source). Any lower
  //    source in cache means MSN failed last time, so we DON'T short-circuit —
  //    we retry MSN to upgrade. (Re-pulling MSN is one tiny call anyway.)
  const recent = loadCache(CACHE_52W_KEY, CACHE_52W_FETCH_TTL, false);
  if (recent && recent.data && recent.data._src === 'msn') {
    state.h52wSource = 'msn';
    state.h52wDiag = '';
    return recent.data;
  }

  // 1. MSN Money — 52-week high/low straight from the quote (single small call).
  try {
    const data = await fetch52WFromMsn();
    saveCache(CACHE_52W_KEY, data);
    state.h52wSource = 'msn';
    state.h52wDiag = '';
    return data;
  } catch (e) {
    state.h52wDiag = 'MSN✕ ' + diagMsg(e);  // TEMP: surface why MSN failed
    console.warn('52W (MSN) failed:', e && e.message);
  }

  // 2. Naver daily history — matches what users see on Naver and uses the same
  //    proxy path that already works for the live Naver rate.
  try {
    const data = await fetch52WFromNaver();
    saveCache(CACHE_52W_KEY, data);
    state.h52wSource = 'naver';
    return data;
  } catch (e) {
    console.warn('52W (Naver) failed:', e && e.message);
  }

  // 2. Daily OHLC — true intraday 52-week high/low. Race Stooq and Yahoo and
  //    take whichever responds first (Yahoo is often blocked from proxy IPs).
  try {
    const data = await Promise.any([fetch52WFromStooq(), fetch52WFromYahoo()]);
    saveCache(CACHE_52W_KEY, data);
    state.h52wSource = data._src;
    return data;
  } catch (e) {
    console.warn('52W (Stooq/Yahoo) failed:', e && e.message);
  }

  // 3. frankfurter (ECB daily reference) — fallback; range will be narrower
  const end   = new Date();
  const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
  try {
    const json = await fetchWithTimeout(
      `${PRIMARY_URL}/${formatDate(start)}..${formatDate(end)}?from=USD&to=KRW,CNY`
    );
    const data = compute52W(json);
    data._src = 'ecb';
    saveCache(CACHE_52W_KEY, data);
    state.h52wSource = 'ecb';
    return data;
  } catch (e) {
    console.warn('52W (frankfurter) failed:', e.message);
  }

  // 4. LocalStorage cache (valid within 24h)
  const fresh = loadCache(CACHE_52W_KEY, CACHE_52W_TTL, false);
  if (fresh) {
    state.h52wSource = h52wFromCache(fresh.data);
    return fresh.data;
  }

  // 5. Expired cache (any age) — better than nothing
  const stale = loadCache(CACHE_52W_KEY, CACHE_52W_TTL, true);
  if (stale) {
    state.h52wSource = 'expired-cache';
    return stale.data;
  }

  state.h52wSource = 'none';
  return null;
}

// ── Process & render ──────────────────────────────────────
function processLatest(rates) {
  state.latestData = {
    'usd-krw': rates.KRW,
    'usd-cny': rates.CNY,
    'cny-krw': rates.KRW / rates.CNY,
  };
}

function formatRate(pairId, value) {
  if (pairId === 'usd-cny') return value.toFixed(4);
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderCard(pairId, current, range) {
  document.getElementById(`rate-${pairId}`).textContent = formatRate(pairId, current);

  const rangeEl = document.getElementById(`range-${pairId}`);
  const rangeNaEl = document.getElementById(`range-na-${pairId}`);

  if (!range) {
    rangeEl.classList.add('hidden');
    rangeNaEl.classList.remove('hidden');
    return;
  }

  rangeEl.classList.remove('hidden');
  rangeNaEl.classList.add('hidden');

  // History is ECB (frankfurter), but the live current rate is Naver/Yahoo.
  // Today is within the trailing 52 weeks, so fold the live value into the
  // observed extremes: the displayed high/low (and the marker) then stay
  // consistent with the live rate and update the moment it breaches the range.
  const newHigh = current > range.high;   // live rate set a fresh 52-week high
  const newLow  = current < range.low;    // live rate set a fresh 52-week low
  const low  = Math.min(range.low, current);
  const high = Math.max(range.high, current);

  document.getElementById(`low-${pairId}`).textContent  = formatRate(pairId, low);
  document.getElementById(`high-${pairId}`).textContent = formatRate(pairId, high);

  // How far the current rate sits above the 52W low and below the 52W high.
  const aboveLow  = low  > 0 ? ((current - low)  / low)  * 100 : 0;   // ≥ 0
  const belowHigh = high > 0 ? ((current - high) / high) * 100 : 0;   // ≤ 0
  document.getElementById(`lowd-${pairId}`).textContent  = `+${aboveLow.toFixed(1)}%`;
  document.getElementById(`highd-${pairId}`).textContent = `${belowHigh.toFixed(1)}%`;

  const pct = (high === low) ? 50 : ((current - low) / (high - low)) * 100;
  const clampedPct = Math.min(100, Math.max(0, pct));

  document.getElementById(`bar-fill-${pairId}`).style.width = `${clampedPct}%`;
  document.getElementById(`bar-marker-${pairId}`).style.left = `${clampedPct}%`;
  document.getElementById(`pct-${pairId}`).textContent = `${Math.round(clampedPct)}% of 52-week range`;

  const marker = document.getElementById(`bar-marker-${pairId}`);
  marker.classList.remove('marker-green', 'marker-red');
  if (clampedPct >= 80) marker.classList.add('marker-red');
  else if (clampedPct <= 20) marker.classList.add('marker-green');

  const badge = document.getElementById(`badge-${pairId}`);
  if (newHigh) {
    badge.textContent = '52W 최고';
    badge.className = 'badge badge-high';
    badge.classList.remove('hidden');
  } else if (newLow) {
    badge.textContent = '52W 최저';
    badge.className = 'badge badge-low';
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function renderAllCards() {
  PAIRS.forEach(id => renderCard(id, state.latestData[id], state.historicalData ? state.historicalData[id] : null));
}

// ── Source indicator ──────────────────────────────────────
function updateFooter() {
  const timeStr = state.lastUpdated.toLocaleTimeString('ko-KR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  document.getElementById('last-updated').textContent = `최종 업데이트: ${timeStr}`;

  const badge = document.getElementById('source-badge');
  let label = '', cls = '';

  // 'naver' (하나은행 매매기준율) and 'realtime' (Yahoo) are live → no badge.
  if (state.apiSource === 'primary') {
    label = 'ECB 일일고시'; cls = 'src-primary';
  } else if (state.apiSource === 'fallback') {
    label = '백업 서버 (일 1회)'; cls = 'src-fallback';
  } else if (state.apiSource === 'cache') {
    label = '캐시 데이터'; cls = 'src-cache';
  }

  if (state.h52wSource === 'ecb') {
    // Yahoo history unavailable → range is ECB daily fixings (narrower, may miss
    // intraday peaks). Flag it so the 52-week numbers aren't taken as exact.
    label = label ? `${label} · 52주 ECB(근사)` : '52주 ECB(근사)';
    cls = cls || 'src-cache';
  } else if (state.h52wSource === 'expired-cache') {
    label = label ? `${label} · 52주 구캐시` : '52주 구캐시';
    cls = cls || 'src-cache';
  } else if (state.h52wSource === 'none') {
    label = label ? `${label} · 52주 없음` : '52주 데이터 없음';
    cls = cls || 'src-cache';
  }

  if (label) {
    badge.textContent = label;
    badge.className = `source-badge ${cls}`;  // resets className
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }

  updateDataCredit();
}

// Header subtitle + footer credit both reflect the source actually in use,
// instead of a hardcoded "ECB 기준" label.
const SUBTITLE_BY_SOURCE = {
  naver:    '실시간 주요 환율 · 네이버(하나은행) 기준',
  realtime: '실시간 주요 환율 · Yahoo Finance 기준',
  primary:  '주요 환율 · ECB 일일고시 기준',
  fallback: '주요 환율 · ExchangeRate-API 기준',
  cache:    '주요 환율 · 캐시',
};

const CREDIT_BY_SOURCE = {
  naver:    '데이터: 하나은행 매매기준율 · 네이버 금융 (실시간)',
  realtime: '데이터: Yahoo Finance (실시간)',
  primary:  '데이터: European Central Bank (ECB) · frankfurter.dev (일일고시)',
  fallback: '데이터: ExchangeRate-API (일 1회)',
  cache:    '데이터: 캐시 (마지막 수신값)',
};

const H52W_LABEL = {
  msn: 'MSN', naver: '네이버 일별', stooq: 'Stooq', yahoo: 'Yahoo',
  ecb: 'ECB 근사', 'expired-cache': '캐시(만료)', none: '없음',
};

function updateDataCredit() {
  const subtitle = document.getElementById('subtitle');
  if (subtitle) subtitle.textContent = SUBTITLE_BY_SOURCE[state.apiSource] || SUBTITLE_BY_SOURCE.primary;
  const credit = document.getElementById('data-credit');
  if (credit) {
    const base = CREDIT_BY_SOURCE[state.apiSource] || CREDIT_BY_SOURCE.primary;
    const h52 = H52W_LABEL[state.h52wSource];
    const diag = (state.h52wSource !== 'msn' && state.h52wDiag) ? `  ·  ${state.h52wDiag}` : '';
    credit.textContent = (h52 ? `${base}  ·  52주: ${h52}` : base) + `  ·  build ${BUILD}` + diag;
  }
}

// ── Main fetch orchestration ──────────────────────────────
async function fetchAllData() {
  if (state.isLoading) return;
  state.isLoading = true;

  try {
    const [rates, historicalData] = await Promise.all([fetchLatest(), fetchHistorical()]);
    processLatest(rates);
    state.historicalData = historicalData;
    state.lastUpdated = new Date();
    renderAllCards();
    updateFooter();
    showData();
  } catch (err) {
    console.error('환율 데이터 로드 실패:', err);
    showErrorState();
    document.getElementById('last-updated').textContent = '데이터 로드 실패';
  } finally {
    state.isLoading = false;
  }
}

function retryFetch() {
  showSkeletons();
  fetchAllData();
}

// ── Auto-refresh ──────────────────────────────────────────
function startCountdown() {
  clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(() => {
    const remaining = state.nextRefreshAt - Date.now();
    if (remaining <= 0) { clearInterval(state.countdownTimer); return; }
    const m = Math.floor(remaining / 60000);
    const s = Math.floor((remaining % 60000) / 1000);
    document.getElementById('refresh-countdown').textContent = `${m}:${String(s).padStart(2, '0')} 후 갱신`;
  }, 1000);
}

function scheduleRefresh() {
  clearInterval(state.refreshTimer);
  state.nextRefreshAt = Date.now() + REFRESH_MS;
  startCountdown();
  state.refreshTimer = setInterval(async () => {
    await fetchAllData();
    state.nextRefreshAt = Date.now() + REFRESH_MS;
    startCountdown();
  }, REFRESH_MS);
}

// ── Visibility change: refresh if stale ──────────────────
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.lastUpdated) {
    if (Date.now() - state.lastUpdated.getTime() > REFRESH_MS) {
      clearInterval(state.refreshTimer);
      clearInterval(state.countdownTimer);
      fetchAllData().then(() => scheduleRefresh());
    }
  }
});

// ── Manual refresh ────────────────────────────────────────
function manualRefresh() {
  if (state.isLoading) return;
  clearInterval(state.refreshTimer);
  clearInterval(state.countdownTimer);
  document.getElementById('refresh-countdown').textContent = '갱신 중...';
  const topBtn = document.getElementById('refresh-btn-top');
  if (topBtn) topBtn.classList.add('spinning');
  showSkeletons();
  fetchAllData().then(() => {
    scheduleRefresh();
    if (topBtn) topBtn.classList.remove('spinning');
  });
}

document.getElementById('refresh-btn').addEventListener('click', manualRefresh);
document.getElementById('refresh-btn-top').addEventListener('click', manualRefresh);

// ── Init ──────────────────────────────────────────────────
function init() {
  startClock();
  showSkeletons();
  fetchAllData().then(() => scheduleRefresh());
}

document.addEventListener('DOMContentLoaded', init);
