import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

/** A capturing fake ServerResponse; `done` resolves (with the parsed JSON) when end() is called. */
function fakeRes() {
  const state = { statusCode: 200, body: "" };
  let resolve: (v: { status: number; json: any }) => void;
  const done = new Promise<{ status: number; json: any }>((r) => (resolve = r));
  const res = {
    setHeader() {},
    get statusCode() {
      return state.statusCode;
    },
    set statusCode(v: number) {
      state.statusCode = v;
    },
    end(b: string) {
      state.body = b;
      resolve({ status: state.statusCode, json: JSON.parse(state.body) });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

function urlFor(pathname: string, params: Record<string, string>): URL {
  const url = new URL("http://localhost" + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url;
}

/** Invoke a handler on a bodyless (GET-style) request and return the parsed JSON. */
export function call(handler: Handler, pathname: string, params: Record<string, string> = {}) {
  const { res } = fakeRes();
  const state = res as unknown as { statusCode: number };
  let captured = { status: 200, json: undefined as any };
  res.end = ((b: string) => {
    captured = { status: state.statusCode, json: JSON.parse(b) };
  }) as ServerResponse["end"];
  handler({} as IncomingMessage, res, urlFor(pathname, params));
  return captured;
}

/** Subscribe to the handler's SSE endpoint (/api/events) and capture every pushed frame —
 *  asserts the unified change flow: writes must announce their diffs. Call `close()` when done
 *  (it clears the server's keep-alive ping for this subscriber). */
export function sseCapture(handler: Handler): { frames: () => any[]; close: () => void } {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as { method?: string }).method = "GET";
  const raw: string[] = [];
  const res = {
    statusCode: 200,
    setHeader() {},
    write(s: string) { raw.push(s); },
    end() {},
  } as unknown as ServerResponse;
  handler(req, res, urlFor("/api/events", {}));
  return {
    frames: () => raw.filter((s) => s.startsWith("data: ")).map((s) => JSON.parse(s.slice("data: ".length))),
    close: () => (req as unknown as EventEmitter).emit("close"),
  };
}

/** Invoke a handler with a method + JSON body (the async write endpoints); awaits the response. */
export function callBody(
  handler: Handler,
  method: "POST" | "DELETE",
  pathname: string,
  body: unknown = undefined,
  params: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  (req as { method?: string }).method = method;
  const { res, done } = fakeRes();
  handler(req, res, urlFor(pathname, params));
  return done;
}
