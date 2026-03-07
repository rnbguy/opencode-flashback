import { describe, expect, test } from "bun:test";
import { isLocalhostRequest, serveStatic } from "../src/web/server.ts";

describe("server security", () => {
  test("isLocalhostRequest rejects non-local Host header", () => {
    const req = new Request("http://127.0.0.1:4747/", {
      headers: { Host: "attacker.com" },
    });

    expect(isLocalhostRequest(req)).toBe(false);
  });

  test("isLocalhostRequest accepts 127.0.0.1 with port", () => {
    const req = new Request("http://127.0.0.1:4747/", {
      headers: { Host: "127.0.0.1:4747" },
    });

    expect(isLocalhostRequest(req)).toBe(true);
  });

  test("isLocalhostRequest accepts localhost with port", () => {
    const req = new Request("http://127.0.0.1:4747/", {
      headers: { Host: "localhost:4747" },
    });

    expect(isLocalhostRequest(req)).toBe(true);
  });

  test("isLocalhostRequest accepts IPv6 loopback with brackets", () => {
    const req = new Request("http://127.0.0.1:4747/", {
      headers: { Host: "[::1]:4747" },
    });

    expect(isLocalhostRequest(req)).toBe(true);
  });

  test("serveStatic blocks path traversal", () => {
    const res = serveStatic("../../etc/passwd");
    expect(res.status).toBe(404);
  });

  test("serveStatic blocks URL-encoded path traversal", () => {
    const res = serveStatic("%2e%2e/%2e%2e/etc/passwd");
    expect(res.status).toBe(404);
  });
});
