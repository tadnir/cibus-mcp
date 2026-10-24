import type { KeeperStatus } from "./keeper.js";
import { LENGTH_ENDED } from "./keeper.js";

export const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `:root{color-scheme:light dark}
body{font:16px/1.5 system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:1rem}
main{max-width:30rem;width:100%}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:.25rem 0 1rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem;margin:0 0 1rem}
dt{opacity:.7}
dd{margin:0}
form{display:inline-block;margin:0 .5rem .5rem 0}
label{display:block;margin:0 0 1rem;font-weight:600}
input[type=text]{display:block;width:100%;box-sizing:border-box;margin-top:.25rem;padding:.6rem;font:inherit;border:1px solid #8888;border-radius:.4rem}
select{font:inherit;padding:.4rem;margin-left:.5rem;border-radius:.4rem}
button{padding:.6rem 1.1rem;font:inherit;border:0;border-radius:.4rem;background:#221c46;color:#fff;cursor:pointer}
button.secondary{background:#8884;color:inherit}
.note{font-size:.85rem;opacity:.7}
.err{color:#b00020}`;

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

function when(iso?: string): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Jerusalem" });
}

function errorLine(error?: string): string {
  return error ? `<p class="err">${escapeHtml(error)}</p>` : "";
}

const DAY_MS = 24 * 3_600_000;

/** How long a sign-in is kept, picked on the page; the keeper drops it then, whatever Pluxee says. */
export const SESSION_LENGTHS: { value: string; label: string; ms: number }[] = [
  { value: "1d", label: "1 day", ms: DAY_MS },
  { value: "7d", label: "1 week", ms: 7 * DAY_MS },
  { value: "30d", label: "30 days", ms: 30 * DAY_MS },
];
export const DEFAULT_LENGTH = "7d";

export function lengthMs(value: string | null): number | undefined {
  return SESSION_LENGTHS.find((l) => l.value === value)?.ms;
}

function hidden(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"/>`;
}

export interface IdFormValues {
  first?: string;
  /** Show the second-detail field (Pluxee asked for it). */
  askSecond?: boolean;
}

function idForm(csrf: string, label: string, secondary: boolean, values: IdFormValues = {}): string {
  const lengths = SESSION_LENGTHS.map((l) => `<option value="${l.value}"${l.value === DEFAULT_LENGTH ? " selected" : ""}>${escapeHtml(l.label)}</option>`).join("");
  const second = values.askSecond
    ? `<label>Additional identification (פרט נוסף שמזהה אותך), such as your ID or employee number<input type="text" name="second" autocomplete="off" maxlength="40" required/></label>`
    : "";
  return `<form method="post" action="start">${hidden(csrf)}
<label>Email or mobile number on your Cibus account<input type="text" name="first" autocomplete="off" maxlength="100" value="${escapeHtml(values.first ?? "")}" required/></label>
${second}<label>Stay signed in for<select name="length">${lengths}</select></label>
<button type="submit"${secondary ? ' class="secondary"' : ""}>${escapeHtml(label)}</button></form>`;
}

export function idPage(status: KeeperStatus, csrf: string, error?: string, values: IdFormValues = {}): string {
  let why = "Nobody is signed in to Cibus yet.";
  if (status.state === "expired") {
    why =
      status.lastError === LENGTH_ENDED
        ? `The session reached the length picked at sign-in, at ${when(status.endedAt)}.`
        : `Pluxee ended the session at ${when(status.endedAt)}.`;
  }
  return layout(
    "Sign in to Cibus",
    `<h1>Sign in to Cibus (Pluxee)</h1>
<p>${escapeHtml(why)} Pluxee sends a one-time code by SMS or email to the contact on your account.</p>
${errorLine(error)}
${idForm(csrf, "Send code", false, values)}
<p class="note">What you type here goes only to Pluxee, through its own sign-in page. This server keeps the resulting session on this machine.</p>`,
  );
}

export function codePage(csrf: string, sentTo?: string, error?: string): string {
  const where = sentTo ? ` to ${escapeHtml(sentTo)}` : "";
  return layout(
    "Enter the Cibus code",
    `<h1>Enter the code</h1>
<p>Pluxee sent a one-time code${where}.</p>
${errorLine(error)}
<form method="post" action="code">${hidden(csrf)}
<label>Code<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,8}" required/></label>
<button type="submit">Sign in</button></form>
<form method="post" action="cancel">${hidden(csrf)}<button type="submit" class="secondary">Start over</button></form>`,
  );
}

export function statusPage(status: KeeperStatus, csrf: string): string {
  return layout(
    "Cibus MCP",
    `<h1>Cibus MCP</h1>
<p>Signed in to Cibus. The server checks the session every few minutes and shows here when it has ended.</p>
<dl>
<dt>Signed in</dt><dd>${escapeHtml(when(status.signedInAt))}</dd>
<dt>Kept until</dt><dd>${escapeHtml(when(status.endsAt))}</dd>
<dt>Last checked</dt><dd>${escapeHtml(when(status.lastCheckedAt))}</dd>
</dl>
${status.lastError ? `<p class="err">Last check error: ${escapeHtml(status.lastError)}</p>` : ""}
<p class="note">Signing in again starts a new session. The current one stays until the new one succeeds.</p>
${idForm(csrf, "Sign in again", true)}
<form method="post" action="sign-out">${hidden(csrf)}<button type="submit" class="secondary">Sign out</button></form>`,
  );
}

/** While Pluxee's page works in the background; reloads itself. */
export function workingPage(csrf: string, what: string): string {
  return layout(
    "Signing in to Cibus",
    `<meta http-equiv="refresh" content="2"/><h1>${escapeHtml(what)}</h1>
<p>This page reloads by itself.</p>
<form method="post" action="cancel">${hidden(csrf)}<button type="submit" class="secondary">Start over</button></form>`,
  );
}

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
