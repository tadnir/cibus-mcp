/**
 * The Pluxee (Cibus) consumer APIs, as the consumers.pluxee.co.il web app
 * calls them.
 *
 * Two backends share the session's cookies:
 *   - the legacy one, api.consumers.pluxee.co.il/api: main.py takes a JSON body
 *     whose "type" names the call and always answers HTTP 200, with the real
 *     status in "code" (0 is success, 172-179 mean signed out); a few reads are
 *     GET <name>.py;
 *   - CAPIR, api.capir.pluxee.co.il: plain REST (sign-in, vouchers).
 */
import type { CookieJar } from "./cookies.js";

export type Fetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export const SITE_ORIGIN = "https://consumers.pluxee.co.il";
export const API_DOMAIN = process.env.CIBUS_API_DOMAIN || "https://api.consumers.pluxee.co.il/api";
export const CAPIR_BASE_URL = process.env.CIBUS_CAPIR_BASE_URL || "https://api.capir.pluxee.co.il";
/** The web app's public application id; the same for everyone. */
export const APPLICATION_ID = "E5D5FEF5-A05E-4C64-AEBA-BA0CECA0E402";

/** The codes the web app treats as "signed out" (177 is "Can't find cookie token"). */
const SIGNED_OUT_CODES = new Set([172, 173, 174, 175, 176, 177, 178, 179]);

export function apiHeaders(lang = "he"): Record<string, string> {
  return {
    // The headers the web app's own requests send.
    accept: "application/json, text/plain, */*",
    "content-type": "application/json",
    "accept-language": lang,
    "application-id": APPLICATION_ID,
    origin: SITE_ORIGIN,
    referer: `${SITE_ORIGIN}/`,
  };
}

export class CibusApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "CibusApiError";
  }
}

/** Pluxee refused the cookies: the session is over. */
export class Unauthorized extends CibusApiError {
  constructor() {
    super("Pluxee ended the session.", 401);
    this.name = "Unauthorized";
  }
}

export type Json = Record<string, unknown>;

/** One menu item as the cart takes it. */
export interface CartItem {
  categoryId: number;
  dishId: number;
  price: number;
}

/** Where the sign-in leaves orders and lookups: the user's company and address. */
export interface UserContext {
  companyId?: number;
  addressId?: number;
}

/** The web app's order types: 0 sit in, 1 delivery, 2 pickup (also vouchers). */
export const ORDER_TYPES = { sit: 0, delivery: 1, pickup: 2 } as const;
export type OrderTypeName = keyof typeof ORDER_TYPES;

export class PluxeeApi {
  readonly #jar: () => Promise<CookieJar>;
  readonly #changed: () => Promise<void>;
  readonly #fetch: Fetch;
  lang = "he";

  /**
   * jar returns the live session's cookies (throwing when there is none);
   * changed is called after an API set new ones, so they can be saved.
   */
  constructor(jar: () => Promise<CookieJar>, changed: () => Promise<void>, f: Fetch = fetch) {
    this.#jar = jar;
    this.#changed = changed;
    this.#fetch = f;
  }

  /** Throws once the session is gone: a small data call the web app makes on every page. */
  async ping(): Promise<void> {
    await this.budgets();
  }

  async logout(): Promise<void> {
    await this.main("prx_logout");
  }

  /** The user's profile: name, company, addresses, budget and balance for the cycle. */
  async userInfo(): Promise<Json> {
    const info = await this.get("prx_user_info.py", { version: "0" });
    checkCode(info, "prx_user_info");
    return info;
  }

  async context(): Promise<UserContext> {
    const info = await this.userInfo();
    const companyId = firstNumber(info, ["comp_id", "company_id"]);
    const addressId = firstNumber(info, ["default_addr_id", "biz_addr_id", "private_addr_id"], (n) => n > 0);
    return { ...(companyId ? { companyId } : {}), ...(addressId ? { addressId } : {}) };
  }

  /** The budgets the balance is made of; the web app's credit is the sum of CurrBudget. */
  async budgets(): Promise<Json[]> {
    return list(await this.main("prx_get_budgets"), "data");
  }

  /** Orders and charges between two days, dd/MM/yyyy. Vouchers carry their code in voucher_code. */
  async orders(from: string, to: string): Promise<Json[]> {
    return list(await this.main("prx_user_deals", { from_date: from, to_date: to }), "list");
  }

  async dealInfo(dealId: string): Promise<Json> {
    return this.main("get_deal_info", { deal_id: dealId });
  }

  /** The app's settings, with the kitchen categories the restaurant filters use. */
  async init(): Promise<Json> {
    const res = await this.main("init");
    return (res.init_cfg_dict as Json | undefined) ?? {};
  }

  /** Restaurants around the user's default address that take this order type. */
  async restaurants(orderType: number, addressId?: number): Promise<Json[]> {
    const addr = addressId ?? (await this.context()).addressId ?? 0;
    const scan = await this.main("rest_scan", { addr_id: addr, order_type: orderType, radius: 9000, get_hash: true, has_15mins_grace: 0 });
    const hash = scan.hash;
    if (typeof hash !== "string" || !hash) throw new CibusApiError("Pluxee returned no restaurant list for this address.");
    return list(await this.get("rest_scan.py", { hash, lang: this.lang }), "list");
  }

