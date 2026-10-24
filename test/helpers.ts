import type { Fetch } from "../src/api.js";
import type { Cookie } from "../src/cookies.js";
import type { LoginBrowser } from "../src/login.js";
import type { SavedSession, SessionStore } from "../src/store.js";

export function memoryStore(initial?: SavedSession): SessionStore & { saved?: SavedSession } {
  const store = {
    saved: initial,
    async load() {
      return store.saved;
    },
    async save(s: SavedSession) {
      store.saved = s;
    },
    async clear() {
      store.saved = undefined;
    },
  };
  return store;
}

export interface Call {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

/** A fetch that answers from a route table and records every call. */
export function fakeFetch(routes: (call: Call) => Response | undefined): Fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    return routes(call) ?? new Response("not found", { status: 404 });
  }) as Fetch & { calls: Call[] };
  f.calls = calls;
  return f;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export interface FakeBrowser extends LoginBrowser {
  posts: { url: string; body: Record<string, unknown> }[];
  actions: string[];
  closed: boolean;
}

/**
 * The Pluxee sign-in page, answering sendOTP and authToken; the right code is
 * 123456. With needsSecond, sendOTP refuses until a second detail is given.
 */
export function fakeBrowser(options: { needsSecond?: boolean; cookies?: Cookie[] } = {}): FakeBrowser {
  let tokens = 0;
  const browser: FakeBrowser = {
    posts: [],
    actions: [],
    closed: false,
    async captcha(action) {
      browser.actions.push(action);
      tokens += 1;
      return `token-${tokens}`;
    },
    async post(url, body) {
      const b = body as Record<string, unknown>;
      browser.posts.push({ url, body: b });
      if (url.endsWith("/auth/sendOTP")) {
        if (options.needsSecond && !b.userInput2) return { status: 404, text: JSON.stringify({ status: 404, error: { message: "user not found" } }) };
        return { status: 201, text: JSON.stringify({ status: 201, data: { method: "sms", maskedInput: "05*-***-**00" } }) };
      }
      if (url.endsWith("/auth/authToken")) {
        if (b.otpPin === "123456") return { status: 200, text: JSON.stringify({ status: 200, data: {} }) };
        return { status: 401, text: JSON.stringify({ status: 401, error: { message: "Wrong code" } }) };
      }
      return { status: 404, text: "" };
    },
    async cookies() {
      return options.cookies ?? [{ name: "token", value: "t1" }];
    },
    async close() {
      browser.closed = true;
    },
  };
  return browser;
}
