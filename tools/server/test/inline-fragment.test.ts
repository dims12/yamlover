import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers, tmpTree } from "./helpers";
import { call, callBody } from "./http";

// THE INLINE FRAGMENT TOKEN (docs/documents/marklower/grammar): a text selection on a marklower
// chunk is spelled as a `[…](…)` token in the prose itself — membership bookmarks ride the
// label, and removing the last one unwraps the token, restoring the prose byte-exact.

const DEFS = {
  "$defs/chapter": "type: variant\nproperties:\n  title:\n    type: string\nitems:\n  anyOf:\n    - *:: yamlover: $defs: chapter\n    - *:: yamlover: $defs: chunk\n",
  "$defs/chunk": "type: [string, binary]\nformat: text/marklower\n",
  "ontos.yo": 'yellow: !!<*::yamlover:$defs:onto>\n  color: "#f9e2af"\ngreen: !!<*::yamlover:$defs:onto>\n  color: "#a6e3a1"\n',
};
const SRC = "!!<*yamlover: $defs: chapter>\ntitle: Lab\n- |\n  the parser reads the file twice: once to scan, once to build\n";
const SEL = { type: "text", exact: "once to scan", prefix: "file twice: ", suffix: ", once to" };

describe("inline fragment tokens", () => {
  it("filing a text selection wraps the words in a token, the bookmark on its label", async () => {
    const root = tmpTree({ "doc/.yo/body.yo": SRC, ...DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const read = () => fs.readFileSync(path.join(root, "doc", ".yo", "body.yo"), "utf8");

    const r = await callBody(h, "POST", "/api/annotate", { target: ":doc[1]", tag: ":ontos.yo:yellow", selector: SEL });
    expect(r.status).toBe(201);
    expect(read()).toContain("[&::ontos.yo:yellow:-: once to scan]()");
    expect(read()).not.toContain("yo:\n"); // no explicit member — the token IS the storage

    // the membership surfaces exactly like an explicit fragment's
    const list = call(h, "/api/annotations", { path: ":doc" }).json;
    const inline = list.filter((a: { inline?: boolean }) => a.inline);
    expect(inline).toHaveLength(1);
    expect(inline[0].tag.name).toBe("yellow");
    expect(inline[0].selector.exact).toBe("once to scan");
    h.close();
  });

  it("a second membership appends to the same token; unfile removes one, the last unwraps", async () => {
    const root = tmpTree({ "doc/.yo/body.yo": SRC, ...DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const read = () => fs.readFileSync(path.join(root, "doc", ".yo", "body.yo"), "utf8");
    const original = read();

    await callBody(h, "POST", "/api/annotate", { target: ":doc[1]", tag: ":ontos.yo:yellow", selector: SEL });
    await callBody(h, "POST", "/api/annotate", { target: ":doc[1]", tag: ":ontos.yo:green", selector: SEL });
    expect(read()).toContain("[&::ontos.yo:yellow:-: &::ontos.yo:green:-: once to scan]()");

    const del = (tag: string) =>
      callBody(h, "DELETE", `/api/annotate?target=${encodeURIComponent(":doc[1]")}&tag=${encodeURIComponent(tag)}&selector=${encodeURIComponent(JSON.stringify(SEL))}`, {});
    expect((await del(":ontos.yo:yellow")).status).toBe(200);
    expect(read()).toContain("[&::ontos.yo:green:-: once to scan]()");
    expect((await del(":ontos.yo:green")).status).toBe(200);
    expect(read()).toBe(original); // BYTE-EXACT restore — the ruling
    h.close();
  });

  it("a selection across a soft break falls back to the explicit member", async () => {
    const root = tmpTree({ "doc/.yo/body.yo": "!!<*yamlover: $defs: chapter>\ntitle: L\n- |\n  alpha beta\n  gamma delta\n", ...DEFS });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const read = () => fs.readFileSync(path.join(root, "doc", ".yo", "body.yo"), "utf8");

    const sel = { type: "text", exact: "beta gamma", prefix: "alpha ", suffix: " delta" };
    const r = await callBody(h, "POST", "/api/annotate", { target: ":doc[1]", tag: ":ontos.yo:yellow", selector: sel });
    expect(r.status).toBe(201);
    expect(read()).not.toContain("[&"); // no token — the words cross a line
    expect(read()).toContain("fragments:"); // the explicit member took it
    expect(read()).toContain("&::ontos.yo:yellow:-");
    h.close();
  });
});
