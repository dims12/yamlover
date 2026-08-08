// @vitest-environment jsdom
//
// The analytics tag, exercised by RUNNING it rather than by matching its source. What matters
// about this code is a behavioural claim — a demo instance never reports its hash — and a
// string assertion cannot check that: the value reaching Google is computed at page-view time
// from `location`, `document.title` and whatever the SPA did to the history stack. So each
// test drives a real DOM, evaluates the emitted script and reads back the gtag queue.

import { describe, it, expect, beforeEach } from "vitest";
import { ga4Tag, ga4ConfigFromEnv } from "../bin/ga4.js";

const HASH = "IVUT51rLNrzuxYROoyHP-Q"; // a real-shaped demo hash: the thing that must not leak

// jsdom hands the whole file ONE window, but the tag mutates it — it wraps the history methods
// and flags itself as initialised. Both have to be undone per test, or a later test inherits
// the previous one's wrappers and sees doubled page_views.
const pristine = { pushState: history.pushState, replaceState: history.replaceState };

/** Evaluate the tag's inline script at `url`, and return the gtag queue it produced. */
function run(tag: string, url: string, title = "some node : its parent") {
  const body = tag.match(/<script>([\s\S]*)<\/script>$/)?.[1];
  if (!body) throw new Error("no inline script in the tag");
  history.pushState = pristine.pushState;
  history.replaceState = pristine.replaceState;
  delete (window as any).__yoGa4__;
  history.replaceState({}, "", url);
  document.title = title;
  (window as any).dataLayer = undefined;
  new Function(body)();
  return calls();
}

/** The queue as plain arrays — gtag pushes an `arguments` object per call. */
const calls = (): any[][] => [...((window as any).dataLayer ?? [])].map((a: any) => [...a]);

const commands = (kind: string) => calls().filter((c) => c[0] === kind);
const lastSet = () => commands("set").at(-1)?.[1];

describe("ga4Tag — off by default", () => {
  it("emits nothing without a measurement id", () => {
    expect(ga4Tag({ measurementId: "" })).toBe("");
    expect(ga4Tag({ measurementId: undefined as any })).toBe("");
  });

  it("loads gtag.js and suppresses its automatic page_view", () => {
    const tag = ga4Tag({ measurementId: "G-ABC123" });
    expect(tag).toContain("googletagmanager.com/gtag/js?id=G-ABC123");
    run(tag, "/");
    expect(commands("config")[0][2]).toEqual({ send_page_view: false });
  });
});

describe("ga4Tag — a demo instance withholds its hash", () => {
  const tag = () => ga4Tag({ measurementId: "G-ABC123", basePath: `/demo/${HASH}`, pagePath: "/demo/<id>", collapse: true });

  it("never puts the hash in the emitted script", () => {
    // Checkable by reading the page, not by reasoning about a branch: a collapsed tag is
    // handed no base path at all, so the hash is not in scope for it to report.
    expect(tag()).not.toContain(HASH);
  });

  it("reports the collapsed path however deep the URL is", () => {
    run(tag(), `/demo/${HASH}/some/node/the/visitor/named`);
    expect(lastSet().page_path).toBe("/demo/<id>/");
    expect(lastSet().page_location).toBe(`${location.origin}/demo/<id>/`);
  });

  it("replaces the document title, which the SPA rewrites to the node's own labels", () => {
    run(tag(), `/demo/${HASH}/`, "secret project : Q3 plans");
    expect(lastSet().page_title).toBe("yamlover demo");
  });

  it("leaks nothing through the whole queue, including query and fragment", () => {
    run(tag(), `/demo/${HASH}/deep?q=${HASH}#frag`);
    expect(JSON.stringify(calls())).not.toContain(HASH);
  });

  it("sends one page_view, not one per in-demo navigation", () => {
    run(tag(), `/demo/${HASH}/`);
    history.pushState({}, "", `/demo/${HASH}/elsewhere`);
    history.pushState({}, "", `/demo/${HASH}/elsewhere/again`);
    // Every path collapses to the same page, so re-sending would inflate the count without
    // reporting anything new.
    expect(commands("event").filter((c) => c[1] === "page_view")).toHaveLength(1);
  });
});

