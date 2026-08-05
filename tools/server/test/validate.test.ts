// validate.ts — the pure format-invariant rules (no I/O). Every code gets a "refuses" case AND
// an "allows the legitimate twin" case: an over-eager rule is as much a bug as a missing one.
import { describe, it, expect } from "vitest";
import {
  validatePath,
  validateWrite,
  validateTree,
  compileMeta,
  defaultMode,
  enforce,
  ValidationError,
  type ConcreteNode,
  type Diagnostic,
  type DiagnosticCode,
  type WriteSnapshot,
} from "../src/validate";

const n = (path: string, concrete: string | null, extra: Partial<ConcreteNode> = {}): ConcreteNode => ({ path, concrete, ...extra });
const w = (over: Partial<WriteSnapshot> = {}): WriteSnapshot => ({ target: n(":", "dir"), writes: [], ...over });
const codes = (v: { diagnostics: Diagnostic[] }): DiagnosticCode[] => v.diagnostics.map((x) => x.code);

describe("validatePath — the rules needing only a root-relative path", () => {
  it("allows the whole legitimate overlay vocabulary", () => {
    for (const p of [
      "a/.yo/body.yo",
      "a/b/.yo/meta.yo",
      ".yo/settings.yo",
      ".yo/index.db",
      "a/.yo", // the marker directory itself
      "a/.yo/fragments/crop-1.webp",
      ".yo/thumbnails/ab12cd.webp",
      "Мир/Евразия/note.yo",
      "",
    ]) {
      expect(validatePath(p), p).toMatchObject({ allowed: true });
    }
  });

  it("refuses an overlay nested in another overlay", () => {
    const v = validatePath("a/.yo/.yo/body.yo");
    expect(v.allowed).toBe(false);
    expect(codes(v)).toContain("layout/nested-overlay");
  });

  it("refuses a stray name inside the overlay, and a subtree under an overlay FILE", () => {
    expect(codes(validatePath(".yo/notes.txt"))).toContain("layout/reserved-overlay-name");
    expect(codes(validatePath("a/.yo/body.yo/x"))).toContain("layout/reserved-overlay-name");
  });

  it("refuses a path escaping the root", () => {
    for (const p of ["a/../../x", "/etc/passwd", "C:/Windows"]) expect(codes(validatePath(p)), p).toContain("layout/escapes-root");
  });

  it("refuses padded, hidden and metachar-bearing member names", () => {
    expect(codes(validatePath("a/ b/x.yo"))).toContain("layout/unsafe-member-name");
    expect(codes(validatePath("a/.hidden/x.yo"))).toContain("layout/unsafe-member-name");
    expect(codes(validatePath('a/we:ird/x.yo'))).toContain("layout/unsafe-member-name");
    expect(codes(validatePath("a/b\u0007c/x.yo"))).toContain("layout/unsafe-member-name");
  });

  it("keeps dashes, dots and digits — the generated name schemes must survive", () => {
    for (const p of ["a/01-Мир/.yo/body.yo", "a/item01-1/.yo/body.yo", "a/my-note.v2.yo"]) {
      expect(validatePath(p), p).toMatchObject({ allowed: true });
    }
  });
});

