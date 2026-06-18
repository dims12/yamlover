import { describe, it, expect } from "vitest";
import { createHandlers } from "../src/server/engine-api";
import { tmpExample, tmpTree } from "./helpers";
import { call } from "./http";

// Read endpoints, against DISPOSABLE COPIES of the example fixtures (indexing writes the
// .yamlover/index.db cache into the served tree, so even reads must not target the repo).

describe("api endpoints (engine-backed)", () => {
  it("/api/info returns the served root's directory name", async () => {
    const h = createHandlers(tmpExample("51-object-in-dir"), { gitignore: false });
    await h.ready;
    expect(call(h, "/api/info").json).toEqual({ root: "51-object-in-dir" });
  });

  it("/api/tree lists scalars and respects depth", async () => {
    const h = createHandlers(tmpExample("51-object-in-dir"), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/tree", { depth: "3" });
    // filesystem order = sorted names (no body.yamlover to impose another); the built-in palette
    // graft (`yamlover`) is always appended — ignore it here
    expect(json.children.map((c: any) => c.label).filter((l: string) => l !== "yamlover")).toEqual(["age", "isAdmin", "name"]);
  });

  it("/api/json is one level deep with link markers", async () => {
    const h = createHandlers(tmpExample("57-image-with-markup"), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":" });
    expect(json.type).toBe("object");
    expect(json.value.markup.$yamloverLink.kind).toBe("array");
  });

  it("/api/json?binary=1 returns base64 for a binary node (even one with overlay entries)", async () => {
    const h = createHandlers(tmpExample("57-image-with-markup"), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":object_detection.png", binary: "1" });
    // the png owns embedded overlay entries (thumbnails/fragments), so it reads as `variant` — but
    // its binary VALUE facet is intact, so ?binary=1 still streams the bytes.
    expect(json.type).toBe("variant");
    expect(json.value.$yamloverBinary.format).toBe("image/png");
  });

  it("/api/schema returns the instance schema", async () => {
    const h = createHandlers(tmpExample("51-object-in-dir"), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/schema", { path: ":" });
    expect(json.type).toBe("object");
    expect(json.properties.name.const).toBe("Alice");
  });

  it("reports an unknown path as a 404", async () => {
    const h = createHandlers(tmpExample("51-object-in-dir"), { gitignore: false });
    await h.ready;
    const { status, json } = call(h, "/api/json", { path: ":nope" });
    expect(status).toBe(404);
    expect(json.error).toBeTruthy();
  });
});

describe("reverse positional membership (~-) projection", () => {
  const tree = () =>
    tmpTree({
      ".yamlover/body.yamlover":
        "items:\n- alpha\nmember:\n  name: m\n  ~- */items\n  ~- */unique\n" +
        "dup:\n  ~- */items\n  ~- */items\nunique: !!set\n- */member\n",
    });

  it("appends reverse members after owned entries, lexicographically, ADDITIVE (repetition kept)", async () => {
    const h = createHandlers(tree(), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":items", depth: "2" });
    const items = json.value as any[];
    expect(items[0]).toBe("alpha"); // owned entry first
    // then /dup twice (two ~- declarations — lists repeat), then /member
    expect(items.slice(1).map((v) => v.$yamloverLink.path)).toEqual([":dup", ":dup", ":member"]);
  });

  it("a !!set container dedups forward+reverse authoring to one membership", async () => {
    const h = createHandlers(tree(), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":unique", depth: "2" });
    const items = json.value as any[];
    expect(items).toHaveLength(1);
    expect(items[0].$yamloverLink.path).toBe(":member");
  });

  it("reverse declarations do not change the member's own type", async () => {
    const h = createHandlers(tree(), { gitignore: false });
    await h.ready;
    const { json } = call(h, "/api/json", { path: ":member", depth: "2" });
    expect(json.type).toBe("object");
    expect(json.value.name).toBe("m");
  });
});
