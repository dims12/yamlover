// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

// The view talks to the stateless preview/edit-text endpoints; mock the api module.
const { previewSource, editText } = vi.hoisted(() => ({ previewSource: vi.fn(), editText: vi.fn() }));
vi.mock("../../src/client/api", () => ({ previewSource, editText, fetchConfig: vi.fn().mockResolvedValue({ settings: {} }) }));

import { BrowserSettingsView } from "../../src/client/BrowserSettingsView";
import { browserSettingsSource } from "../../src/client/browser-settings";

const payload = (width: number) => ({
  path: ":",
  type: "object",
  format: "x-yamlover-config",
  valueType: null,
  hasKeyed: true,
  hasOrdinal: false,
  concrete: "yamlover",
  documentPath: ":",
  title: null,
  description: null,
  value: { width },
  comments: { "": { tag: "!!<*yamlover: $defs: config>" }, "/width": { trailing: [" reading width"] } },
  relations: {},
});

beforeEach(() => {
  cleanup();
  localStorage.clear();
  previewSource.mockReset();
  editText.mockReset();
});

describe("BrowserSettingsView", () => {
  it("previews the localStorage document and renders it in the data view (tag line included)", async () => {
    previewSource.mockResolvedValue(payload(72));
    render(<BrowserSettingsView onNavigate={() => {}} />);
    await screen.findByText("width");
    expect(previewSource).toHaveBeenCalledWith(browserSettingsSource());
    const txt = document.body.textContent ?? "";
    expect(txt).toContain("!!<*yamlover: $defs: config>"); // the root tag line
    expect(txt).toContain("# reading width");
    expect(txt).toContain("this browser"); // the provenance chip
  });

  it("unlock → edit width → editText applies to the stored text, result persisted + re-previewed", async () => {
    previewSource.mockResolvedValue(payload(72));
    render(<BrowserSettingsView onNavigate={() => {}} />);
    await screen.findByText("width");
    const before = browserSettingsSource();
    const after = before.replace("width: 72", "width: 96");
    editText.mockResolvedValue({ source: after });
    previewSource.mockResolvedValue(payload(96));

    fireEvent.click(screen.getByRole("button", { name: /edit/i })); // unlock
    const field = await screen.findByText("72"); // the scalar becomes an inline field
    fireEvent.focus(field);
    field.textContent = "96";
    fireEvent.blur(field);

    await waitFor(() => expect(editText).toHaveBeenCalledWith(before, [{ path: ":width", op: "emplace", yamlover: "96" }]));
    await waitFor(() => expect(browserSettingsSource()).toBe(after)); // persisted to localStorage
  });

  it("a rejected edit reverts the field and leaves the stored text untouched", async () => {
    previewSource.mockResolvedValue(payload(72));
    render(<BrowserSettingsView onNavigate={() => {}} />);
    await screen.findByText("width");
    const before = browserSettingsSource();
    editText.mockRejectedValue(new Error("no such key"));

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    const field = await screen.findByText("72");
    fireEvent.focus(field);
    field.textContent = "96";
    fireEvent.blur(field);

    await waitFor(() => expect(editText).toHaveBeenCalled());
    await waitFor(() => expect(field.className).toContain("edit-error"));
    expect(field.textContent).toBe("72"); // reverted
    expect(browserSettingsSource()).toBe(before); // untouched
  });
});
