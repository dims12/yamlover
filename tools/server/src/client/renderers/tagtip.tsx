import { ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchNode, TagRef } from "../api";
import { tagDisplayPath } from "../paths";
import { resolveTagColor, tagBody } from "./tag";

// A tag's BODY (its own text value) is not carried in the menu's tag index, so it is fetched
// once per path on first hover and remembered here — repeat hovers reuse it. `null` means
// "fetched, but the tag has no body"; `undefined` (absent) means "not fetched yet".
const bodyCache = new Map<string, string | null>();

/** Wraps a tag chip (badge / swatch / suggestion) and shows a COLOURED hover-card revealing the
 *  tag's full identity — line 1 the canonical path (the `tags:` prefix dropped, a space after each
 *  colon), line 2 the tag's text value when it has one. Replaces the native `title` tooltip, which
 *  browsers will not let us colour. Rendered through a portal so it escapes the menu's / table's
 *  `overflow` clipping; `body` may be supplied to skip the lazy fetch when already known. */
export function TagTip({
  tag,
  body,
  children,
}: {
  tag: { path: string; name: string; color?: string | null } | TagRef;
  body?: string | null;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [text, setText] = useState<string | null>(body ?? bodyCache.get(tag.path) ?? null);

  // Lazily fetch the tag body the first time we hover a tag whose body we don't know yet.
  useEffect(() => {
    if (!pos || body != null || bodyCache.has(tag.path)) return;
    let on = true;
    fetchNode(tag.path, 1)
      .then((n) => tagBody(n.value))
      .catch(() => null)
      .then((b) => {
        bodyCache.set(tag.path, b ?? null);
        if (on) setText(b ?? null);
      });
    return () => { on = false; };
  }, [pos, tag.path, body]);

  const show = () => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 4 });
  };
  const hide = () => setPos(null);

  const color = resolveTagColor({ name: tag.name, color: (tag as TagRef).color });
  const value = body ?? text;

  return (
    <span ref={anchorRef} className="tagtip-anchor" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {pos &&
        createPortal(
          <span className="tagtip" style={{ left: pos.left, top: pos.top, background: color }}>
            <span className="tagtip-path">{tagDisplayPath(tag.path)}</span>
            {value && <span className="tagtip-value">{value}</span>}
          </span>,
          document.body,
        )}
    </span>
  );
}
