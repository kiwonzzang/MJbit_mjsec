// ===== 업비트 Open API (시세 조회는 키 없이 사용 가능) =====
// 문서: https://docs.upbit.com/kr/reference
const REST_URL = 'https://api.upbit.com/v1';
const WS_URL = 'wss://api.upbit.com/websocket/v1';

async function getJSON(path) {
  const res = await fetch(REST_URL + path);
  if (!res.ok) throw new Error(`업비트 API 오류 (${res.status})`);
  return res.json();
}

// 원화 마켓 목록 (한글 이름 검색용). 한 번만 받아서 재사용.
let krwMarketsPromise = null;
export function fetchKrwMarkets() {
  krwMarketsPromise ??= getJSON('/market/all?isDetails=false')
    .then((list) => list.filter((m) => m.market.startsWith('KRW-')))
    .catch((err) => {
      krwMarketsPromise = null;
      throw err;
    });
  return krwMarketsPromise;
}

function toTick(r) {
  return {
    market: r.market ?? r.code,
    price: r.trade_price,
    changeRate: r.signed_change_rate,
    // 웹소켓 연결 직후의 스냅샷은 새 체결이 아니므로 거래량에 더하지 않는다
    volume: r.stream_type === 'SNAPSHOT' ? 0 : r.trade_volume,
    timestamp: r.trade_timestamp,
  };
}

// 현재가 한 번 조회 (페이지 처음 열었을 때 바로 보여주기용)
export async function fetchTickers(markets) {
  if (markets.length === 0) return [];
  const rows = await getJSON(`/ticker?markets=${markets.map(encodeURIComponent).join(',')}`);
  return rows.map(toTick);
}

// 실시간 현재가 (웹소켓). 연결이 끊기면 점점 간격을 늘리며 다시 연결한다.
export class TickerStream {
  #ws = null;
  #markets = [];
  #retry = 0;
  #timer = null;
  #onTick;
  #decoder = new TextDecoder();

  constructor(onTick) {
    this.#onTick = onTick;
  }

  setMarkets(markets) {
    const next = [...new Set(markets)].sort();
    if (next.join() === this.#markets.join()) return;
    this.#markets = next;
    this.#close();
    if (next.length > 0) this.#connect();
  }

  #close() {
    clearTimeout(this.#timer);
    if (this.#ws) {
      this.#ws.onclose = null;
      this.#ws.close();
      this.#ws = null;
    }
  }

  #connect() {
    const ws = new WebSocket(WS_URL);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.#retry = 0;
      ws.send(JSON.stringify([
        { ticket: `market-board-${Date.now()}` },
        { type: 'ticker', codes: this.#markets },
      ]));
    };

    ws.onmessage = (event) => {
      const text = typeof event.data === 'string' ? event.data : this.#decoder.decode(event.data);
      try {
        const msg = JSON.parse(text);
        if (msg.type === 'ticker') this.#onTick(toTick(msg));
      } catch {
        // 형식이 다른 메시지는 무시
      }
    };

    ws.onclose = () => {
      this.#ws = null;
      const delay = Math.min(30000, 1000 * 2 ** this.#retry++);
      this.#timer = setTimeout(() => this.#connect(), delay);
    };

    this.#ws = ws;
  }
}