describe("validateWrite — the encoding rules", () => {
  const dirTarget = n(":World", "dir/yamlover", { fsPath: "World", names: [".yo"] });

  it("refuses a keyed container spliced inline instead of promoted to a directory", () => {
    const v = validateWrite(
      w({ target: dirTarget, child: { keyed: true, container: true }, route: "dir", writes: [{ kind: "splice", fsPath: "World/.yo/body.yo" }] }),
    );
    expect(v.allowed).toBe(false);
    expect(codes(v)).toContain("layout/inline-collection");
  });

  it("allows it once the plan actually writes the directory", () => {
    const v = validateWrite(
      w({
        target: dirTarget,
        child: { keyed: true, container: true },
        route: "dir",
        memberName: "Eurasia",
        writes: [
          { kind: "dir", fsPath: "World/Eurasia", concrete: "dir/yamlover" },
          { kind: "overlay", fsPath: "World/Eurasia/.yo/body.yo" },
        ],
      }),
    );
    expect(v).toMatchObject({ allowed: true });
  });

  it("refuses an ORDINAL container spliced inline, and allows the dir-seq plan", () => {
    const child = { keyed: false, container: true };
    expect(codes(validateWrite(w({ target: dirTarget, child, route: "dir-seq", writes: [{ kind: "splice", fsPath: "World/.yo/body.yo" }] })))).toContain(
      "layout/inline-collection",
    );
    expect(
      validateWrite(
        w({
          target: dirTarget,
          child,
          route: "dir-seq",
          memberName: "item01",
          writes: [
            { kind: "dir", fsPath: "World/item01", concrete: "dir/yamlover" },
            { kind: "splice", fsPath: "World/.yo/body.yo" },
          ],
        }),
      ),
    ).toMatchObject({ allowed: true });
  });

  it("leaves the other shapes alone — no shape special-cases", () => {
    // a TAGGED ordinal container is content (a table, a typographic list): it stays inline.
    const tagged = { keyed: false, container: true, tagged: true };
    // scalars, keyed and ordinal alike, are body-encoded.
    for (const child of [tagged, { keyed: true, container: false }, { keyed: false, container: false }]) {
      const v = validateWrite(w({ target: dirTarget, child, route: "body", writes: [{ kind: "splice", fsPath: "World/.yo/body.yo" }] }));
      expect(v, JSON.stringify(child)).toMatchObject({ allowed: true });
    }
  });

  it("suspends the derivation when the edit names a concrete explicitly", () => {
    const v = validateWrite(
      w({
        target: dirTarget,
        child: { keyed: true, container: true },
        explicitConcrete: "yamlover",
        writes: [{ kind: "splice", fsPath: "World/.yo/body.yo" }],
      }),
    );
    expect(v).toMatchObject({ allowed: true });
  });

  it("runs the path rules over every planned write", () => {
    const v = validateWrite(w({ writes: [{ kind: "overlay", fsPath: ".yo/.yo/body.yo" }] }));
    expect(codes(v)).toContain("layout/nested-overlay");
  });

  it("refuses a keyed member whose key already names a child, but not a dir-seq name", () => {
    const names = ["Eurasia", ".yo"];
    const target = n(":World", "dir/yamlover", { fsPath: "World", names });
    expect(codes(validateWrite(w({ target, route: "dir", memberName: "Eurasia", writes: [{ kind: "dir", fsPath: "World/Eurasia", concrete: "dir/yamlover" }] })))).toContain(
      "layout/duplicate-member",
    );
    // dir-seq names go through uniqueName/nextMemberName — a collision is renamed, not refused.
    expect(validateWrite(w({ target, route: "dir-seq", memberName: "Eurasia", nameFamily: undefined, writes: [] })).allowed).toBe(true);
  });

  it("refuses a language switch inside a file document, and allows the matching interior", () => {
    const parent = n(":cfg", "file/json5p", { fsPath: "cfg.json5p" });
    const splice: WriteSnapshot["writes"] = [{ kind: "splice", fsPath: "cfg.json5p" }];
    expect(codes(validateWrite(w({ parent, childLanguage: "yaml", writes: splice })))).toContain("layout/language-switch");
    expect(validateWrite(w({ parent, childLanguage: "json5p", writes: splice }))).toMatchObject({ allowed: true });
  });

  it("imposes no interior language on a directory parent", () => {
    const parent = n(":World", "dir/yamlover", { fsPath: "World" });
    expect(validateWrite(w({ parent, childLanguage: "yamlover", writes: [] }))).toMatchObject({ allowed: true });
  });

  it("warns — but allows — a generated member off the order-key scheme", () => {
    const v = validateWrite(w({ route: "dir-seq", memberName: "Eurasia", writes: [] }));
    expect(v.allowed).toBe(true); // the order lives in the body pointer array; the name is cosmetic
    expect(v.diagnostics).toMatchObject([{ code: "layout/off-scheme-name", severity: "warning" }]);
    expect(validateWrite(w({ route: "dir-seq", memberName: "item01", writes: [] })).diagnostics).toEqual([]);
    expect(validateWrite(w({ nameFamily: "title", memberName: "01-Мир", writes: [] })).diagnostics).toEqual([]);
  });
});

