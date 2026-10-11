// Public market-data feed: its own unauthenticated Deriv socket that streams
// ticks for many symbols at once. Independent of the account socket so live
// prices work with legacy or PAT tokens, before connecting, and across markets.
import { lastDigit } from "./deriv";

const FEED_WS = "wss://ws.derivws.com/websockets/v3?app_id=1089";

export interface FeedTick {
  symbol: string;
  price: number;
  digit: number;
  pip: number;
}

type TickCb = (t: FeedTick) => void;
type HistCb = (symbol: string, prices: number[], pip: number) => void;
type ErrCb = (msg: string) => void;

class MarketFeed {
  private ws: WebSocket | null = null;
  private want = new Set<string>();
  private subs = new Map<string, string>(); // symbol -> subscription id
  private pip: Record<string, number> = {};
  private reqId = 1;
  private reqSym = new Map<number, string>();
  private ping: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private lastMsg = 0;
  onTick: TickCb = () => {};
  onHistory: HistCb = () => {};
  onError: ErrCb = () => {};

  setSymbols(list: string[]) {
    const next = new Set(list.filter(Boolean));
    for (const s of [...this.want]) if (!next.has(s)) this.unsub(s);
    this.want = next;
    if (!this.ws || this.ws.readyState > 1) return this.connect();
    if (this.ws.readyState === 1) for (const s of next) if (!this.subs.has(s)) this.sub(s);
  }

  private connect() {
    if (typeof window === "undefined") return;
    if (this.retry) clearTimeout(this.retry);
    const ws = new WebSocket(FEED_WS);
    this.ws = ws;
    this.subs.clear();
    ws.onopen = () => {
      this.lastMsg = Date.now();
      for (const s of this.want) this.sub(s);
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => {
        if (ws.readyState === 1) ws.send(JSON.stringify({ ping: 1 }));
        // stale stream watchdog: no data for 20s -> reconnect
        if (Date.now() - this.lastMsg > 20_000) ws.close();
      }, 10_000);
    };
    ws.onerror = () => this.onError("Market data connection error");
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      if (this.ws !== ws) return;
      this.subs.clear();
      this.onError("Market data disconnected — reconnecting");
      this.retry = setTimeout(() => this.connect(), 2000);
    };
    ws.onmessage = (ev) => {
      this.lastMsg = Date.now();
      let m: any;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      const reqSym = m.req_id ? this.reqSym.get(m.req_id) : undefined;
      if (m.error) {
        if (reqSym) this.reqSym.delete(m.req_id);
        if (m.error.code !== "AlreadySubscribed")
          this.onError(`Market data ${reqSym ?? ""}: ${m.error.message}`);
        return;
      }
      if (m.msg_type === "history" && reqSym) {
        this.reqSym.delete(m.req_id);
        const pip = Number(m.pip_size ?? 2);
        this.pip[reqSym] = pip;
        if (m.subscription?.id) this.subs.set(reqSym, m.subscription.id);
        this.onHistory(reqSym, (m.history?.prices ?? []).map(Number), pip);
      }
      if (m.msg_type === "tick" && m.tick) {
        const sym: string = m.tick.symbol;
        if (!this.want.has(sym)) return;
        const pip = Number(m.tick.pip_size ?? this.pip[sym] ?? 2);
        if (m.subscription?.id && !this.subs.has(sym)) this.subs.set(sym, m.subscription.id);
        const price = Number(m.tick.quote);
        this.onTick({ symbol: sym, price, pip, digit: lastDigit(price, pip) });
      }
    };
  }

  private sub(symbol: string) {
    const req_id = this.reqId++;
    this.reqSym.set(req_id, symbol);
    this.subs.set(symbol, "pending");
    this.ws?.send(
      JSON.stringify({ ticks_history: symbol, count: 200, end: "latest", style: "ticks", subscribe: 1, req_id }),
    );
  }

  private unsub(symbol: string) {
    const id = this.subs.get(symbol);
    this.subs.delete(symbol);
    if (id && id !== "pending" && this.ws?.readyState === 1) this.ws.send(JSON.stringify({ forget: id }));
  }
}

export const feed = new MarketFeed();
