import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ORDER_TYPES, Unauthorized, legacyDate, type Json } from "./api.js";
import type { SessionManager } from "./session.js";
import { VoucherBuyer, describeVoucher, flattenMenu, sellsVouchers, voucherKitchenTypes } from "./vouchers.js";

export const VERSION = "0.1.0";

const INSTRUCTIONS = [
  "Unofficial client of the user's own Cibus (סיבוס) meal card, run by Pluxee Israel. Unaffiliated with Pluxee.",
  "Reading: get_balance, list_orders, list_restaurants → get_menu, list_vouchers (the codes of vouchers already bought).",
  "Getting a code: list_voucher_shops → get_menu with order_type pickup → buy_voucher. buy_voucher charges the card, so it works in two calls: the first only quotes; show the user the voucher and its price, and call it again with the confirm_token only after the user clearly says yes. Never buy without that yes, and never buy more than the user asked for.",
  "send_voucher_details has Pluxee send a voucher's details to the user's own phone or email.",
  "When a tool says the user must sign in, call cibus_login and give the user the link it returns; the user signs in on that page (email or mobile number and a one-time code). Never ask for these in the chat.",
  "Amounts are in shekels. Keep Hebrew names as Pluxee gives them.",
].join(" ");

const ORDER_TYPE_NAMES = ["delivery", "pickup", "sit"] as const;
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().regex(/^\d{1,12}$/);

const schemas = {
  empty: z.object({}),
  orders: z.object({
    from: isoDay.describe("First day, yyyy-MM-dd."),
    to: isoDay.describe("Last day, yyyy-MM-dd."),
  }),
  restaurants: z.object({
    order_type: z.enum(ORDER_TYPE_NAMES).default("delivery").describe("delivery, pickup (also where vouchers are) or sit (eat in)."),
    search: z.string().max(60).optional().describe("Only restaurants whose name contains this text."),
    limit: z.string().regex(/^\d{1,3}$/).default("50").describe("At most this many, default 50."),
  }),
  shops: z.object({
    search: z.string().max(60).optional().describe("Only stores whose name contains this text."),
  }),
  menu: z.object({
    restaurant_id: id.describe("restaurant_id from list_restaurants or list_voucher_shops."),
    order_type: z.enum(ORDER_TYPE_NAMES).default("delivery").describe("The order type the restaurant was listed under; pickup for vouchers."),
  }),
  vouchers: z.object({
    state: z.enum(["active", "all"]).default("active").describe("active: only vouchers that can still be used."),
  }),
  send: z.object({
    voucher_id: z.string().regex(/^[\w-]{1,64}$/).describe("id from list_vouchers."),
  }),
  buy: z.object({
    restaurant_id: id.describe("The store, from list_voucher_shops."),
    dish_id: id.describe("The voucher, from get_menu with order_type pickup."),
    clear_cart: z.enum(["true", "false"]).default("false").describe("true empties a Cibus cart that holds something else first; ask the user before."),
    confirm_token: z.string().regex(/^[\w-]{6,40}$/).optional().describe("From the quote, only after the user said yes to buying."),
  }),
};

function inputSchema(schema: z.ZodObject<z.ZodRawShape>): Tool["inputSchema"] {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    const field = value as z.ZodTypeAny;
    let inner = field;
    while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) inner = inner._def.innerType;
    properties[key] = {
      type: "string",
      ...(field.description ? { description: field.description } : {}),
      ...(inner instanceof z.ZodEnum ? { enum: inner.options } : {}),
    };
    if (!field.isOptional()) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

const TOOLS: { name: string; description: string; schema: z.ZodObject<z.ZodRawShape> }[] = [
  { name: "cibus_login", description: "Get the link where the user signs in to Cibus (email or mobile number and a one-time code are typed on that page, never in the chat). Returns the status when already signed in.", schema: schemas.empty },
  { name: "cibus_session_status", description: "Whether this server is signed in to Cibus, since when, until when, and the sign-in link when it is not.", schema: schemas.empty },
  {
    name: "cibus_renew_session",
    description: "Renew the Cibus session's 24-hour token now, as the keep-alive does when it is close to expiring. Reports what Pluxee answered to each try, never token values.",
    schema: schemas.empty,
  },
  { name: "cibus_logout", description: "Sign out of Cibus here: end the session and forget it.", schema: schemas.empty },
  { name: "get_balance", description: "The card's balance now (the sum of its budgets, as the Cibus app shows it), and the budgets it is made of.", schema: schemas.empty },
  { name: "list_orders", description: "Orders and charges on the card between two days, newest first, with each voucher's code (voucher_code).", schema: schemas.orders },
  { name: "list_restaurants", description: "Restaurants that take the card around the user's default address, for one order type.", schema: schemas.restaurants },
  { name: "get_menu", description: "One restaurant's or store's menu as a flat list: category_id, dish_id, name, price.", schema: schemas.menu },
  { name: "list_vouchers", description: "The vouchers bought with the card (\"My Vouchers\"), with each one's code, amount, remaining amount and expiry.", schema: schemas.vouchers },
  { name: "send_voucher_details", description: "Have Pluxee send one voucher's details to the user's own phone or email, as the Cibus app's \"send me the details\" does.", schema: schemas.send },
  { name: "list_voucher_shops", description: "The stores that sell vouchers (gift cards) for the card, for buy_voucher.", schema: schemas.shops },
  {
    name: "buy_voucher",
    description:
      "Get a voucher code: buy one voucher from a store with the card. CHARGES THE CARD. Without confirm_token it only puts the voucher in the cart and returns its price and a confirm_token; with the token, which you pass only after the user clearly agreed to that voucher and price, it buys it and returns the code.",
    schema: schemas.buy,
  },
];

