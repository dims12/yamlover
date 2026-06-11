import { useEffect, useState } from "react";
import { NodeJson, fetchTagged } from "../api";
import { asLink, Link } from "../render";
import { typeIcon } from "../icons";
import { TAG_FORMAT, tagLabel, tagBody, resolveTagColor } from "./tag";
import { displayPath, displayKey } from "../paths";
import { touchesYamlover, useDiffBump } from "../live";

const ANNOTATION_FORMAT = "x-yamlover-annotation";
const MIXED_KEY = "$yamloverMixed";

// ---- the view mode: a URL parameter (`?view=`), so a view is a shareable link ---- //

const VIEWS = ["large", "small"] as const;
type ViewMode = (typeof VIEWS)[number];
const DEFAULT_VIEW: ViewMode = "large";
const params = () => new URLSearchParams(window.location.search);

/** The grid view from the URL's `?view=`, or the default (an unknown value ignored). */
export function explorerViewMode(): ViewMode {
  const v = params().get("view");
  return (VIEWS as readonly string[]).includes(v ?? "") ? (v as ViewMode) : DEFAULT_VIEW;
}

function writeViewMode(v: ViewMode): void {
  const q = params();
  if (v === DEFAULT_VIEW) q.delete("view");
  else q.set("view", v);
  const qs = q.toString();
  window.history.replaceState({}, "", window.location.pathname + (qs ? "?" + qs : ""));
}

/** The view selector beside the explorer tab (the renderer's `config` hook) — writes
 *  `?view=` and rerenders, like the plaintext encoding control. */
export function ExplorerViewControl({ rerender }: { rerender: () => void }) {
  return (
    <label className="enc-control">
      view{" "}
      <select
        value={explorerViewMode()}
        onChange={(e) => {
          writeViewMode(e.target.value as ViewMode);
          rerender();
        }}
      >
        <option value="large">large icons</option>
        <option value="small">small icons</option>
      </select>
    </label>
  );
}

/**
 * The EXPLORER renderer — a directory (or a tag) as a desktop file manager:
 * every member an icon + label, with the node's reverse UPLINKS (`relations`:
 * the `..` parent and each upstream `*`/`~` source) leading the grid as
 * visually distinct items. Two views, chosen by the `?view=` URL parameter
 * (a renderer param, like the markup width or the CSV options): **large
 * icons** (the default — tiles, the icon above the label) and **small icons**
 * (rows, the icon beside the label).
 *
 * It claims two shapes:
 *   - a node stored as a filesystem directory (`concrete` `dir`/`yamlover`,
 *     the registry's concrete fallback) — ALL members show, not just files:
 *     scalar members read `key: value`, containers and binaries link onward;
 *   - a tag (`x-yamlover-tag`) — the members are the MATERIALS filed under it
 *     (GET /api/tagged: annotations resolved to their `target`, deduped),
 *     alongside its owned fields (subtags as colored badges); the mediating
 *     annotation nodes themselves stay out of the grid.
 */

/** One grid item: a navigable link marker (or a defensive non-link member). */
export interface ExplorerItem {
  key: string; // the label source: a member key, `[i]`, or a relation key (`..`, `/eve`, …)
  link: Link | null;
  raw?: unknown; // the value when it is not a link marker (rendered inert)
  up?: boolean; // an uplink (relations) item — shown first, styled distinct
}

/** The uplink items: the node's `relations` in server order (`..` always first). */
export function uplinkItems(relations?: Record<string, unknown>): ExplorerItem[] {
  return Object.entries(relations ?? {})
    .map(([key, v]) => ({ key, link: asLink(v), up: true }))
    .filter((it) => it.link != null);
}

/** The member items, from any depth-1 projection shape: a plain object's entries, an array's
 *  items, or a `$yamloverMixed` marker's entries (the omni self-value is the BODY — shown in
 *  the header, not the grid). At depth 1 every member arrives as a `$yamloverLink` marker;
 *  a non-link value is kept defensively as an inert label. */
export function memberItems(node: NodeJson): ExplorerItem[] {
  const v = node.value;
  if (Array.isArray(v)) return v.map((item, i) => ({ key: `[${i}]`, link: asLink(item), raw: item }));
  if (!v || typeof v !== "object") return [];
  const mixed = (v as Record<string, unknown>)[MIXED_KEY] as
    | { entries?: { key: string | null; value: unknown }[] }
    | undefined;
  if (Object.keys(v).length === 1 && mixed?.entries) {
    return mixed.entries.map((e, i) => ({ key: e.key ?? `[${i}]`, link: asLink(e.value), raw: e.value }));
  }
  return Object.entries(v as Record<string, unknown>).map(([key, val]) => ({ key, link: asLink(val), raw: val }));
}

