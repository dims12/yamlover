// GET /api/content — the yamlover wire (Stage 1 of the one-wire migration). The response is a
// yamlover ENVELOPE (header keys + `source` block scalar + `side` sidecar + `relations`); the
// laws pinned here:
//   - the envelope parses, and its `source` facet is a serializer FIXED POINT
//     (serialize(parse(source)) === source — the block-scalar embedding lost nothing);
//   - depth counts DOCUMENT boundaries: cut members respell as their authored pointers
//     (`- *: name` positioned, `name: *: name` keyed-remainder), inline content always whole;
//   - BLOBS always cut, with a linkMarker stub in the sidecar;
//   - the sidecar carries member provenance (anchorKey/member), derived formats, resolved
//     reference targets; hidden overlay subtrees never appear;
//   - the slash path spelling decodes like the colon one (digits = positions, `~` = null key).
import { describe, it, expect } from "vitest";
import { createHandlers, tmpExample } from "./helpers";
import { callText } from "./http";
import { parseYamlover } from "../../parser/ts/src/yamlover.ts";
import { serializeYamlover } from "../../parser/ts/src/serialize-yamlover.ts";
import { isPointer, type Node, type Value } from "../../parser/ts/src/ir.ts";

type Handler = Parameters<typeof callText>[0];

interface Env {
  status: number;
  header: Record<string, unknown>;
  source: string;
  root: Node; // parse(source).root
  side: Record<string, Record<string, unknown>>;
  relations: Record<string, unknown>;
}

/** Decode one envelope: parse the yamlover response and lift its facets into plain JS. */
async function getContent(h: Handler, slashPath: string, depth?: string): Promise<Env> {
  const r = await callText(h, `/api/content${slashPath === "" ? "" : "/" + slashPath}`, depth !== undefined ? { depth } : {});
  if (r.status !== 200) {
    if (r.status === 400) console.error("CONTENT 400:", JSON.stringify(r.text).slice(0, 400));
    return { status: r.status, header: {}, source: "", root: null as never, side: {}, relations: {} };
  }
  const doc = parseYamlover(r.text, "<envelope>");
  const js = (v: Value): unknown => {
    if (isPointer(v)) return { pointer: v.raw };
    const n = v as Node & { value?: unknown };
    if (n.kind === "scalar" && (n.entries ?? []).length === 0) return n.value;
    const entries = n.entries ?? [];
    if (entries.every((e) => e.key === null)) return entries.map((e) => js(e.value));
    const out: Record<string, unknown> = {};
    for (const e of entries) out[String(e.key)] = js(e.value);
    return out;
  };
  const top = js(doc.root) as Record<string, unknown>;
  const source = String(top.source ?? "");
  return {
    status: r.status,
    header: top,
    source,
    root: parseYamlover(source, "<source>").root,
    side: (top.side ?? {}) as Env["side"],
    relations: (top.relations ?? {}) as Env["relations"],
  };
}

const entryKeys = (n: Node): (string | null)[] => (n.entries ?? []).map((e) => e.key);
const entryAt = (n: Node, i: number) => (n.entries ?? [])[i];

