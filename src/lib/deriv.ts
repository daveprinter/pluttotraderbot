export const DERIV_LEGACY_APP_ID = "1089";

// PAT tokens use Deriv's new PAT-format App ID.
export const DERIV_NEW_APP_ID = "33uaaVh8xkm8lpUWTHDkm";

const DERIV_LEGACY_WS = `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_LEGACY_APP_ID}`;

const DERIV_REST_BASE = "https://api.derivws.com/trading/v1/options";

export type DerivMode = "legacy" | "pat";

export interface DerivAuthResult {
  ws: DerivWS;
  loginid: string;
  currency: string;
  balance: number;
  mode: DerivMode;
}

export function detectTokenMode(token: string): DerivMode {
  // Deriv PAT tokens are long and typically prefixed / dot-separated.
  if (/^[a-z0-9]{1,3}-/i.test(token) && token.length < 40) return "legacy";
  if (token.length > 40 || token.includes(".")) return "pat";
  return "legacy";
}

function extractDerivRestError(body: any, fallback: string): string {
  return (
    body?.error?.message ||
    body?.error?.description ||
    body?.errors?.[0]?.message ||
    body?.message ||
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
  } catch {
    /* ignore */
  }

  if (!response.ok) {
    throw new Error(extractDerivRestError(body, `Deriv PAT API failed (${response.status})`));
  }
  return body as T;
}

type Listener = (msg: any) => void;

export class DerivWS {
  mode: DerivMode = "legacy";
  private socket: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private listeners = new Set<Listener>();
  onClose: (() => void) | null = null;

  connect(url?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const target = url || DERIV_LEGACY_WS;
      let ws: WebSocket;
      try {
        ws = new WebSocket(target);
      } catch (e: any) {
        reject(new Error(e?.message || "Could not open Deriv socket"));
        return;
      }
      this.socket = ws;
      const timer = setTimeout(() => reject(new Error("Deriv connection timed out")), 20000);

      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Deriv socket error"));
      };
      ws.onclose = () => {
        this.pending.forEach((p) => p.reject(new Error("Deriv connection closed")));
        this.pending.clear();
        this.onClose?.();
      };
      ws.onmessage = (event) => {
        let data: any;
        try {
          data = JSON.parse(event.data as string);
        } catch {
          return;
        }
        const id = data?.req_id;
        if (id && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          this.pending.delete(id);
          if (data.error) p.reject(new Error(data.error.message || "Deriv API error"));
          else p.resolve(data);
        }
        this.listeners.forEach((l) => l(data));
      };
    });
  }

  get isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  onMessage(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send<T = any>(payload: Record<string, any>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Deriv socket is not connected"));
        return;
      }
      const req_id = this.reqId++;
      this.pending.set(req_id, { resolve, reject });
      this.socket.send(JSON.stringify({ ...payload, req_id }));
      setTimeout(() => {
        if (this.pending.has(req_id)) {
          this.pending.delete(req_id);
          reject(new Error("Deriv request timed out"));
        }
      }, 30000);
    });
  }

  close() {
    try {
      this.socket?.close();
    } catch {
      /* ignore */
    }
    this.socket = null;
  }
}

export interface DerivAccount {
  /** loginid (legacy) or account_id (PAT) */
  id: string;
  currency: string;
  balance: number;
  isDemo: boolean;
  mode: DerivMode;
  /** token that grants access to this account */
  token: string;
}

function accountIsDemo(account: any, id: string): boolean {
  if (account?.is_virtual === 1 || account?.is_virtual === true) return true;
  const type = String(
    account?.account_type ?? account?.type ?? account?.category ?? "",
  ).toLowerCase();
  if (type.includes("demo") || type.includes("virtual")) return true;
  return /^vr/i.test(id);
}

async function listPatAccounts(token: string): Promise<DerivAccount[]> {
  const accountsResponse = await derivRest<{ data?: any[] | any }>("/accounts", token, {
    method: "GET",
  });

  const raw = Array.isArray(accountsResponse.data)
    ? accountsResponse.data
    : accountsResponse.data
      ? [accountsResponse.data]
      : [];

  return raw
    .map((a) => {
      const id = String(a?.account_id || a?.id || a?.loginid || "");
      if (!id) return null;
      return {
        id,
        currency: String(a?.currency ?? "USD"),
        balance: Number(a?.balance ?? 0),
        isDemo: accountIsDemo(a, id),
        mode: "pat" as DerivMode,
        token,
      };
    })
    .filter(Boolean) as DerivAccount[];
}

