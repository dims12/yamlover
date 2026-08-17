// A minimal MIME reader for the `.eml` renderer (RFC 5322 + RFC 2045/2046/2047).
//
// Hand-written and dependency-free, like the rest of this repo's parsers. It reads what a mail
// archive actually contains rather than the whole of MIME: headers, nested multiparts, the
// three transfer encodings that occur in practice, and RFC 2047 encoded words. Charset work is
// `TextDecoder`'s — the WHATWG Encoding Standard covers koi8-r, windows-1251, iso-2022-jp and
// gb2312, which is exactly what a twenty-year-old mailbox is full of.
//
// EVERYTHING RUNS ON A LATIN-1 STRING. Decoding the raw bytes as latin1 is lossless and
// bijective (one byte ↔ one code unit), so the structural parse can use ordinary string
// operations and only the leaf bodies are turned back into bytes for their real charset. This
// is the standard trick and it keeps the whole file free of manual byte scanning.

export interface MimePart {
  /** Every header, in source order, names as written: `[name, value]`. */
  headers: [string, string][];
  /** Lowercased `type/subtype`, defaulting to `text/plain` as RFC 2045 requires. */
  contentType: string;
  /** Lowercased Content-Type parameters (`charset`, `boundary`, `name`). */
  params: Record<string, string>;
  /** Lowercased Content-Disposition value (`inline`, `attachment`), or "". */
  disposition: string;
  /** The filename this part announces, from either header. */
  filename: string | null;
  /** The part's own bytes, transfer-encoding already undone. Empty for a multipart. */
  body: Uint8Array;
  /** Child parts, for a multipart. */
  parts: MimePart[];
}

const bytesOf = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const latin1 = (b: Uint8Array): string => new TextDecoder("latin1").decode(b);

/** Parse a whole message. Never throws: a malformed part degrades to its raw bytes. */
export function parseEml(bytes: Uint8Array): MimePart {
  return parsePart(latin1(bytes));
}

function parsePart(raw: string): MimePart {
  const split = splitHeaders(raw);
  const headers = unfold(split.head);
  const ct = parseParams(headerOf(headers, "content-type") ?? "text/plain");
  const cd = parseParams(headerOf(headers, "content-disposition") ?? "");
  const encoding = (headerOf(headers, "content-transfer-encoding") ?? "").trim().toLowerCase();
  const contentType = ct.value.toLowerCase() || "text/plain";

  const part: MimePart = {
    headers,
    contentType,
    params: ct.params,
    disposition: cd.value.toLowerCase(),
    filename: cd.params.filename ?? ct.params.name ?? null,
    body: new Uint8Array(0),
    parts: [],
  };

  if (contentType.startsWith("multipart/") && ct.params.boundary) {
    part.parts = splitMultipart(split.body, ct.params.boundary).map(parsePart);
    return part;
  }
  // `message/rfc822` nests a whole message; read it as one part so a forwarded mail is
  // navigable rather than a wall of bytes.
  if (contentType === "message/rfc822") {
    part.parts = [parsePart(decodeTransfer(split.body, encoding, true))];
    return part;
  }
  part.body = bytesOf(decodeTransfer(split.body, encoding, true));
  return part;
}

/** The blank line that ends the header block; tolerant of bare-LF messages. */
function splitHeaders(raw: string): { head: string; body: string } {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  const at = crlf >= 0 && (lf < 0 || crlf <= lf) ? crlf : lf;
  if (at < 0) return { head: raw, body: "" };
  return { head: raw.slice(0, at), body: raw.slice(at + (at === crlf ? 4 : 2)) };
}

/** Header lines, continuation lines folded back on (RFC 5322 §2.2.3). */
function unfold(head: string): [string, string][] {
  const out: [string, string][] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1][1] += " " + line.trim();
      continue;
    }
    const at = line.indexOf(":");
    if (at > 0) out.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return out;
}

export function headerOf(headers: [string, string][], name: string): string | null {
  const want = name.toLowerCase();
  for (const [k, v] of headers) if (k.toLowerCase() === want) return v;
  return null;
}

