import { CookieJar, type Cookie } from "./cookies.js";
import type { RenewResult } from "./renew.js";
import type { SavedSession, SessionStore } from "./store.js";

/**
 * Keeps one Pluxee sign-in for as long as Pluxee allows.
 *
 * The keeper checks the session every few minutes with a small data call,
 * renews Pluxee's 24-hour token when it is close to expiring (renew.ts),
 * saves any cookies Pluxee sets so a restart picks them up, and drops the
 * session once Pluxee refuses it, or at the latest by the length picked at
 * sign-in. Then a person has to sign in again.
 */

export type KeeperState = "signed_out" | "signed_in" | "expired";

export interface KeeperStatus {
  state: KeeperState;
  signedInAt?: string;
  endsAt?: string;
  lastCheckedAt?: string;
  endedAt?: string;
  lastError?: string;
  /** When Pluxee last set a cookie (a sign it extended the session); never values. */
  lastRenewedAt?: string;
  /** The last renewal of the token: what each try got, never values. */
  lastRenewal?: RenewResult;
  /** The session's cookie names and when each expires, never their values. */
  cookies?: { name: string; expiresAt?: string }[];
}

function cookieSummary(cookies: Cookie[]): KeeperStatus["cookies"] {
  return cookies.map((c) => ({ name: c.name, ...(c.expires ? { expiresAt: new Date(c.expires * 1000).toISOString() } : {}) }));
}

/** Thrown by the check when Pluxee refused the cookies. */
export class SessionRefused extends Error {
  constructor(message = "Pluxee ended the session.") {
    super(message);
    this.name = "SessionRefused";
  }
}

export interface KeeperOptions {
  store: SessionStore;
  /** Between keep-alive rounds. */
  tickMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export const DEFAULT_TICK_MS = 10 * 60_000;
export const LENGTH_ENDED = "The session reached its time limit.";

export class SignInRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInRequired";
  }
}

export class SessionKeeper {
  readonly #store: SessionStore;
  readonly #tickMs: number;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  #session: SavedSession | undefined;
  #jar: CookieJar | undefined;
  #status: KeeperStatus = { state: "signed_out" };
  #timer: ReturnType<typeof setInterval> | undefined;
  #busy: Promise<unknown> = Promise.resolve();
  /** The keep-alive call; set by the owner, as it needs this keeper's cookies. */
  check: () => Promise<void> = async () => undefined;
  signInHint = "Sign in to Cibus again.";

  constructor(options: KeeperOptions) {
    this.#store = options.store;
    this.#tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((line) => console.error(`[keeper] ${line}`));
  }

  status(): KeeperStatus {
    const cookies = this.#jar ? cookieSummary(this.#jar.list()) : this.#status.cookies;
    return { ...this.#status, ...(cookies ? { cookies } : {}) };
  }

  async start(): Promise<void> {
    await this.reload();
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Takes a fresh sign-in: saves it and starts keeping it. */
  async signedIn(cookies: Cookie[], lengthMs: number): Promise<void> {
    await this.#serial(async () => {
      const now = this.#now();
      this.#session = { version: 1, cookies, signedInAt: new Date(now).toISOString(), endsAt: now + lengthMs };
      this.#jar = new CookieJar(cookies);
      await this.#store.save(this.#session);
      this.#status = { ...this.#fromSession(this.#session), state: "signed_in", lastCheckedAt: new Date(now).toISOString() };
      this.#log("signed in");
    });
  }