async function listLegacyAccounts(token: string): Promise<DerivAccount[]> {
  const ws = new DerivWS();
  ws.mode = "legacy";
  await ws.connect();
  try {
    const auth = await ws.send<any>({ authorize: token });
    if (!auth?.authorize) throw new Error("Invalid token (legacy)");
    const a = auth.authorize;
    // A legacy API token can only trade on the account it was created under,
    // so we expose exactly that account. Paste a second token for the other
    // account type (demo/real) to get both in the switcher.
    return [
      {
        id: String(a.loginid),
        currency: String(a.currency || "USD"),
        balance: Number(a.balance ?? 0),
        isDemo: accountIsDemo(a, String(a.loginid)),
        mode: "legacy" as DerivMode,
        token,
      },
    ];
  } finally {
    ws.close();
  }
}

/** Fetch every account (demo and real) reachable with the given tokens. */
export async function listDerivAccounts(tokens: string[]): Promise<DerivAccount[]> {
  const unique = Array.from(new Set(tokens.map((t) => t.trim()).filter(Boolean)));
  if (unique.length === 0) throw new Error("Enter your Deriv token first");

  const results: DerivAccount[] = [];
  const errors: string[] = [];

  for (const token of unique) {
    try {
      const accounts =
        detectTokenMode(token) === "pat"
          ? await listPatAccounts(token)
          : await listLegacyAccounts(token);
      accounts.forEach((account) => {
        if (!results.some((r) => r.id === account.id)) results.push(account);
      });
    } catch (error: any) {
      errors.push(error?.message || "Token failed");
    }
  }

  if (results.length === 0) {
    throw new Error(errors[0] || "No Deriv accounts found for this token");
  }

  // Demo accounts first so the default selection is always a demo account.
  return results.sort((a, b) => Number(b.isDemo) - Number(a.isDemo));
}

/** Open an authenticated socket for one specific account. */
export async function authorizeDerivAccount(account: DerivAccount): Promise<DerivAuthResult> {
  if (account.mode === "legacy") {
    const ws = new DerivWS();
    ws.mode = "legacy";
    await ws.connect();
    const auth = await ws.send<any>({ authorize: account.token });
    if (!auth?.authorize) throw new Error("Invalid token (legacy)");
    if (String(auth.authorize.loginid) !== account.id) {
      ws.close();
      throw new Error(
        `This token belongs to ${auth.authorize.loginid}, not ${account.id}. Add a token created under ${account.id}.`,
      );
    }
    return {
      ws,
      loginid: String(auth.authorize.loginid),
      currency: String(auth.authorize.currency || "USD"),
      balance: Number(auth.authorize.balance ?? 0),
      mode: "legacy",
    };
  }

  // PAT: request an OTP-authenticated WebSocket URL for this exact account.
  const otpResponse = await derivRest<{ data?: { url?: string; websocket_url?: string } }>(
    `/accounts/${encodeURIComponent(account.id)}/otp`,
    account.token,
    { method: "POST" },
  );

  const websocketUrl = String(otpResponse.data?.url || otpResponse.data?.websocket_url || "");
  if (!websocketUrl) throw new Error("Deriv PAT API did not return a WebSocket URL");

  const ws = new DerivWS();
  ws.mode = "pat";
  await ws.connect(websocketUrl);

  return {
    ws,
    loginid: account.id,
    currency: account.currency,
    balance: account.balance,
    mode: "pat",
  };
}

export function accountLabel(account: DerivAccount) {
  return `${account.isDemo ? "Demo" : "Real"} · ${account.id} · ${account.balance.toFixed(2)} ${account.currency}`;
}

export async function authorizeDeriv(rawToken: string): Promise<DerivAuthResult> {
  const token = rawToken.trim();
  if (!token) throw new Error("Empty token");
  const accounts = await listDerivAccounts([token]);
  const preferred = accounts.find((a) => a.isDemo) ?? accounts[0];
  if (!preferred) throw new Error("No Deriv account found for this token");
  return authorizeDerivAccount(preferred);

}


export const MARKETS: { symbol: string; label: string }[] = [
  { symbol: "1HZ10V", label: "Volatility 10 (1s) Index" },
  { symbol: "1HZ15V", label: "Volatility 15 (1s) Index" },
  { symbol: "1HZ25V", label: "Volatility 25 (1s) Index" },
  { symbol: "1HZ30V", label: "Volatility 30 (1s) Index" },
  { symbol: "1HZ50V", label: "Volatility 50 (1s) Index" },
  { symbol: "1HZ75V", label: "Volatility 75 (1s) Index" },
  { symbol: "1HZ90V", label: "Volatility 90 (1s) Index" },
  { symbol: "1HZ100V", label: "Volatility 100 (1s) Index" },
  { symbol: "R_10", label: "Volatility 10 Index" },
  { symbol: "R_25", label: "Volatility 25 Index" },
  { symbol: "R_50", label: "Volatility 50 Index" },
  { symbol: "R_75", label: "Volatility 75 Index" },
  { symbol: "R_100", label: "Volatility 100 Index" },
];

export function marketLabel(symbol: string) {
  return MARKETS.find((m) => m.symbol === symbol)?.label ?? symbol;
}
