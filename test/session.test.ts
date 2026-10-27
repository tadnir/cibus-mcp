import { afterEach, describe, expect, test } from "vitest";
import { request } from "node:http";
import { legacyDate, orderTime } from "../src/api.js";
import { normalizeFirst } from "../src/login.js";
import { SessionManager } from "../src/session.js";
import { createMcpServer } from "../src/server.js";
import { fakeBrowser, fakeFetch, json, memoryStore, type Call, type FakeBrowser } from "./helpers.js";

/** Made-up data in Pluxee's shapes. */
const RESTAURANTS = [
  { restaurant_id: 101, name: "Example Burger", kitchen_type: 1, logo: "x.png", is_open: 1 },
  { restaurant_id: 202, name: "Example Market vouchers", kitchen_type: 300574, is_open: 1 },
  { restaurant_id: 303, name: "Example Books", kitchen_type: 5, is_barcode: 1 },
];
const MENU = [
  {
    element_id: 7,
    name: "Vouchers",
    "13": [
      { element_id: 71, name: "Voucher 50", price: 50, child_count: 0 },
      { element_id: 72, name: "Voucher with options", price: 80, child_count: 2 },
    ],
  },
];
const OLD_VOUCHER = { id: "v1", barcode: "1111222233334444", amount: 100, currentAmount: 40, isActive: true, isStoredBarcode: true, expirationDate: "2030-01-01 00:00:00", restaurantInfo: { name: "Example Market" } };
const USED_VOUCHER = { id: "v0", barcode: "9999", amount: 50, currentAmount: 0, isActive: false, isStoredBarcode: false, barcodeUrl: "https://store.example/check" };

/** One Pluxee account, with a cart and vouchers; the session cookie is token=t1. */
function world() {
  let cart: Record<string, unknown>[] = [];
  let vouchers: Record<string, unknown>[] = [OLD_VOUCHER, USED_VOUCHER];
  const f = fakeFetch((call: Call) => {
    const url = new URL(call.url);
    const signedIn = call.headers.cookie === "token=t1";
    if (url.host === "api.capir.pluxee.co.il") {
      if (!signedIn) return json({ status: 401 }, 401);
      if (url.pathname === "/vouchers" && call.method === "GET") return json({ data: { vouchers } });
      if (url.pathname === "/vouchers/v1") return new Response(null, { status: 204 });
      if (url.pathname === "/vouchers/v0") return new Response(null, { status: 403 });
      return undefined;
    }
    if (!signedIn) return json({ code: 177, msg: "Can't find cookie token" });
    if (url.pathname === "/api/prx_user_info.py") return json({ company_id: 11, default_addr_id: 22, budget: 1000 });
    if (url.pathname === "/api/rest_scan.py" && url.searchParams.get("hash") === "h1") return json({ list: RESTAURANTS });
    if (url.pathname === "/api/rest_menu_tree.py") return json(MENU);
    if (url.pathname !== "/api/main.py") return undefined;
    const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>;
    switch (body.type) {
      case "prx_get_budgets":
        return json({ code: 0, data: [{ CurrBudget: "100.50" }, { CurrBudget: 20 }] }, 200, { "set-cookie": "token=t1; Path=/; HttpOnly" });
      case "prx_user_deals":
        return json({ code: 0, list: [{ deal_id: 5, rest_name: "Example Burger", voucher_code: "" }] });
      case "rest_scan":
        return json({ code: 0, hash: "h1" });
      case "init":
        return json({ code: 0, init_cfg_dict: { types: { kitchen_categories: [{ id: 10300560, kitchen_types: [300574] }] } } });
      case "prx_get_cart":
        return json({ code: 0, order_type: 2, oper_time: 1_800_000_000, dish_list: cart });
      case "prx_del_cart":
        cart = [];
        return json({ code: 0, msg: "OK" });
      case "prx_add_prod_to_cart": {
        const dish = body.dish_list as Record<string, unknown>;
        cart = [...cart, { dish_id: dish.dish_id, amount: 1, restaurant_id: 202 }];
        return json({ code: 0, msg: "OK" });
      }
      case "prx_simulate_order":
        return json({ code: 0, list: [{ otl_price: 50, price: 50, nested: { x: 1 } }] });
      case "prx_apply_order":
        cart = [];
        vouchers = [...vouchers, { id: "v2", barcode: "5555666677778888", amount: 50, currentAmount: 50, isActive: true, isStoredBarcode: true, restaurantInfo: { name: "Example Market" } }];
        return json({ code: 0, list: [{ deal_id: 999 }] });
      case "prx_logout":
        return json({ code: 0, msg: "OK" });
      default:
        return json({ code: 1, msg: "unknown type" });
    }
  });
  return { f, putInCart: (item: Record<string, unknown>) => (cart = [...cart, item]) };
}

