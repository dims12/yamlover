import { useEffect, useState } from "react";
import { NodeJson, blobUrl } from "../api";
import { Chunk } from "./registry";

/**
 * Renderer for an `application/rtf` (`.rtf`) document. RTF is a plain-text control
 * language; rather than pull in a heavy dependency we walk it with a compact,
 * dependency-free converter ({@link rtfToHtml}) that covers the common content:
 * paragraphs, bold/italic/underline runs, tabs/line breaks, hex (`\'xx`, CP-1252)
 * and `\uN` Unicode escapes — skipping the non-content destination groups
 * (`fonttbl`, `colortbl`, `stylesheet`, `info`, pictures, …). The result is shown
 * in the shared `.markup` body, like the Markdown/AsciiDoc renderers.
 */

// The handful of Windows-1252 code points that differ from Latin-1 (0x80–0x9F),
// used to decode `\'xx` bytes the way most RTF producers mean them.
const CP1252: Record<number, string> = {
  0x80: "€", 0x82: "‚", 0x83: "ƒ", 0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡",
  0x88: "ˆ", 0x89: "‰", 0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8e: "Ž", 0x91: "‘",
  0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•", 0x96: "–", 0x97: "—", 0x98: "˜",
  0x99: "™", 0x9a: "š", 0x9b: "›", 0x9c: "œ", 0x9e: "ž", 0x9f: "Ÿ",
};
const byteToChar = (b: number) => (b < 0x80 ? String.fromCharCode(b) : CP1252[b] ?? String.fromCharCode(b));

// Group destinations whose contents are not document text — skipped wholesale.
const SKIP_DESTS = new Set([
  "fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer",
  "footnote", "xmlnstbl", "themedata", "colorschememapping", "datastore",
  "latentstyles", "listtable", "listoverridetable", "rsidtbl", "generator",
  "operator", "creatim", "revtim", "printim", "buptim", "author", "title",
  "subject", "keywords", "comment", "company", "manager", "category", "doccomm",
  "hlinkbase", "filetbl", "mmathPr", "fldinst", "object", "nonshppict",
]);

