import { describe, it, expect } from "vitest";
import { createHandlers } from "./helpers";
import { tmpTree } from "./helpers";
import { call } from "./http";

// GET /api/query — the 3g evaluator exposed (the engine-API `query` op of ENGINE.md).

describe("/api/query", () => {
  it("evaluates a colon-grammar query and returns client paths", async () => {
    const h = createHandlers(
      tmpTree({ "team.yamlover": "alice:\n  age: 31\nbob:\n  age: 9\n" }),
      { gitignore: false },
    );
    await h.ready;
    const r = call(h, "/api/query", { q: ": team.yamlover: ?: age: >10" });
    expect(r.status).toBe(200);
    expect(r.json.results).toEqual([":team.yamlover:alice:age"]);
  });

  it("a malformed query is a 400, an empty result is a 200 with []", async () => {
    const h = createHandlers(tmpTree({ name: "Alice" }), { gitignore: false });
    await h.ready;
    expect(call(h, "/api/query", { q: ": tags: дорожный знак" }).status).toBe(400); // unquoted spacey key
    expect(call(h, "/api/query", { q: ": nowhere" }).json.results).toEqual([]);
  });
});
