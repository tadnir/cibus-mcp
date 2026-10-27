/**
 * Signing in to Cibus: an email or mobile number (and, for some accounts, a
 * second detail Pluxee asks for, such as an ID or employee number) gets a
 * one-time code by SMS or email, and the code gets the session's cookies.
 *
 * Both steps carry a reCAPTCHA v3 token that only Pluxee's own page can
 * produce, so they run inside a real browser on that page (Playwright's
 * Chromium): the browser asks reCAPTCHA for a token as the page would, and
 * sends each request from the page with its cookies. reCAPTCHA v3 shows no
 * puzzle; it scores the browser. Nothing is solved automatically. The email,
 * phone, second detail and code are only ever sent to Pluxee.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { APPLICATION_ID, API_DOMAIN, CAPIR_BASE_URL, SITE_ORIGIN } from "./api.js";
import type { Cookie } from "./cookies.js";
import { configDir } from "./store.js";

export const LOGIN_PAGE_URL = `${SITE_ORIGIN}/login`;
/** The web app's reCAPTCHA v3 site key; the page's own script tag wins when it names another. */
export const RECAPTCHA_SITE_KEY = "6LddY28jAAAAALbiEdodIdIYiM563_AgOW4LMcmu";

export class CibusLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CibusLoginError";
  }
}

export interface Identity {
  /** The email or mobile number. */
  first: string;
  /** The second detail, when Pluxee asks for one; empty otherwise. */
  second: string;
}

/** Where the code went, as Pluxee shows it (masked). */
export interface CodeSent {
  method: string;
  maskedInput: string;
}

/** The browser the sign-in runs in, open on the Pluxee sign-in page. */
export interface LoginBrowser {
  /** A fresh reCAPTCHA v3 token for an action of the page. */
  captcha(action: string): Promise<string>;
  /** POSTs JSON to an API from the page, with its cookies; returns the answer's text. */
  post(url: string, body: unknown): Promise<{ status: number; text: string }>;
  /** Both APIs' cookies, HttpOnly ones included. */
  cookies(): Promise<Cookie[]>;
  close(): Promise<void>;
}

export type OpenBrowser = () => Promise<LoginBrowser>;

/** A mobile number as digits only; an email as typed. */
export function normalizeFirst(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("@")) return trimmed;
  return trimmed.replace(/[\s()-]/g, "");
}

/** Thrown when Pluxee needs the second detail before it sends a code. */
export class SecondInputRequired extends CibusLoginError {
  constructor() {
    super("Pluxee needs one more detail to find your account (for example your ID or employee number).");
    this.name = "SecondInputRequired";
  }
}

interface CapirAnswer {
  status?: number;
  message?: unknown;
  error?: { message?: unknown };
  data?: { method?: string; maskedInput?: string };
}

function parse(text: string): CapirAnswer {
  try {
    return JSON.parse(text) as CapirAnswer;
  } catch {
    return {};
  }
}

function messageOf(answer: CapirAnswer): string {
  const m = answer.error?.message ?? answer.message;
  if (typeof m === "string") return m;
  if (m && typeof m === "object" && "message" in m && typeof (m as { message: unknown }).message === "string") return (m as { message: string }).message;
  return "";
}

/** Asks Pluxee to send the one-time code. */
export async function sendCode(browser: LoginBrowser, identity: Identity): Promise<CodeSent> {
  const res = await browser.post(`${CAPIR_BASE_URL}/auth/sendOTP`, {
    userInput1: normalizeFirst(identity.first),
    userInput2: identity.second.trim(),
    reCAPTCHAToken: await browser.captcha("verifyUser"),
    call: false,
  });
  const answer = parse(res.text);
  const status = answer.status ?? res.status;
  if (status === 201 || status === 200) return { method: answer.data?.method ?? "", maskedInput: answer.data?.maskedInput ?? "" };
  // The web app asks for the second detail when the first one alone fails.
  if (!identity.second.trim()) throw new SecondInputRequired();
  const message = messageOf(answer);
  throw new CibusLoginError(`Pluxee did not send a code${message ? `: ${message}` : ` (HTTP ${status})`}. Check the details you entered.`);
}

