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

  it("finds a `fragments:` mapping nested inside `yo: fragments:` — pre-fix annotate damage", async () => {
    // written by the old embed walk over the FLAT `yo: fragments:` spelling; nothing writes
    // this shape any more, so the doctor surfaces what earlier versions left behind
    const d = await doctor(
      tmpTree({
        "a.txt": "hi\n",
        ".yo/body.yo":
          '"a.txt":\n  yo: fragments:\n    fragments:\n      stale: !!<*::yamlover:$defs:fragment>\n        type: "rect"\n        x: 1\n        y: 1\n        w: 2\n        h: 2\n',
      }),
    );
    const hit = d.diagnostics.find((x) => x.code === "annotations/doubled-fragments");
    expect(hit).toBeTruthy();
    expect(hit!.message).toContain("fragments");
    // …and a WELL-FORMED flat spelling never fires it
    const clean = await doctor(
      tmpTree({
        "b.txt": "hi\n",
        ".yo/body.yo":
          '"b.txt":\n  yo: fragments:\n    ok1: !!<*::yamlover:$defs:fragment>\n      type: "rect"\n      x: 1\n      y: 1\n      w: 2\n      h: 2\n',
      }),
    );
    expect(codesOf(clean)).not.toContain("annotations/doubled-fragments");
  });

  it("finds an overlay whose only content is sidecar blobs", async () => {
    const d = await doctor(tmpTree({ "World/.yo/thumbnails/ab12.webp": "\u0000" }));
    expect(codesOf(d)).toContain("layout/orphan-overlay");
  });

  it("allows a MARKER-ONLY overlay — meta.yo alone is the scalar-as-binary shape", async () => {
    const d = await doctor(tmpTree({ "pic.png": "\u0000", ".yo/meta.yo": "properties:\n  pic.png:\n    type: binary\n" }));
    expect(d).toMatchObject({ allowed: true });
  });

  it("passes a dir/index.yo tree — the other overlay flavor is not corruption", async () => {
    const d = await doctor(tmpTree({ "World/index.yo": "- *Eurasia\n", "World/Eurasia/index.yo": "Europe: 1\n" }));
    expect(d).toMatchObject({ allowed: true, diagnostics: [] });
  });

  it("finds a directory carrying BOTH instance overlays", async () => {
    const d = await doctor(tmpTree({ "World/index.yo": "from the file\n", "World/.yo/body.yo": "from the marker\n" }));
    expect(d.allowed).toBe(false);
    const hit = d.diagnostics.find((x) => x.code === "layout/duplicate-overlay");
    expect(hit?.fsPath).toBe("World");
  });

  it("reports the fsPath of the offending object, so the message is actionable", async () => {
    const d = await doctor(tmpTree({ "a/.yo/body.yo": "x\n", "a/.yo/junk.yaml": "y\n" }));
    const hit = d.diagnostics.find((x) => x.code === "layout/reserved-overlay-name");
    expect(hit?.fsPath).toBe("a/.yo/junk.yaml");
  });
});

describe("GET /api/doctor — THE LINK INVARIANT (dead prose links are warnings)", () => {
  it("a link that names no node is a link/dead-target warning; live and reserved links are not", async () => {
    const d = await doctor(
      tmpTree({
        "target.md": "T\n",
        "note.yo": 'a: "live [x](*::target.md) dead [y](*::nowhere.md) reserved [z](&some:mark)"\n',
      }),
    );
    expect(d.allowed).toBe(true); // content, not corruption — a warning never refuses
    const dead = d.diagnostics.filter((x) => x.code === "link/dead-target");
    expect(dead).toHaveLength(1);
    expect(dead[0].message).toContain(":nowhere.md");
    expect(dead[0].fsPath).toBe("note.yo");
  });

  it("the bare alias and relative scopes are checked with the same frames navigation uses", async () => {
    const d = await doctor(
      tmpTree({
        "P/holder/index.yo": "Holder\n- >\n  ok [a](*..:target) dead [b](*..:gone) alias-dead [c](::absent)\n",
        "P/target/index.yo": "Target\n",
        "P/index.yo": "P\n- *: holder\n- *: target\n",
      }),
    );
    const dead = d.diagnostics.filter((x) => x.code === "link/dead-target").map((x) => x.message);
    expect(dead).toHaveLength(2);
    expect(dead.some((m) => m.includes(":P:gone"))).toBe(true);
    expect(dead.some((m) => m.includes(":absent"))).toBe(true);
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
