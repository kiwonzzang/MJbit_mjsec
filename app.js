import { TickerStream, fetchKrwMarkets, fetchTickers } from './upbit.js';

// ===== 설정 =====
const STORAGE_KEY = 'my-market-board:v2';
const LEGACY_STORAGE_KEY = 'my-market-board:v1';
const WIDGET_BASE = 'https://s3.tradingview.com/external-embedding/';

// 상단 시세 띠 맨 앞에 항상 보여줄 환율
const FX_SYMBOLS = [
  { proName: 'FX_IDC:USDKRW', title: '달러/원' },
  { proName: 'FX_IDC:EURKRW', title: '유로/원' },
  { proName: 'FX_IDC:JPYKRW', title: '엔/원' },
  { proName: 'FX_IDC:CNYKRW', title: '위안/원' },
];

const CATEGORIES = {
  all: '전체',
  crypto: '코인',
  stock: '주식',
  bond: '채권·금리',
  etf: 'ETF·지수',
};

// source: 'upbit' → 코인 (업비트 실시간 시세) / 'kis' → 국내 주식 (한국투자증권 시세)
//         'tradingview' → 그 외 (TradingView 위젯, 미국 종목은 목록 가격만 한국투자증권 시세)
// symbol은 종목 고유 키이자 TradingView 심볼(차트·시세 흐름·뉴스 위젯용)
const upbitItem = (base, name) => ({
  symbol: `UPBIT:${base}KRW`,
  market: `KRW-${base}`,
  name,
  category: 'crypto',
  source: 'upbit',
});
const tvItem = (symbol, name, category) => ({ symbol, name, category, source: 'tradingview' });
const krItem = (code, name) => ({ symbol: `KRX:${code}`, code, name, category: 'stock', source: 'kis' });

// 미국 거래소 종목은 달러 가격에 환율을 곱해 원화로 보여준다 (TradingView 심볼 계산식)
const US_EXCHANGES = ['NASDAQ', 'NYSE', 'AMEX', 'NYSEARCA', 'CBOE', 'OTC'];
const isUS = (item) => US_EXCHANGES.includes(item.symbol.split(':')[0]);
const krwSymbol = (item) => (isUS(item) ? `${item.symbol}*FX_IDC:USDKRW` : item.symbol);

// TradingView 거래소 이름 → 한국투자증권 해외 거래소 코드 (목록 가격 조회용)
const KIS_EXCHANGES = { NASDAQ: 'NAS', NYSE: 'NYS', AMEX: 'AMS', NYSEARCA: 'AMS' };
function quoteUrl(item) {
  if (item.source === 'kis') return `/api/kr/quote?code=${item.code}`;
  const [exchange, ticker] = item.symbol.split(':');
  if (KIS_EXCHANGES[exchange]) return `/api/us/quote?code=${KIS_EXCHANGES[exchange]}:${ticker}`;
  return null;
}

const DEFAULT_WATCHLIST = [
  upbitItem('BTC', '비트코인'),
  upbitItem('ETH', '이더리움'),
  upbitItem('SOL', '솔라나'),
  tvItem('NASDAQ:AAPL', '애플', 'stock'),
  tvItem('NASDAQ:NVDA', '엔비디아', 'stock'),
  tvItem('NASDAQ:TSLA', '테슬라', 'stock'),
  tvItem('TVC:US10Y', '미국 10년물 금리', 'bond'),
  tvItem('TVC:US02Y', '미국 2년물 금리', 'bond'),
  tvItem('AMEX:SPY', 'S&P 500 ETF', 'etf'),
  tvItem('NASDAQ:QQQ', '나스닥 100 ETF', 'etf'),
];

// ===== 상태 (localStorage에 저장) =====
// v1에서 바이낸스 USDT 심볼로 저장한 코인은 업비트 원화 마켓으로 옮긴다
function migrateV1(saved) {
  const toV2 = (symbol) => symbol?.replace(/^BINANCE:([A-Z0-9]+)USDT$/, 'UPBIT:$1KRW');
  return {
    ...saved,
    selected: toV2(saved.selected),
    watchlist: saved.watchlist.map((item) => {
      const match = item.symbol.match(/^BINANCE:([A-Z0-9]+)USDT$/);
      if (match) return { ...upbitItem(match[1], item.name), category: item.category };
      return { ...item, source: 'tradingview' };
    }),
  };
}

