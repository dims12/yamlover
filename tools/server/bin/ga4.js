// The Google Analytics 4 tag injected into the served SPA shell.
//
// OFF UNLESS THE SERVER IS TOLD OTHERWISE. Nothing here runs without $GA4_MEASUREMENT_ID,
// which only the hosted deployment sets — `npx yamlover`, the desktop app and any
// self-hosted tree serve the same shell and send nothing. A local-first viewer that phoned
// home by default would be a different product.
//
// The tag reports a path the SERVER chose ($GA4_PAGE_PATH), never the one in the address
// bar, because the address bar is not safe to forward:
//
//   • a demo instance is mounted at /demo/<hash>, and that hash IS the credential for it —
//     copying it into a third-party report hands out the instance;
//   • below the mount point the URL is the yamlover data path, and in a demo the visitor
//     may have typed the node names themselves.
//
// So a demo collapses to a single page ($GA4_COLLAPSE_PATH) and drops document.title, which
// the SPA rewrites to the node's own labels. The docs instance serves published content, so
// it reports its real sub-paths — knowing which chapters get read is the point.
//
// No `anonymize_ip`: that is a Universal Analytics parameter and GA4 ignores it. GA4
// truncates the address on receipt and never stores it.

/** Embed a value as a JS literal that is safe inside `<script>` (`</script>` in a string
 *  would otherwise close the element early). */
const js = (v) => JSON.stringify(v ?? "").replace(/</g, "\\u003c");

/** The GA4 `<script>` for a shell served at `basePath`, or "" when analytics is off.
 *
 *  `measurementId` — the G-XXXXXXXXXX stream id.
 *  `pagePath`      — the mount point as analytics should see it (e.g. `/demo/<id>`, `/docs`).
 *  `collapse`      — report `pagePath` alone, never a sub-path or the document title. */
export function ga4Tag({ measurementId, basePath = "", pagePath = "", collapse = false }) {
  if (!measurementId) return "";
  return (
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}"></script>` +
    `<script>(function(){` +
    // Initialise once per document. The tag wraps history.pushState, so a second copy in the
    // same page would wrap the wrapper and report every SPA navigation twice.
    `if(window.__yoGa4__)return;window.__yoGa4__=1;` +
    // A collapsed tag is handed no base path at all. `at()` would not read it either way,
    // but not emitting it is what makes "this script cannot know the hash" checkable by
    // reading the page instead of by reasoning about a branch.
    `var ID=${js(measurementId)},BASE=${js(collapse ? "" : basePath)},PUB=${js(pagePath)},COLLAPSE=${collapse ? "1" : "0"};` +
    `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}window.gtag=gtag;` +
    `gtag("js",new Date());` +
    // The reported path. Query and fragment are dropped wholesale: both carry data paths.
    `function at(){if(COLLAPSE)return PUB+"/";var p=location.pathname;` +
    `if(BASE&&p.indexOf(BASE)===0)p=p.slice(BASE.length)||"/";return PUB+p}` +
    // Stamped as GLOBAL parameters rather than per-event: the tag's own enhanced-measurement
    // events (scroll, outbound click, history) are fired by gtag.js and would otherwise
    // report location.href, routing around the redaction above.
    `var last="";function stamp(){var p=at();last=p;` +
    `gtag("set",{page_path:p,page_location:location.origin+p,page_title:COLLAPSE?"yamlover demo":document.title})}` +
    `stamp();gtag("config",ID,{send_page_view:false});gtag("event","page_view");` +
    // The SPA routes on the JSON path with no document load, so page_view is re-sent by hand.
    // A collapsed instance reports one path, so every navigation inside it is a repeat — the
    // `last` guard keeps it to a single page_view instead of one per click.
    `function nav(){if(at()===last)return;stamp();gtag("event","page_view")}` +
    `["pushState","replaceState"].forEach(function(m){var o=history[m];` +
    `history[m]=function(){var r=o.apply(this,arguments);nav();return r}});` +
    `addEventListener("popstate",nav)})()</script>`
  );
}

/** Read the tag's configuration from the environment. `basePath` comes from the caller
 *  because the flag may override $BASE_PATH; `GA4_PAGE_PATH` defaults to it, which is
 *  right for a root or /docs mount and is overridden for a demo (whose path is a secret). */
export function ga4ConfigFromEnv(basePath) {
  const measurementId = process.env.GA4_MEASUREMENT_ID ?? "";
  if (!measurementId) return null;
  return {
    measurementId,
    basePath,
    pagePath: process.env.GA4_PAGE_PATH ?? basePath,
    collapse: ["1", "true", "yes"].includes(String(process.env.GA4_COLLAPSE_PATH ?? "").toLowerCase()),
  };
}
