// THE EDIT-SEQUENCE HARNESS — replay a keystroke script through the REAL client stack into a REAL
// server, then look at the file on disk.
//
// Why it exists: every other editor test mocks `api.ts`, so a server REJECTION is invisible to it
// by construction — `edit sync failed: …` can only be seen by something that actually posts. The
// client's whole transport is two functions over `fetch` (api.ts `getJson`/`postJson`), so stubbing
// `fetch` puts a real handler underneath everything: fetchNode, editChunks, the op queue and its
// 500 ms debounce all run for real, against a real temp tree.
//
// Used by edit-corpus.test.ts (the `edit-examples/` corpus) and importable by ad-hoc tests.

import { expect } from "vitest";
import { createEvent, fireEvent, waitFor } from "@testing-library/react";
import type { IncomingMessage, ServerResponse } from "node:http";
import { callBody, callText } from "./http";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

// --------------------------------------------------------------------------- //
// The keystroke script
// --------------------------------------------------------------------------- //

/** One keystroke: a literal character, or a named key. */
export type Stroke = { ch: string } | { key: string };

/** The named keys a script may use. `Blur` is not a key — it blurs the focused cell, which is how a
 *  real user leaves the editor (and what triggers a commit-on-blur). */
const NAMED = new Set(["Enter", "Tab", "ShiftTab", "Backspace", "Delete", "Escape", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Blur"]);

/** Aliases, so a script reads the way a person would write it. */
const ALIAS: Record<string, string> = { Left: "ArrowLeft", Right: "ArrowRight", Up: "ArrowUp", Down: "ArrowDown", Esc: "Escape" };

/** Parse a `keys` script: literal text, `{Enter}`-style named keys, `{{` for a literal `{`.
 *  A TRAILING newline is ignored (every text file has one); an inner newline is an error — line
 *  breaks are `{Enter}`, so that a script cannot silently mean two different things. */
export function parseKeys(script: string): Stroke[] {
  const src = script.replace(/\n$/, "");
  const out: Stroke[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\n") throw new Error(`a raw newline at offset ${i} — write {Enter} instead`);
    if (c === "{" && src[i + 1] === "{") { out.push({ ch: "{" }); i++; continue; }
    if (c === "{") {
      const close = src.indexOf("}", i);
      if (close < 0) throw new Error(`unterminated { at offset ${i}`);
      const raw = src.slice(i + 1, close);
      const key = ALIAS[raw] ?? raw;
      if (!NAMED.has(key)) throw new Error(`unknown key {${raw}} — known: ${[...NAMED].join(", ")}`);
      out.push({ key });
      i = close;
      continue;
    }
    out.push({ ch: c });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// The transport stub — the real client, a real server
// --------------------------------------------------------------------------- //

/** Route `fetch` into `handler` for the duration of a test. GET goes through http.ts's
 *  `callText`, POST/DELETE through `callBody` — the same adapters the server tests use, so
 *  there is one definition of "what the handler sees". Returns the restore function. */
export function installFetch(handler: Handler): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const url = new URL(raw, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const params: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (params[k] = v));
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    if (method === "GET") {
      // callText awaits ASYNC handlers and carries NON-JSON bodies (/api/content answers
      // text/yamlover) — JSON endpoints still parse lazily in json()
      const r = await callText(handler, url.pathname, params);
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        json: async () => JSON.parse(r.text),
        text: async () => r.text,
        arrayBuffer: async () => new TextEncoder().encode(r.text).buffer,
      } as unknown as Response;
    }
    const r = await callBody(handler, method as "POST" | "DELETE", url.pathname, body, params);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.json,
      text: async () => JSON.stringify(r.json),
    } as unknown as Response;
  }) as typeof fetch;
  return () => { globalThis.fetch = real; };
}

/** Capture `window.alert` — the op queue reports a failed flush there (`ops.ts`: "edit sync
 *  failed: …"), which is exactly the class of defect this harness exists to catch. */
export function captureAlerts(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const real = window.alert;
  window.alert = (m?: unknown) => { messages.push(String(m)); };
  return { messages, restore: () => { window.alert = real; } };
}

// --------------------------------------------------------------------------- //
// Replay
// --------------------------------------------------------------------------- //

/** The focused cell, asserted to exist: a keystroke with nowhere to go is an editor TRAP, and the
 *  fixture that reached it should fail there rather than silently type into the void. */
