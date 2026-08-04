// THE WIRE-EQUIVALENCE GATE — the heart of the one-wire migration (Stage 2). For EVERY
// TOC-addressable node of the deep-book fixture × every depth variant, the client-side
// derivation (`decodeEnvelope` + `deriveNodeJson` over GET /api/content) must produce the
// EXACT NodeJson the live /api/json serves today. This runs while both wires are live — the
// only safe window; when /api/json retires (Stage 4), the Stage-0 goldens flip role and pin
// the derivation directly.
import fs from "node:fs";
import { describe, it, expect } from "vitest";
import { createHandlers, tmpExample } from "./helpers";
import { call, callText } from "./http";
import { decodeEnvelope } from "../src/client/content";
import { deriveNodeJson } from "../src/client/derive-node";

const DEPTHS: { name: string; param: string | undefined; old: number | null | undefined }[] = [
  { name: "0", param: "0", old: 0 },
  { name: "1", param: "1", old: 1 },
  { name: "2", param: "2", old: 2 },
  { name: "default", param: undefined, old: undefined },
  { name: "inf", param: ".inf", old: null },
];

interface TreeRow { path: string; children?: TreeRow[] }
const collectPaths = (t: TreeRow, out: string[] = []): string[] => {
  out.push(t.path);
  for (const c of t.children ?? []) collectPaths(c, out);
  return out;
};

/** A colon path's slash spelling — segment tokens are already percent-encoded, so the swap
 *  is unambiguous (`:` never appears inside a token). */
const slashOf = (colonPath: string): string => colonPath.slice(1).split(":").join("/");

describe("the wire-equivalence gate — derived NodeJson ≡ /api/json, every node × depth", () => {
  it("examples/74-deep-book", async () => {
    const h = createHandlers(tmpExample("74-deep-book"), { gitignore: false });
    await h.ready;
    const tree = call(h, "/api/tree", { depth: "12" });
    const paths = collectPaths(tree.json as TreeRow).sort();
    expect(paths.length).toBeGreaterThan(10);

    for (const d of DEPTHS) {
      for (const p of paths) {
        const params: Record<string, string> = d.param !== undefined ? { depth: d.param } : {};
        const old = call(h, "/api/json", { path: p, ...params });
        expect(old.status, `/api/json ${p} @ ${d.name}`).toBe(200);
        const slash = slashOf(p);
        const env = await callText(h, `/api/content${slash ? "/" + slash : ""}`, params);
        expect(env.status, `/api/content ${p} @ ${d.name}: ${env.text.slice(0, 200)}`).toBe(200);
        const derived = deriveNodeJson(decodeEnvelope(env.text), d.old);
        try {
          expect(derived, `${p} @ depth=${d.name}`).toEqual(old.json);
        } catch (err) {
          // dump both sides for a side-by-side diff — the vitest diff truncates
          if (process.env.WIRE_DBG) {
            fs.writeFileSync(process.env.WIRE_DBG + "-old.json", JSON.stringify(old.json, null, 2));
            fs.writeFileSync(process.env.WIRE_DBG + "-derived.json", JSON.stringify(derived, null, 2));
          }
          throw err;
        }
      }
    }
  }, 240_000);
});
