import { describe, it, expect } from "vitest";
import { targetUrl, stripBase } from "../bin/request-url.js"; // a plain .js CLI module, like bin/ga4.js

describe("targetUrl (the request target → URL step)", () => {
  it("reads an ordinary target", () => {
    const u = targetUrl("/docs/meta?format=chapter")!;
    expect(u.pathname).toBe("/docs/meta");
    expect(u.search).toBe("?format=chapter");
  });

  it("keeps a `//` target a PATH instead of throwing on a protocol-relative parse", () => {
    // `new URL("//:meta", "http://localhost")` reads `:meta` as an authority whose port is not
    // a number and THROWS — inside the request listener that is an unhandled exception, i.e.
    // `GET //:meta` was a one-request kill for the process. It is a path, and it answers 404.
    expect(targetUrl("//:meta")!.pathname).toBe("//:meta");
    expect(targetUrl("//example.com/x")!.pathname).toBe("//example.com/x"); // never another host
    expect(targetUrl("//:meta")!.host).toBe("localhost");
  });

  it("returns null (the caller's 400) for a target that cannot be a URL at all", () => {
    // an absolute-form target (RFC 7230 §5.3.2 — what a proxy would send) with a broken host
    expect(targetUrl("http://[bad")).toBeNull();
    // …while a `//` target is pinned to the origin first, so it survives as a path
    expect(targetUrl("//:80:80")!.pathname).toBe("//:80:80");
  });

  it("reads a missing/empty target as the root rather than failing the request", () => {
    expect(targetUrl(undefined)!.pathname).toBe("/");
  });
});

describe("stripBase (--base-path)", () => {
  it("strips the prefix and rewrites the target for downstream handlers", () => {
    const b = stripBase(targetUrl("/docs/language/vs-yaml?format=chapter")!, "/docs")!;
    expect(b.url.pathname).toBe("/language/vs-yaml");
    expect(b.rest).toBe("/language/vs-yaml?format=chapter");
  });

  it("maps the mount point itself to the root", () => {
    expect(stripBase(targetUrl("/docs")!, "/docs")!.url.pathname).toBe("/");
    expect(stripBase(targetUrl("/docs/")!, "/docs")!.url.pathname).toBe("/");
  });

  it("survives a `//` remainder — the crawler spelling that killed the docs instance", () => {
    const b = stripBase(targetUrl("/docs//:meta")!, "/docs")!;
    expect(b.url.pathname).toBe("//:meta"); // still a path, still this origin
    expect(b.rest).toBe("//:meta");
  });

  it("rejects a target outside the prefix (the caller's 404)", () => {
    expect(stripBase(targetUrl("/other")!, "/docs")).toBeNull();
    expect(stripBase(targetUrl("/docsy")!, "/docs")).toBeNull(); // prefix, not path boundary
  });

  it("passes the target through untouched with no base path", () => {
    const b = stripBase(targetUrl("/a/b?x=1")!, "")!;
    expect(b.url.pathname).toBe("/a/b");
    expect(b.rest).toBe("/a/b?x=1");
  });
});
