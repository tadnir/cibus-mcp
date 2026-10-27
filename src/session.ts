/**
 * The signed-in side of the server: one Pluxee session kept alive in this
 * process, and a small sign-in page that starts it.
 *
 * Settings (environment):
 *   CIBUS_CONFIG_DIR  where the session is saved (default ~/.config/cibus-mcp)
 *   CIBUS_LOGIN_HOST  address the sign-in page listens on (default 127.0.0.1)
 *   CIBUS_LOGIN_PORT  its port (default 8768; a free port if that one is taken)
 *   CIBUS_LOGIN_URL   the link handed out, when the page is reached through a
 *                     reverse proxy (default http://localhost:<port>/); when
 *                     set, the page starts with the server
 *   CIBUS_HEADLESS    false shows the sign-in browser's window (default true)
 *
 * The email or phone, the second detail and the one-time code are typed on
 * that page only. The model is only ever given its link.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { PluxeeApi, Unauthorized, type Fetch } from "./api.js";
import { SessionKeeper, SessionRefused, SignInRequired, type KeeperStatus } from "./keeper.js";
import { CibusLoginError, SecondInputRequired, openChromium, sendCode, verifyCode, type Identity, type LoginBrowser, type OpenBrowser } from "./login.js";
import { DEFAULT_LENGTH, PAGE_HEADERS, codePage, idPage, lengthMs, messagePage, statusPage, workingPage, type IdFormValues } from "./pages.js";
import { fileStore, type SessionStore } from "./store.js";

const log = (line: string): void => console.error(`[cibus-mcp] ${line}`);

/** A sent code is good for a few minutes; the browser waiting on it is closed after this. */
const PENDING_TTL_MS = 10 * 60_000;
/** How long a form waits for Pluxee before showing a progress page. */
const STEP_WAIT_MS = 8_000;

export interface SessionStatus extends KeeperStatus {
  signInUrl?: string;
}

export interface SessionManagerOptions {
  store?: SessionStore;
  fetch?: Fetch;
  openBrowser?: OpenBrowser;
  host?: string;
  port?: number;
  url?: string;
  tickMs?: number;
  /** How long a form waits for Pluxee before showing progress. */
  stepWaitMs?: number;
}

/** A sign-in in progress, in a browser on Pluxee's page. */
interface Pending {
  browser: LoginBrowser;
  identity: Identity;
  lengthMs: number;
  at: number;
  /** sending the code, waiting for it, or checking it. */
  step: "sending" | "code" | "verifying";
  sentTo?: string;
  error?: string;
}

export class SessionManager {
  readonly keeper: SessionKeeper;
  readonly api: PluxeeApi;
  readonly #openBrowser: OpenBrowser;
  readonly #stepWaitMs: number;
  readonly #csrf = randomBytes(16).toString("hex");
  readonly #host: string;
  readonly #port: number;
  readonly #fixedUrl: string | undefined;
  #server: Promise<string> | undefined;
  #http: Server | undefined;
  #pending: Pending | undefined;
  /** Why the last sign-in failed, shown once on the sign-in page. */
  #notice: string | undefined;
  /** What to fill the form with after Pluxee asked for the second detail. */
  #retry: IdFormValues | undefined;

  constructor(options: SessionManagerOptions = {}) {
    this.#openBrowser = options.openBrowser ?? openChromium;
    this.#stepWaitMs = options.stepWaitMs ?? STEP_WAIT_MS;
    this.#host = options.host ?? (process.env.CIBUS_LOGIN_HOST || "127.0.0.1");
    this.#port = options.port ?? Number(process.env.CIBUS_LOGIN_PORT || 8768);
    this.#fixedUrl = options.url ?? (process.env.CIBUS_LOGIN_URL || undefined);
    this.keeper = new SessionKeeper({ store: options.store ?? fileStore(), ...(options.tickMs ? { tickMs: options.tickMs } : {}) });
    this.api = new PluxeeApi(
      () => this.#jar(),
      () => this.keeper.cookiesChanged(),
      (input, init) => this.#apiFetch(input, init, options.fetch ?? fetch),
    );
    this.keeper.check = async () => {
      try {
        await this.api.ping();
      } catch (err) {
        if (err instanceof Unauthorized || err instanceof SignInRequired) throw new SessionRefused();
        throw err;
      }
    };
  }