function contains(value: unknown, search: string | undefined): boolean {
  return !search || (typeof value === "string" && value.toLowerCase().includes(search.trim().toLowerCase()));
}

/** A restaurant entry without the fields only the web app's layout uses. */
function describeRestaurant(r: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    if (/img|image|logo|banner|pic|color|icon/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

export function createMcpServer(session: SessionManager): Server {
  const api = session.api;
  const buyer = new VoucherBuyer(api);
  const server = new Server({ name: "cibus-mcp", version: VERSION }, { instructions: INSTRUCTIONS, capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t.schema) })),
  }));

  async function call(name: string, raw: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "cibus_login": {
        const status = await session.status();
        if (status.state === "signed_in") return { ...status, message: "Already signed in." };
        return { ...status, message: `Ask the user to open ${status.signInUrl} and sign in there, then try the request again.` };
      }
      case "cibus_session_status":
        return session.status();
      case "cibus_renew_session":
        return session.renew();
      case "cibus_logout":
        if (session.keeper.status().state === "signed_in") await api.logout().catch(() => undefined);
        await session.keeper.signOut();
        return { state: "signed_out", message: "Signed out; the saved session is gone." };
      case "get_balance": {
        const budgets = await api.budgets();
        const balance = budgets.reduce((sum, b) => sum + (Number(b.CurrBudget) || 0), 0);
        return { balance: Math.round(balance * 100) / 100, currency: "ILS", budgets };
      }
      case "list_orders": {
        const args = schemas.orders.parse(raw);
        const orders = await api.orders(legacyDate(args.from), legacyDate(args.to));
        return { count: orders.length, orders };
      }
      case "list_restaurants": {
        const args = schemas.restaurants.parse(raw);
        const all = await api.restaurants(ORDER_TYPES[args.order_type]);
        const found = all.filter((r) => contains(r.name, args.search));
        return { count: found.length, restaurants: found.slice(0, Number(args.limit)).map(describeRestaurant) };
      }
      case "list_voucher_shops": {
        const args = schemas.shops.parse(raw);
        const [init, all] = await Promise.all([api.init(), api.restaurants(ORDER_TYPES.pickup)]);
        const types = voucherKitchenTypes(init);
        const shops = all.filter((r) => sellsVouchers(r, types) && contains(r.name, args.search));
        return { count: shops.length, shops: shops.map(describeRestaurant) };
      }
      case "get_menu": {
        const args = schemas.menu.parse(raw);
        const dishes = flattenMenu(await api.menu(Number(args.restaurant_id), ORDER_TYPES[args.order_type]));
        return { count: dishes.length, dishes };
      }
      case "list_vouchers": {
        const args = schemas.vouchers.parse(raw);
        const vouchers = (await api.vouchers()).map(describeVoucher).filter((v) => args.state === "all" || v.active);
        return { count: vouchers.length, vouchers };
      }
      case "send_voucher_details": {
        const args = schemas.send.parse(raw);
        const status = await api.sendVoucherDetails(args.voucher_id);
        if (status >= 200 && status < 300) return { sent: true, message: "Pluxee sent the voucher's details to the user's phone or email." };
        if (status === 403) return { sent: false, message: "Pluxee sent these details a moment ago; it allows another send after a short wait." };
        if (status === 422) return { sent: false, message: "Pluxee could not send them: the account's phone or email is missing or invalid." };
        return { sent: false, message: `Pluxee answered HTTP ${status}.` };
      }
      case "buy_voucher": {
        const args = schemas.buy.parse(raw);
        if (args.confirm_token) return buyer.buy(args.confirm_token);
        return buyer.quote({ restaurantId: Number(args.restaurant_id), dishId: Number(args.dish_id), clearCart: args.clear_cart === "true" });
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await call(request.params.name, request.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      // A signed-out code inside an HTTP 200 answer ends the session too.
      const error = err instanceof Unauthorized ? await session.signedOut() : err;
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "tool failed" }] };
    }
  });

  return server;
}
