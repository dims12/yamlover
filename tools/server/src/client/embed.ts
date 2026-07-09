// The single **embed** resolver: a marklower `*[label](target)` target → the concrete thing that
// should be inlined for it. Pure (no React, no DOM), so the renderer, the HTML→marklower
// serializers, and tests all agree on what a target means.
//
// A target is whatever `resolveLink` accepts — an in-app JSON-space path (its bytes come from the
// blob endpoint) or an external `scheme://` URL — and the *kind* is inferred the way the server
// infers a blob's Content-Type: by provider host first, then by extension.
//
// Providers that become an `<iframe>` are an ALLOWLIST. An unrecognized host resolves to `null`,
// and the caller falls back to a plain link: prose must never be able to mount an arbitrary origin
// in a frame.

import { blobUrl } from "./api";
import { resolveLink } from "./links";

/** What a target inlines to. `path` is set when the source is an in-app node (so the embed can be
 *  clicked through to the node's own page); absent for external URLs. */
export type Embed =
  | { kind: "iframe"; provider: "youtube" | "vimeo"; src: string; poster: string | null }
  | { kind: "video"; src: string; path?: string }
  | { kind: "audio"; src: string; path?: string }
  | { kind: "image"; src: string; path?: string };

const VIDEO_EXT = /\.(mp4|webm|ogv|mov|m4v)$/i;
const AUDIO_EXT = /\.(mp3|ogg|oga|wav|flac|m4a|aac)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

/** The kinds a bare file can be — everything except `iframe`, which only a provider produces. */
type MediaKind = "video" | "audio" | "image";

/** A media kind from a pathname's extension — the fallback once no provider claims the host. */
function byExtension(pathname: string): MediaKind | null {
  if (VIDEO_EXT.test(pathname)) return "video";
  if (AUDIO_EXT.test(pathname)) return "audio";
  if (IMAGE_EXT.test(pathname)) return "image";
  return null;
}

/** A YouTube/Vimeo start offset in seconds, from the `t`/`start` param. Accepts the bare seconds
 *  YouTube emits (`90`, `90s`) and the colloquial spelling its share links use (`1m30s`, `1h2m3s`). */
function startSeconds(raw: string | null): number | null {
  if (!raw) return null;
  if (/^\d+s?$/.test(raw)) return Number(raw.replace(/s$/, ""));
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(raw);
  if (!m || !m[0]) return null;
  const secs = Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return secs || null;
}

/** The YouTube video id, across every spelling the site hands out: `youtu.be/ID`,
 *  `/watch?v=ID`, `/embed/ID`, `/shorts/ID`, `/live/ID`. */
function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^www\.|^m\./, "");
  const seg = u.pathname.split("/").filter(Boolean);
  if (host === "youtu.be") return seg[0] ?? null;
  if (host !== "youtube.com" && host !== "youtube-nocookie.com") return null;
  if (seg[0] === "watch") return u.searchParams.get("v");
  if (seg[0] === "embed" || seg[0] === "shorts" || seg[0] === "live") return seg[1] ?? null;
  return null;
}

/** The Vimeo video id: `vimeo.com/123` or `player.vimeo.com/video/123`. */
function vimeoId(u: URL): string | null {
  const host = u.hostname.replace(/^www\./, "");
  const seg = u.pathname.split("/").filter(Boolean);
  if (host === "vimeo.com") return /^\d+$/.test(seg[0] ?? "") ? seg[0] : null;
  if (host === "player.vimeo.com" && seg[0] === "video") return /^\d+$/.test(seg[1] ?? "") ? seg[1] : null;
  return null;
}

/** An allowlisted video provider → its privacy-preserving embed URL, carrying the start offset the
 *  original link asked for. `youtube-nocookie.com` is the no-tracking host; Vimeo has no equivalent
 *  and takes `dnt=1`. The poster lets the caller render a click-to-play facade instead of mounting
 *  the frame (and its third-party scripts) on page load. */
function byProvider(u: URL): Embed | null {
  const start = startSeconds(u.searchParams.get("t") ?? u.searchParams.get("start"));

  const yt = youtubeId(u);
  if (yt) {
    const q = start ? `?start=${start}` : "";
    return {
      kind: "iframe",
      provider: "youtube",
      src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(yt)}${q}`,
      poster: `https://i.ytimg.com/vi/${encodeURIComponent(yt)}/hqdefault.jpg`,
    };
  }

  const vm = vimeoId(u);
  if (vm) {
    const q = start ? `?dnt=1#t=${start}s` : "?dnt=1";
    return { kind: "iframe", provider: "vimeo", src: `https://player.vimeo.com/video/${vm}${q}`, poster: null };
  }

  return null;
}

/**
 * Resolve a `*[label](target)` target to the thing that should be inlined, or `null` when the
 * target is not embeddable (an ordinary page, an unknown host, an unresolvable path) — the caller
 * then renders it as a plain link, which is always a safe degradation.
 */
export function embed(target: string, documentPath?: string): Embed | null {
  const { path, href } = resolveLink(target, documentPath);

  if (path) {
    // An in-app node: its bytes stream from the blob endpoint, its kind comes from its own name.
    const kind = byExtension(path);
    return kind ? { kind, src: blobUrl(path), path } : null;
  }

  if (!href) return null;

  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null; // no mailto:, no data:, no javascript:

  const provider = byProvider(u);
  if (provider) return provider;

  const kind = byExtension(u.pathname);
  return kind ? { kind, src: href } : null; // a direct media file — served by whoever hosts it
}

/**
 * Would {@link embed} claim this target? The same allowlist, asked as a yes/no — for the HTML →
 * marklower serializers, which decide whether a pasted `<img>`/`<iframe>` becomes an embed token
 * and never need the resolved `src`.
 *
 * Defined as `embed(…) !== null` rather than as a second copy of the rules: one allowlist, so a
 * host added here can't be a host the serializers still refuse (or, worse, the reverse).
 */
export function isEmbeddable(target: string, documentPath?: string): boolean {
  return embed(target, documentPath) !== null;
}
