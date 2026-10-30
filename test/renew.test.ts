import { describe, expect, test } from "vitest";
import { CookieJar } from "../src/cookies.js";
import { MOBILE_APPLICATION_ID, bodyToken, dueForRenewal, jwtExpiry, renewToken } from "../src/renew.js";
import { fakeFetch, json } from "./helpers.js";

const now = Date.parse("2026-01-01T00:00:00Z");
const inHours = (h: number) => now / 1000 + h * 3600;
const jwt = (exp: number) => `x.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.y`;

describe("renewing the token", () => {
  test("is due only within three hours of the token's expiry", () => {
    expect(dueForRenewal(new CookieJar([{ name: "token", value: "t", expires: inHours(4) }]), now)).toBe(false);
    expect(dueForRenewal(new CookieJar([{ name: "token", value: "t", expires: inHours(2) }]), now)).toBe(true);
    expect(dueForRenewal(new CookieJar([{ name: "lbsessid", value: "s" }]), now)).toBe(false);
  });

  test("takes a renewed token from Set-Cookie and stops trying", async () => {
    const jar = new CookieJar([{ name: "token", value: "old", expires: inHours(1) }]);
    const f = fakeFetch(() => new Response("{}", { headers: [["set-cookie", "token=new; Max-Age=86400"]] }));
    const result = await renewToken(jar, f, () => now);
    expect(result.renewed).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.setCookies).toEqual(["token"]);
    expect(jar.header()).toBe("token=new");
    expect(f.calls[0]?.url).toBe("https://api.capir.pluxee.co.il/auth/exchangeToken");
  });

  test("tries the mobile app's shapes, and takes a token from the body", async () => {
    const jar = new CookieJar([{ name: "token", value: "old", expires: inHours(1) }]);
    const fresh = jwt(inHours(24));
    const f = fakeFetch((call) => {
      if (call.headers["application-id"] !== MOBILE_APPLICATION_ID) return json({ status: 403, error: { message: "Forbidden" } }, 403);
      if (!call.headers.authorization) return json({ status: 401, error: { message: "No token" } }, 401);
      return json({ status: 200, data: { token: fresh } });
    });
    const result = await renewToken(jar, f, () => now);
    expect(result.renewed).toBe(true);
    expect(result.attempts.map((a) => [a.status, a.message])).toEqual([
      [403, "Forbidden"],
      [401, "No token"],
      [200, undefined],
    ]);
    expect(result.attempts[2]?.bodyKeys).toEqual(["status", "data", "data.token"]);
    expect(jar.list()).toEqual([{ name: "token", value: fresh, expires: inHours(24) }]);
    expect(JSON.stringify(result)).not.toContain(fresh);
  });

  test("reports every refusal and keeps the old token", async () => {
    const jar = new CookieJar([{ name: "token", value: "old", expires: inHours(1) }]);
    const result = await renewToken(jar, fakeFetch(() => json({ error: { message: "nope" } }, 400)), () => now);
    expect(result.renewed).toBe(false);
    expect(result.attempts).toHaveLength(3);
    expect(jar.header()).toBe("token=old");
  });

  test("reads tokens and JWT expiries", () => {
    expect(bodyToken({ data: { accessToken: "a".repeat(30) } })).toBe("a".repeat(30));
    expect(bodyToken({ token: "short" })).toBeUndefined();
    expect(jwtExpiry(jwt(123))).toBe(123);
    expect(jwtExpiry("not-a-jwt")).toBeUndefined();
  });
});
