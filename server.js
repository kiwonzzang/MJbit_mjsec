// ===== 정적 파일 + 한국투자증권(KIS) 국내 주식 시세 중계 서버 =====
// 실행: node server.js  →  http://localhost:8000
// App Key/Secret은 .env에만 두고 브라우저로는 절대 보내지 않는다.
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = import.meta.dirname;
const TOKEN_FILE = join(ROOT, '.kis-token.json');

try {
  process.loadEnvFile(join(ROOT, '.env'));
} catch {
  console.warn('⚠️  .env 파일이 없어요. 국내 주식 시세 없이 실행합니다.');
}
const {
  KIS_APP_KEY,
  KIS_APP_SECRET,
  KIS_URL = 'https://openapi.koreainvestment.com:9443', // 모의투자: https://openapivts.koreainvestment.com:29443
  PORT = 8000,
} = process.env;

// ----- KIS 접근 토큰 -----
// 하루 유효하고 발급할 때마다 카카오 알림톡이 오므로, 파일에 저장해 두고 재사용한다.
let token = null;
let issuing = null;

async function issueToken() {
  const res = await fetch(`${KIS_URL}/oauth2/tokenP`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: KIS_APP_KEY, appsecret: KIS_APP_SECRET }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(body.error_description ?? body.msg1 ?? '토큰 발급 실패');
  token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  await writeFile(TOKEN_FILE, JSON.stringify(token));
}

async function getToken() {
  const valid = () => token && token.expiresAt > Date.now() + 60_000;
  if (!valid()) {
    try {
      token = JSON.parse(await readFile(TOKEN_FILE, 'utf8'));
    } catch {
      // 저장된 토큰 없음
    }
  }
  if (!valid()) {
    issuing ??= issueToken().finally(() => (issuing = null)); // 동시에 여러 번 발급하지 않도록
    await issuing;
  }
  return token.value;
}

// KIS는 초당 호출 수 제한이 있어서(새로 발급한 키는 더 낮음) 요청을 한 줄로 세워 간격을 둔다
const KIS_GAP_MS = 500;
let kisQueue = Promise.resolve();

function kisGet(path, trId, params) {
  const run = kisQueue.then(() => kisFetch(path, trId, params));
  kisQueue = run.catch(() => {}).then(() => sleep(KIS_GAP_MS));
  return run;
}

async function kisFetch(path, trId, params, retried = false) {
  const res = await fetch(`${KIS_URL}${path}?${new URLSearchParams(params)}`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${await getToken()}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: trId,
      custtype: 'P',
    },
  });
  const body = await res.json();
  // EGW00201: 초당 거래건수 초과 → 잠깐 쉬었다가 한 번만 다시 시도
  if ((body.msg_cd === 'EGW00201' || body.msg1?.includes('초당')) && !retried) {
    await sleep(1000);
    return kisFetch(path, trId, params, true);
  }
  if (body.rt_cd !== '0') throw new Error(body.msg1 ?? `KIS 오류 (${res.status})`);
  return body.output;
}

const API = {
  // 현재가 (전일 대비, 등락률 포함)
  '/api/kr/quote': async (code) => {
    const o = await kisGet('/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', {
      FID_COND_MRKT_DIV_CODE: 'J',
      FID_INPUT_ISCD: code,
    });
    const n = (key) => Number(o[key]);
    return {
      code,
      price: n('stck_prpr'),
      change: n('prdy_vrss'),
      changeRate: n('prdy_ctrt') / 100,
      stats: {
        open: n('stck_oprc'),
        high: n('stck_hgpr'),
        low: n('stck_lwpr'),
        volume: n('acml_vol'),
        tradingValue: n('acml_tr_pbmn'),
        w52High: n('w52_hgpr'),
        w52Low: n('w52_lwpr'),
        marketCap: n('hts_avls') * 1e8, // KIS는 억원 단위
        per: n('per'),
        pbr: n('pbr'),
        eps: n('eps'),
        foreignRate: n('hts_frgn_ehrt'),
      },
    };
  },
  // 미국 주식·ETF 현재가 (원화 환산값 포함). code = "NAS:AAPL" 형식
  '/api/us/quote': async (code) => {
    const [excd, symb] = code.split(':');
    const o = await kisGet('/uapi/overseas-price/v1/quotations/price-detail', 'HHDFS76200200', {
      AUTH: '',
      EXCD: excd,
      SYMB: symb,
    });
    if (!Number(o?.last)) throw new Error('해외 시세를 찾을 수 없어요.');
    return { code, price: Number(o.t_xprc), usd: Number(o.last), changeRate: Number(o.last) / Number(o.base) - 1 };
  },
  // 종목 이름 (종목 추가할 때 사용)
  '/api/kr/info': async (code) => {
    const o = await kisGet('/uapi/domestic-stock/v1/quotations/search-stock-info', 'CTPF1002R', {
      PRDT_TYPE_CD: '300',
      PDNO: code,
    });
    if (!o?.prdt_abrv_name && !o?.prdt_name) throw new Error('종목을 찾을 수 없어요.');
    return { code, name: o.prdt_abrv_name || o.prdt_name };
  },
};

// ----- 정적 파일 -----
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  const handler = API[url.pathname];
  if (handler) {
    const code = url.searchParams.get('code') ?? '';
    if (!KIS_APP_KEY || !KIS_APP_SECRET) return send(res, 503, { error: 'KIS 키가 설정되지 않았어요. (.env)' });
    const validCode = url.pathname.startsWith('/api/us/') ? /^(NAS|NYS|AMS):[A-Z0-9.]{1,10}$/ : /^[0-9A-Z]{6}$/;
    if (!validCode.test(code)) return send(res, 400, { error: '종목코드 형식이 올바르지 않아요.' });
    try {
      return send(res, 200, await handler(code));
    } catch (err) {
      return send(res, 502, { error: err.message });
    }
  }

  // .env, .kis-token.json 같은 숨김 파일은 절대 내보내지 않는다
  const path = normalize(join(ROOT, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!path.startsWith(ROOT + sep) || path.slice(ROOT.length).split(sep).some((part) => part.startsWith('.'))) {
    return send(res, 404, 'Not found', 'text/plain');
  }
  try {
    send(res, 200, await readFile(path), TYPES[extname(path)] ?? 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