function http(port: number, method: string, path: string, body?: string, host = `127.0.0.1:${port}`) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host, "content-type": "application/x-www-form-urlencoded" } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode!, text: t }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

let session: SessionManager | undefined;
afterEach(() => session?.stop());

async function signedOutSession(needsSecond = false) {
  const browsers: FakeBrowser[] = [];
  const w = world();
  session = new SessionManager({
    store: memoryStore(),
    fetch: w.f,
    port: 0,
    stepWaitMs: 50,
    openBrowser: async () => {
      const b = fakeBrowser({ needsSecond });
      browsers.push(b);
      return b;
    },
  });
  await session.start();
  const url = await session.signInUrl();
  return { ...w, session, browsers, port: Number(new URL(url).port) };
}

async function signedInSession() {
  const s = await signedOutSession();
  await s.session.keeper.signedIn([{ name: "token", value: "t1" }], 3_600_000);
  return s;
}

const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]+)"/.exec(html)![1]!;

async function callTool(server: ReturnType<typeof createMcpServer>, name: string, args: Record<string, unknown> = {}) {
  const handler = (server as unknown as { _requestHandlers: Map<string, (r: unknown, x: unknown) => Promise<unknown>> })._requestHandlers.get("tools/call")!;
  return (await handler({ method: "tools/call", params: { name, arguments: args } }, {})) as { isError?: boolean; content: { text: string }[] };
}

async function toolJson(server: ReturnType<typeof createMcpServer>, name: string, args: Record<string, unknown> = {}) {
  const result = await callTool(server, name, args);
  if (result.isError) throw new Error(result.content[0]!.text);
  return JSON.parse(result.content[0]!.text);
}

describe("sign-in page", () => {
  test("email or phone, then code, then signed in; each step gets its own reCAPTCHA token", async () => {
    const { session, browsers, port } = await signedOutSession();
    const first = await http(port, "GET", "/");
    expect(first.text).toContain("Send code");
    const csrf = csrfOf(first.text);

    expect((await http(port, "POST", "/start", `csrf=${csrf}&first=050-000-0000&length=1d`)).status).toBe(303);
    const browser = browsers[0]!;
    expect(browser.posts[0]).toEqual({
      url: "https://api.capir.pluxee.co.il/auth/sendOTP",
      body: { userInput1: "0500000000", userInput2: "", reCAPTCHAToken: "token-1", call: false },
    });
    const codePage = (await http(port, "GET", "/")).text;
    expect(codePage).toContain("Enter the code");
    expect(codePage).toContain("05*-***-**00");

    expect((await http(port, "POST", "/code", `csrf=${csrf}&code=000000`)).status).toBe(303);
    expect((await http(port, "GET", "/")).text).toContain("Wrong code");
    expect((await http(port, "POST", "/code", `csrf=${csrf}&code=123456`)).status).toBe(303);
    expect(browser.posts[2]!.body).toMatchObject({ otpPin: "123456", userInput1: "0500000000", reCAPTCHAToken: "token-3", trustDevice: true });
    expect(browser.actions).toEqual(["verifyUser", "loginOtp", "loginOtp"]);
    expect(browser.closed).toBe(true);
    const status = session.keeper.status();
    expect(status.state).toBe("signed_in");
    expect(Date.parse(status.endsAt!) - Date.parse(status.signedInAt!)).toBe(24 * 3_600_000);

    // Signing in again keeps the session until it succeeds.
    const page = (await http(port, "GET", "/")).text;
    expect(page).toContain("Signed in to Cibus");
    expect(page).toContain("Sign in again");
    expect((await http(port, "POST", "/start", `csrf=${csrf}&first=someone%40example.com&length=7d`)).status).toBe(303);
    expect(browsers[1]!.posts[0]!.body).toMatchObject({ userInput1: "someone@example.com" });
    expect(session.keeper.status().state).toBe("signed_in");
  });

  test("when Pluxee needs a second detail, the page asks for it and sends it", async () => {
    const { session, browsers, port } = await signedOutSession(true);
    const csrf = csrfOf((await http(port, "GET", "/")).text);
    expect((await http(port, "POST", "/start", `csrf=${csrf}&first=0500000000&length=7d`)).status).toBe(303);
    const again = (await http(port, "GET", "/")).text;
    expect(again).toContain("Additional identification");
    expect(again).toContain('value="0500000000"');
    expect(browsers[0]!.closed).toBe(true);
    expect((await http(port, "POST", "/start", `csrf=${csrf}&first=0500000000&second=123456782&length=7d`)).status).toBe(303);
    expect(browsers[1]!.posts[0]!.body).toMatchObject({ userInput2: "123456782" });
    expect((await http(port, "POST", "/code", `csrf=${csrf}&code=123456`)).status).toBe(303);
    expect(browsers[1]!.posts[1]!.body).toMatchObject({ userInput2: "123456782" });
    expect(session.keeper.status().state).toBe("signed_in");
  });

  test("other hosts, forms without the token and bad input are refused", async () => {
    const { port, browsers } = await signedOutSession();
    expect((await http(port, "GET", "/", undefined, "attacker.example")).status).toBe(421);
    expect((await http(port, "POST", "/start", "csrf=nope&first=0500000000")).status).toBe(400);
    const csrf = csrfOf((await http(port, "GET", "/")).text);
    expect((await http(port, "POST", "/start", `csrf=${csrf}&first=not-a-contact&length=7d`)).status).toBe(400);
    expect((await http(port, "POST", "/start", `csrf=${csrf}&first=0500000000&length=forever`)).status).toBe(400);
    expect(browsers).toHaveLength(0);
  });
});

