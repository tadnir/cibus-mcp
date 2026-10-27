/**
 * Buying a voucher (a store's gift card or a Cibus voucher) with the card and
 * getting its code, the way the web app does it: the voucher goes in the
 * cart as a pickup order, prx_simulate_order prices it, prx_apply_order buys
 * it, and its barcode then shows in "My Vouchers".
 *
 * Buying charges the card, so it takes two calls: quote() puts the voucher in
 * the cart and prices it without buying, and hands back a token; buy() with
 * that token, after the user said yes, places the order.
 */
import { randomBytes } from "node:crypto";
import { CibusApiError, ORDER_TYPES, orderTime, legacyDate, type Json, type PluxeeApi } from "./api.js";

/** The voucher plate of the web app's restaurant list. */
export const VOUCHER_CATEGORY_ID = 10300560;
/** A quote is good for this long. */
export const QUOTE_TTL_MS = 10 * 60_000;

export interface MenuDish {
  category_id: number;
  category?: string;
  dish_id: number;
  name?: string;
  description?: string;
  price: number;
  /** The dish has options to pick (not supported for buying here). */
  has_options: boolean;
}

/** The menu tree as a flat list: categories hold their dishes under "13", as the web app reads them. */
export function flattenMenu(tree: Json[]): MenuDish[] {
  const out: MenuDish[] = [];
  for (const category of tree) {
    const dishes = (category["13"] ?? category.dishes ?? category.children) as Json[] | undefined;
    if (!Array.isArray(dishes)) continue;
    for (const dish of dishes) {
      const dishId = Number(dish.element_id);
      if (!Number.isFinite(dishId)) continue;
      out.push({
        category_id: Number(category.element_id),
        ...(text(category.name) ? { category: text(category.name) } : {}),
        dish_id: dishId,
        ...(text(dish.name) ? { name: text(dish.name) } : {}),
        ...(text(dish.desc ?? dish.description) ? { description: text(dish.desc ?? dish.description) } : {}),
        price: Number(dish.price ?? 0),
        has_options: Number(dish.child_count ?? 0) > 0,
      });
    }
  }
  return out;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** The kitchen types the voucher plate stands for, from the app's settings. */
export function voucherKitchenTypes(init: Json): Set<number> {
  const categories = ((init.types as Json | undefined)?.kitchen_categories ?? []) as Json[];
  const plate = categories.find((c) => Number(c.id) === VOUCHER_CATEGORY_ID);
  return new Set(((plate?.kitchen_types ?? []) as unknown[]).map(Number));
}

/** Whether a restaurant from the list sells vouchers. */
export function sellsVouchers(rest: Json, kitchenTypes: Set<number>): boolean {
  if (Number(rest.is_barcode) === 1) return true;
  const types = [rest.kitchen_type, ...((rest.food_types as unknown[] | undefined) ?? [])].map(Number);
  return types.some((t) => kitchenTypes.has(t));
}

interface Quote {
  token: string;
  restaurantId: number;
  dishId: number;
  price: number;
  at: number;
}

export interface QuoteArgs {
  restaurantId: number;
  dishId: number;
  /** Empty a cart that holds something else first. */
  clearCart: boolean;
}

export class VoucherBuyer {
  readonly #api: PluxeeApi;
  readonly #now: () => number;
  readonly #pollMs: number;
  readonly #quotes = new Map<string, Quote>();

  constructor(api: PluxeeApi, options: { now?: () => number; pollMs?: number } = {}) {
    this.#api = api;
    this.#now = options.now ?? Date.now;
    this.#pollMs = options.pollMs ?? 3_000;
  }

  /** Puts the voucher in the cart and prices it. Charges nothing. */
  async quote(args: QuoteArgs): Promise<Json> {
    const dishes = flattenMenu(await this.#api.menu(args.restaurantId, ORDER_TYPES.pickup));
    const dish = dishes.find((d) => d.dish_id === args.dishId);
    if (!dish) throw new CibusApiError("That item is not on this store's voucher menu. Read the menu with get_menu (order_type pickup) first.");
    if (dish.has_options) throw new CibusApiError("That item has options to pick, which this server can't buy. Buy it in the Cibus app.");

    const before = cartItems(await this.#api.cart());
    // A quote again for the same voucher finds it in the cart already.
    const already = before.length === 1 && Number(before[0]!.dish_id) === dish.dish_id && Number(before[0]!.amount ?? 1) === 1;
    if (before.length && !already) {
      if (!args.clearCart) throw new CibusApiError("The Cibus cart already holds other items. Ask the user whether to empty it, then call again with clear_cart true.");
      await this.#api.clearCart();
    }
    if (!already) await this.#api.addToCart(ORDER_TYPES.pickup, { categoryId: dish.category_id, dishId: dish.dish_id, price: dish.price });

    const cart = await this.#api.cart();
    const items = cartItems(cart);
    if (items.length !== 1 || Number(items[0]!.dish_id) !== dish.dish_id) throw new CibusApiError("Pluxee did not put the voucher in the cart.");
    const simulated = await this.#api.simulateOrder(orderTime(Number(cart.oper_time)));

    const token = randomBytes(9).toString("base64url");
    this.#quotes.set(token, { token, restaurantId: args.restaurantId, dishId: dish.dish_id, price: dish.price, at: this.#now() });
    return {
      confirm_token: token,
      voucher: { restaurant_id: args.restaurantId, ...dish },
      charge: summary(simulated),
      message:
        "Nothing is charged yet; the voucher is in the Cibus cart. Show the user the voucher and its price and ask whether to buy it. " +
        "Only after a clear yes, call buy_voucher again with this confirm_token. It expires in 10 minutes.",
    };
  }

  /** Buys the quoted voucher and returns its code once Pluxee has it. */
  async buy(token: string): Promise<Json> {
    const quote = this.#quotes.get(token);
    if (!quote || this.#now() - quote.at > QUOTE_TTL_MS) {
      this.#quotes.delete(token);
      throw new CibusApiError("That confirm_token is unknown or expired. Call buy_voucher without it to get a new quote.");
    }
    const cart = await this.#api.cart();
    const items = cartItems(cart);
    if (items.length !== 1 || Number(items[0]!.dish_id) !== quote.dishId || Number(items[0]!.amount ?? 1) !== 1) {
      throw new CibusApiError("The Cibus cart changed since the quote. Call buy_voucher without a token to quote again.");
    }
    this.#quotes.delete(token);
    const known = new Set((await this.#api.vouchers()).map((v) => String(v.id)));
    const applied = await this.#api.applyOrder(orderTime(Number(cart.oper_time)));
    const deal = ((applied.list as Json[] | undefined) ?? [])[0];
    const dealId = Number(deal?.deal_id ?? 0);
    if (!(dealId > 0)) throw new CibusApiError(`Pluxee did not place the order${typeof applied.msg === "string" ? `: ${applied.msg}` : ""}.`);

    // The code shows up in "My Vouchers" (and the order's voucher_code) once the store issued it.
    for (let attempt = 0; attempt < 10; attempt++) {
      const fresh = (await this.#api.vouchers()).filter((v) => !known.has(String(v.id)));
      if (fresh.length) return { bought: true, deal_id: dealId, vouchers: fresh.map(describeVoucher) };
      const today = legacyDate(new Date(this.#now()).toISOString().slice(0, 10));
      const order = (await this.#api.orders(today, today)).find((o) => String(o.deal_id) === String(dealId));
      if (typeof order?.voucher_code === "string" && order.voucher_code) return { bought: true, deal_id: dealId, voucher_code: order.voucher_code };
      if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, this.#pollMs));
    }
    return {
      bought: true,
      deal_id: dealId,
      message: "The voucher was bought, but Pluxee has not shown its code yet. Call list_vouchers in a few minutes.",
    };
  }
}

function cartItems(cart: Json): Json[] {
  return Array.isArray(cart.dish_list) ? (cart.dish_list as Json[]) : [];
}

/** What a simulated order says it will charge. */
function summary(simulated: Json): Json {
  const first = ((simulated.list as Json[] | undefined) ?? [])[0] ?? {};
  const out: Json = {};
  for (const [k, v] of Object.entries(first)) if (v !== null && v !== "" && typeof v !== "object") out[k] = v;
  return out;
}

/** One entry of "My Vouchers", with its code. */
export function describeVoucher(v: Json): Json {
  const rest = (v.restaurantInfo as Json | undefined) ?? {};
  const out: Json = {
    id: v.id,
    ...(text(rest.name) ? { business: text(rest.name) } : {}),
    code: v.barcode ?? null,
    amount: v.amount,
    ...(v.currentAmount !== undefined ? { remaining: v.currentAmount } : {}),
    ...(v.purchaseDate ? { purchased: v.purchaseDate } : {}),
    ...(v.expirationDate ? { expires: v.expirationDate } : {}),
    active: Boolean(v.isActive),
    ...(v.status !== undefined ? { status: v.status } : {}),
  };
  // Some stores keep the code on their own site; this link checks it there.
  if (!v.isStoredBarcode && typeof v.barcodeUrl === "string" && v.barcodeUrl) out.check_url = v.barcodeUrl;
  return out;
}
