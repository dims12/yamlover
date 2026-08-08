// The Google Analytics 4 tag for the registration landing page — a plain, single-view page,
// so this is the stock gtag.js snippet with nothing to redact.
//
// Deliberately NOT shared with the copy in tools/server/bin/ga4.js: only tools/demo is
// rsynced to the box, tools/server arrives as a Docker image, and the two are versioned
// apart. A shared module would couple a demo-server redeploy to a server rebuild to save
// ten lines.
//
// No `anonymize_ip`: that is a Universal Analytics parameter and GA4 ignores it — GA4
// truncates the address before it is written and never stores it.

/** The GA4 `<script>` for `measurementId`, or "" when analytics is switched off. */
export function ga4Tag(measurementId) {
  if (!measurementId) return "";
  const id = JSON.stringify(measurementId);
  return (
    `<script async src="https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}"></script>` +
    `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}` +
    `gtag("js",new Date());gtag("config",${id})</script>`
  );
}