describe("tools", () => {
  test("signed out: data tools answer with the sign-in link", async () => {
    const { session, port } = await signedOutSession();
    const result = await callTool(createMcpServer(session), "get_balance");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(`http://localhost:${port}/`);
    expect(result.content[0]!.text).toContain("Never ask the user");
  });

  test("balance, orders, restaurants and menus, with the session's cookie and the app's headers", async () => {
    const { session, f } = await signedInSession();
    const server = createMcpServer(session);
    expect(await toolJson(server, "get_balance")).toMatchObject({ balance: 120.5, currency: "ILS" });
    expect(f.calls.at(-1)!.headers).toMatchObject({ "application-id": "E5D5FEF5-A05E-4C64-AEBA-BA0CECA0E402", origin: "https://consumers.pluxee.co.il" });

    expect((await toolJson(server, "list_orders", { from: "2026-01-01", to: "2026-01-31" })).count).toBe(1);
    expect(JSON.parse(f.calls.at(-1)!.body!)).toEqual({ from_date: "01/01/2026", to_date: "31/01/2026", type: "prx_user_deals" });

    const rests = await toolJson(server, "list_restaurants", { search: "burger" });
    expect(rests.restaurants).toEqual([{ restaurant_id: 101, name: "Example Burger", kitchen_type: 1, is_open: 1 }]);
    const scan = f.calls.find((c) => c.body?.includes('"rest_scan"'))!;
    expect(JSON.parse(scan.body!)).toMatchObject({ addr_id: 22, order_type: 1 });

    const menu = await toolJson(server, "get_menu", { restaurant_id: "202", order_type: "pickup" });
    expect(menu.dishes[0]).toEqual({ category_id: 7, category: "Vouchers", dish_id: 71, name: "Voucher 50", price: 50, has_options: false });
    const tree = new URL(f.calls.find((c) => c.url.includes("rest_menu_tree"))!.url);
    expect(Object.fromEntries(tree.searchParams)).toMatchObject({ restaurant_id: "202", comp_id: "11", order_type: "2", address_id: "22" });
  });

  test("vouchers: codes of the ones bought, the stores that sell them, and sending details", async () => {
    const { session } = await signedInSession();
    const server = createMcpServer(session);
    const active = await toolJson(server, "list_vouchers");
    expect(active.vouchers).toEqual([{ id: "v1", business: "Example Market", code: "1111222233334444", amount: 100, remaining: 40, expires: "2030-01-01 00:00:00", active: true }]);
    const all = await toolJson(server, "list_vouchers", { state: "all" });
    expect(all.vouchers[1]).toMatchObject({ id: "v0", check_url: "https://store.example/check", active: false });

    const shops = await toolJson(server, "list_voucher_shops");
    expect(shops.shops.map((s: { restaurant_id: number }) => s.restaurant_id)).toEqual([202, 303]);

    expect(await toolJson(server, "send_voucher_details", { voucher_id: "v1" })).toMatchObject({ sent: true });
    expect(await toolJson(server, "send_voucher_details", { voucher_id: "v0" })).toMatchObject({ sent: false });
    expect(session.keeper.status().state).toBe("signed_in");
  });

  test("buying a voucher quotes first, and buys only with the quote's token", async () => {
    const { session, f } = await signedInSession();
    const server = createMcpServer(session);
    const quote = await toolJson(server, "buy_voucher", { restaurant_id: "202", dish_id: "71" });
    expect(quote.voucher).toMatchObject({ dish_id: 71, price: 50 });
    expect(quote.charge).toEqual({ otl_price: 50, price: 50 });
    expect(f.calls.some((c) => c.body?.includes('"prx_apply_order"'))).toBe(false);
    const add = f.calls.find((c) => c.body?.includes('"prx_add_prod_to_cart"'))!;
    expect(JSON.parse(add.body!)).toEqual({
      type: "prx_add_prod_to_cart",
      order_type: "2",
      dish_list: { category_id: 7, dish_id: 71, dish_price: 50, co_owner_id: -1, extra_list: [] },
    });
    const simulate = f.calls.find((c) => c.body?.includes('"prx_simulate_order"'))!;
    expect(JSON.parse(simulate.body!)).toMatchObject({ order_time: orderTime(1_800_000_000) });

    // A second quote for the same voucher doesn't add it twice.
    await toolJson(server, "buy_voucher", { restaurant_id: "202", dish_id: "71" });
    expect(f.calls.filter((c) => c.body?.includes('"prx_add_prod_to_cart"'))).toHaveLength(1);

    expect((await callTool(server, "buy_voucher", { restaurant_id: "202", dish_id: "71", confirm_token: "made-up-token" })).isError).toBe(true);
    const bought = await toolJson(server, "buy_voucher", { restaurant_id: "202", dish_id: "71", confirm_token: quote.confirm_token });
    expect(bought).toMatchObject({ bought: true, deal_id: 999, vouchers: [{ id: "v2", code: "5555666677778888", amount: 50 }] });
    // A token buys once.
    expect((await callTool(server, "buy_voucher", { restaurant_id: "202", dish_id: "71", confirm_token: quote.confirm_token })).isError).toBe(true);
  });

  test("buying never touches a cart that holds something else unless told to", async () => {
    const { session, f, putInCart } = await signedInSession();
    const server = createMcpServer(session);
    putInCart({ dish_id: 1234, amount: 1, restaurant_id: 101 });
    const refused = await callTool(server, "buy_voucher", { restaurant_id: "202", dish_id: "71" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("clear_cart");
    expect(f.calls.some((c) => c.body?.includes('"prx_del_cart"'))).toBe(false);
    const quote = await toolJson(server, "buy_voucher", { restaurant_id: "202", dish_id: "71", clear_cart: "true" });
    expect(quote.confirm_token).toBeTruthy();
    expect(f.calls.some((c) => c.body?.includes('"prx_del_cart"'))).toBe(true);
    // Items with options can't be bought here.
    expect((await callTool(server, "buy_voucher", { restaurant_id: "202", dish_id: "72" })).isError).toBe(true);
  });

  test("a signed-out code in an HTTP 200 answer ends the session and the tools ask for a sign-in", async () => {
    const { session } = await signedOutSession();
    await session.keeper.signedIn([{ name: "token", value: "stale" }], 3_600_000);
    const result = await callTool(createMcpServer(session), "get_balance");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Not signed in");
    expect(session.keeper.status().state).toBe("expired");
  });

  test("the keep-alive check uses the session, and ends one Pluxee refuses", async () => {
    const { session } = await signedInSession();
    await session.keeper.tick();
    expect(session.keeper.status()).toMatchObject({ state: "signed_in" });
    expect(session.keeper.status().lastError).toBeUndefined();
    await session.keeper.signedIn([{ name: "token", value: "stale" }], 3_600_000);
    await session.keeper.tick();
    expect(session.keeper.status().state).toBe("expired");
  });

  test("bad ids never reach a URL", async () => {
    const { session } = await signedInSession();
    const server = createMcpServer(session);
    expect((await callTool(server, "get_menu", { restaurant_id: "../x" })).isError).toBe(true);
    expect((await callTool(server, "send_voucher_details", { voucher_id: "../../auth" })).isError).toBe(true);
  });
});

describe("helpers", () => {
  test("dates and order times as the web app sends them", () => {
    expect(legacyDate("2026-03-04")).toBe("04/03/2026");
    // 2026-01-01 10:05 UTC is 12:05 in Israel (winter time).
    expect(orderTime(Date.UTC(2026, 0, 1, 10, 5) / 1000)).toBe("12:05");
  });

  test("a mobile number is sent as digits, an email as typed", () => {
    expect(normalizeFirst(" 050-000 0000 ")).toBe("0500000000");
    expect(normalizeFirst("Someone@Example.com")).toBe("Someone@Example.com");
  });
});
