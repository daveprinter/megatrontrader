// Minimal Deriv WebSocket client. The PAT connection can be swapped for the
// user's exact code inside `connect()`.
type Msg = Record<string, any>;
type Listener = (m: Msg) => void;

const APP_ID = 1089;
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

export class DerivClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, { res: (m: Msg) => void; rej: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  onMessage(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private ensureSocket(): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(URL);
      this.ws = ws;
      ws.onopen = () => {
        this.pingTimer = setInterval(() => this.send({ ping: 1 }).catch(() => {}), 25000);
        resolve();
      };
      ws.onerror = () => reject(new Error("Connection to Deriv failed"));
      ws.onclose = () => {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.listeners.forEach((l) => l({ msg_type: "__closed" }));
      };
      ws.onmessage = (ev) => {
        const m: Msg = JSON.parse(ev.data);
        const p = m.req_id ? this.pending.get(m.req_id) : undefined;
        if (p && !m.subscription) {
          this.pending.delete(m.req_id);
          m.error ? p.rej(new Error(m.error.message)) : p.res(m);
        } else if (p && m.subscription) {
          this.pending.delete(m.req_id);
          m.error ? p.rej(new Error(m.error.message)) : p.res(m);
        }
        this.listeners.forEach((l) => l(m));
      };
    });
  }

  async send(req: Msg): Promise<Msg> {
    await this.ensureSocket();
    const req_id = this.reqId++;
    return new Promise((res, rej) => {
      this.pending.set(req_id, { res, rej });
      this.ws!.send(JSON.stringify({ ...req, req_id }));
    });
  }

  async connect(token: string) {
    const auth = await this.send({ authorize: token.trim() });
    await this.send({ balance: 1, subscribe: 1 }).catch(() => {});
    return auth.authorize as { balance: number; currency: string; loginid: string };
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
  }
}

export const deriv = new DerivClient();

export function lastDigit(price: number, pip: number) {
  const s = price.toFixed(pip);
  return Number(s[s.length - 1]);
}