  /** One restaurant's menu tree: categories, their dishes ("13") and the dishes' options. */
  async menu(restaurantId: number, orderType: number): Promise<Json[]> {
    const { companyId, addressId } = await this.context();
    const tree = await this.get("rest_menu_tree.py", {
      restaurant_id: String(restaurantId),
      comp_id: String(companyId ?? 0),
      order_type: String(orderType),
      element_type_deep: "16",
      lang: this.lang,
      address_id: String(addressId ?? 0),
    });
    if (Array.isArray(tree)) return tree as Json[];
    checkCode(tree, "rest_menu_tree");
    return list(tree, "menu");
  }

  /** The vouchers bought with the card ("My Vouchers"), with their barcodes. */
  async vouchers(): Promise<Json[]> {
    const res = (await this.capir("GET", "/vouchers")) as Json;
    return list((res.data as Json | undefined) ?? {}, "vouchers");
  }

  /** Has Pluxee send one voucher's details to the user's own phone or email. Returns the HTTP status. */
  async sendVoucherDetails(voucherId: string): Promise<number> {
    const res = await this.#request(new URL(`${CAPIR_BASE_URL}/vouchers/${encodeURIComponent(voucherId)}`), { method: "POST", body: "{}" });
    return res.status;
  }

  async cart(): Promise<Json> {
    return this.main("prx_get_cart");
  }

  async clearCart(): Promise<void> {
    await this.main("prx_del_cart");
  }

  async addToCart(orderType: number, item: CartItem): Promise<void> {
    await this.main("prx_add_prod_to_cart", {
      order_type: String(orderType),
      dish_list: { category_id: item.categoryId, dish_id: item.dishId, dish_price: item.price, co_owner_id: -1, extra_list: [] },
    });
  }

  /** What the order in the cart would charge, without placing it. */
  async simulateOrder(orderTime: string): Promise<Json> {
    return this.main("prx_simulate_order", { order_time: orderTime });
  }

  /** Places the order in the cart and charges the card. */
  async applyOrder(orderTime: string): Promise<Json> {
    return this.main("prx_apply_order", { order_time: orderTime });
  }

  async main(type: string, body: Json = {}): Promise<Json> {
    const res = await this.#request(new URL(`${API_DOMAIN}/main.py`), { method: "POST", body: JSON.stringify({ ...body, type }) });
    const json = (await res.json()) as Json;
    checkCode(json, type);
    return json;
  }

  async get(name: string, params: Record<string, string>): Promise<Json> {
    const url = new URL(`${API_DOMAIN}/${name}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await this.#request(url, { method: "GET" });
    return (await res.json()) as Json;
  }

  async capir(method: string, path: string, body?: Json): Promise<unknown> {
    const res = await this.#request(new URL(`${CAPIR_BASE_URL}${path}`), { method, ...(body ? { body: JSON.stringify(body) } : {}) });
    return res.json();
  }

  async #request(url: URL, init: RequestInit): Promise<Response> {
    const jar = await this.#jar();
    const res = await this.#fetch(url, {
      ...init,
      headers: { ...apiHeaders(this.lang), ...(init.headers as Record<string, string> | undefined), cookie: jar.header() },
    });
    if (jar.update(res)) await this.#changed();
    if (res.status === 401) throw new Unauthorized();
    if (!res.ok && !(init.method === "POST" && url.pathname.startsWith("/vouchers/"))) {
      throw new CibusApiError(`Pluxee answered HTTP ${res.status}.`, res.status);
    }
    return res;
  }
}

/** main.py's real status is in the body. */
export function checkCode(json: Json, type: string): void {
  const code = Number(json.code ?? 0);
  if (!code) return;
  if (SIGNED_OUT_CODES.has(code)) throw new Unauthorized();
  const msg = typeof json.msg === "string" && json.msg ? json.msg : "no message";
  throw new CibusApiError(`Pluxee refused ${type}: ${msg} (code ${code}).`);
}

function list(json: Json, key: string): Json[] {
  const value = json[key];
  return Array.isArray(value) ? (value as Json[]) : [];
}

function firstNumber(info: Json, keys: string[], ok: (n: number) => boolean = () => true): number | undefined {
  for (const key of keys) {
    const n = Number(info[key]);
    if (Number.isFinite(n) && n !== 0 && ok(n)) return n;
  }
  return undefined;
}

/** dd/MM/yyyy, as main.py takes dates, from yyyy-MM-dd. */
export function legacyDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** HH:mm in Israel, as the web app sends an order's time, from the cart's epoch seconds. */
export function orderTime(epochSeconds: number | undefined, now = Date.now()): string {
  const at = epochSeconds && epochSeconds > 0 ? epochSeconds * 1000 : now;
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}