  async start(): Promise<void> {
    await this.keeper.start();
    if (this.#fixedUrl) await this.signInUrl();
  }

  stop(): void {
    this.keeper.stop();
    this.#http?.close();
    void this.#dropPending();
  }

  /** Starts the sign-in page if it is not up yet and returns its link. */
  signInUrl(): Promise<string> {
    this.#server ??= this.#listen().catch((err: unknown) => {
      this.#server = undefined;
      throw err;
    });
    return this.#server;
  }

  async status(): Promise<SessionStatus> {
    const status = this.keeper.status();
    if (status.state === "signed_in") return status;
    return { ...status, signInUrl: await this.signInUrl() };
  }

  async #jar() {
    try {
      return await this.keeper.jar();
    } catch (err) {
      if (err instanceof SignInRequired) throw await this.#signInRequired();
      throw err;
    }
  }

  async #signInRequired(): Promise<SignInRequired> {
    const url = await this.signInUrl();
    return new SignInRequired(
      `Not signed in to Cibus (the session ended, or nobody has signed in yet). ` +
        `Ask the user to open ${url} and sign in there with the email or mobile number on their Cibus account and the one-time code Pluxee sends, then try again. ` +
        `Never ask the user for these in the chat.`,
    );
  }

  /** A refused session is forgotten, and the caller is told to sign in. */
  async #apiFetch(input: URL | RequestInfo, init: RequestInit | undefined, f: Fetch): Promise<Response> {
    const res = await f(input, init);
    if (res.status === 401) {
      await this.keeper.lost("Pluxee refused the session cookie.");
      throw await this.#signInRequired();
    }
    return res;
  }

  /** The API saw a signed-out code in an answer: forget the session too. */
  async signedOut(): Promise<SignInRequired> {
    await this.keeper.lost("Pluxee refused the session cookie.");
    return this.#signInRequired();
  }

  async #listen(): Promise<string> {
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((err: unknown) => {
        log(`sign-in page failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) page(res, 500, messagePage("Something went wrong", "Reload the page and try again."));
        else res.end();
      });
    });
    const bind = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, this.#host, () => {
          server.off("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      });
    let port: number;
    try {
      port = await bind(this.#port);
    } catch (err) {
      // Another client's copy of this server holds the port: any free one will do locally.
      if ((err as { code?: string }).code !== "EADDRINUSE" || this.#fixedUrl) throw err;
      port = await bind(0);
    }
    server.unref();
    this.#http = server;
    const url = this.#fixedUrl ?? `http://localhost:${port}/`;
    log(`sign-in page on ${this.#host}:${port}, linked as ${url}`);
    return url;
  }

  /** Only the hosts the link names: a page another site rebinds to 127.0.0.1 gets nothing. */
  #hostAllowed(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? "").toLowerCase();
    const name = host.replace(/:\d+$/, "");
    if (name === "localhost" || name === "127.0.0.1" || name === "[::1]") return true;
    if (!this.#fixedUrl) return false;
    return host === new URL(this.#fixedUrl).host.toLowerCase();
  }

  #livePending(): Pending | undefined {
    if (this.#pending && Date.now() - this.#pending.at > PENDING_TTL_MS) void this.#dropPending();
    return this.#pending;
  }

  async #dropPending(): Promise<void> {
    const pending = this.#pending;
    this.#pending = undefined;
    await pending?.browser.close().catch(() => undefined);
  }

  /** Runs a step in the background; a form waits a little for it, then the page shows its progress. */
  async #run(pending: Pending, step: () => Promise<void>, onError: (err: unknown, message: string) => Promise<void>): Promise<void> {
    const task = step().catch(async (err: unknown) => {
      if (this.#pending !== pending) return;
      await onError(err, err instanceof CibusLoginError ? err.message : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
    });
    await Promise.race([task, new Promise((resolve) => setTimeout(resolve, this.#stepWaitMs).unref())]);
  }

  async #fail(message: string, retry?: IdFormValues): Promise<void> {
    this.#notice = message;
    this.#retry = retry;
    await this.#dropPending();
  }

  #pendingPage(pending: Pending): string {
    if (pending.step === "code") return codePage(this.#csrf, pending.sentTo, pending.error);
    return workingPage(this.#csrf, pending.step === "sending" ? "Asking Pluxee for a code…" : "Checking the code…");
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#hostAllowed(req)) {
      page(res, 421, messagePage("Wrong address", "Open the sign-in link exactly as it was given."));
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, cibus: this.keeper.status().state }));
      return;
    }
    if (req.method === "GET" && path === "/") {
      const status = this.keeper.status();
      const pending = this.#livePending();
      const notice = this.#notice;
      const retry = this.#retry;
      this.#notice = undefined;
      this.#retry = undefined;
      if (pending) page(res, 200, this.#pendingPage(pending));
      else if (status.state === "signed_in" && !notice) page(res, 200, statusPage(status, this.#csrf));
      else page(res, 200, idPage(status, this.#csrf, notice, retry));
      return;
    }
    if (req.method !== "POST" || !["/start", "/code", "/cancel", "/sign-out"].includes(path)) {
      res.writeHead(404).end();
      return;
    }
    const form = new URLSearchParams(await readBody(req));
    if (form.get("csrf") !== this.#csrf) {
      page(res, 400, messagePage("Form expired", "Reload the page and try again."));
      return;
    }
    if (path === "/cancel") {
      await this.#dropPending();
    } else if (path === "/sign-out") {
      await this.#dropPending();
      if (this.keeper.status().state === "signed_in") await this.api.logout().catch(() => undefined);
      await this.keeper.signOut();
    } else if (path === "/start") {
      const first = (form.get("first") ?? "").trim();
      const second = (form.get("second") ?? "").trim();
      const length = lengthMs(form.get("length") ?? DEFAULT_LENGTH);
      const firstOk = /^[^\s@]{1,64}@[^\s@]{1,100}\.[^\s@]{2,}$/.test(first) || /^\+?[\d\s()-]{9,16}$/.test(first);
      if (!firstOk || second.length > 40 || !length) {
        page(res, 400, idPage(this.keeper.status(), this.#csrf, "Enter the email or mobile number on your Cibus account.", { first, askSecond: second !== "" }));
        return;
      }
      await this.#dropPending();
      let browser: LoginBrowser;
      try {
        browser = await this.#openBrowser();
      } catch (err) {
        if (!(err instanceof CibusLoginError)) throw err;
        page(res, 200, idPage(this.keeper.status(), this.#csrf, err.message, { first }));
        return;
      }
      const pending: Pending = { browser, identity: { first, second }, lengthMs: length, at: Date.now(), step: "sending" };
      this.#pending = pending;
      await this.#run(
        pending,
        async () => {
          const sent = await sendCode(browser, pending.identity);
          pending.sentTo = sent.maskedInput || undefined;
          pending.step = "code";
          pending.at = Date.now();
        },
        (err, message) => this.#fail(message, { first, askSecond: err instanceof SecondInputRequired || second !== "" }),
      );
    } else {
      const pending = this.#livePending();
      if (!pending || pending.step !== "code") {
        if (!pending) this.#notice = "That sign-in timed out. Start again.";
        res.writeHead(303, { location: "./", "cache-control": "no-store" }).end();
        return;
      }
      const code = (form.get("code") ?? "").trim();
      pending.step = "verifying";
      delete pending.error;
      await this.#run(
        pending,
        async () => {
          const cookies = await verifyCode(pending.browser, pending.identity, code);
          if (this.#pending !== pending) return;
          this.#pending = undefined;
          await pending.browser.close().catch(() => undefined);
          await this.keeper.signedIn(cookies, pending.lengthMs);
        },
        async (_err, message) => {
          pending.step = "code";
          pending.error = `Pluxee did not accept the code: ${message}`;
        },
      );
    }
    res.writeHead(303, { location: "./", "cache-control": "no-store" }).end();
  }
}

function page(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, PAGE_HEADERS).end(html);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 16 * 1024) throw new Error("form too large");
  }
  return body;
}
