import { NodeJson } from "../api";

/**
 * A renderer turns a node into a React element for the RHS pane. The registry is
 * the extension point for "renderable objects" — e.g. a future markdown renderer
 * for `contentMediaType: text/markdown`, or an image renderer for `image/png`.
 *
 * A node with a matching renderer here is also *excluded from the TOC* (it is
 * shown as content, not navigated as structure — see `hasRenderer` on the
 * server). v1 ships none, so every node falls through to the default YAML view.
 */
export interface Renderer {
  name: string;
  match: (node: NodeJson) => boolean;
  render: (node: NodeJson, onNavigate: (path: string) => void) => JSX.Element;
}

const REGISTRY: Renderer[] = [
  // e.g. { name: "markdown", match: n => ..., render: ... },
];

export function getRenderer(node: NodeJson): Renderer | null {
  return REGISTRY.find((r) => r.match(node)) ?? null;
}

// A renderer is keyed by a (type, format) tuple. Scalar types and object/array
// have built-in renderers; object/array ones are *passive* — they render the
// node but do NOT stop it from being expanded in the TOC. An *active* renderer
// (a custom format, e.g. an image or a rendered document) does: such a node is
// shown but not expanded (its internals are presented as content, not browsed).
const ACTIVE_FORMATS = new Set<string>([
  // e.g. "image/png", "text/markdown"
]);

/** Whether a (type, format) has an active custom renderer — if so the node is a
 *  leaf in the TOC even when it is a container. v1 registers none. */
export function isActiveRenderer(_type: string, format: string | null): boolean {
  return format != null && ACTIVE_FORMATS.has(format);
}