function focused(what: string): HTMLElement {
  const el = document.activeElement as HTMLElement | null;
  expect(el, `no cell has focus before ${what} — the editor trapped the caret`).toBeTruthy();
  expect(el, `focus fell to <body> before ${what} — the editor trapped the caret`).not.toBe(document.body);
  return el!;
}

/** ONE keystroke through the real cell path: fire `keydown` first, and only if the cell did not
 *  `preventDefault` does the character land. That ordering is what makes the editor's key
 *  grammar — `,` in a flow token, the block header's Enter — actually run. The YED cells are
 *  CONTROLLED inputs/textareas (the character lands via onChange); a contentEditable cell (the
 *  PICK kit's query cells) takes text the browser's way (textContent + input). */
export function press(stroke: Stroke): void {
  if ("key" in stroke && stroke.key === "Blur") { fireEvent.blur(focused("{Blur}")); return; }
  const el = focused("key" in stroke ? `{${stroke.key}}` : JSON.stringify(stroke.ch));
  const key = "key" in stroke ? (stroke.key === "ShiftTab" ? "Tab" : stroke.key) : stroke.ch;
  const ev = createEvent.keyDown(el, { key, ...("key" in stroke && stroke.key === "ShiftTab" ? { shiftKey: true } : {}) });
  fireEvent(el, ev);
  if ("key" in stroke) {
    // an unconsumed Backspace on a text cell is the browser's char delete — simulate it
    // (jsdom fires the event but never edits); the grammar consumed it when it preventDefaulted
    if (stroke.key === "Backspace" && !ev.defaultPrevented) {
      const cur = document.activeElement as HTMLElement | null;
      if ((cur instanceof HTMLInputElement || cur instanceof HTMLTextAreaElement) && cur.value !== "") {
        fireEvent.change(cur, { target: { value: cur.value.slice(0, -1) } });
      }
    }
    return;
  }
  if (ev.defaultPrevented) return;
  // the character lands in whatever cell has focus NOW — a keydown may have moved it. A GAP is
  // a caret position; a character pressed there that no grammar consumed does not land anywhere.
  const cur = focused("the typed character");
  if (cur instanceof HTMLInputElement || cur instanceof HTMLTextAreaElement) {
    fireEvent.change(cur, { target: { value: cur.value + stroke.ch } });
    return;
  }
  // attribute, not isContentEditable — jsdom never implemented the property
  if (!cur.hasAttribute("contenteditable")) return;
  cur.textContent = (cur.textContent ?? "") + stroke.ch;
  fireEvent.input(cur);
}

/** Replay a whole script. */
export function replay(script: string): void {
  for (const s of parseKeys(script)) press(s);
}

/** Let the op queue's real 500 ms debounce fire and the flush settle. `await`ing real time keeps
 *  the queue's own timing honest — a fake-timer shortcut would not exercise the coalescing. */
export async function settleOps(): Promise<void> {
  await new Promise((r) => setTimeout(r, 900));
  await waitFor(() => expect(true).toBe(true));
}

/** A cell's CONTENT text: a controlled input's value, else the visible text. */
export const cellText = (el: HTMLElement): string =>
  el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? "");

/** The Y2 projection's text, chrome stripped: debug captions (`.y2-tag`), gap glyphs, the
 *  ＋ tail and the empty-document label are not content; a controlled input contributes its
 *  VALUE (its textContent is empty by construction). */
function y2Text(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  const el = node as HTMLElement;
  const cls = el.classList;
  if (cls && (cls.contains("y2-tag") || cls.contains("y2-gapslot") || cls.contains("y2-tail") || cls.contains("y2-empty"))) return "";
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
  let out = "";
  for (const c of Array.from(node.childNodes)) out += y2Text(c);
  return out;
}

/** The editor's rows as text — the projection a reader sees. LEAF `.y2-row`s only (rows nest:
 *  a wrapping key row holds its child rows); a document that draws no rows (a one-line flow
 *  root, the empty document) is ONE row: the doc surface's own text. */
export const rowsOf = (container: HTMLElement): string[] => {
  const doc = container.querySelector<HTMLElement>("[data-testid=y2-doc]");
  if (!doc) return [];
  const rows = Array.from(doc.querySelectorAll<HTMLElement>(".y2-row"))
    .filter((r) => !r.querySelector(".y2-row") && !r.querySelector(".y2-tail") && !r.classList.contains("y2-blankline"));
  if (rows.length === 0) return [y2Text(doc)];
  return rows.map(y2Text);
};