/** Sends the code; returns the session's cookies. */
export async function verifyCode(browser: LoginBrowser, identity: Identity, otpPin: string): Promise<Cookie[]> {
  if (!/^\d{4,8}$/.test(otpPin)) throw new CibusLoginError("The code is digits only.");
  const res = await browser.post(`${CAPIR_BASE_URL}/auth/authToken`, {
    otpPin,
    userInput1: normalizeFirst(identity.first),
    userInput2: identity.second.trim(),
    reCAPTCHAToken: await browser.captcha("loginOtp"),
    trustDevice: true,
  });
  const answer = parse(res.text);
  const status = answer.status ?? res.status;
  if (status >= 400 || res.status >= 400) {
    const message = messageOf(answer);
    throw new CibusLoginError(message || "Pluxee did not accept the code.");
  }
  const cookies = await browser.cookies();
  if (cookies.length === 0) throw new CibusLoginError("Pluxee accepted the code but set no session cookie.");
  return cookies;
}

// Run in the page, so given as source: a TypeScript loader may wrap compiled
// functions in helpers the page doesn't have.

/** A reCAPTCHA v3 token for the site key and action. */
const CAPTCHA_SCRIPT = `function (siteKey, action) {
  return new Promise(function (resolve, reject) {
    var timer = setTimeout(function () { reject(new Error("timeout")); }, 60000);
    window.grecaptcha.ready(function () {
      window.grecaptcha.execute(siteKey, { action: action }).then(function (token) { clearTimeout(timer); resolve(token); }, function (err) { clearTimeout(timer); reject(err); });
    });
  });
}`;

/** POSTs a JSON body with the page's cookies, as the web app's own requests do. */
const POST_SCRIPT = `function (url, body, appId) {
  return fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json", accept: "application/json, text/plain, */*", "application-id": appId, "accept-language": "he" },
    body: body
  }).then(function (res) { return res.text().then(function (text) { return { status: res.status, text: text }; }); });
}`;

/** The site key in the page's reCAPTCHA script tag, if it has one. */
const SITE_KEY_SCRIPT = `(function () {
  var s = document.querySelector('script[src*="recaptcha/api.js"][src*="render="]');
  if (!s) return "";
  var m = /[?&]render=([^&]+)/.exec(s.getAttribute("src") || "");
  return m && m[1] !== "explicit" ? decodeURIComponent(m[1]) : "";
})()`;

const READY_SCRIPT = `typeof window.grecaptcha === "object" && typeof window.grecaptcha.execute === "function"`;

/** The sign-in browser that has the profile, and the launch in progress. */
let open: { close(): Promise<void> } | undefined;
let launching: Promise<unknown> = Promise.resolve();

/**
 * Chromium on the Pluxee sign-in page. Headless unless CIBUS_HEADLESS=false;
 * CIBUS_CHROMIUM_PATH picks another Chromium than Playwright's own.
 *
 * reCAPTCHA v3 scores a browser that looks automated or new lower, so this
 * runs full Chromium in its new headless mode (not the bare headless shell),
 * without the automation flag or "HeadlessChrome" in its user agent, and
 * keeps one profile in CIBUS_CONFIG_DIR/browser, so Google's cookies from one
 * sign-in carry over to the next.
 */
