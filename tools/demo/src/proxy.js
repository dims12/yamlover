// A minimal streaming reverse proxy to a demo's yamlover instance on 127.0.0.1:<port>.
// The request URL is forwarded UNCHANGED — it still carries the `/demo/<hash>` prefix,
// which yamlover strips itself (`--base-path`). Piping (not buffering) keeps the SSE
// stream (`/api/events`, text/event-stream) flowing live; yamlover prod has no
// WebSocket, so no upgrade handling is needed.

import http from "node:http";

export function proxy(req, res, port) {
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: `127.0.0.1:${port}` },
    },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) {
      res.statusCode = 502;
      res.end("demo backend unavailable");
    } else {
      res.destroy();
    }
  });
  // If the client hangs up (e.g. closes an SSE tab), tear down the upstream socket.
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}