describe("ga4Tag — the docs instance reports real paths", () => {
  const tag = () => ga4Tag({ measurementId: "G-ABC123", basePath: "/docs", pagePath: "/docs", collapse: false });

  it("keeps the sub-path — which chapter gets read is the point", () => {
    run(tag(), "/docs/language/pointers");
    expect(lastSet().page_path).toBe("/docs/language/pointers");
  });

  it("keeps the real document title", () => {
    run(tag(), "/docs/", "Pointers - yamlover");
    expect(lastSet().page_title).toBe("Pointers - yamlover");
  });

  it("drops query and fragment, which carry data paths", () => {
    run(tag(), "/docs/language?open=:a:b#frag");
    expect(lastSet().page_path).toBe("/docs/language");
  });

  it("re-sends page_view when the SPA routes to a new path", () => {
    run(tag(), "/docs/one");
    history.pushState({}, "", "/docs/two");
    const views = commands("event").filter((c) => c[1] === "page_view");
    expect(views).toHaveLength(2);
    expect(lastSet().page_path).toBe("/docs/two");
  });

  it("reports the mount root as / when served without a base path", () => {
    run(ga4Tag({ measurementId: "G-ABC123" }), "/");
    expect(lastSet().page_path).toBe("/");
  });
});

describe("ga4Tag — initialising twice in one document is a no-op", () => {
  it("does not double-count when a second copy of the tag runs", () => {
    const tag = ga4Tag({ measurementId: "G-ABC123", basePath: "/docs", pagePath: "/docs" });
    const body = tag.match(/<script>([\s\S]*)<\/script>$/)![1];
    run(tag, "/docs/one");
    new Function(body)(); // a second injection into the same page
    expect(commands("config")).toHaveLength(1);
    // The real hazard is the history wrapper: wrapped twice, one navigation reports twice.
    history.pushState({}, "", "/docs/two");
    expect(commands("event").filter((c) => c[1] === "page_view")).toHaveLength(2);
  });
});

describe("ga4Tag — the injected values cannot break out of the element", () => {
  it("escapes a closing script tag in a configured value", () => {
    const tag = ga4Tag({ measurementId: "G-ABC123", pagePath: "/x</script><script>alert(1)</script>" });
    // One inline script, and the payload's `<` is escaped rather than parsed as markup.
    expect(tag.match(/<script>/g)).toHaveLength(1);
    expect(tag).not.toContain("</script><script>alert");
  });
});

describe("ga4ConfigFromEnv", () => {
  beforeEach(() => {
    delete process.env.GA4_MEASUREMENT_ID;
    delete process.env.GA4_PAGE_PATH;
    delete process.env.GA4_COLLAPSE_PATH;
  });

  it("is null unless a measurement id is set — every run that is not the hosted one", () => {
    expect(ga4ConfigFromEnv("/docs")).toBeNull();
    process.env.GA4_MEASUREMENT_ID = "";
    expect(ga4ConfigFromEnv("/docs")).toBeNull();
  });

  it("defaults the reported path to the base path", () => {
    process.env.GA4_MEASUREMENT_ID = "G-ABC123";
    expect(ga4ConfigFromEnv("/docs")).toEqual({
      measurementId: "G-ABC123",
      basePath: "/docs",
      pagePath: "/docs",
      collapse: false,
    });
  });

  it("takes an explicit reported path over the base path — how a demo hides its own", () => {
    process.env.GA4_MEASUREMENT_ID = "G-ABC123";
    process.env.GA4_PAGE_PATH = "/demo/<id>";
    process.env.GA4_COLLAPSE_PATH = "1";
    const cfg = ga4ConfigFromEnv(`/demo/${HASH}`)!;
    expect(cfg.pagePath).toBe("/demo/<id>");
    expect(cfg.collapse).toBe(true);
  });

  it("reads the collapse flag loosely but treats 0/absent as off", () => {
    process.env.GA4_MEASUREMENT_ID = "G-ABC123";
    for (const v of ["1", "true", "TRUE", "yes"]) {
      process.env.GA4_COLLAPSE_PATH = v;
      expect(ga4ConfigFromEnv("")!.collapse).toBe(true);
    }
    for (const v of ["0", "false", "no", ""]) {
      process.env.GA4_COLLAPSE_PATH = v;
      expect(ga4ConfigFromEnv("")!.collapse).toBe(false);
    }
  });
});
