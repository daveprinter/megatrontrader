// Deriv connection client supporting both legacy API tokens and PAT tokens.
// PAT flow (user-supplied): REST /accounts -> POST /accounts/:id/otp -> connect
// to the returned authenticated WebSocket URL.
type Msg = any;
type Listener = (m: Msg) => void;

export const DERIV_LEGACY_APP_ID = "1089";
// PAT tokens use Deriv's new PAT-format App ID.
export const DERIV_NEW_APP_ID = "34DWL0183Hjp3s2BF8ROk";

const DERIV_LEGACY_WS = `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_LEGACY_APP_ID}`;
const DERIV_REST_BASE = "https://api.derivws.com/trading/v1/options";

export type TokenMode = "legacy" | "pat";

export interface DerivAuthResult {
  balance: number;
  currency: string;
  loginid: string;
  mode: TokenMode;
}

function extractDerivRestError(body: any, fallback: string): string {
  return (
    body?.error?.message ||
    body?.message ||
    body?.error ||
    fallback
  );
}

async function derivRest<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${DERIV_REST_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Deriv-App-ID": DERIV_NEW_APP_ID,
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });
  } catch (error: any) {
    throw new Error(error?.message || "Could not reach Deriv PAT API");
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {}

  if (!response.ok) {
    throw new Error(extractDerivRestError(body, `Deriv PAT API failed (${response.status})`));
  }
  return body as T;
}

export class DerivClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, { res: (m: Msg) => void; rej: (e: Error) => void }>();
  private listeners = new Set<Listener>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  mode: TokenMode = "legacy";

  onMessage(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private ensureSocket(url: string = DERIV_LEGACY_WS): Promise<void> {
    if (this.open) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
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
        if (p) {
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

  // Legacy: authorize over the public websocket.
  private async connectLegacy(token: string): Promise<DerivAuthResult> {
    this.mode = "legacy";
    await this.ensureSocket(DERIV_LEGACY_WS);
    const auth = await this.send({ authorize: token });
    if (!auth?.authorize) throw new Error("Invalid token (legacy)");
    await this.send({ balance: 1, subscribe: 1 }).catch(() => {});
    return {
      balance: Number(auth.authorize.balance ?? 0),
      currency: auth.authorize.currency || "USD",
      loginid: auth.authorize.loginid,
      mode: "legacy",
    };
  }

  // PAT: REST accounts -> OTP websocket URL -> connect directly.
  private async connectPat(token: string): Promise<DerivAuthResult> {
    this.mode = "pat";

    // Step 1: accounts list via REST
    const accountsResponse = await derivRest<{ data?: any[] | any }>("/accounts", token, {
      method: "GET",
    });
    const accounts = Array.isArray(accountsResponse.data)
      ? accountsResponse.data
      : accountsResponse.data
        ? [accountsResponse.data]
        : [];
    const account = accounts.find((a) => a?.status === "active") || accounts[0];
    const accountId = String(account?.account_id || account?.id || account?.loginid || "");
    if (!accountId) {
      throw new Error("No Deriv options account found for this PAT token");
    }

    // Step 2: OTP to get an authenticated WebSocket URL
    const otpResponse = await derivRest<{ data?: { url?: string; websocket_url?: string } }>(
      `/accounts/${encodeURIComponent(accountId)}/otp`,
      token,
      { method: "POST" },
    );
    const websocketUrl = String(otpResponse.data?.url || otpResponse.data?.websocket_url || "");
    if (!websocketUrl) {
      throw new Error("Deriv PAT API did not return a WebSocket URL");
    }

    // Step 3: connect directly using the authenticated URL
    await this.ensureSocket(websocketUrl);
    await this.send({ balance: 1, subscribe: 1 }).catch(() => {});

    return {
      balance: Number(account?.balance ?? 0),
      currency: String(account?.currency ?? "USD"),
      loginid: accountId,
      mode: "pat",
    };
  }

  async connect(rawToken: string): Promise<DerivAuthResult> {
    const token = rawToken.trim();
    if (!token) throw new Error("Empty token");
    // Try legacy first; if the token isn't a legacy API token, fall back to PAT.
    try {
      return await this.connectLegacy(token);
    } catch (legacyErr: any) {
      this.disconnect();
      try {
        return await this.connectPat(token);
      } catch (patErr: any) {
        throw new Error(patErr?.message || legacyErr?.message || "Could not connect to Deriv");
      }
    }
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
