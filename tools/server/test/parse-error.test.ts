// A file the walk could not parse is served DEGRADED (walk.ts: raw-text scalar / plain
// filesystem mapping) — the laws pinned here:
//   - /api/content declares the failure: the header carries `parseError` with the
//     root-relative file and the parser's message, so the client can show it;
//   - the WRITE GATE refuses re-serializing the degraded model over the user's original
//     text (400, per-node refusal prose), whichever endpoint the write arrives through;
//   - a degraded DIRECTORY's intact children (their own files on disk) still edit freely —
//     the gate is keyed by the file the stamp names, never by ancestry.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers, tmpTree } from "./helpers";
import { call, callBody, callText } from "./http";
import { parseYamlover } from "../../parser/ts/src/yamlover.ts";
import { toPlain } from "../../parser/ts/src/ir.ts";

const BROKEN = "- **bold** is not a pointer\n"; // `*` opens a pointer → a parse error

type Handler = Parameters<typeof callText>[0];

async function header(h: Handler, slashPath: string): Promise<Record<string, unknown>> {
  const r = await callText(h, `/api/content/${slashPath}`);
  expect(r.status).toBe(200);
  return toPlain(parseYamlover(r.text, "<envelope>").root) as Record<string, unknown>;
}

describe("a degraded node declares its parse error and refuses mediated writes", () => {
  it("a broken DATA FILE: header carries parseError; an emplace is refused; the bytes stand", async () => {
    const root = tmpTree({ "broken.yo": BROKEN, "healthy.yo": "a: 1\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const env = await header(h, "broken.yo");
    expect(env.parseError).toMatchObject({ file: "broken.yo" });
    expect(String((env.parseError as { message: string }).message)).toMatch(/pointer/);

    // /api/source still serves the TRUE bytes — the rescue view a degraded file must keep
    expect(call(h, "/api/source", { path: ":broken.yo" }).json).toEqual({ source: BROKEN });

    const bad = await callBody(h, "POST", "/api/edit", { path: ":broken.yo", op: "emplace", yamlover: "x: 1" });
    expect(bad.status).toBe(400);
    expect(String(bad.json.error)).toMatch(/cannot edit :broken\.yo/);
    expect(fs.readFileSync(path.join(root, "broken.yo"), "utf8")).toBe(BROKEN); // untouched

    // a healthy sibling is not the gate's business
    const ok = await callBody(h, "POST", "/api/edit", { path: ":healthy.yo", op: "emplace", yamlover: "a: 2" });
    expect(ok.status).toBe(200);
  });

  it("a broken OVERLAY: the directory wears the error; its own body refuses; an intact child edits", async () => {
    const root = tmpTree({ "julia/index.yo": BROKEN, "julia/name.yo": "Julia\n" });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;

    const env = await header(h, "julia");
    expect(env.parseError).toMatchObject({ file: "julia/index.yo" });

    // a write that would re-serialize the broken overlay (the board rewrites the dir's body)
    const bad = await callBody(h, "POST", "/api/board", { path: ":julia", op: "structure", structure: [] });
    expect(bad.status).toBe(400);
    expect(String(bad.json.error)).toMatch(/cannot edit :julia\b/);
    expect(fs.readFileSync(path.join(root, "julia", "index.yo"), "utf8")).toBe(BROKEN); // untouched

    // the child is its OWN file — the degradation never locks it
    const ok = await callBody(h, "POST", "/api/edit", { path: ":julia:name.yo", op: "emplace", yamlover: "Julie" });
    expect(ok.status).toBe(200);
    expect(fs.readFileSync(path.join(root, "julia", "name.yo"), "utf8")).toContain("Julie");
    expect((await header(h, "julia/name.yo")).parseError).toBeUndefined();
  });
});
