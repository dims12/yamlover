// `<meta name="robots" content="noindex">`, added while the view is showing an address that
// resolves to nothing.
//
// WHY THIS IS A CLIENT CONCERN. The shell is a blind catch-all: bin/yamlover.js answers 200 with
// index.html for every non-asset path and does no tree lookup at all. That is not laziness — it
// has to stay that way. `/.browser/settings.yo` is a working page backed by localStorage and by
// no server node whatsoever (App.tsx intercepts it before NodeView mounts), so a server that
// 404'd "paths that aren't nodes" would 404 a page that works. And a 404 body is exactly what a
// fronting proxy with `proxy_intercept_errors` replaces with its own, which would break the SPA
// on precisely the URLs that used to load.
//
// So the status stays 200 and the CLIENT — the only party that actually knows the address came
// up empty — says so. Google processes a robots meta injected during rendering, and rendering is
// the only way it ever sees this app; without the tag it collects hundreds of distinct URLs all
// answering with the same successful, near-identical shell, which is a soft-404 pile that
// devalues the pages that are real.

const ID = "yo-robots-noindex";

/** Add or remove the noindex tag. Idempotent in both directions — call it from an effect with
 *  `setNoIndex(false)` as the cleanup, so navigating off a dead address re-opens the page to
 *  indexing without a reload (the SPA never re-fetches the shell). */
export function setNoIndex(on: boolean): void {
  const existing = document.getElementById(ID);
  if (!on) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const m = document.createElement("meta");
  m.id = ID;
  m.name = "robots";
  m.content = "noindex";
  document.head.appendChild(m);
}