function loadState() {
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const defaults = {
    watchlist: DEFAULT_WATCHLIST,
    selected: DEFAULT_WATCHLIST[0].symbol,
    category: 'all',
    newsMode: 'symbol',
    theme: prefersDark ? 'dark' : 'light',
  };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.watchlist)) return { ...defaults, ...saved };

    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY));
    if (legacy && Array.isArray(legacy.watchlist)) return { ...defaults, ...migrateV1(legacy) };
  } catch {
    // 저장된 값이 없거나 깨졌으면 기본값 사용
  }
  return defaults;
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 시크릿 모드 등에서 저장이 막혀도 페이지는 동작
  }
}

const state = loadState();
saveState();

// ===== 실시간 시세 (업비트) =====
const quotes = new Map(); // symbol → { price, changeRate }
const upbitSymbol = (market) => `UPBIT:${market.slice(4)}KRW`;

const stream = new TickerStream(handleTick);

function upbitMarkets() {
  return state.watchlist.filter((item) => item.source === 'upbit').map((item) => item.market);
}

function handleTick(tick) {
  const symbol = upbitSymbol(tick.market);
  quotes.set(symbol, tick);
  updateQuote(symbol);
}

// 업비트 원화 마켓 호가 단위에 맞춘 소수점 자리수
function formatKRW(price) {
  const digits = price >= 1000 ? 0 : price >= 100 ? 1 : price >= 10 ? 2 : price >= 1 ? 3 : 4;
  return price.toLocaleString('ko-KR', { maximumFractionDigits: digits });
}

async function syncQuotes() {
  const markets = upbitMarkets();
  stream.setMarkets(markets);

  const missing = markets.filter((market) => !quotes.has(upbitSymbol(market)));
  try {
    for (const tick of await fetchTickers(missing)) {
      if (!quotes.has(upbitSymbol(tick.market))) handleTick(tick);
    }
  } catch {
    // 첫 시세 조회에 실패해도 웹소켓으로 곧 들어온다
  }
}

// ===== 국내·미국 주식 시세 (한국투자증권, server.js 경유) =====
let krError = '';

async function getJSON(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? '시세 서버가 꺼져 있어요. (node server.js로 실행)');
  return body;
}

// 서버가 KIS 요청을 0.5초 간격으로 보내므로, 이전 조회가 끝나기 전에는 새로 시작하지 않는다
let polling = null;

function pollKisQuotes() {
  polling ??= (async () => {
    for (const item of state.watchlist) {
      const url = quoteUrl(item);
      if (!url) continue;
      try {
        quotes.set(item.symbol, await getJSON(url));
        krError = '';
      } catch (err) {
        krError = err.message;
      }
      updateQuote(item.symbol);
    }
  })().finally(() => (polling = null));
}
setInterval(pollKisQuotes, 5000);

// ===== TradingView 위젯 삽입 =====
// 위젯 스크립트는 자기 바로 앞의 컨테이너를 찾아 그려지므로 매번 새로 만들어 넣는다.
function mountWidget(slot, scriptName, config) {
  slot.innerHTML = '';

  const container = document.createElement('div');
  container.className = 'tradingview-widget-container';
  container.style.cssText = 'height:100%;width:100%';

  const target = document.createElement('div');
  target.className = 'tradingview-widget-container__widget';
  target.style.cssText = 'height:100%;width:100%';

  const script = document.createElement('script');
  script.src = WIDGET_BASE + scriptName;
  script.async = true;
  script.textContent = JSON.stringify(config);

  container.append(target, script);
  slot.append(container);
}

function selectedItem() {
  return state.watchlist.find((item) => item.symbol === state.selected);
}

function renderTickerTape() {
  const slot = document.getElementById('ticker-tape');
  mountWidget(slot, 'embed-widget-ticker-tape.js', {
    symbols: [
      ...FX_SYMBOLS,
      // 국내 주식(KRX)은 위젯에서 차단되므로 뺀다
      ...state.watchlist
        .filter((item) => item.source !== 'kis')
        .map((item) => ({ proName: krwSymbol(item), title: item.name })),
    ],
    showSymbolLogo: true,
    isTransparent: false,
    displayMode: 'adaptive',
    colorTheme: state.theme,
    locale: 'kr',
  });
}