/** A scalar member's value as a short label tail (`key: <this>`) — its first line,
 *  capped (a long text would bloat the DOM; the CSS ellipsis only hides overflow). */
function scalarText(v: unknown): string {
  if (v === null || v === undefined) return "~";
  const line = String(v).split("\n", 1)[0];
  return line.length > 80 ? line.slice(0, 79) + "…" : line;
}

/** A scalar whose format marks it file-like CONTENT (a media type such as `text/markdown`,
 *  or an `x-yamlover-…` shape) — its value is the whole document, not a datum: the grid
 *  shows just the name (the icon already says what it is). A schema VALUE format (`date`,
 *  `email`, …) keeps the `key: value` form. */
function isDocFormat(f?: string | null): boolean {
  return !!f && (f.includes("/") || f.startsWith("x-yamlover-"));
}

function Item({ it, onNavigate }: { it: ExplorerItem; onNavigate: (path: string) => void }) {
  const link = it.link;
  if (!link) {
    // not a marker (unexpected at depth 1) — an inert label, no navigation
    return (
      <span className="dirview-item">
        <span className="dirview-icon t-bin">•</span>
        <span className="dirview-label">{it.key}: {scalarText(it.raw)}</span>
      </span>
    );
  }
  const g = typeIcon(link.type ?? link.kind, link.format ?? null, link.concrete);
  // an uplink labels by its (decoded) relation key; a member by title, else its key
  const name = it.up ? displayKey(it.key) : link.title ?? it.key;
  const label =
    link.format === TAG_FORMAT ? (
      // a tag member (e.g. a subtag) keeps its badge color everywhere
      <span className="tagtag" style={{ background: resolveTagColor({ name, color: link.color }) }}>{name}</span>
    ) : link.kind === "scalar" && !isDocFormat(link.format) ? (
      <>
        {name}: <span className="val">{scalarText(link.value)}</span>
      </>
    ) : (
      name
    );
  return (
    <a
      className={"dirview-item" + (it.up ? " dirview-up" : "")}
      href={link.path}
      title={displayPath(link.path)}
      onClick={(e) => {
        e.preventDefault();
        onNavigate(link.path);
      }}
    >
      <span className={"dirview-icon " + g.cls} title={g.title}>{g.glyph}</span>
      <span className="dirview-label">{label}</span>
    </a>
  );
}

export function ExplorerView({ node, onNavigate }: { node: NodeJson; onNavigate: (path: string) => void }) {
  const isTag = node.format === TAG_FORMAT;
  // a tag's materials (annotations resolved to their targets) — fetched per tag page, refetched
  // when a diff (live.ts) touches a `.yamlover` file (an annotation created/deleted anywhere)
  const [tagged, setTagged] = useState<Link[]>([]);
  const diffBump = useDiffBump(touchesYamlover);
  useEffect(() => {
    setTagged([]);
    if (!isTag) return;
    let cancelled = false;
    fetchTagged(node.path)
      .then((arr) => {
        if (!cancelled) setTagged(arr.map(asLink).filter((l): l is Link => l != null));
      })
      .catch(() => {}); // the owned members still show
    return () => {
      cancelled = true;
    };
  }, [node.path, isTag, diffBump]);

  const ups = uplinkItems(node.relations);
  let members = memberItems(node);
  if (isTag) {
    // the raw back-edge members are the mediating ANNOTATION nodes — the grid shows the
    // materials from /api/tagged instead (directly-tagged nodes are in both → dedup by path)
    members = members.filter((m) => m.link?.format !== ANNOTATION_FORMAT);
    const have = new Set(members.map((m) => m.link?.path).filter(Boolean));
    for (const l of tagged) if (!have.has(l.path)) members.push({ key: tagLabel(l.path, l.title), link: l });
  }
  const items = [...ups, ...members];

  // a tag page's description is its BODY (the header bar already names the node)
  const desc = (isTag ? tagBody(node.value) : null) ?? node.description;
  return (
    <div className="explorerview">
      {desc && (
        <div className="dirhead">
          <p className="tagdesc">{desc}</p>
        </div>
      )}
      <div className={"dirview" + (explorerViewMode() === "large" ? " dirview-lg" : "")}>
        {items.map((it, i) => (
          <Item key={`${it.up ? "^" : ""}${it.link?.path ?? it.key}#${i}`} it={it} onNavigate={onNavigate} />
        ))}
        {items.length === 0 && <span className="dirview-empty">empty</span>}
      </div>
    </div>
  );
}
