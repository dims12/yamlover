import { describe, it, expect } from "vitest";
import { createHandlers } from "../src/server/engine-api";
import { tmpExample } from "./helpers";
import { call } from "./http";

// Read endpoints, against DISPOSABLE COPIES of the example fixtures (indexing writes the
// .yamlover/index.db cache into the served tree, so even reads must not target the repo).

describe("api endpoints (engine-backed)", () => {
  it("/api/info returns the served root's directory name", () => {
    const h = createHandlers(tmpExample("51-object-in-dir"), { gitignore: false });
    expect(call(h, "/api/info").json).toEqual({ root: "51-object-in-dir" });
  });

  it("/api/tree lists scalars and respects depth", () => {
    const h = createHandlers(tmpExample("51-object-in-dir"), { gitignore: false });
    const { json } = call(h, "/api/tree", { depth: "3" });
    // filesystem order = sorted names (no body.yamlover to impose another)
    expect(json.children.map((c: any) => c.label)).toEqual(["age", "isAdmin", "name"]);
  });

  it("/api/json is one level deep with link markers", () => {
    const h = createHandlers(tmpExample("57-image-with-markup"), { gitignore: false });
    const { json } = call(h, "/api/json", { path: "/" });
    expect(json.type).toBe("object");
    expect(json.value.markup.$yamloverLink.kind).toBe("array");
  });

  it("/api/json?binary=1 returns base64 for a binary leaf", () => {
    const h = createHandlers(tmpExample("57-image-with-markup"), { gitignore: false });
    const { json } = call(h, "/api/json", { path: "/object_detection.png", binary: "1" });
    expect(json.type).toBe("binary");
    expect(json.value.$yamloverBinary.format).toBe("image/png");
  });

  it("/api/schema returns the instance schema", () => {
    const h = createHandlers(tmpExample("51-object-in-dir"), { gitignore: false });
    const { json } = call(h, "/api/schema", { path: "/" });
    expect(json.type).toBe("object");
    expect(json.properties.name.const).toBe("Alice");
  });

  it("reports an unknown path as a 404", () => {
    const h = createHandlers(tmpExample("51-object-in-dir"), { gitignore: false });
    const { status, json } = call(h, "/api/json", { path: "/nope" });
    expect(status).toBe(404);
    expect(json.error).toBeTruthy();
  });
});
