// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";

const { fetchConfig } = vi.hoisted(() => ({ fetchConfig: vi.fn() }));
vi.mock("../../src/client/api", () => ({ fetchConfig }));
const configWith = (settings: Record<string, unknown>) =>
  fetchConfig.mockResolvedValue({
    source: "",
    settings: { exports: [], annotations: ":annotations", tags: ":tags", sidecars: "per-directory", ...settings },
    path: ":.yamlover:settings.yamlover",
  });
/** Prime the project layer from the current mock and wait for it to land. */
const prime = async () => {
  primeProjectSettings();
  await new Promise((r) => setTimeout(r, 0));
};

import {
  applyTheme,
  browserSettingsSource,
  browserSettingsTemplate,
  browserTheme,
  browserWidthCh,
  saveBrowserSettings,
  setBrowserSettingKey,
  primeProjectSettings,
  projectWidthCh,
} from "../../src/client/browser-settings";

beforeEach(() => {
  localStorage.clear();
  saveBrowserSettings(browserSettingsTemplate(72)); // reset text AND the parse memo between tests
  localStorage.clear();
});

describe("browser settings document", () => {
  it("initializes from the template on first read (self-documenting, tagged, width authored) and persists", () => {
    const src = browserSettingsSource();
    expect(src).toContain("!!<*yamlover:$defs:config>");
    expect(src).toContain("width: 72");
    expect(src).toContain("THIS DEVICE");
    expect(localStorage.getItem("yamlover.settings")).toBe(src); // persisted
    expect(browserWidthCh()).toBe(72);
  });

  it("migrates the legacy yamlover.markupWidthCh value once", () => {
    localStorage.setItem("yamlover.markupWidthCh", "96");
    expect(browserSettingsSource()).toContain("width: 96");
    expect(browserWidthCh()).toBe(96);
  });

  it("an EXISTING doc from an older release gains newly-templated keys (theme) on read, once", () => {
    // a pre-theme document, as a user who set their width last week has it
    localStorage.setItem("yamlover.settings", "# my settings\n!!<*yamlover:$defs:config>\n\nwidth: 124\n");
    const src = browserSettingsSource();
    expect(src).toContain("width: 124"); // authored content untouched
    expect(src).toContain("# my settings");
    expect(src).toMatch(/^theme: dark {3}# ui palette: dark \| light$/m); // the upgrade line appended
    expect(src.match(/^theme:/gm)?.length).toBe(1);
    expect(browserSettingsSource()).toBe(src); // idempotent — a second read appends nothing
    expect(browserTheme()).toBe("dark"); // and it parses
  });

  it("setBrowserSettingKey splices ONE key, preserving comments and other lines; appends when fresh", () => {
    browserSettingsSource(); // materialize the template
    setBrowserSettingKey("width", "120");
    const src = browserSettingsSource();
    expect(src).toContain("width: 120");
    expect(src).toContain("!!<*yamlover:$defs:config>"); // tag preserved
    expect(src).toContain("# Browser settings"); // comments preserved
    expect(src.match(/^width:/gm)?.length).toBe(1); // replaced in place, not duplicated
    expect(browserWidthCh()).toBe(120); // memo invalidated

    setBrowserSettingKey("theme", "dark"); // a fresh key appends
    expect(browserSettingsSource()).toMatch(/theme: dark\n/);
  });

  it("an out-of-range or non-integer width falls through (null)", () => {
    saveBrowserSettings("width: 9000\n");
    expect(browserWidthCh()).toBe(null);
    saveBrowserSettings("width: wide\n");
    expect(browserWidthCh()).toBe(null);
    saveBrowserSettings("tags: *:: tags\n"); // absent
    expect(browserWidthCh()).toBe(null);
  });

  it("projectWidthCh reflects the primed /api/config settings", async () => {
    configWith({ width: 100 });
    await prime();
    expect(projectWidthCh()).toBe(100);
  });
});

describe("theme", () => {
  it("browserTheme reads the doc's `theme` key; junk → null; an absent key upgrades to authored dark", () => {
    saveBrowserSettings("theme: light\n");
    expect(browserTheme()).toBe("light");
    saveBrowserSettings("theme: blue\n");
    expect(browserTheme()).toBe(null); // junk authored → this layer is silent
    saveBrowserSettings("width: 72\n"); // absent → the read UPGRADES the doc to author `theme: dark`
    expect(browserTheme()).toBe("dark"); // (the UI can only edit present keys, so the doc always offers it)
  });

  it("applyTheme stamps html[data-theme] and the pre-paint mirror key; browser doc wins, project is the fallback", async () => {
    configWith({ theme: "light" });
    await prime(); // the project layer says light
    saveBrowserSettings("theme: blue\n"); // browser authors JUNK → its layer is silent → project decides
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("yamlover.theme")).toBe("light");
    // a valid browser value overrides the project layer — and the save applies INSTANTLY
    saveBrowserSettings("theme: dark\n");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("yamlover.theme")).toBe("dark");
  });

  it("with neither layer authoring a valid theme the default is dark", async () => {
    configWith({});
    await prime(); // project authors no theme
    saveBrowserSettings("theme: nonsense\n"); // browser layer silent too
    applyTheme();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("a `theme` splice through setBrowserSettingKey re-applies instantly too", () => {
    browserSettingsSource(); // materialize the template (theme: dark)
    setBrowserSettingKey("theme", "light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(browserSettingsSource()).toContain("theme: light");
  });
});
