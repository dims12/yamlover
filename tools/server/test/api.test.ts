import { describe, it, expect } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHandlers } from "../src/server/api";
import { ex } from "./helpers";

type Handler = ReturnType<typeof createHandlers>;

/** Invoke a handler with a fake request/response and return the parsed JSON. */
function call(handler: Handler, pathname: string, params: Record<string, string> = {}) {
  const url = new URL("http://localhost" + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const state = { statusCode: 200, body: "" };
  const res = {
    setHeader() {},
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(v: number) {
      state.statusCode = v;
    },
    end(b: string) {
      state.body = b;
    },
  } as unknown as ServerResponse;
  handler({} as IncomingMessage, res, url);
  return { status: state.statusCode, json: JSON.parse(state.body) };
}

describe("api endpoints", () => {
  it("/api/info returns the yamlover title when present", () => {
    const h = createHandlers(ex("15-doc-tree"), { gitignore: false });
    expect(call(h, "/api/info").json).toEqual({ root: "The Yamlover Handbook" });
  });

  it("/api/info falls back to the directory name", () => {
    const h = createHandlers(ex("04-object-in-dir"), { gitignore: false });
    expect(call(h, "/api/info").json).toEqual({ root: "04-object-in-dir" });
  });

  it("/api/tree lists scalars and respects depth", () => {
    const h = createHandlers(ex("04-object-in-dir"), { gitignore: false });
    const { json } = call(h, "/api/tree", { depth: "3" });
    expect(json.children.map((c: any) => c.label)).toEqual(["name", "age", "isAdmin"]);
  });

  it("/api/json is one level deep with link markers", () => {
    const h = createHandlers(ex("12-image-with-markup"), { gitignore: false });
    const { json } = call(h, "/api/json", { path: "/" });
    expect(json.type).toBe("object");
    expect(json.value.markup.$yamloverLink.kind).toBe("array");
  });

  it("/api/json?binary=1 returns base64 for a binary leaf", () => {
    const h = createHandlers(ex("12-image-with-markup"), { gitignore: false });
    const { json } = call(h, "/api/json", { path: "/object_detection.png", binary: "1" });
    expect(json.type).toBe("binary");
    expect(json.value.$yamloverBinary.format).toBe("image/png");
  });

  it("/api/schema returns the instance schema", () => {
    const h = createHandlers(ex("04-object-in-dir"), { gitignore: false });
    const { json } = call(h, "/api/schema", { path: "/" });
    expect(json.type).toBe("object");
    expect(json.properties.name.const).toBe("Alice");
  });

  it("reports a bad path as a 400 error", () => {
    const h = createHandlers(ex("04-object-in-dir"), { gitignore: false });
    const { status, json } = call(h, "/api/json", { path: "/nope" });
    expect(status).toBe(400);
    expect(json.error).toBeTruthy();
  });
});
