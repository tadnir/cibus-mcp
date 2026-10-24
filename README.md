# cibus-mcp

**Use your own Cibus (סיבוס) meal card, run by Pluxee Israel, from an AI assistant over MCP: the balance, your orders, restaurants and their menus, and your vouchers' codes. It can also buy a voucher and return its code, after you confirm.**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Unofficial. Not affiliated with Pluxee. It uses the same API as the Cibus website (consumers.pluxee.co.il), which can change without notice.

Everything runs on your machine. You sign in on a page this server serves, the session is saved only on your computer, and this project has no hosted backend and collects nothing. Whatever your AI client requests is passed to that client and handled under its provider's privacy terms.

## Terms of use

- **Your own account only.**
- **Buying spends your card.** `buy_voucher` only buys after a quote and a token from that quote. An assistant is told to pass the token only once you have agreed to that voucher and price. It never places food orders.
- **The session file is secret.** It holds Pluxee's session cookies, is saved with mode `0600` under `~/.config/cibus-mcp/`, and must never be committed or pasted.

## Install

```sh
git clone https://github.com/tadnir/cibus-mcp.git
cd cibus-mcp
npm install
npx playwright install chromium
npm test
```

## Use it from an MCP client

```json
{
  "mcpServers": {
    "cibus": {
      "command": "npx",
      "args": ["tsx", "src/main.ts"],
      "cwd": "/absolute/path/to/cibus-mcp"
    }
  }
}
```

For Claude Desktop, use absolute paths: `"command": "/absolute/path/to/node"` with `"args": ["/absolute/path/to/cibus-mcp/node_modules/.bin/tsx", "/absolute/path/to/cibus-mcp/src/main.ts"]`.

### Signing in

1. Ask your assistant something, for example "how much is left on my Cibus card?".
2. While nobody is signed in, the tools answer with a link to a sign-in page this server serves on `http://localhost:8768/`. `cibus_login` returns the same link.
3. Open it, enter the email or mobile number on your Cibus account, and pick how long to stay signed in (1 day to 30 days). Pluxee sends a one-time code by SMS or email; enter it on the page. Some accounts are asked for one more detail first, such as an ID or employee number. The page asks for it when Pluxee does.
4. Ask again.

What you type goes only to Pluxee, from Pluxee's own sign-in page. The assistant only ever sees the link.

Pluxee protects its sign-in with reCAPTCHA v3, which only its own page can run, so the server does each step inside a Chromium browser open on Pluxee's sign-in page. reCAPTCHA v3 shows no puzzle. It scores the browser, and a low score refuses the sign-in ("Invalid reCAPTCHA"). This is more likely from a datacenter address than from home. The browser keeps its profile (Google's cookies included) in `CIBUS_CONFIG_DIR/browser`. If headless sign-ins keep failing, `CIBUS_HEADLESS=false` uses a visible window.

While the MCP server runs it checks the session every 10 minutes with a small data call, saves any cookies Pluxee renews, and shows the session as ended as soon as Pluxee refuses it. It also drops the session at the length you picked. A restart picks the saved session back up.

### Tools

| Tool | What it does |
| --- | --- |
| `get_balance` | The card's balance now, and the budgets it is made of |
| `list_orders` | Orders and charges between two days, with each voucher's code |
| `list_restaurants` | Restaurants around your default address, for delivery, pickup or eating in |
| `get_menu` | A restaurant's or store's menu as a flat list of items and prices |
| `list_vouchers` | Your vouchers ("My Vouchers"), with each one's code, amount left and expiry |
| `send_voucher_details` | Has Pluxee send a voucher's details to your own phone or email |
| `list_voucher_shops` | The stores that sell vouchers (gift cards) for the card |
| `buy_voucher` | **Get a code:** quotes one voucher (it goes in your Cibus cart, nothing is charged), then, called again with the quote's `confirm_token`, buys it and returns its code |
| `cibus_login`, `cibus_session_status`, `cibus_logout` | The sign-in link, whether a session is live and until when, and sign-out |

`buy_voucher` leaves a cart that holds something else alone, unless it is called with `clear_cart` set to `true`. It can't buy items that have options to pick, or the variable-amount Cibus voucher. Use the Cibus app for those.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `CIBUS_CONFIG_DIR` | `~/.config/cibus-mcp` | Where the session and the sign-in browser's profile are saved |
| `CIBUS_LOGIN_HOST` | `127.0.0.1` | Address the sign-in page listens on |
| `CIBUS_LOGIN_PORT` | `8768` | Its port; a free one is used if another copy holds it |
| `CIBUS_LOGIN_URL` | `http://localhost:<port>/` | The link handed out, when the page sits behind a reverse proxy. When set, the page starts with the server. |
| `CIBUS_HEADLESS` | `true` | `false` also shows the sign-in browser's window |
| `CIBUS_CHROMIUM_PATH` | Playwright's Chromium | Another Chromium to sign in with |

## Hosting one long-lived copy

To share one session between several clients, run a single copy on an always-on machine at home and put a stdio-to-HTTP MCP proxy in front of it, such as [TBXark/mcp-proxy](https://github.com/TBXark/mcp-proxy), with a bearer token per client. Keep it on your own network or a private VPN, never on the internet. Put the sign-in page behind your own authentication and set `CIBUS_LOGIN_URL` to its address (and `CIBUS_LOGIN_HOST=0.0.0.0` inside a container). Its links and forms are relative, so it can sit at the root of a host or under a path whose prefix the reverse proxy strips (`CIBUS_LOGIN_URL=https://mcp.example.com/cibus/login/`, with the trailing slash).

Every token holder uses the account of whoever signed in on the page, including `buy_voucher`. The proxy's tokens and the Pluxee session are unrelated. For a second person, run a second copy with its own `CIBUS_CONFIG_DIR`, tokens and sign-in page.

The `Dockerfile` builds an image of the stdio server with Chromium, published as `ghcr.io/tadnir/cibus-mcp` from master, with the session in `/data` and the page on port 8768. Run it with `docker run -i`, or use it as a base for an image that adds your MCP proxy.

The sign-in page answers only to `localhost`, `127.0.0.1` and the host in `CIBUS_LOGIN_URL`, and each form carries a per-process token. Anyone who can open the page can sign in or out, so keep it on loopback or behind your own authentication.

## License

[MIT](LICENSE)
