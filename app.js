// ── Constants ──────────────────────────────────────────────
const PRIMARY_URL   = 'https://api.frankfurter.dev/v1';
const FALLBACK_URL  = 'https://open.er-api.com/v6/latest/USD';
const TIMEOUT_MS    = 7000;
const REFRESH_MS    = 5 * 60 * 1000;   // 5 minutes
const CACHE_52W_TTL = 24 * 60 * 60 * 1000;  // 24 hours
const CACHE_NOW_TTL = 60 * 60 * 1000;       // 1 hour

const PAIRS = ['usd-krw', 'cny-krw', 'usd-cny'];

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
  apiSource:       null,  // 'primary' | 'fallback' | 'cache'
  h52wSource:      null,  // 'fresh' | 'cache' | 'expired-cache' | 'none'
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

// ── Fetch: current rates ──────────────────────────────────
async function fetchLatest() {
  // 1. Primary API (frankfurter.dev)
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

async function fetchHistorical() {
  // 1. Try primary API for fresh 52W data
  const end   = new Date();
  const start = new Date(end.getTime() - 365 * 24 * 60 * 60 * 1000);
  try {
    const json = await fetchWithTimeout(
      `${PRIMARY_URL}/${formatDate(start)}..${formatDate(end)}?from=USD&to=KRW,CNY`
    );
    const data = compute52W(json);
    saveCache('er_52w', data);
    state.h52wSource = 'fresh';
    return data;
  } catch (e) {
    console.warn('Historical API failed:', e.message);
  }

  // 2. LocalStorage cache (valid within 24h)
  const fresh = loadCache('er_52w', CACHE_52W_TTL, false);
  if (fresh) {
    state.h52wSource = 'cache';
    return fresh.data;
  }

  // 3. Expired cache (any age) — better than nothing
  const stale = loadCache('er_52w', CACHE_52W_TTL, true);
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

  document.getElementById(`low-${pairId}`).textContent  = formatRate(pairId, range.low);
  document.getElementById(`high-${pairId}`).textContent = formatRate(pairId, range.high);

  let pct;
  if (range.high === range.low) {
    pct = 50;
  } else {
    pct = ((current - range.low) / (range.high - range.low)) * 100;
  }
  const rawPct     = pct;
  const clampedPct = Math.min(100, Math.max(0, pct));

  document.getElementById(`bar-fill-${pairId}`).style.width = `${clampedPct}%`;
  document.getElementById(`bar-marker-${pairId}`).style.left = `${clampedPct}%`;
  document.getElementById(`pct-${pairId}`).textContent = `${Math.round(clampedPct)}% of 52-week range`;

  const marker = document.getElementById(`bar-marker-${pairId}`);
  marker.classList.remove('marker-green', 'marker-red');
  if (clampedPct >= 80) marker.classList.add('marker-red');
  else if (clampedPct <= 20) marker.classList.add('marker-green');

  const badge = document.getElementById(`badge-${pairId}`);
  if (rawPct > 100) {
    badge.textContent = '52W 최고';
    badge.className = 'badge badge-high';
    badge.classList.remove('hidden');
  } else if (rawPct < 0) {
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

  if (state.apiSource === 'fallback') {
    label = '백업 서버'; cls = 'src-fallback';
  } else if (state.apiSource === 'cache') {
    label = '캐시 데이터'; cls = 'src-cache';
  }

  if (state.h52wSource === 'expired-cache') {
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
document.getElementById('refresh-btn').addEventListener('click', () => {
  if (state.isLoading) return;
  clearInterval(state.refreshTimer);
  clearInterval(state.countdownTimer);
  document.getElementById('refresh-countdown').textContent = '갱신 중...';
  showSkeletons();
  fetchAllData().then(() => scheduleRefresh());
});

// ── Init ──────────────────────────────────────────────────
function init() {
  startClock();
  showSkeletons();
  fetchAllData().then(() => scheduleRefresh());
}

document.addEventListener('DOMContentLoaded', init);