export async function openChromium(): Promise<LoginBrowser> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new CibusLoginError("Playwright is not installed: run `npm install` and `npx playwright install chromium`.");
  }
  const headless = process.env.CIBUS_HEADLESS !== "false";
  const executablePath = process.env.CIBUS_CHROMIUM_PATH || undefined;
  const options = {
    headless,
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
    args: ["--disable-blink-features=AutomationControlled"],
    locale: "he-IL",
    timezoneId: "Asia/Jerusalem",
    viewport: { width: 1280, height: 800 },
    bypassCSP: true,
  };
  const profile = join(configDir(), "browser");
  // The profile takes one browser at a time. A newer sign-in replaces an older
  // one still open (say, the form sent twice), as the sign-in page does; once
  // none is open, a lock left in the profile is from a browser that died with
  // its container.
  const launch = launching.then(async () => {
    await open?.close().catch(() => undefined);
    for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) await rm(join(profile, lock), { force: true });
    return chromium.launchPersistentContext(profile, options);
  });
  launching = launch.catch(() => undefined);
  const context = await launch.catch((err: unknown) => {
    throw new CibusLoginError(`Could not start Chromium (${err instanceof Error ? err.message : String(err)}). Run \`npx playwright install chromium\`.`);
  });
  open = context;
  const browser = {
    close: async () => {
      if (open === context) open = undefined;
      await context.close();
    },
  };
  try {
    // New headless mode still says "HeadlessChrome" in its user agent, which Google reads as a bot.
    const page = context.pages()[0] ?? (await context.newPage());
    const userAgent = String(await page.evaluate("navigator.userAgent"));
    if (userAgent.includes("HeadlessChrome")) {
      const plain = userAgent.replace("HeadlessChrome", "Chrome");
      await context.setExtraHTTPHeaders({ "user-agent": plain });
      await context.addInitScript(`Object.defineProperty(Navigator.prototype, "userAgent", { get: () => ${JSON.stringify(plain)} });`);
    }
    await page.goto(LOGIN_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    let siteKey = "";
    // The page loads reCAPTCHA itself; load it if it has not by the time the page settles.
    if (await page.waitForFunction(READY_SCRIPT, undefined, { timeout: 20_000 }).then(() => true, () => false)) {
      siteKey = String(await page.evaluate(SITE_KEY_SCRIPT));
    }
    if (!siteKey) {
      siteKey = RECAPTCHA_SITE_KEY;
      if (!(await page.evaluate(READY_SCRIPT))) {
        await page.addScriptTag({ url: `https://www.google.com/recaptcha/api.js?render=${siteKey}` });
        await page.waitForFunction(READY_SCRIPT, undefined, { timeout: 30_000 });
      }
    }
    return {
      async captcha(action) {
        return page
          .evaluate(`(${CAPTCHA_SCRIPT})(${JSON.stringify(siteKey)}, ${JSON.stringify(action)})`)
          .then((token) => {
            if (typeof token !== "string" || !token) throw new Error("no token");
            return token;
          })
          .catch((err: unknown) => {
            console.error(`[cibus-mcp] reCAPTCHA failed: ${err instanceof Error ? err.message : String(err)}`);
            throw new CibusLoginError("reCAPTCHA did not pass this sign-in. Start again.");
          });
      },
      async post(url, body) {
        return (await page.evaluate(`(${POST_SCRIPT})(${JSON.stringify(url)}, ${JSON.stringify(JSON.stringify(body))}, ${JSON.stringify(APPLICATION_ID)})`)) as { status: number; text: string };
      },
      async cookies() {
        const all = await context.cookies([`${API_DOMAIN}/`, `${CAPIR_BASE_URL}/`]);
        const byName = new Map<string, Cookie>();
        for (const c of all) byName.set(c.name, { name: c.name, value: c.value, ...(c.expires > 0 ? { expires: Math.floor(c.expires) } : {}) });
        return [...byName.values()];
      },
      async close() {
        await browser.close();
      },
    };
  } catch (err) {
    await browser.close().catch(() => undefined);
    throw err instanceof CibusLoginError ? err : new CibusLoginError(`Could not open the Pluxee sign-in page: ${err instanceof Error ? err.message : String(err)}`);
  }
}