interface Style {
  b: boolean;
  i: boolean;
  u: boolean;
  uc: number; // Unicode fallback skip count (\ucN)
}
interface Run {
  text: string;
  b: boolean;
  i: boolean;
  u: boolean;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Convert RTF source to an HTML string (a sequence of `<p>` paragraphs with
 *  `<strong>`/`<em>`/`<u>` runs). Best-effort: unknown control words are ignored. */
export function rtfToHtml(rtf: string): string {
  const paragraphs: Run[][] = [];
  let runs: Run[] = [];
  let st: Style = { b: false, i: false, u: false, uc: 1 };
  const stack: Style[] = [];
  let depth = 0;
  let skipDepth = Infinity; // skip content while depth >= skipDepth
  const n = rtf.length;
  let i = 0;

  const active = () => depth < skipDepth;
  const emit = (t: string) => {
    if (!t || !active()) return;
    const last = runs[runs.length - 1];
    if (last && last.b === st.b && last.i === st.i && last.u === st.u) last.text += t;
    else runs.push({ text: t, b: st.b, i: st.i, u: st.u });
  };
  const endPara = () => {
    if (!active()) return;
    paragraphs.push(runs);
    runs = [];
  };

  const control = (word: string, param: number | null) => {
    switch (word) {
      case "b": st.b = param !== 0; break;
      case "i": st.i = param !== 0; break;
      case "ul": st.u = param !== 0; break;
      case "ulnone": st.u = false; break;
      case "uc": st.uc = param ?? 1; break;
      case "par": case "row": endPara(); break;
      case "line": case "sect": emit("\n"); break;
      case "tab": case "cell": emit("\t"); break;
      case "pard": case "plain": st.b = st.i = st.u = false; break;
      default:
        if (SKIP_DESTS.has(word)) skipDepth = Math.min(skipDepth, depth);
        break;
    }
  };

  while (i < n) {
    const c = rtf[i];
    if (c === "{") {
      stack.push({ ...st });
      depth++;
      i++;
    } else if (c === "}") {
      depth--;
      if (depth < skipDepth) skipDepth = Infinity;
      st = stack.pop() ?? st;
      i++;
    } else if (c === "\\") {
      const next = rtf[i + 1];
      if (next === "\\" || next === "{" || next === "}") {
        emit(next);
        i += 2;
      } else if (next === "*") {
        skipDepth = Math.min(skipDepth, depth); // ignorable destination
        i += 2;
      } else if (next === "'") {
        const b = parseInt(rtf.substr(i + 2, 2), 16);
        if (!isNaN(b)) emit(byteToChar(b));
        i += 4;
      } else if (next === "~") {
        emit(" "); i += 2; // non-breaking space
      } else if (next === "-") {
        i += 2; // optional hyphen — drop
      } else if (/[a-zA-Z]/.test(next ?? "")) {
        let j = i + 1;
        while (j < n && /[a-zA-Z]/.test(rtf[j])) j++;
        const word = rtf.slice(i + 1, j);
        let num = "";
        if (rtf[j] === "-") { num += "-"; j++; }
        while (j < n && /[0-9]/.test(rtf[j])) num += rtf[j++];
        const param = num === "" ? null : parseInt(num, 10);
        if (rtf[j] === " ") j++; // a single trailing space delimits, and is consumed
        i = j;
        if (word === "u" && param !== null) {
          if (active()) emit(String.fromCodePoint(param < 0 ? param + 0x10000 : param));
          // skip the \ucN fallback characters that follow the \u
          for (let skip = st.uc; skip > 0 && i < n; skip--) {
            if (rtf[i] === "\\" && rtf[i + 1] === "'") i += 4;
            else if (rtf[i] === "\\") i += 2;
            else if (rtf[i] === "{" || rtf[i] === "}") break;
            else i++;
          }
        } else {
          control(word, param);
        }
      } else {
        i++; // a lone backslash before something unexpected
      }
    } else if (c === "\r" || c === "\n") {
      i++; // raw newlines in the source are not content
    } else {
      emit(c);
      i++;
    }
  }
  endPara();

  const renderRun = (r: Run) => {
    let t = escapeHtml(r.text).replace(/\t/g, "&nbsp;&nbsp;&nbsp;&nbsp;").replace(/\n/g, "<br>");
    if (r.u) t = `<u>${t}</u>`;
    if (r.i) t = `<em>${t}</em>`;
    if (r.b) t = `<strong>${t}</strong>`;
    return t;
  };
  return paragraphs
    .filter((p) => p.some((r) => r.text.trim() || r.text.includes("\n")))
    .map((p) => `<p>${p.map(renderRun).join("")}</p>`)
    .join("\n");
}

/** Fetch the `.rtf` bytes, decode as Windows-1252 (RTF source is 7-bit with
 *  `\'xx` for the rest), and convert to HTML. Shared by the page and chunk forms. */
function useRtfHtml(path: string): { html: string | null; error: string | null } {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setError(null);
    fetch(blobUrl(path))
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        if (cancelled) return;
        const src = new TextDecoder("windows-1252").decode(new Uint8Array(buf));
        setHtml(rtfToHtml(src));
      })
      .catch((e) => !cancelled && setError(String((e as Error).message || e)));
    return () => {
      cancelled = true;
    };
  }, [path]);
  return { html, error };
}

export function RtfView({ node }: { node: NodeJson }) {
  const { html, error } = useRtfHtml(node.path);
  if (error) return <div className="error">rtf: {error}</div>;
  if (html == null) return <div className="loading">reading RTF…</div>;
  return (
    <div className="text">
      {node.title && <h1 className="chapter-title">{node.title}</h1>}
      {node.description && <p className="chapter-subtitle">{node.description}</p>}
      <div className="markup" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

export function RtfChunk({ chunk }: { chunk: Chunk }) {
  const { html, error } = useRtfHtml(chunk.path);
  if (error) return <div className="error">rtf: {error}</div>;
  if (html == null) return <div className="loading">reading RTF…</div>;
  return <div className="markup" dangerouslySetInnerHTML={{ __html: html }} />;
}