/** `value; k=v; k="v"` → the value plus lowercased parameter names. */
function parseParams(raw: string): { value: string; params: Record<string, string> } {
  const parts = splitUnquoted(raw, ";");
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const at = p.indexOf("=");
    if (at < 0) continue;
    let k = p.slice(0, at).trim().toLowerCase();
    let v = p.slice(at + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    // RFC 2231 `name*=charset'lang'pct-encoded`, common enough to be worth the four lines
    if (k.endsWith("*")) {
      k = k.slice(0, -1);
      const m = v.match(/^([^']*)'[^']*'(.*)$/);
      if (m) v = decodeBytes(bytesOf(percentDecode(m[2])), m[1]);
    }
    params[k] = v;
  }
  return { value: parts[0]?.trim() ?? "", params };
}

function splitUnquoted(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    if (c === sep && !quoted) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function percentDecode(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** Split a multipart body on its boundary, dropping the preamble and epilogue. */
function splitMultipart(body: string, boundary: string): string[] {
  const marker = "--" + boundary;
  const out: string[] = [];
  const lines = body.split(/\r?\n/);
  let cur: string[] | null = null;
  for (const line of lines) {
    if (line.trimEnd() === marker) {
      if (cur) out.push(cur.join("\r\n"));
      cur = [];
      continue;
    }
    if (line.trimEnd() === marker + "--") break; // the close-delimiter ends the part list
    if (cur) cur.push(line);
  }
  if (cur) out.push(cur.join("\r\n"));
  return out;
}

/** Undo `base64` / `quoted-printable`; everything else is already the bytes. */
function decodeTransfer(body: string, encoding: string, _leaf: boolean): string {
  if (encoding === "base64") {
    try {
      return atob(body.replace(/[^A-Za-z0-9+/=]/g, ""));
    } catch {
      return body; // truncated or corrupt base64: show what is there
    }
  }
  if (encoding === "quoted-printable") {
    return body
      .replace(/=\r?\n/g, "") // soft line breaks
      .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

/** Bytes → text in the named charset, falling back rather than throwing. */
export function decodeBytes(bytes: Uint8Array, charset?: string | null): string {
  for (const label of [charset ?? "", "utf-8", "latin1"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // an unknown label — try the next
    }
  }
  return latin1(bytes);
}

/** A text part's content, decoded with its declared charset. */
export function partText(part: MimePart): string {
  return decodeBytes(part.body, part.params.charset);
}

/** RFC 2047 encoded words (`=?koi8-r?B?…?=`), as they appear in Subject and From. */
export function decodeWords(s: string): string {
  return s.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?=&#61;\?|=\?))?/g,
    (_all, charset: string, kind: string, text: string) => {
      try {
        const raw =
          kind.toLowerCase() === "b"
            ? atob(text.replace(/[^A-Za-z0-9+/=]/g, ""))
            : text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
        const decoded = decodeBytes(bytesOf(raw), charset);
        // A word that had a payload but decodes to nothing is not "an empty subject" — it is
        // a word we failed to read, and silently deleting it would hide that. `atob` does not
        // throw on rubbish, it returns "", so this is the only place the failure shows.
        return text.length > 0 && decoded.length === 0 ? _all : decoded;
      } catch {
        return _all; // undecodable: show the raw token rather than nothing
      }
    },
  );
}

/** Depth-first walk, this part first. */
export function walkParts(part: MimePart): MimePart[] {
  return [part, ...part.parts.flatMap(walkParts)];
}

/** The part to show as the body: the richest alternative that is not an attachment. */
export function pickBody(root: MimePart): { html: MimePart | null; text: MimePart | null } {
  let html: MimePart | null = null;
  let text: MimePart | null = null;
  for (const p of walkParts(root)) {
    if (p.disposition === "attachment" || p.parts.length > 0) continue;
    if (p.contentType === "text/html" && !html) html = p;
    else if (p.contentType.startsWith("text/") && !text) text = p;
  }
  return { html, text };
}

/** Named parts that are not the body — what a mail client lists as attachments. */
export function attachmentsOf(root: MimePart, body: { html: MimePart | null; text: MimePart | null }): MimePart[] {
  return walkParts(root).filter(
    (p) => p.parts.length === 0 && p !== root && p !== body.html && p !== body.text &&
      (p.disposition === "attachment" || p.filename != null),
  );
}
