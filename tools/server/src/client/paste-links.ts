// Pasted-LINK handlers: a paste that is EXACTLY one well-known URL means the linked CONTENT is
// wanted, not the URL text. Each recognizer turns the link into something the normal paste flows
// accept — a file to upload (arXiv) or a text to chunk (a tweet). A link inside longer text is
// left alone (the prose is the paste). Used by NodeView's paste listener.

/** The arXiv paper behind a pasted link: a lone `arxiv.org/{abs|pdf|html}/<id>` URL — fetch its
 *  PDF (arXiv sends `access-control-allow-origin: *`) and run the normal file-paste flow. New
 *  (`2605.00615v2`) and old (`math/0211159`) id styles. */
export function arxivPdf(text: string): { url: string; name: string } | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?(?:[?#][^\s]*)?$/i.exec(text.trim());
  if (!m) return null;
  const id = m[1];
  if (!/^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/.test(id)) return null;
  return { url: `https://arxiv.org/pdf/${id}`, name: `arxiv-${id.replace(/\//g, "-")}.pdf` };
}

/** The tweet behind a pasted `x.com`/`twitter.com` status link, canonicalized; null if the text
 *  is not exactly one such link. */
export function tweetUrl(text: string): string | null {
  const m = /^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/(\w{1,15})\/status(?:es)?\/(\d+)(?:[/?#][^\s]*)?$/i.exec(text.trim());
  return m ? `https://twitter.com/${m[1]}/status/${m[2]}` : null;
}

/** Fetch a tweet's FULL content via X's public oEmbed endpoint (`publish.x.com/oembed` — the
 *  embedded-tweet API: no auth, CORS-open) and compose it as pasteable text — the whole message,
 *  then an author/date attribution line, then the link. */
export async function fetchTweetText(statusUrl: string): Promise<string> {
  const res = await fetch(`https://publish.x.com/oembed?url=${encodeURIComponent(statusUrl)}&omit_script=true&dnt=true`);
  if (!res.ok) throw new Error(`oEmbed HTTP ${res.status}`);
  const o = (await res.json()) as { html?: string; author_name?: string; author_url?: string; url?: string };
  // the payload's `html` is a <blockquote><p>tweet…</p>— Author (@handle) <a>date</a></blockquote>
  const doc = new DOMParser().parseFromString((o.html ?? "").replace(/<br\s*\/?>/gi, "\n"), "text/html");
  const quote = doc.querySelector("blockquote");
  const body = quote?.querySelector("p")?.textContent?.trim();
  if (!body) throw new Error("no tweet text in the oEmbed payload");
  const handle = (o.author_url ?? "").split("/").filter(Boolean).pop();
  const dateLinks = quote ? Array.from(quote.querySelectorAll(":scope > a")) : [];
  const date = dateLinks[dateLinks.length - 1]?.textContent?.trim();
  const who = [o.author_name, handle && `@${handle}`].filter(Boolean).join(" ");
  const attribution = [who && `— ${who}`, date].filter(Boolean).join(", ");
  return [body, "", [attribution, o.url ?? statusUrl].filter(Boolean).join("\n")].join("\n");
}
