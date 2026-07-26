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
import { call, callBody } from "./http";

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

/** Route `fetch` into `handler` for the duration of a test. GET goes through http.ts's `call`,
 *  POST/DELETE through `callBody` — the same adapters the server tests use, so there is one
 *  definition of "what the handler sees". Returns the restore function. */
export function installFetch(handler: Handler): () => void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const url = new URL(raw, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const params: Record<string, string> = {};
    url.searchParams.forEach((v, k) => (params[k] = v));
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    const r =
      method === "GET"
        ? call(handler, url.pathname, params)
        : await callBody(handler, method as "POST" | "DELETE", url.pathname, body, params);
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
 *  `preventDefault` does the character land (then `input`). That ordering is what makes the
 *  editor's key grammar — `,` in a flow token, `:` after a closed quote — actually run. */
export function press(stroke: Stroke): void {
  if ("key" in stroke && stroke.key === "Blur") { fireEvent.blur(focused("{Blur}")); return; }
  const el = focused("key" in stroke ? `{${stroke.key}}` : JSON.stringify(stroke.ch));
  const key = "key" in stroke ? (stroke.key === "ShiftTab" ? "Tab" : stroke.key) : stroke.ch;
  const ev = createEvent.keyDown(el, { key, ...("key" in stroke && stroke.key === "ShiftTab" ? { shiftKey: true } : {}) });
  fireEvent(el, ev);
  if (ev.defaultPrevented || "key" in stroke) return;
  // the character lands in whatever cell has focus NOW — a keydown may have moved it
  const cur = focused("the typed character");
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

/** The editor's rows as text — the projection a reader sees. */
export const rowsOf = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll(".yed-row")).map((r) => r.textContent ?? "");
