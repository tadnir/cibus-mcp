/**
 * Renewing the session before Pluxee's 24 hours run out.
 *
 * The "token" cookie expires 24 hours after a sign-in, and no call the web app
 * makes moves that forward. Pluxee's Android app keeps its users signed in
 * with a CAPIR call the web app doesn't make, auth/exchangeToken, which it
 * calls before its token expires. Its exact request isn't public, so this
 * tries the likely shapes in turn and keeps a record of what each one got,
 * without any cookie or token values.
 */
import { APPLICATION_ID, CAPIR_BASE_URL, apiHeaders, type Fetch, type Json } from "./api.js";
import type { CookieJar } from "./cookies.js";

/** The Android app's application id, as it sends it. */
export const MOBILE_APPLICATION_ID = "1657D777-FE1B-449A-BACF-724B497E238F";
export const EXCHANGE_PATH = "/auth/exchangeToken";
/** Renew once the token has less than this left. */
export const RENEW_BEFORE_MS = 3 * 60 * 60_000;
/** A token Pluxee hands back in the body, without an expiry, lasts this long. */
const DEFAULT_TOKEN_LIFE_S = 24 * 60 * 60;

export interface RenewAttempt {
  variant: string;
  status?: number;
  /** The names of the cookies the answer set. */
  setCookies?: string[];
  /** The answer's JSON keys, and its data object's, never their values. */
  bodyKeys?: string[];
  message?: string;
  error?: string;
}

export interface RenewResult {
  at: string;
  renewed: boolean;
  tokenExpiresAt?: string;
  attempts: RenewAttempt[];
}

interface Variant {
  name: string;
  headers: (token: string) => Record<string, string>;
  body: (token: string) => Json;
}

const VARIANTS: Variant[] = [
  { name: "cookie, web app id", headers: () => ({}), body: () => ({}) },
  { name: "cookie, mobile app id", headers: () => ({ "application-id": MOBILE_APPLICATION_ID }), body: () => ({}) },
  {
    name: "bearer and body token, mobile app id",
    headers: (token) => ({ "application-id": MOBILE_APPLICATION_ID, authorization: `Bearer ${token}` }),
    body: (token) => ({ token }),
  },
];

export function tokenExpiry(jar: CookieJar): number | undefined {
  const expires = jar.list().find((c) => c.name === "token")?.expires;
  return expires === undefined ? undefined : expires * 1000;
}

export function dueForRenewal(jar: CookieJar, now = Date.now()): boolean {
  const expiry = tokenExpiry(jar);
  return expiry !== undefined && expiry - now < RENEW_BEFORE_MS;
}

/**
 * Tries each shape of auth/exchangeToken until one gives a token that lasts
 * longer than the one held. f is a plain fetch: a refusal here must not end
 * the session, which still holds until its token expires.
 */
export async function renewToken(jar: CookieJar, f: Fetch, now = Date.now): Promise<RenewResult> {
  const attempts: RenewAttempt[] = [];
  const before = tokenExpiry(jar) ?? 0;
  const token = jar.list().find((c) => c.name === "token")?.value ?? "";
  for (const variant of VARIANTS) {
    const attempt: RenewAttempt = { variant: variant.name };
    attempts.push(attempt);
    try {
      const res = await f(new URL(`${CAPIR_BASE_URL}${EXCHANGE_PATH}`), {
        method: "POST",
        headers: { ...apiHeaders(), "application-id": APPLICATION_ID, ...variant.headers(token), cookie: jar.header() },
        body: JSON.stringify(variant.body(token)),
      });
      attempt.status = res.status;
      const setCookies = (res.headers.getSetCookie?.() ?? []).map((line) => line.split("=")[0]?.trim() ?? "");
      if (setCookies.length) attempt.setCookies = setCookies;
      jar.update(res, now());
      const body = (await res.json().catch(() => undefined)) as Json | undefined;
      if (body && typeof body === "object") {
        attempt.bodyKeys = describeKeys(body);
        const message = errorMessage(body);
        if (message) attempt.message = message;
        const fresh = res.ok ? bodyToken(body) : undefined;
        if (fresh && fresh !== token) jar.set({ name: "token", value: fresh, expires: jwtExpiry(fresh) ?? Math.floor(now() / 1000) + DEFAULT_TOKEN_LIFE_S });
      }
    } catch (err) {
      attempt.error = err instanceof Error ? err.message : String(err);
    }
    const after = tokenExpiry(jar) ?? 0;
    if (after > before) return { at: new Date(now()).toISOString(), renewed: true, tokenExpiresAt: new Date(after).toISOString(), attempts };
  }
  return { at: new Date(now()).toISOString(), renewed: false, ...(before ? { tokenExpiresAt: new Date(before).toISOString() } : {}), attempts };
}

function describeKeys(body: Json): string[] {
  const keys = Object.keys(body);
  const data = body.data;
  if (data && typeof data === "object" && !Array.isArray(data)) keys.push(...Object.keys(data as Json).map((k) => `data.${k}`));
  return keys;
}

function errorMessage(body: Json): string | undefined {
  const error = body.error as Json | string | undefined;
  if (typeof error === "string") return error.slice(0, 200);
  if (error && typeof error.message === "string") return error.message.slice(0, 200);
  return typeof body.message === "string" ? body.message.slice(0, 200) : undefined;
}

/** A token in the answer's body, under the names the app's models use. */
export function bodyToken(body: Json): string | undefined {
  const data = (body.data && typeof body.data === "object" ? body.data : {}) as Json;
  for (const source of [data, body]) {
    for (const key of ["token", "authToken", "accessToken", "access_token", "sessionToken"]) {
      const value = source[key];
      if (typeof value === "string" && value.length >= 20) return value;
    }
  }
  return undefined;
}

/** A JWT's exp, in epoch seconds, when the token is one. */
export function jwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const exp = Number((JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Json).exp);
    return Number.isFinite(exp) && exp > 0 ? exp : undefined;
  } catch {
    return undefined;
  }
}