// ===== 차트 =====
function renderChart() {
  const item = selectedItem();
  document.getElementById('chart-title').textContent = item ? item.name : '차트';
  document.getElementById('chart-symbol').textContent = !item
    ? ''
    : isUS(item)
      ? `${item.symbol} · 원화 환산`
      : item.symbol;

  const slot = document.getElementById('chart');
  if (!item) {
    slot.innerHTML = '<p class="empty" style="padding:16px">왼쪽에서 종목을 추가하거나 선택하세요.</p>';
    return;
  }
  if (item.source === 'kis') {
    renderKrCard(slot, item);
    return;
  }

  mountWidget(slot, 'embed-widget-advanced-chart.js', {
    autosize: true,
    symbol: krwSymbol(item),
    interval: 'D',
    timezone: 'Asia/Seoul',
    theme: state.theme,
    style: '1',
    locale: 'kr',
    allow_symbol_change: true,
    hide_side_toolbar: false,
    calendar: false,
    support_host: 'https://www.tradingview.com',
  });
}

// 1조 이상은 "조", 1억 이상은 "억" 단위로 줄여서 보여준다
function formatBigKRW(won) {
  if (won >= 1e12) return `${(won / 1e12).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}조원`;
  if (won >= 1e8) return `${Math.round(won / 1e8).toLocaleString('ko-KR')}억원`;
  return `${won.toLocaleString('ko-KR')}원`;
}

const won = (v) => `${v.toLocaleString('ko-KR')}원`;
const KR_STATS = [
  ['open', '시가', won],
  ['high', '고가', won],
  ['low', '저가', won],
  ['volume', '거래량', (v) => `${v.toLocaleString('ko-KR')}주`],
  ['tradingValue', '거래대금', formatBigKRW],
  ['marketCap', '시가총액', formatBigKRW],
  ['w52High', '52주 최고', won],
  ['w52Low', '52주 최저', won],
  ['per', 'PER', (v) => `${v.toFixed(2)}배`],
  ['pbr', 'PBR', (v) => `${v.toFixed(2)}배`],
  ['eps', 'EPS', won],
  ['foreignRate', '외국인 소진율', (v) => `${v.toFixed(2)}%`],
];

// 국내 주식은 TradingView 위젯 차트가 막혀 있어서 현재가 카드 + 외부 차트 링크로 대신한다
function renderKrCard(slot, item) {
  slot.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'kr-card';
  card.dataset.symbol = item.symbol;

  const links = document.createElement('div');
  links.className = 'kr-links';
  for (const [label, href] of [
    ['네이버 증권에서 차트 보기', `https://finance.naver.com/item/main.naver?code=${item.code}`],
    ['TradingView에서 차트 보기', `https://www.tradingview.com/chart/?symbol=KRX:${item.code}`],
  ]) {
    const a = document.createElement('a');
    a.className = 'btn';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = label;
    links.append(a);
  }

  const stats = document.createElement('dl');
  stats.className = 'kr-stats';
  for (const [key, label] of KR_STATS) {
    const cell = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.dataset.stat = key;
    dd.textContent = '-';
    cell.append(dt, dd);
    stats.append(cell);
  }

  card.append(
    span('muted', `KRX · ${item.code}`),
    span('item-price'),
    span('item-change'),
    span('kr-status muted'),
    stats,
    links,
    span('muted', '국내 주식 차트는 TradingView 위젯에서 제공되지 않아 외부 링크로 열어요.')
  );
  slot.append(card);
  updateQuote(item.symbol);
}

// ===== 뉴스 =====
function renderNews() {
  document.querySelectorAll('[data-news-mode]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.newsMode === state.newsMode);
  });

  const item = selectedItem();
  const bySymbol = state.newsMode === 'symbol' && item;
  mountWidget(document.getElementById('news'), 'embed-widget-timeline.js', {
    ...(bySymbol ? { feedMode: 'symbol', symbol: item.symbol } : { feedMode: 'all_symbols' }),
    isTransparent: false,
    displayMode: 'regular',
    width: '100%',
    height: '100%',
    colorTheme: state.theme,
    locale: 'kr',
  });
}

// ===== 관심 종목 목록 =====
function renderTabs() {
  const nav = document.getElementById('category-tabs');
  nav.innerHTML = '';
  for (const [key, label] of Object.entries(CATEGORIES)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.classList.toggle('active', state.category === key);
    btn.addEventListener('click', () => {
      state.category = key;
      saveState();
      renderTabs();
      renderWatchlist();
    });
    nav.append(btn);
  }
}

