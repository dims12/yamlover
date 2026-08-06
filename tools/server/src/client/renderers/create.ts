// The client side of generic object creation (the right-click "＋ New …" menu). Creating an object =
// instantiating a schema in a chosen CONCRETE (storage form). This module OWNS the creatable-schema
// registry — the server knows nothing about chapters; it is handed a `meta` tag and a body — labels
// each schema by its TITLE (or its PATH when it has none, the case for every current `$defs`), and
// computes which schemas + concretes apply at a given target node. The actual write is
// `createObject` (api.ts) → POST /api/edit with `op:"insert"`.

import { useEffect, useState } from "react";
import { fetchNode } from "../api";
import { displayPath } from "../paths";
import { isDirConcrete } from "../../concrete";
import { allowedChildConcretes, defaultChildConcrete, type ChildConcrete } from "../../concrete-rules";

interface CreatableSchema {
  schema: string; // the schema's client path (also the server registry key)
  childOf: string[]; // parent node formats that accept it as an inline/linked CHILD
}
const CREATABLE_SCHEMAS: CreatableSchema[] = [
  { schema: "::yamlover:$defs:chapter", childOf: ["x-yamlover-chapter", "x-yamlover-task"] },
];

export interface ConcreteOption { id: string; label: string }
export interface Creatable {
  schema: string;
  label: string; // schema title, else the schema path
  concretes: ConcreteOption[];
  defaultConcrete: string;
}

// The storage options and the default come from the RULES module (concrete-rules.ts) — this
// file only maps concrete ids to their menu labels.
const CONCRETE_LABELS: Record<ChildConcrete, string> = {
  "yamlover": "inline",
  "file/yamlover": "file",
  "dir/.yo": "directory",
  "dir/index.yo": "directory", // the same offer, spelled in the parent's overlay flavor
};
const options = (parent: string | null | undefined, kind: "child" | "member"): ConcreteOption[] =>
  allowedChildConcretes(parent, kind).map((id) => ({ id, label: CONCRETE_LABELS[id] }));

/** The schemas creatable AT `node` (its format/concrete), each with its concrete options + default.
 *  A child of a compatible parent, else a member of a directory, else nothing. Which concretes are
 *  OFFERED and which one is the DEFAULT are the inheritance rules' calls (concrete-rules.ts —
 *  a directory-concrete chapter defaults subchapters to subdirectories, the ex-66 shape; a
 *  single-file chapter defaults inline). `labels` maps a schema to its (fetched) title; the
 *  schema path is the fallback. */
export function creatablesFor(node: { format?: string | null; concrete?: string | null }, labels: Record<string, string>): Creatable[] {
  const out: Creatable[] = [];
  for (const c of CREATABLE_SCHEMAS) {
    const label = labels[c.schema] || schemaLabel(c.schema);
    if (node.format && c.childOf.includes(node.format)) {
      out.push({ schema: c.schema, label, concretes: options(node.concrete, "child"), defaultConcrete: defaultChildConcrete(node.concrete) });
    } else if (isDirConcrete(node.concrete)) {
      out.push({ schema: c.schema, label, concretes: options(node.concrete, "member"), defaultConcrete: defaultChildConcrete(node.concrete) });
    }
  }
  // Any filesystem directory (a plain dir OR a dir-backed document) can also gain a generic NODE —
  // an UNTAGGED yamlover document (no schema meta, an empty scalar body), stored as a member file
  // or (the default) a dir/.yo directory. Creating one opens it in yamlover editing mode.
  if (isDirConcrete(node.concrete)) {
    out.push({ schema: NODE_SCHEMA, label: "node", concretes: options(node.concrete, "member"), defaultConcrete: defaultChildConcrete(node.concrete) });
  }
  return out;
}

/** The pseudo-schema key of the generic-node create entry — no real schema backs it; App routes it
 *  to {@link createNode} (api.ts) instead of `createObject`. */
export const NODE_SCHEMA = "node";

/** The readable schema path shown when a schema has no title — the leading `:` and the redundant
 *  `yamlover` self-import authority trimmed (e.g. `::yamlover:$defs:chapter` → `$defs: chapter`). */
function schemaLabel(schema: string): string {
  return displayPath(schema).replace(/^:\s?/, "").replace(/^yamlover:\s?/, "");
}

// The schema titles, fetched once per session (cached like the color palette). No `$defs` schema has
// a title today, so this stays empty and every label falls back to the path — but a future titled
// schema is picked up automatically.
let labelsPromise: Promise<Record<string, string>> | null = null;
async function loadLabels(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    CREATABLE_SCHEMAS.map(async (c) => {
      try {
        const n = await fetchNode(c.schema, 0);
        if (n.title) out[c.schema] = n.title;
      } catch {
        /* schema not resolvable here — fall back to the path */
      }
    }),
  );
  return out;
}

export function useCreatableLabels(): Record<string, string> {
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    labelsPromise ??= loadLabels();
    let live = true;
    labelsPromise.then((l) => { if (live) setLabels(l); });
    return () => { live = false; };
  }, []);
  return labels;
}