describe("validateTree — the doctor sweep", () => {
  it("passes a well-formed tree", () => {
    const v = validateTree({
      nodes: [
        n(":", "dir/yamlover", { fsPath: "", names: [".yo", "World"] }),
        n(":.yo", "dir", { fsPath: ".yo", names: ["settings.yo", "index.db"] }),
        n(":World", "dir/yamlover", { fsPath: "World", names: [".yo", "Eurasia"] }),
        n(":World:.yo", "dir", { fsPath: "World/.yo", names: ["body.yo"] }),
        n(":World:Eurasia", "dir", { fsPath: "World/Eurasia", names: [] }),
        n(":note.yo", "file/yamlover", { fsPath: "note.yo" }),
      ],
    });
    expect(v).toMatchObject({ allowed: true, diagnostics: [] });
  });

  it("finds an overlay whose directory is gone", () => {
    const v = validateTree({ nodes: [n(":gone:.yo", "dir", { fsPath: "gone/.yo", names: ["body.yo"] })] });
    expect(codes(v)).toContain("layout/orphan-overlay");
  });

  it("finds an overlay holding only sidecar blobs, but allows a meta-only marker", () => {
    const parent = n(":a", "dir/yamlover", { fsPath: "a", names: [".yo"] });
    const blobs = n(":a:.yo", "dir", { fsPath: "a/.yo", names: ["thumbnails"] });
    expect(codes(validateTree({ nodes: [parent, blobs] }))).toContain("layout/orphan-overlay");
    const metaOnly = n(":a:.yo", "dir", { fsPath: "a/.yo", names: ["meta.yo"] });
    expect(validateTree({ nodes: [parent, metaOnly] })).toMatchObject({ allowed: true });
  });

  it("finds a nested overlay in the tree too, not only pre-flight", () => {
    const v = validateTree({ nodes: [n(":a:.yo:.yo", "dir", { fsPath: "a/.yo/.yo" })] });
    expect(codes(v)).toContain("layout/nested-overlay");
  });

  it("finds a concrete disagreeing with the shape backing it", () => {
    const marker = n(":a", "dir/yamlover", { fsPath: "a", names: ["x.yo"] });
    expect(codes(validateTree({ nodes: [marker] }))).toContain("layout/concrete-mismatch");
    const plain = n(":b", "dir", { fsPath: "b", names: [".yo"] });
    expect(codes(validateTree({ nodes: [plain] }))).toContain("layout/concrete-mismatch");
    const mistyped = n(":c.json", "file/yaml", { fsPath: "c.json" });
    expect(codes(validateTree({ nodes: [mistyped] }))).toContain("layout/concrete-mismatch");
  });

  it("leaves a concrete alone when the extension names no data language", () => {
    // docs/language/concretes: an unknown text file is modeled as a file/yaml scalar string.
    expect(validateTree({ nodes: [n(":readme.md", "file/yaml", { fsPath: "readme.md" })] })).toMatchObject({ allowed: true });
    expect(validateTree({ nodes: [n(":pic.png", "file/binary", { fsPath: "pic.png" })] })).toMatchObject({ allowed: true });
  });
});

describe("options", () => {
  const bad = () => validatePath("a/.yo/.yo/body.yo", { ignore: [] });

  it("ignore suppresses a code entirely", () => {
    expect(bad().allowed).toBe(false);
    const v = validatePath("a/.yo/.yo/body.yo", { ignore: ["layout/nested-overlay"] });
    expect(v).toMatchObject({ allowed: true, diagnostics: [] });
  });

  it("severity demotes an error to a warning and flips the verdict", () => {
    const v = validatePath("a/.yo/.yo/body.yo", { severity: { "layout/nested-overlay": "warning" } });
    expect(v.allowed).toBe(true);
    expect(v.diagnostics).toMatchObject([{ code: "layout/nested-overlay", severity: "warning" }]);
  });

  it("reports the first error as the verdict's reason", () => {
    const v = bad();
    if (v.allowed) throw new Error("expected refused");
    expect(v.reason).toBe(v.diagnostics.find((x) => x.severity === "error")!.message);
  });
});

describe("enforcement", () => {
  const warned = validateWrite(w({ route: "dir-seq", memberName: "Eurasia", writes: [] }));
  const refused = validatePath("a/.yo/.yo/body.yo");

  it("resolves the mode: an explicit setting wins, else dev throws and prod refuses", () => {
    expect(defaultMode({ dev: true })).toBe("throw");
    expect(defaultMode({ dev: false })).toBe("refuse");
    expect(defaultMode({ dev: true, setting: "report" })).toBe("report");
    expect(defaultMode({ dev: true, setting: "nonsense" })).toBe("throw"); // an unknown setting is not an off switch
  });

  it("throw mode fails on a warning too — corruption must go red in the suite", () => {
    expect(() => enforce(warned, "throw")).toThrow(ValidationError);
    expect(() => enforce(refused, "throw")).toThrow(ValidationError);
  });

  it("refuse mode rejects errors and hands warnings back to be logged", () => {
    expect(() => enforce(refused, "refuse")).toThrow(ValidationError);
    expect(enforce(warned, "refuse")).toMatchObject([{ code: "layout/off-scheme-name" }]);
  });

  it("report never throws; off discards", () => {
    expect(enforce(refused, "report")).toHaveLength(1);
    expect(enforce(refused, "off")).toEqual([]);
  });

  it("carries the diagnostics on the error", () => {
    try {
      enforce(refused, "refuse");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).diagnostics.map((x) => x.code)).toContain("layout/nested-overlay");
      expect((e as ValidationError).message).toBe((refused as { reason: string }).reason);
    }
  });
});

describe("compileMeta — the reserved schema seam", () => {
  it("compiles to nothing yet, and an empty schema source changes no verdict", () => {
    expect(compileMeta({ properties: { age: { type: "integer" } } }, ":a")).toEqual([]);
    expect(validateWrite(w({ writes: [] }), { schema: compileMeta({}, ":") })).toMatchObject({ allowed: true });
  });
});
