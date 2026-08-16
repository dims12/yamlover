import { describe, it, expect } from "vitest";
import { decodeEnvelope } from "../../src/client/content";
import { deriveNodeJson } from "../../src/client/derive-node";

const MIX = "$yamloverMixed";
const REF = "$yamloverRef";
const LINK = "$yamloverLink";

function derive(envelope: string, depth: number | null = null) {
  return deriveNodeJson(decodeEnvelope(envelope), depth);
}

describe("deriveNodeJson — bookmark-created members (side.backEdges)", () => {
  it("a scalar onto with incoming `&…:-` backs shows them as keyless omni members", () => {
    // the live `:ontos:boo` shape: authored source is just `null`; the filed fragments
    // ride the sidecar as keyless backEdges (docs/annotations/derivation — O: -)
    const node = derive(`
path: :ontos:boo
type: 'null'
valueType: 'null'
hasKeyed: false
hasOrdinal: false
format: x-yamlover-onto
concrete: yamlover
documentPath: :ontos
source: |
  !!<*:: yamlover: $defs: onto>
  null
side:
  "":
    format: x-yamlover-onto
    backEdges:
      - label:
        path: :doc:yo:fragments:abc
        text: '*:: doc: yo: fragments: abc'
        stub:
          ${LINK}:
            kind: object
            path: :doc:yo:fragments:abc
            format: x-yamlover-fragment
relations: {}
`);
    const m = (node.value as Record<string, { kind: string; value: unknown; entries: { key: unknown; value: unknown }[] }>)[MIX];
    expect(m.kind).toBe("omni");
    expect(m.value).toBeNull();
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0].key).toBeNull();
    expect(m.entries[0].value).toEqual({ [REF]: { text: "*:: doc: yo: fragments: abc", path: ":doc:yo:fragments:abc" } });
  });

  it("a map onto with keyless backs becomes a mix (keyed fields + positional members)", () => {
    const node = derive(`
path: :ontos:genre
type: map
hasKeyed: true
hasOrdinal: false
format: x-yamlover-onto
concrete: yamlover
documentPath: :ontos
source: |
  !!<*:: yamlover: $defs: onto>
  humor: x
side:
  "":
    format: x-yamlover-onto
    backEdges:
      - label:
        path: :paper.pdf
        text: '*:: paper.pdf'
        stub:
          ${LINK}:
            kind: binary
            path: :paper.pdf
            format: application/pdf
  /humor:
    format: x-yamlover-onto
relations: {}
`);
    const m = (node.value as Record<string, { kind: string; entries: { key: unknown }[] }>)[MIX];
    expect(m.kind).toBe("mix");
    expect(m.entries.map((e) => e.key)).toEqual(["humor", null]);
  });
});
