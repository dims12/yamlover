import { ReactNode } from "react";

/**
 * A click-to-open wrapper for an inline chapter chunk (an image or a map). Inside a chapter's flow
 * we render these as a **plain, static preview** — no pan/zoom, no Leaflet controls — because the
 * reading page should stay calm and scrollable. The full interactive viewer is always one click
 * away: this anchor SPA-navigates to the resource's own page (its JSON-space `path`), where the
 * pan/zoom gestures live. A no-op passthrough when there is nowhere to navigate.
 */
export function OpenChunk({
  path,
  onNavigate,
  title,
  children,
}: {
  path: string;
  onNavigate?: (path: string) => void;
  title: string;
  children: ReactNode;
}) {
  if (!onNavigate || !path) return <>{children}</>;
  return (
    <a
      className="chunk-open"
      href={path}
      title={title}
      onClick={(e) => {
        e.preventDefault();
        onNavigate(path);
      }}
    >
      {children}
    </a>
  );
}
