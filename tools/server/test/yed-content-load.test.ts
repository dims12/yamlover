// THE ONE-WIRE yed loader — irFromContent over a REAL handler's /api/content (the old
// yed-load.test.ts hand-built wire shapes; this suite reads the same facts off the live
// envelope, so the loader and the endpoint can never drift apart).
import { describe, it, expect } from "vitest";
import { createHandlers, tmpExample } from "./helpers";
import { callText } from "./http";
import { decodeEnvelope } from "../src/client/content";
import { irFromContent } from "../src/client/renderers/yed-content-load";
import { isPointer, type Document, type Entry, type Node } from "../../parser/ts/src/ir.ts";

type Handler = Parameters<typeof callText>[0];

async function load(h: Handler, slash: string): Promise<Document> {
  const r = await callText(h, `/api/content${slash ? "/" + slash : ""}`, { depth: ".inf" });
  expect(r.status, r.text.slice(0, 200)).toBe(200);
  return irFromContent(decodeEnvelope(r.text));
}

const entryByAnchor = (n: Node, key: string): Entry | undefined =>
  (n.entries ?? []).find((e) => ((e.meta ?? {}) as { anchorKey?: string }).anchorKey === key);

describe("irFromContent — the yed editors' load over the real wire", () => {
  it("members, blobs, refs, formats — the sidecar stamps the parsed IR", async () => {
    const h = createHandlers(tmpExample("74-deep-book"), { gitignore: false });
    await h.ready;

    const doc = await load(h as unknown as Handler, "");
    expect(doc.source.concrete).toBe("dir/.yo");
    expect(doc.source.uri).toBe(":");

    // a body-positioned member: KEYLESS entry + anchorKey provenance (the sync's address)
    const partOne = entryByAnchor(doc.root, "part-one");
    expect(partOne).toBeTruthy();
    expect(partOne!.key).toBeNull();
    expect((partOne!.value as Node & { value?: unknown }).value).toBe("Part One");

    // the keyed-remainder member keeps its key, NO anchorKey
    const partOneNode = partOne!.value as Node;
    const stray = (partOneNode.entries ?? []).find((e) => e.key === "stray");
    expect(stray).toBeTruthy();
    expect(((stray!.meta ?? {}) as { anchorKey?: string }).anchorKey).toBeUndefined();

    // the BLOB member: an opaque atom wearing its link face (the wire's cut pointer replaced)
    const cover = entryByAnchor(doc.root, "cover.png");
    expect(cover).toBeTruthy();
    expect((cover!.value as Node).kind).toBe("blob");
    const link = ((cover!.value as Node).meta as { link?: { path: string; format?: string } }).link;
    expect(link?.path).toBe(":cover.png");
    expect(link?.format).toBe("image/png");

    // THE FORMAT LAW: a scalar LEAF is never side-stamped (the old wire never carried a
    // format for one) — the latex chunk's format is its AUTHORED tag, parsed natively into
    // meta.schema from the source text; containers DO carry the engine-resolved format
    const deep = entryByAnchor(partOneNode, "01-deep")!.value as Node;
    const latex = (deep.entries ?? []).map((e) => e.value)
      .find((v) => !isPointer(v) && ((v as Node).meta as { schema?: unknown } | undefined)?.schema !== undefined
        && (v as Node & { value?: unknown }).value === "e = mc^2");
    expect(latex).toBeTruthy();
    expect(((latex as Node).meta as { derivedFormat?: string }).derivedFormat).toBeUndefined();
    expect(((deep.meta ?? {}) as { derivedFormat?: string }).derivedFormat).toBe("x-yamlover-chapter");

    // a realized reference keeps its authored raw and gains the resolved refPath
    const item01 = entryByAnchor(partOneNode, "item01")!.value as Node;
    const ref = (item01.entries ?? []).find((e) => isPointer(e.value));
    expect(ref).toBeTruthy();
    expect((ref!.value as { raw?: string }).raw).toBe("..: ..");
    expect((ref!.value as { refPath?: string }).refPath).toBe(":");

    // incoming `~` pseudo-entries are the PROJECTION's, never the editor's: misc.yo holds
    // only its authored keys (the old wire injected `kin` here — the latent diff bug)
    const partTwo = entryByAnchor(doc.root, "part-two")!.value as Node;
    const misc = (partTwo.entries ?? []).find((e) => e.key === "misc.yo")!.value as Node;
    expect((misc.entries ?? []).map((e) => e.key)).toEqual(["just", "list"]);
  });
});
