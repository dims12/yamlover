// THE ONE-WIRE yed loader — replaces yed-load.ts's marker reconstruction. The parsed
// /api/content source IS the parser IR already (comments, raw spellings, flow/K&R, tags,
// anchors, selfAt, the null key — all authored, all parsed natively by the SHARED parser);
// this module only stamps the sidecar facts the text cannot spell:
//   - entry `meta.anchorKey` — a body-positioned member's storage provenance (the sync's
//     addressing, the move law, materialize's predictions all read it);
//   - node `meta.derivedFormat` — the engine's resolved format (extension folds, $defs);
//   - a pointer's resolved `refPath` (the ↗ affordance);
//   - a CUT member (a BLOB at unlimited depth) becomes the opaque atom with its link face —
//     the pointer was the wire's cut spelling, not authored content.
// Incoming `~` back-edges are deliberately NOT added: they are the projection's pseudo-
// entries, not authored content — an editor diff must never emit ops against them (the old
// wire's latent bug, fixed by construction here).

import { isPointer, type Document, type Node, type Value } from "../../../../parser/ts/src/ir.ts";
import type { Content, SideBucket } from "../content";

export function irFromContent(content: Content): Document {
  let root = content.doc.root;
  // the EMPTY document: empty source parses to a null scalar with raw "" — the editor owns
  // it as an empty CONTAINER, not a null scalar (the same rule the legacy loader applied);
  // an authored `null`/`~` keeps its raw and stays a scalar
  const r = root as Node & { value?: unknown; raw?: string };
  if (r.kind === "scalar" && r.value === null && r.raw === "" && !(r.entries ?? []).length) {
    root = { kind: "mapping", entries: [] } as unknown as Node;
  }
  stamp(root, "", content.side);
  return {
    root,
    ...(content.doc.head?.length ? { head: content.doc.head } : {}),
    source: {
      concrete: String(content.header.concrete ?? "yamlover"),
      uri: String(content.header.path ?? ":"),
    },
  } as unknown as Document;
}

function stamp(node: Node, frag: string, side: Record<string, SideBucket>): void {
  const bucket = side[frag];
  // THE FORMAT LAW (the old wire's): an engine-resolved format lands on CONTAINERS and the
  // document ROOT — never on a plain scalar leaf. A leaf's only format is its AUTHORED tag,
  // which rides the source text natively (meta.schema → explicitFormatOf's tag fold); the
  // schema-RESOLVED chapter format on a scalar member must not turn the chunk readonly.
  const isContainer = node.kind !== "scalar" || (node.entries ?? []).length > 0;
  if (bucket?.format !== undefined && (isContainer || frag === "")) {
    node.meta = { ...node.meta, derivedFormat: bucket.format };
  }
  let rendered = 0;
  for (const e of node.entries ?? []) {
    const back = (e as { edge?: string }).edge === "back";
    const nullKey = (e as { nullKey?: boolean }).nullKey === true;
    const tok = e.key !== null ? String(e.key) : nullKey ? "~" : String(rendered);
    if (!back) rendered++;
    const f = `${frag}/${encodeURIComponent(tok)}`;
    const b = side[f];
    if (b?.anchorKey !== undefined) {
      (e as { meta?: object }).meta = { ...(e as { meta?: object }).meta, anchorKey: b.anchorKey };
    }
    if (isPointer(e.value)) {
      if (b?.stub !== undefined && (b.anchorKey !== undefined || b.member === true)) {
        const info = ((b.stub as { $yamloverLink?: Record<string, unknown> }).$yamloverLink ?? {}) as Record<string, unknown>;
        e.value = {
          kind: "blob",
          entries: [],
          meta: {
            link: {
              path: String(info.path ?? ""),
              ...(info.title !== undefined ? { title: String(info.title) } : {}),
              ...(info.format !== undefined ? { format: String(info.format) } : {}),
              ...(info.yo === true ? { yo: true } : {}),
            },
            ...(info.format !== undefined ? { derivedFormat: String(info.format) } : {}),
          },
        } as unknown as Value;
      } else if (b?.refPath !== undefined) {
        (e.value as { refPath?: string }).refPath = b.refPath;
      }
      continue;
    }
    stamp(e.value as Node, f, side);
  }
}