  /** Re-reads the saved session, e.g. one another process signed in. */
  async reload(): Promise<void> {
    await this.#serial(async () => {
      const saved = await this.#store.load();
      if (!saved) {
        this.#session = undefined;
        this.#jar = undefined;
        this.#status = this.#status.state === "expired" ? this.#status : { state: "signed_out" };
        return;
      }
      if (saved.signedInAt !== this.#session?.signedInAt) this.#jar = new CookieJar(saved.cookies);
      this.#session = saved;
      this.#status = { ...this.#fromSession(saved), state: "signed_in" };
      await this.#endIfOver();
    });
  }

  /** One keep-alive round: drop the session past its length, else call Pluxee. */
  async tick(): Promise<void> {
    await this.#serial(() => this.#endIfOver());
    if (!this.#session) return;
    try {
      await this.check();
      this.#status = { ...this.#status, lastCheckedAt: new Date(this.#now()).toISOString() };
      delete this.#status.lastError;
    } catch (err) {
      if (err instanceof SessionRefused) {
        await this.lost(err.message);
        return;
      }
      // A network error: keep the session and try again on the next round.
      const message = err instanceof Error ? err.message : String(err);
      this.#status = { ...this.#status, lastError: message };
      this.#log(`session check failed, will retry: ${message}`);
    }
  }

  /** The cookies to call Pluxee with. Throws SignInRequired when there are none. */
  async jar(): Promise<CookieJar> {
    if (!this.#session) await this.reload();
    await this.#serial(() => this.#endIfOver());
    if (!this.#session || !this.#jar) throw new SignInRequired(this.signInHint);
    return this.#jar;
  }

  /** Keeps what the last renewal got, for the status. */
  renewed(result: RenewResult): void {
    this.#status = { ...this.#status, lastRenewal: result };
    this.#log(result.renewed ? `renewed the token until ${result.tokenExpiresAt}` : `could not renew the token: ${JSON.stringify(result.attempts)}`);
  }

  /** Pluxee set new cookies: save them so a restart has them. */
  async cookiesChanged(): Promise<void> {
    await this.#serial(async () => {
      if (!this.#session || !this.#jar) return;
      this.#session = { ...this.#session, cookies: this.#jar.list() };
      await this.#store.save(this.#session);
      this.#status = { ...this.#status, lastRenewedAt: new Date(this.#now()).toISOString() };
    });
  }

  async signOut(): Promise<void> {
    await this.#serial(async () => {
      this.#session = undefined;
      this.#jar = undefined;
      await this.#store.clear();
      this.#status = { state: "signed_out" };
      this.#log("signed out");
    });
  }

  /** Pluxee refused the cookies: forget the session. */
  async lost(reason: string): Promise<void> {
    await this.#serial(() => this.#drop(reason));
  }

  async #drop(reason: string): Promise<void> {
    if (!this.#session) return;
    const { signedInAt } = this.#session;
    const { lastCheckedAt, lastRenewedAt, lastRenewal } = this.#status;
    const cookies = this.#jar ? cookieSummary(this.#jar.list()) : undefined;
    this.#session = undefined;
    this.#jar = undefined;
    await this.#store.clear();
    // What the session looked like when it ended, to tell why it did.
    this.#status = {
      state: "expired",
      signedInAt,
      endedAt: new Date(this.#now()).toISOString(),
      lastError: reason,
      ...(lastCheckedAt ? { lastCheckedAt } : {}),
      ...(lastRenewedAt ? { lastRenewedAt } : {}),
      ...(lastRenewal ? { lastRenewal } : {}),
      ...(cookies ? { cookies } : {}),
    };
    this.#log(reason === LENGTH_ENDED ? "the session reached its time limit; signed out" : `Pluxee ended the session: ${reason}`);
  }

  #fromSession(session: SavedSession): KeeperStatus {
    return {
      state: "signed_in",
      signedInAt: session.signedInAt,
      ...(session.endsAt ? { endsAt: new Date(session.endsAt).toISOString() } : {}),
      ...(this.#status.lastCheckedAt ? { lastCheckedAt: this.#status.lastCheckedAt } : {}),
    };
  }

  async #endIfOver(): Promise<void> {
    const endsAt = this.#session?.endsAt;
    if (endsAt !== undefined && this.#now() >= endsAt) await this.#drop(LENGTH_ENDED);
  }

  /** Saves, reloads and sign-outs never overlap. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#busy.then(fn, fn);
    this.#busy = run.catch(() => undefined);
    return run;
  }
}
