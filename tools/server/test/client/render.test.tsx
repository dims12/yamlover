// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Render } from "../../src/client/render";

afterEach(cleanup);

describe("Render", () => {
  it("renders scalars as YAML", () => {
    render(<Render value={{ name: "Alice", n: 5, ok: true }} syntax="yaml" onNavigate={() => {}} />);
    const txt = document.body.textContent ?? "";
    expect(txt).toContain("name");
    expect(txt).toContain("Alice");
    expect(txt).toContain("5");
    expect(txt).toContain("true");
  });

  it("renders a scalar's faithful `raw` token so a string `\"~\"` reads as a quoted string, not null", () => {
    render(
      <Render
        value={{ name: "~", id: 255, nul: null }}
        syntax="yaml"
        onNavigate={() => {}}
        comments={{ "/name": { raw: '"~"' }, "/id": { raw: "0xff" } }}
      />,
    );
    const txt = document.body.textContent ?? "";
    expect(txt).toContain('"~"'); // the STRING renders WITH quotes (faithful), distinct from null `~`
    expect(txt).toContain("0xff"); // hex spelling kept
    // the string "~" sits in the string colour class, carrying the quoted token
    const s = [...document.querySelectorAll(".s")].find((e) => e.textContent === '"~"');
    expect(s).toBeTruthy();
    expect(txt).toContain("nul"); // an actual null still renders bare as `null`
  });

  it("renders leading, trailing, head and tail comments inline (yaml, dimmed)", () => {
    render(
      <Render
        value={{ name: "Alice", user: { role: "admin" } }}
        syntax="yaml"
        onNavigate={() => {}}
        comments={{
          $head: [" banner"],
          "/name": { leading: [" the name"], trailing: [" who"] },
          "/user/role": { leading: [" nested"] },
          $tail: [" bye"],
        }}
      />,
    );
    const txt = document.body.textContent ?? "";
    expect(txt).toContain("# banner"); // head
    expect(txt).toContain("# the name"); // leading
    expect(txt).toContain("# who"); // trailing
    expect(txt).toContain("# nested"); // nested leading
    expect(txt).toContain("# bye"); // tail
    expect(document.querySelector(".c")).toBeTruthy(); // rendered with the dimmed comment class
  });

  it("renders a ref as its authored pointer token, an anchor, and a type tag (yaml)", () => {
    render(
      <Render
        value={{
          boss: { name: "Rex" },
          team: { lead: { $yamloverRef: { text: ":chief", path: ":boss" } } },
          crew: ["x"],
        }}
        syntax="yaml"
        onNavigate={() => {}}
        comments={{
          "/boss": { anchors: [": chief"] },
          "/team/lead": { pointer: ": chief" },
          "/crew": { tag: "!!set" },
        }}
      />,
    );
    const txt = document.body.textContent ?? "";
    expect(txt).toContain("&: chief"); // anchor on boss
    expect(txt).toContain("*: chief"); // ref rendered as the authored pointer, not `:chief`
    expect(txt).not.toContain(":chief\n"); // NOT the bare resolved path
    expect(txt).toContain("!!set"); // type tag on crew
  });

  it("renders the viewed node's OWN !!<…> tag / anchors as standalone lines above the body (yaml)", () => {
    render(
      <Render
        value={{
          annotations: { $yamloverRef: { text: ":: annotations", path: null } }, // dangling: no link
          sidecars: "per-directory",
        }}
        syntax="yaml"
        onNavigate={() => {}}
        comments={{
          "": { tag: "!!<*yamlover: $defs: config>", anchors: [": cfg"] },
          "/annotations": { pointer: ":: annotations" },
        }}
      />,
    );
    const txt = document.body.textContent ?? "";
    expect(txt).toContain("!!<*yamlover: $defs: config>"); // the tag application, kept in view
    expect(txt.indexOf("!!<")).toBeLessThan(txt.indexOf("annotations")); // above the body
    expect(txt).toContain("&: cfg"); // the root's own anchor line
    expect(txt).toContain("*:: annotations"); // the dangling entry renders its authored pointer…
    const ref = [...document.querySelectorAll(".s")].find((e) => e.textContent === "*:: annotations");
    expect(ref).toBeTruthy(); // …as plain text (no hyperlink — nothing to navigate to)
  });

  it("renders null as `null`, not the obsolete `~`", () => {
    render(<Render value={{ cain: null }} syntax="yaml" onNavigate={() => {}} />);
    const txt = document.body.textContent ?? "";
    expect(txt).toContain("cain:");
    expect(txt).toContain("null");
    expect(txt).not.toContain("~");
  });

  it("renders comments as // in the json view", () => {
    render(
      <Render
        value={{ name: "Alice" }}
        syntax="json"
        onNavigate={() => {}}
        comments={{ "/name": { leading: [" the name"], trailing: [" who"] } }}
      />,
    );
    const txt = document.body.textContent ?? "";
    expect(txt).toContain("// the name");
    expect(txt).toContain("// who");
  });

  it("renders nothing extra when there are no comments", () => {
    render(<Render value={{ name: "Alice" }} syntax="yaml" onNavigate={() => {}} />);
    expect(document.querySelector(".c")).toBeNull();
  });

  it("renders an object link marker as a labelled hyperlink that navigates", () => {
    const onNav = vi.fn();
    render(
      <Render
        value={{ child: { $yamloverLink: { kind: "object", count: 3, path: ":child" } } }}
        syntax="yaml"
        onNavigate={onNav}
      />,
    );
    const link = screen.getByText("{ object with 3 properties }");
    expect(link.getAttribute("href")).toBe(":child");
    fireEvent.click(link);
    expect(onNav).toHaveBeenCalledWith(":child");
  });

  it("labels array/binary markers and handles singular/plural", () => {
    render(
      <Render
        value={{
          a: { $yamloverLink: { kind: "array", count: 1, path: ":a" } },
          b: { $yamloverLink: { kind: "binary", size: 1234, path: ":b" } },
          c: { $yamloverLink: { kind: "object", count: 1, path: ":c" } },
        }}
        syntax="yaml"
        onNavigate={() => {}}
      />,
    );
    expect(screen.getByText("[ array with 1 item ]")).toBeTruthy();
    expect(screen.getByText("< binary of 1234 bytes >")).toBeTruthy();
    expect(screen.getByText("{ object with 1 property }")).toBeTruthy();
  });

  it("renders a scalar link by its value (syntax-aware) as a navigating hyperlink", () => {
    const onNav = vi.fn();
    // null → `null` in YAML (the canonical spelling, not the obsolete `~`)
    const { rerender } = render(
      <Render
        value={{ seth: { $yamloverLink: { kind: "scalar", value: null, path: ":adam:seth" } } }}
        syntax="yaml"
        onNavigate={onNav}
      />,
    );
    const yamlLink = screen.getByText("null");
    expect(yamlLink.tagName).toBe("A");
    expect(yamlLink.getAttribute("href")).toBe(":adam:seth");
    fireEvent.click(yamlLink);
    expect(onNav).toHaveBeenCalledWith(":adam:seth");

    // null → `null`, string quoted in JSON
    rerender(
      <Render
        value={{ seth: { $yamloverLink: { kind: "scalar", value: null, path: ":adam:seth" } }, name: { $yamloverLink: { kind: "scalar", value: "Alice", path: ":name" } } }}
        syntax="json"
        onNavigate={onNav}
      />,
    );
    expect(screen.getByText("null").tagName).toBe("A");
    expect(screen.getByText('"Alice"').tagName).toBe("A");
  });

  it("renders a binary payload as a YAML !!binary block", () => {
    render(
      <Render
        value={{ $yamloverBinary: { format: "image/png", size: 9, base64: "iVBORw0KGgo" } }}
        syntax="yaml"
        onNavigate={() => {}}
      />,
    );
    const txt = document.body.textContent ?? "";
    expect(txt).toContain("!!binary");
    expect(txt).toContain("image/png");
    expect(txt).toContain("iVBORw0KGgo");
  });

  it("renders a rel ref resolving OUTSIDE the rendered subtree as a navigating hyperlink", () => {
    const onNav = vi.fn();
    render(
      <Render
        value={{ "x-yamlover": { rel: { mother: { $yamloverRef: { text: ":eve", path: ":eve" } } } } }}
        syntax="yaml"
        onNavigate={onNav}
        documentPath=":"
        nodePath=":adam" // the ref target :eve is not inside :adam → ordinary navigation
      />,
    );
    const link = screen.getByText(":eve");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe(":eve");
    fireEvent.click(link);
    expect(onNav).toHaveBeenCalledWith(":eve");
  });

  it("renders a LOCAL rel ref (inside the rendered subtree) as an in-page #fragment link", () => {
    const onNav = vi.fn();
    render(
      <Render
        value={{ "x-yamlover": { rel: { mother: { $yamloverRef: { text: ":eve", path: ":eve" } } } } }}
        syntax="yaml"
        onNavigate={onNav}
        documentPath=":"
        nodePath=":" // root renders the whole document → :eve is local, scroll in-page
      />,
    );
    const link = screen.getByText(":eve");
    expect(link.tagName).toBe("A");
    expect(link.getAttribute("href")).toBe("#/eve"); // slash continuation from the document root
    fireEvent.click(link);
    expect(onNav).not.toHaveBeenCalled(); // a local ref scrolls, it does not navigate
  });

  it("renders a file-backed omni's self-value as a navigable `< binary >`, never null", () => {
    const onNav = vi.fn();
    render(
      <Render
        value={{ $yamloverMixed: { kind: "omni", value: { $yamloverLink: { kind: "binary", type: "blob", path: ":pic.png", size: 1234 } }, entries: [{ key: "yamlover-thumbnails", value: {} }] } }}
        syntax="yaml"
        onNavigate={onNav}
        documentPath=":"
        nodePath=":pic.png"
      />,
    );
    const link = screen.getByText("< binary of 1234 bytes >"); // NOT "null"
    expect(link.tagName).toBe("A");
    fireEvent.click(link);
    expect(onNav).toHaveBeenCalledWith(":pic.png");
  });

  it("renders an unresolved rel ref as plain text (no link)", () => {
    render(
      <Render
        value={{ rel: { ghost: { $yamloverRef: { text: "*anchor", path: null } } } }}
        syntax="yaml"
        onNavigate={() => {}}
      />,
    );
    const el = screen.getByText("*anchor");
    expect(el.tagName).not.toBe("A");
  });

  it("renders JSON syntax with quoted keys/strings", () => {
    render(<Render value={{ name: "Alice" }} syntax="json" onNavigate={() => {}} />);
    const txt = document.body.textContent ?? "";
    expect(txt).toContain('"name"');
    expect(txt).toContain('"Alice"');
  });

  it("shows an inline nested container expanded by default, and folds it to a summary on toggle (YAML)", () => {
    render(<Render value={{ outer: { inner: "deep" } }} syntax="yaml" onNavigate={() => {}} />);
    // expanded by default: the nested value is visible
    expect(screen.getByText("inner")).toBeTruthy();
    expect(screen.getByText("deep")).toBeTruthy();
    // a fold toggle exists; click it to collapse
    const toggle = document.querySelector("button.fold-gutter") as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle);
    // collapsed: children gone, an in-place summary shown (not a navigating hyperlink)
    expect(screen.queryByText("inner")).toBeNull();
    const summary = screen.getByText("{ 1 property }");
    expect(summary.tagName).not.toBe("A");
    // toggling back restores the children
    fireEvent.click(document.querySelector("button.fold-gutter") as HTMLButtonElement);
    expect(screen.getByText("inner")).toBeTruthy();
  });

  it("marks the YAML array dash with its own class so it can be styled distinctly", () => {
    render(<Render value={{ list: ["a", "b"] }} syntax="yaml" onNavigate={() => {}} />);
    const dashes = document.querySelectorAll(".yaml-dash");
    expect(dashes).toHaveLength(2); // one per array item
    expect(dashes[0].textContent).toBe("-");
  });

  it("renders an array of objects in compact YAML block style — first key on the dash line, not wrapped below", () => {
    render(<Render value={{ pets: [{ name: "Rex", species: "dog" }] }} syntax="yaml" onNavigate={() => {}} />);
    const txt = document.body.textContent ?? "";
    expect(txt).toContain("- name:"); // dash and first key share the line (like JetBrains / real YAML)
    expect(txt).not.toMatch(/-\s*\n\s*name/); // NOT a bare dash then the key wrapped onto the next line
    expect(screen.getByText("Rex")).toBeTruthy();
    expect(screen.getByText("species")).toBeTruthy(); // the rest of the mapping still renders
  });

  it("folds an inline nested array to an item-count summary (JSON)", () => {
    render(<Render value={{ list: [1, 2, 3] }} syntax="json" onNavigate={() => {}} />);
    fireEvent.click(document.querySelector("button.fold-gutter") as HTMLButtonElement);
    expect(screen.getByText("[ 3 items ]")).toBeTruthy();
  });

  it("renders a NESTED mixed/omni marker as an omni block (not a literal $yamloverMixed key)", () => {
    render(
      <Render
        value={{ file: { $yamloverMixed: { kind: "omni", value: null, entries: [{ key: "tag", value: "x" }] } } }}
        syntax="yaml"
        onNavigate={() => {}}
      />,
    );
    const txt = document.body.textContent ?? "";
    expect(txt).not.toContain("$yamloverMixed"); // the marker is interpreted, not shown raw
    expect(screen.getByText("tag")).toBeTruthy(); // its field renders
    // folding it shows the omni summary
    fireEvent.click(document.querySelector("button.fold-gutter") as HTMLButtonElement);
    expect(screen.getByText("{ variant null + 1 field }")).toBeTruthy();
  });

  it("renders an omni self-value at its authored position (selfAt) among the entries — order preserved", () => {
    render(
      <Render
        value={{
          doc: {
            $yamloverMixed: {
              kind: "omni",
              value: "BLOCKVAL",
              selfAt: 1, // the self-value sits AFTER the first entry, matching the source
              entries: [
                { key: null, value: "solid" },
                { key: null, value: "recommended" },
                { key: "scale", value: 10 },
              ],
            },
          },
        }}
        syntax="yaml"
        onNavigate={() => {}}
      />,
    );
    const txt = document.body.textContent ?? "";
    // source order: solid · <self-value> · recommended · scale — the self is NOT hoisted first
    const iSolid = txt.indexOf("solid"), iSelf = txt.indexOf("BLOCKVAL"), iRec = txt.indexOf("recommended");
    expect(iSolid).toBeGreaterThanOrEqual(0);
    expect(iSelf).toBeGreaterThan(iSolid);
    expect(iRec).toBeGreaterThan(iSelf);
  });

  it("keeps a continuation link marker a navigating hyperlink, not a fold toggle", () => {
    const onNav = vi.fn();
    render(
      <Render
        value={{ child: { $yamloverLink: { kind: "object", count: 2, path: ":child" } } }}
        syntax="yaml"
        onNavigate={onNav}
      />,
    );
    expect(document.querySelector("button.fold-gutter")).toBeNull(); // a link marker is not collapsible
    const link = screen.getByText("{ object with 2 properties }");
    expect(link.tagName).toBe("A");
    fireEvent.click(link);
    expect(onNav).toHaveBeenCalledWith(":child");
  });
});