function span(className, text = '') {
  const el = document.createElement('span');
  el.className = className;
  el.textContent = text;
  return el;
}

function renderWatchlist() {
  const list = document.getElementById('watchlist');
  list.innerHTML = '';

  const items = state.watchlist.filter(
    (item) => state.category === 'all' || item.category === state.category
  );

  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '이 카테고리에 종목이 없어요.';
    list.append(li);
    return;
  }

  items.forEach((item, index) => {
    const li = document.createElement('li');
    li.classList.toggle('active', item.symbol === state.selected);
    li.dataset.symbol = item.symbol;
    setupDrag(li, item.symbol);

    const selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'item-select';
    selectBtn.append(
      span('item-name', item.name),
      span('item-price'),
      span('item-symbol', item.market ?? item.code ?? item.symbol),
      span('item-change')
    );
    selectBtn.addEventListener('click', () => selectSymbol(item.symbol));

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'item-remove';
    removeBtn.textContent = '×';
    removeBtn.title = `${item.name} 삭제`;
    removeBtn.addEventListener('click', () => removeSymbol(item.symbol));

    // 휴대폰용 순서 버튼: 지금 보이는 목록(카테고리 필터 적용)에서 위/아래 종목과 자리를 바꾼다
    const order = document.createElement('div');
    order.className = 'item-order';
    for (const [label, neighbor, after] of [['▲', items[index - 1], false], ['▼', items[index + 1], true]]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.disabled = !neighbor;
      btn.addEventListener('click', () => moveItem(item.symbol, neighbor.symbol, after));
      order.append(btn);
    }

    li.append(selectBtn, order, removeBtn);
    list.append(li);
    updateQuote(item.symbol);
  });
}

// ----- 끌어서 순서 바꾸기 (HTML 기본 드래그 앤 드롭) -----
let draggedSymbol = null;

function setupDrag(li, symbol) {
  li.draggable = true;
  li.addEventListener('dragstart', (event) => {
    draggedSymbol = symbol;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', symbol);
    li.classList.add('dragging');
  });
  li.addEventListener('dragend', () => {
    draggedSymbol = null;
    li.classList.remove('dragging');
  });
  li.addEventListener('dragover', (event) => {
    if (!draggedSymbol || draggedSymbol === symbol) return;
    event.preventDefault();
    const rect = li.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    li.classList.toggle('drop-after', after);
    li.classList.toggle('drop-before', !after);
  });
  li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
  li.addEventListener('drop', (event) => {
    event.preventDefault();
    moveItem(draggedSymbol, symbol, li.classList.contains('drop-after'));
  });
}

function moveItem(fromSymbol, toSymbol, after) {
  if (!fromSymbol || fromSymbol === toSymbol) return;
  const list = state.watchlist;
  const [moved] = list.splice(list.findIndex((i) => i.symbol === fromSymbol), 1);
  const target = list.findIndex((i) => i.symbol === toSymbol);
  list.splice(after ? target + 1 : target, 0, moved);
  saveState();
  renderWatchlist();
  renderTickerTape();
}

// 틱마다 목록 전체를 다시 그리지 않고 해당 종목의 가격만 바꾼다 (목록 + 국내 주식 카드)
function updateQuote(symbol) {
  const tick = quotes.get(symbol);
  const pct = tick ? tick.changeRate * 100 : 0;

  for (const node of document.querySelectorAll(`[data-symbol="${symbol}"]`)) {
    node.querySelector('.item-price').textContent = tick ? `${formatKRW(tick.price)}원` : '';
    const change = node.querySelector('.item-change');
    change.textContent = tick ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '';
    change.className = `item-change ${pct > 0 ? 'up' : pct < 0 ? 'down' : ''}`;
    const status = node.querySelector('.kr-status');
    if (status) status.textContent = tick ? '' : krError || '시세 불러오는 중…';
    for (const [key, , format] of tick?.stats ? KR_STATS : []) {
      const dd = node.querySelector(`[data-stat="${key}"]`);
      if (dd) dd.textContent = format(tick.stats[key]);
    }
  }
}

function selectSymbol(symbol) {
  if (state.selected === symbol) return;
  state.selected = symbol;
  saveState();
  renderWatchlist();
  renderChart();
  renderNews();
}

