import { describe, it, expect } from "vitest";
import { createHandlers } from "./helpers";
import { tmpTree } from "./helpers";
import { call } from "./http";

// A scalar's decoded VALUE loses its authored spelling — `"~"` (a string) and `~` (null) both project
// to distinct values, but `0xff`→255, `True`→true, a quoted `"~"`→"~" all render ambiguously if shown
// bare. The projection carries the authored SOURCE token (`raw`) in the comment sidecar, but ONLY when
// it differs from the plain decoded form, so the renderer can show it faithfully (CONCRETES.md
// §Scalar representation). Plain `Rex`/`42` carry nothing.
describe("scalar raw representation (comment sidecar)", () => {
  it("carries raw for representation-significant scalars only, value unchanged", async () => {
    const src = 'humans:\n  - name: "~"\n    plain: Rex\n    id: 0xff\n    n: 42\n    b: True\n    nul: ~\n';
    const root = tmpTree({ "d.yo": src });
    const h = createHandlers(root, { gitignore: false });
    await h.ready;
    const j = call(h, "/api/json", { path: ":d.yo", depth: ".inf" }).json as { value: any; comments: Record<string, { raw?: string }> };
    const c = j.comments;

    expect(j.value.humans[0].name).toBe("~"); // still the STRING "~", not null
    expect(j.value.humans[0].id).toBe(255);
    expect(j.value.humans[0].nul).toBeNull();

    expect(c["/humans/0/name"]?.raw).toBe('"~"'); // quoted → distinguishable from null
    expect(c["/humans/0/id"]?.raw).toBe("0xff"); // hex spelling kept
    expect(c["/humans/0/b"]?.raw).toBe("True"); // casing kept
    expect(c["/humans/0/nul"]?.raw).toBe("~"); // tilde null kept
    expect(c["/humans/0/plain"]?.raw).toBeUndefined(); // plain string → nothing
    expect(c["/humans/0/n"]?.raw).toBeUndefined(); // plain decimal → nothing
  });
});

// The REPRESENTATION concrete (repr.ts, CONCRETES.md §Scalar representation) rides the same sidecar
// beside `raw`: `raw` is the bytes, `repr` is the CLASSIFICATION a renderer, schema or style-picker
// reasons about. It is carried only when it is not the default for the value, so the sidecar stays
// as sparse as it is for `raw`.
describe("representation concretes on the wire", () => {
  const source =
    "plain: Rex\n" +
    "quoted: 'Rex'\n" +
    'dq: "a b"\n' +
    "tilde: ~\n" +
    "nul: null\n" +
    "hex: 0xff\n" +
    "dec: 255\n" +
    "num: 42\n" +
    "bool: true\n" +
    "exp: 6.022e23\n" +
    "blk: |-\n  one\n  two\n";

  async function comments() {
    const h = createHandlers(tmpTree({ "d/.yo/body.yo": source }), { gitignore: false });
    await h.ready;
    return (call(h, "/api/json", { path: ":d", depth: "2" }).json as { comments: Record<string, { repr?: string; block?: unknown }> }).comments;
  }

  it("classifies each authored spelling", async () => {
    const c = await comments();
    expect(c["/quoted"]?.repr).toBe("yaml/single");
    expect(c["/dq"]?.repr).toBe("yaml/double");
    expect(c["/tilde"]?.repr).toBe("yaml/tilde");
    expect(c["/hex"]?.repr).toBe("yaml/hex");
    expect(c["/exp"]?.repr).toBe("yaml/exp");
    expect(c["/blk"]?.repr).toBe("yaml/literal");
    expect(c["/blk"]?.block).toEqual({ chomp: "strip" }); // clip is the default and is not recorded
  });

  it("carries NOTHING for a value written the canonical way", async () => {
    const c = await comments();
    // these are re-derivable from the value, so sending them would bloat every node for nothing
    for (const k of ["/plain", "/nul", "/dec", "/num", "/bool"]) expect(c[k]?.repr, k).toBeUndefined();
  });
});

// Known parser gaps, pinned so the vocabulary and the reader do not drift apart silently:
// CONCRETES.md lists `yaml/oct` / `yaml/bin` / `yaml/bool11`, but the reader follows the YAML 1.2
// CORE schema, where `0o377`, `0b1111`, `yes` and `no` are ordinary STRINGS (1.1 word booleans are
// marked "opt-in" there). repr.ts classifies them the moment a reader decodes them — repr.test.ts
// drives the classifier directly, so the vocabulary stays covered either way.
describe("notations the core reader does not decode", () => {
  it("read as strings, so they carry no representation concrete", async () => {
    const h = createHandlers(tmpTree({ "d/.yo/body.yo": "oct: 0o377\nbin: 0b1111\nyes11: yes\n" }), { gitignore: false });
    await h.ready;
    const j = call(h, "/api/json", { path: ":d", depth: "2" }).json as { value: Record<string, unknown>; comments: Record<string, { repr?: string }> };
    expect(j.value).toMatchObject({ oct: "0o377", bin: "0b1111", yes11: "yes" });
    for (const k of ["/oct", "/bin", "/yes11"]) expect(j.comments[k]?.repr, k).toBeUndefined();
  });
});
