// GET /api/doctor — validate.ts's layout rules swept over a whole served tree.
//
// The two halves of this file pull against each other on purpose: the corruption cases prove the
// rules FIRE, and the examples sweep proves they do not fire on anything the project ships. A new
// rule that cannot satisfy both is over-eager.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHandlers, tmpTree, tmpExample, REPO } from "./helpers";
import { call } from "./http";

type Doctor = { allowed: boolean; diagnostics: { code: string; fsPath?: string; message: string }[] };

async function doctor(root: string): Promise<Doctor> {
  const h = createHandlers(root, { gitignore: false });
  await h.ready;
  const r = await call(h, "/api/doctor");
  expect(r.status).toBe(200);
  return r.json as Doctor;
}

const codesOf = (d: Doctor): string[] => d.diagnostics.map((x) => x.code);

describe("GET /api/doctor — corruption is found", () => {
  it("passes a well-formed tree", async () => {
    const d = await doctor(
      tmpTree({
        ".yo/settings.yo": "sidecars: per-directory\n",
        "World/.yo/body.yo": "- *Eurasia\n",
        "World/Eurasia/.yo/body.yo": "Europe: 1\n",
        "note.yo": "hi\n",
      }),
    );
    expect(d).toMatchObject({ allowed: true, diagnostics: [] });
  });

  it("finds an overlay buried inside another overlay — the shape the index cannot see", async () => {
    const root = tmpTree({ "World/.yo/body.yo": "x\n" });
    fs.mkdirSync(path.join(root, "World", ".yo", ".yo"));
    fs.writeFileSync(path.join(root, "World", ".yo", ".yo", "body.yo"), "buried\n");
    const d = await doctor(root);
    expect(d.allowed).toBe(false);
    expect(codesOf(d)).toContain("layout/nested-overlay");
  });

  it("finds a stray name inside an overlay", async () => {
    const d = await doctor(tmpTree({ "World/.yo/body.yo": "x\n", "World/.yo/notes.txt": "stray\n" }));
    expect(codesOf(d)).toContain("layout/reserved-overlay-name");
  });

  it("finds an overlay whose only content is sidecar blobs", async () => {
    const d = await doctor(tmpTree({ "World/.yo/thumbnails/ab12.webp": "\u0000" }));
    expect(codesOf(d)).toContain("layout/orphan-overlay");
  });

  it("allows a MARKER-ONLY overlay — meta.yo alone is the scalar-as-binary shape", async () => {
    const d = await doctor(tmpTree({ "pic.png": "\u0000", ".yo/meta.yo": "properties:\n  pic.png:\n    type: binary\n" }));
    expect(d).toMatchObject({ allowed: true });
  });

  it("reports the fsPath of the offending object, so the message is actionable", async () => {
    const d = await doctor(tmpTree({ "a/.yo/body.yo": "x\n", "a/.yo/junk.yaml": "y\n" }));
    const hit = d.diagnostics.find((x) => x.code === "layout/reserved-overlay-name");
    expect(hit?.fsPath).toBe("a/.yo/junk.yaml");
  });
});

describe("GET /api/doctor — the examples sweep", () => {
  // Every fixture the project ships must be clean. This is the net that keeps a new rule honest:
  // an over-eager rule breaks here long before it can reject a user's legitimate edit.
  const examples = fs
    .readdirSync(path.join(REPO, "examples"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  it("finds the fixtures", () => expect(examples.length).toBeGreaterThan(5));

  for (const name of examples) {
    it(`${name} is clean`, async () => {
      const d = await doctor(tmpExample(name));
      expect(d.diagnostics, `${name}: ${JSON.stringify(d.diagnostics, null, 2)}`).toEqual([]);
    });
  }
});