function removeSymbol(symbol) {
  state.watchlist = state.watchlist.filter((item) => item.symbol !== symbol);
  if (state.selected === symbol) state.selected = state.watchlist[0]?.symbol ?? null;
  saveState();
  renderAll();
}

// ===== 종목 추가 폼 =====
// "BTC", "KRW-BTC", "UPBIT:BTCKRW", "비트코인", "Bitcoin" 모두 받아준다
async function findUpbitMarket(query) {
  const markets = await fetchKrwMarkets();
  const upper = query.toUpperCase();
  const code = upper.replace(/^UPBIT:(.+)KRW$/, '$1').replace(/^KRW-/, '');
  return (
    markets.find((m) => m.market === `KRW-${code}`) ??
    markets.find((m) => m.korean_name === query) ??
    markets.find((m) => m.english_name.toUpperCase() === upper) ??
    // "리플" → "엑스알피(리플)"처럼 이름 일부만 입력한 경우
    markets.find((m) => m.korean_name.includes(query))
  );
}

async function buildItem(category, query, customName) {
  if (category === 'crypto') {
    const found = await findUpbitMarket(query);
    if (!found) throw new Error('업비트 원화 마켓에서 찾을 수 없어요. (예: BTC, 리플)');
    const item = upbitItem(found.market.slice(4), found.korean_name);
    return { ...item, name: customName || item.name };
  }

  // 국내 주식: 6자리 종목코드 (005930 또는 KRX:005930) → 한국투자증권에서 이름 조회
  const krCode = query.toUpperCase().replace(/^KRX:/, '');
  if (category === 'stock' && /^[0-9A-Z]{6}$/.test(krCode) && /\d/.test(krCode)) {
    const info = await getJSON(`/api/kr/info?code=${krCode}`);
    return krItem(krCode, customName || info.name);
  }

  const symbol = query.toUpperCase();
  if (!/^[A-Z0-9_]+:[A-Z0-9._!&-]+$/.test(symbol)) {
    throw new Error('"거래소:티커" 형식으로 입력하세요. (예: NASDAQ:MSFT)');
  }
  return tvItem(symbol, customName || symbol.split(':')[1], category);
}

function setupAddForm() {
  const form = document.getElementById('add-form');
  const symbolInput = document.getElementById('add-symbol');
  const nameInput = document.getElementById('add-name');
  const categorySelect = document.getElementById('add-category');
  const submitBtn = form.querySelector('button[type="submit"]');
  const error = document.getElementById('add-error');

  for (const [key, label] of Object.entries(CATEGORIES)) {
    if (key === 'all') continue;
    categorySelect.append(new Option(label, key));
  }

  const updatePlaceholder = () => {
    symbolInput.placeholder = {
      crypto: '코인 (예: XRP 또는 리플)',
      stock: '종목코드 005930 또는 NASDAQ:MSFT',
    }[categorySelect.value] ?? '심볼 (예: NASDAQ:MSFT)';
  };
  categorySelect.addEventListener('change', updatePlaceholder);
  updatePlaceholder();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    submitBtn.disabled = true;
    error.textContent = '';

    try {
      const item = await buildItem(
        categorySelect.value,
        symbolInput.value.trim(),
        nameInput.value.trim()
      );
      if (state.watchlist.some((existing) => existing.symbol === item.symbol)) {
        throw new Error('이미 관심 종목에 있어요.');
      }
      state.watchlist.push(item);
      state.selected = item.symbol;
      saveState();

      symbolInput.value = '';
      nameInput.value = '';
      renderAll();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ===== 테마 =====
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  document.getElementById('theme-toggle').textContent = state.theme === 'dark' ? '☀️' : '🌙';
}

function setupThemeToggle() {
  document.getElementById('theme-toggle').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    saveState();
    applyTheme();
    // 위젯은 테마를 생성 시점에만 받으므로 다시 그린다
    renderTickerTape();
    renderChart();
    renderNews();
  });
}

function setupNewsToggle() {
  document.querySelectorAll('[data-news-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.newsMode === btn.dataset.newsMode) return;
      state.newsMode = btn.dataset.newsMode;
      saveState();
      renderNews();
    });
  });
}

// ===== 시작 =====
function renderAll() {
  renderTabs();
  renderWatchlist();
  renderTickerTape();
  renderChart();
  renderNews();
  syncQuotes();
  pollKisQuotes();
}

applyTheme();
setupThemeToggle();
setupNewsToggle();
setupAddForm();
renderAll();
