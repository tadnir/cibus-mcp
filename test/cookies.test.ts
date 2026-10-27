import { describe, expect, test } from "vitest";
import { CookieJar, parseSetCookie } from "../src/cookies.js";

const now = Date.parse("2026-01-01T00:00:00Z");

describe("CookieJar", () => {
  test("parses Max-Age and Expires", () => {
    expect(parseSetCookie("a=1; Path=/; Max-Age=60; HttpOnly", now)).toEqual({ name: "a", value: "1", expires: now / 1000 + 60 });
    expect(parseSetCookie("b=x=y; expires=Thu, 01 Jan 2026 01:00:00 GMT", now)).toEqual({ name: "b", value: "x=y", expires: now / 1000 + 3600 });
    expect(parseSetCookie("nonsense", now)).toBeUndefined();
  });

  test("takes new cookies, drops expired ones, and reports changes", () => {
    const jar = new CookieJar([{ name: "a", value: "1" }, { name: "b", value: "2" }]);
    const res = new Response("", { headers: [["set-cookie", "a=3; Path=/"], ["set-cookie", "b=; Max-Age=0"]] });
    expect(jar.update(res, now)).toBe(true);
    expect(jar.header()).toBe("a=3");
    expect(jar.update(new Response(""), now)).toBe(false);
  });

  test("keeps sending a cookie past its Expires; Pluxee decides whether it still holds", () => {
    const jar = new CookieJar([{ name: "old", value: "1", expires: now / 1000 - 1 }, { name: "new", value: "2" }]);
    expect(jar.header()).toBe("old=1; new=2");
  });
});