describe("GET /api/content — the yamlover wire over examples/74-deep-book", () => {
  async function book(): Promise<{ h: Handler }> {
    const h = createHandlers(tmpExample("74-deep-book"), { gitignore: false });
    await h.ready;
    return { h: h as unknown as Handler };
  }

  it("the ROOT at default depth (dir → 1): members inline ONE document deep, deeper members cut to pointers", async () => {
    const { h } = await book();
    const env = await getContent(h, "");
    expect(env.status).toBe(200);
    expect(env.header.path).toBe(":");
    expect(env.header.concrete).toBe("dir/.yo");
    expect(env.header.depth).toBe(1);
    // the root document's own text is whole: title, description, prose, the empty chunk
    expect((env.root as Node & { value?: unknown }).value).toBe("The Deep Book");
    // part-one is a member WITHIN depth 1 → inlined, KEYLESS (its position is the body's),
    // with anchorKey provenance in the sidecar
    const keys = entryKeys(env.root);
    expect(keys).toContain(null);
    const partOneIdx = (env.root.entries ?? []).findIndex(
      (e) => e.key === null && !isPointer(e.value) && ((e.value as Node & { value?: unknown }).value === "Part One"),
    );
    expect(partOneIdx).toBeGreaterThan(-1);
    const partOneFrag = `/${partOneIdx}`;
    expect(env.side[partOneFrag]?.anchorKey).toBe("part-one");
    // …but part-one's OWN members (item01, 01-deep) are documents one level deeper → cut,
    // spelled as the authored member pointers
    const partOne = entryAt(env.root, partOneIdx).value as Node;
    const cuts = (partOne.entries ?? []).filter((e) => isPointer(e.value)).map((e) => (e.value as { raw: string }).raw);
    expect(cuts).toContain(": item01");
    expect(cuts).toContain(": 01-deep");
    // the cut members carry linkMarker stubs
    const item01Frag = `${partOneFrag}/${(partOne.entries ?? []).findIndex((e) => isPointer(e.value) && (e.value as { raw: string }).raw === ": item01")}`;
    // the stub is the linkMarker payload VERBATIM — the exact `$yamloverLink` shape every
    // renderer already consumes, so the derivation can splice it without translation
    const stub = (env.side[item01Frag]?.stub as Record<string, Record<string, unknown>>)?.$yamloverLink;
    expect(stub?.path).toBe(":part-one:item01");
    expect(stub?.title).toBe("Lists And Tables");
    // the BLOB member (cover.png) cuts at ANY depth, stub carries size/format
    const coverIdx = (env.root.entries ?? []).findIndex((e) => isPointer(e.value) && (e.value as { raw: string }).raw === ": cover.png");
    expect(coverIdx).toBeGreaterThan(-1);
    const coverStub = (env.side[`/${coverIdx}`]?.stub as Record<string, Record<string, unknown>>)?.$yamloverLink;
    expect(coverStub?.kind).toBe("binary");
    expect(coverStub?.size).toBe(70);
  });

  it("depth .inf inlines the WHOLE tree except blobs; the source is a serializer fixed point", async () => {
    const { h } = await book();
    const env = await getContent(h, "", ".inf");
    expect(env.status).toBe(200);
    // the fixed point: re-serializing the parsed source reproduces it byte-for-byte —
    // the envelope's block-scalar embedding lost nothing
    const again = serializeYamlover(
      { root: env.root, source: { concrete: "yamlover", uri: "<x>" } } as never,
      { comments: true },
    );
    expect(again).toBe(env.source);
    // deep content is present as TEXT: the third level's prose and the back-edge (the merged
    // IR holds the canonical SPACED raw — the authored compact spelling normalizes upstream
    // of this endpoint, in the walk)
    expect(env.source).toContain("The third level's prose.");
    expect(env.source).toContain("*..: ..");
    // comments survive (the part-one banner)
    expect(env.source).toContain("keyed-remainder member");
    // blobs still cut
    expect(env.source).toContain("*: cover.png");
    // the STRAY keyed-remainder member spells `stray: *: stray` beyond… no — at .inf it inlines,
    // KEYED, with `member` provenance
    const strayEntry = (findByValue(env.root, "Stray Member"));
    expect(strayEntry).not.toBeNull();
  });

  it("the stray keyed-remainder member: keyed inline within depth, `stray: *: stray` beyond", async () => {
    const { h } = await book();
    const at1 = await getContent(h, "part-one", "1");
    expect(at1.status).toBe(200);
    // depth 1 at part-one: its members inline (stray keyed, item01/01-deep keyless)
    const strayIdx = (at1.root.entries ?? []).findIndex((e) => e.key === "stray");
    expect(strayIdx).toBeGreaterThan(-1);
    expect(at1.side[`/stray`]?.member).toBe(true);
    const at0 = await getContent(h, "part-one", "0");
    // depth 0: every member cuts — the keyed-remainder as a KEYED member pointer
    expect(at0.source).toContain("stray: *: stray");
    expect(at0.source).toContain("*: item01");
    expect(at0.side["/stray"]?.stub).toBeTruthy();
  });

  it("authored references resolve through the sidecar (the back-edge reaches the root)", async () => {
    const { h } = await book();
    const env = await getContent(h, "part-one/item01", ".inf");
    expect(env.status).toBe(200);
    const refIdx = (env.root.entries ?? []).findIndex((e) => isPointer(e.value));
    expect(refIdx).toBeGreaterThan(-1);
    expect((entryAt(env.root, refIdx).value as { raw: string }).raw).toBe("..: ..");
    expect(env.side[`/${refIdx}`]?.refPath).toBe(":");
  });

  it("the !!yo island keeps its raw spellings and the null key; the hidden .yo overlay never appears", async () => {
    const { h } = await book();
    const env = await getContent(h, "part-two", ".inf");
    expect(env.source).toContain("0xff");
    expect(env.source).toContain("1e3");
    expect(env.source).toContain(".inf");
    expect(env.source).toContain("~: the null-keyed value");
    expect(env.source).not.toContain("index.db"); // the hidden overlay's contents never leak
    expect(env.source).not.toContain("'.yo'"); // …nor the overlay key itself
  });

  it("slash-path decoding: digits are positions, `~` the null key; a bad path 404s", async () => {
    const { h } = await book();
    const chunk = await getContent(h, "part-one/2");
    expect(chunk.status).toBe(200);
    expect(chunk.header.path).toBe(":part-one:2");
    expect((chunk.root as Node & { value?: unknown }).value).toBe("The chunk before the deep members.");
    const missing = await getContent(h, "no/such/node");
    expect(missing.status).toBe(404);
  });

  it("relations ride the envelope verbatim (the `..` upstream marker)", async () => {
    const { h } = await book();
    const env = await getContent(h, "part-one/item01");
    const up = env.relations[".."] as Record<string, Record<string, unknown>>;
    expect(up?.$yamloverRef?.path).toBe(":part-one");
  });
});

function findByValue(n: Node, text: string): Node | null {
  const self = (n as Node & { value?: unknown }).value;
  if (self === text) return n;
  for (const e of n.entries ?? []) {
    if (isPointer(e.value)) continue;
    const hit = findByValue(e.value as Node, text);
    if (hit) return hit;
  }
  return null;
}
