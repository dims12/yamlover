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

  it("stamps every fragment anchor with its node path (the TOC presence bridge)", () => {
    render(
      <Render
        value={{ human1: { pets: ["Rex"] } }}
        syntax="yaml"
        onNavigate={() => {}}
        documentPath=":"
        nodePath=":"
      />,
    );
    const byId = (id: string) => document.getElementById(id) as HTMLElement | null;
    expect(byId("/human1")?.dataset.nodePath).toBe(":human1");
    expect(byId("/human1/pets")?.dataset.nodePath).toBe(":human1:pets");
    expect(byId("/human1/pets/0")?.dataset.nodePath).toBe(":human1:pets:0");
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
    // `#/` leads the banner — a TOC click on the file must not land after the comments
    const root = document.querySelector('.frag-anchor[id="/"]') as HTMLElement;
    const banner = [...document.querySelectorAll(".c")].find((e) => e.textContent?.includes("banner"));
    expect(root).toBeTruthy();
    expect(banner).toBeTruthy();
    expect(root.compareDocumentPosition(banner!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    expect(txt).not.toContain("boss: &: chief"); // own-line after the key, not jammed before the body
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

  it("renders a colon-styled bookmark on its own line, a bookmarked null as the bare `key:`", () => {
    // 58-genealogy-dag: `seth:\n  &: eve: seth` — a null scalar with a bookmark. Inlining
    // `&: eve: seth` on the key line before `null` drops the colon between bookmark and value;
    // the canonical spelling omits the `null` token entirely (the bookmark line carries it).
    render(
      <Render
        value={{ adam: { cain: { enoch: null }, seth: null, azura: { enoch: null } } }}
        syntax="yaml"
        onNavigate={() => {}}
        comments={{
          "/adam/cain": { anchors: [": eve: cain"] },
          "/adam/cain/enoch": { anchors: [": adam: azura: enoch"] },
          "/adam/seth": { anchors: [": eve: seth"] },
          "/adam/azura": { anchors: [": eve: azura"] },
        }}
      />,
    );
    const txt = document.body.textContent ?? "";
    expect(txt).not.toMatch(/&: eve: seth\s+null/); // not jammed before the value
    expect(txt).not.toMatch(/seth: ?null/); // a bookmarked null drops its token
    expect(txt).toMatch(/seth:\n\s+&: eve: seth\n/); // bare `key:`, the `&…` on its own line
    expect(txt).toMatch(/enoch:\n\s+&: adam: azura: enoch\n/);
    expect(txt).toMatch(/cain:\n\s+&: eve: cain\n/); // a container's bookmark leads its block
    expect(txt).toMatch(/azura:\n\s+&: eve: azura\n/);
    expect(txt).toMatch(/enoch: null/); // azura's enoch has no bookmark — null stays spelled
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
    expect(link.getAttribute("href")).toBe("/child");
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
    expect(yamlLink.getAttribute("href")).toBe("/adam/seth");
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
    expect(link.getAttribute("href")).toBe("/eve");
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

  it("renders a keyed OMNI's self-value ON the key row (`world: World`), children below — not wrapped", () => {
    // issue: a titled directory chapter (`world: World` + child) dropped its self-value to the next
    // line in the read-only view; it must ride the key row, matching the source and the editor.
    render(<Render value={{ world: { $yamloverMixed: { kind: "omni", value: "World", entries: [{ key: "eurasia", value: "Eurasia" }] } } }} syntax="yaml" onNavigate={() => {}} />);
    const txt = document.body.textContent ?? "";
    expect(txt).toContain("world: World"); // the omni self-value rides the key's own row
    expect(txt).not.toMatch(/world:\s*\n\s*World/); // NOT dropped to the next line
    expect(screen.getByText("eurasia")).toBeTruthy(); // its child still renders below
  });

  it("does NOT inline a keyed container's first CHILD onto the key row (`person: name:` is invalid)", () => {
    render(<Render value={{ person: { name: "Rex", age: 4 } }} syntax="yaml" onNavigate={() => {}} />);
    const txt = document.body.textContent ?? "";
    expect(txt).not.toContain("person: name"); // only a node's OWN self-value inlines after a key:
    expect(screen.getByText("name")).toBeTruthy();
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
    expect(screen.getByText("{ omni null + 1 field }")).toBeTruthy();
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

// FLOW in the READ-ONLY view. The two renderers are independent (this one draws the LOCKED view,
// cells.tsx the unlocked editor), so flow has to be honoured in both — otherwise typing `[12, 13]`
// and pressing Done showed `- 12` / `- 13`, telling the reader the file says something it does not.
// The style arrives per node as `comments[frag].repr === "yaml/flow"`.
describe("Render — the yaml/flow collection style", () => {
  const show = (value: unknown, comments: Record<string, unknown>): string => {
    const { container } = render(<Render value={value} syntax="yaml" onNavigate={() => {}} comments={comments as never} />);
    return container.textContent ?? "";
  };

  it("a flow DOCUMENT root stays one line", () => {
    expect(show([12, 13], { "": { repr: "yaml/flow" } })).toBe("[12, 13]\n");
  });

  it("a flow value rides its key row, and its siblings are untouched", () => {
    expect(show({ k: [12, 13], b: 1 }, { "/k": { repr: "yaml/flow" } })).toBe("k: [12, 13]\nb: 1\n");
  });

  it("a flow ELEMENT rides its dash", () => {
    expect(show([[12, 13], 9], { "/0": { repr: "yaml/flow" } })).toBe("- [12, 13]\n- 9\n");
  });

  it("a flow MAP keeps its braces and keys", () => {
    expect(show({ k: { a: 1, b: 2 } }, { "/k": { repr: "yaml/flow" } })).toBe("k: {a: 1, b: 2}\n");
  });

  it("nested flow nests — each level carries its own bit", () => {
    const c = { "/k": { repr: "yaml/flow" }, "/k/0": { repr: "yaml/flow" }, "/k/1": { repr: "yaml/flow" } };
    expect(show({ k: [[1, 2], [3]] }, c)).toBe("k: [[1, 2], [3]]\n");
  });

  it("BLOCK is the default — no bit, no braces", () => {
    // (the leading `›` is the fold chevron a block container's row carries)
    expect(show({ k: [12, 13] }, {})).toContain("k:\n  - 12\n  - 13\n");
  });

  it("scalar tokens inside a flow token keep their authored spelling", () => {
    const out = show({ k: [255, "~"] }, { "/k": { repr: "yaml/flow" }, "/k/0": { raw: "0xff" }, "/k/1": { raw: '"~"' } });
    expect(out).toBe('k: [0xff, "~"]\n'); // hex stays hex; the STRING "~" keeps its quotes
  });

  it("FALLS BACK to block when a member cannot live on one line", () => {
    // the same refusal the serializer applies (flowTextOrNull) — the view must not claim a shape
    // the file cannot carry, so a multiline member demotes the whole token
    const out = show({ k: ["a\nb"] }, { "/k": { repr: "yaml/flow" } });
    expect(out).not.toContain("["); // no brackets: the token demoted
    expect(out).toContain("k:");
    expect(out).toContain("- |-"); // the member renders as the block scalar it needs to be
  });
});

// K&R — a flow token written across SEVERAL lines, which on the yamlover surface is an inline
// concrete switch to json5p (docs/language/concretes/00-storage/00-inlined). It arrives as the sidecar's
// `concrete: "json5p"`, set only WHERE THE SWITCH HAPPENS: the interior is json5p by language, so
// this renderer expands the whole subtree — exactly what serialize-json5p.ts writes to the file.
describe("Render — a K&R (multi-line flow) value", () => {
  const show = (value: unknown, comments: Record<string, unknown>): string => {
    const { container } = render(<Render value={value} syntax="yaml" onNavigate={() => {}} comments={comments as never} />);
    return container.textContent ?? "";
  };
  const KR = { concrete: "json5p" };

  it("opens on the key row and closes at that key's column", () => {
    expect(show({ k: { a: 1, b: 2 }, z: 9 }, { "/k": KR })).toBe("k: {\n  a: 1,\n  b: 2\n}\nz: 9\n");
  });

  it("a sequence keeps its brackets, one element per line", () => {
    expect(show({ k: [1, 2] }, { "/k": KR })).toBe("k: [\n  1,\n  2\n]\n");
  });

  it("a K&R DOCUMENT root closes back at column 0", () => {
    expect(show({ a: 1 }, { "": KR })).toBe("{\n  a: 1\n}\n");
  });

  it("rides a dash, closing at the dash column", () => {
    expect(show([[1, 2], 9], { "/0": KR })).toBe("- [\n  1,\n  2\n]\n- 9\n");
  });

  it("EXPANDS every nested container — inside the switch the language is json5p", () => {
    // the inner token carries no bit of its own (the parser strips it: one signal, the concrete),
    // and the json5p emitter expands everything, so the view must too — else the screen and the
    // file would disagree about the same bytes
    expect(show({ k: { q: [1], y: 2 } }, { "/k": KR })).toBe("k: {\n  q: [\n    1\n  ],\n  y: 2\n}\n");
  });

  it("keeps authored scalar spellings, and an empty container stays tight", () => {
    const out = show({ k: { n: 255, e: {} } }, { "/k": KR, "/k/n": { raw: "0xff" } });
    expect(out).toBe("k: {\n  n: 0xff,\n  e: {}\n}\n");
  });

  it("FALLS BACK to block rows when a member cannot live in a token", () => {
    // the same refusal flow makes — a multiline member has no in-token form, so the whole thing
    // demotes to rows and the member becomes the block scalar it needs to be
    const out = show({ k: { a: "x\ny" } }, { "/k": KR });
    expect(out).not.toContain("{");
    expect(out).toContain("a: |-");
  });
});

// A whole DOCUMENT written K&R. Reported: a file that reads
//   [ \n {"name": "Eurasia", "children": [ … ]} \n ]
// rendered as block rows — the root's own `concrete` never left the server (its self bucket was
// emitted only for a hand-kept list of five fields), so the view showed a shape the file did not
// have. The bug was one layer down, but this is where it was visible.
// FLAT ROWS in the READ-ONLY view (docs/language/flattening). The key concrete arrives per
// entry as `comments[frag].keyConcrete === "yamlover/key/flat"` — the same sidecar channel
// flow uses for `repr`. Without it the view nests a shape the file wrote flat.
describe("Render — yamlover/key/flat", () => {
  const show = (value: unknown, comments: Record<string, unknown>): string => {
    const { container } = render(<Render value={value} syntax="yaml" onNavigate={() => {}} comments={comments as never} />);
    return (container.textContent ?? "").replace(/›/g, "");
  };
  const flat = (frag: string) => ({ [frag]: { keyConcrete: "yamlover/key/flat" } });

  it("a multi-child fold repeats the head — human1: name / human1: age", () => {
    expect(show({ human1: { name: "Alice", age: 30 } }, { ...flat("/human1/name"), ...flat("/human1/age") }))
      .toBe("human1: name: Alice\nhuman1: age: 30\n");
  });

  it("the nested twin without the concrete stays nested", () => {
    expect(show({ human1: { name: "Alice", age: 30 } }, {})).toBe("human1:\n  name: Alice\n  age: 30\n");
  });

  it("a trailing -: append plus its block is one row, body one step under", () => {
    const v = { human1: { pets: [{ name: "Whiskers", kind: "cat" }] } };
    const c = { ...flat("/human1/pets"), ...flat("/human1/pets/0") };
    expect(show(v, c)).toBe("human1: pets: -:\n  name: Whiskers\n  kind: cat\n");
  });

  it("a row of scalars is a repetition of trailing -: rows", () => {
    expect(show({ scores: [7, 9] }, { ...flat("/scores/0"), ...flat("/scores/1") }))
      .toBe("scores: -: 7\nscores: -: 9\n");
  });

  it("each flat row lists every segment path for the TOC in-view band", () => {
    const { container } = render(
      <Render
        value={{ human1: { name: "Alice", age: 30 } }}
        syntax="yaml"
        onNavigate={() => {}}
        comments={{ "/human1/name": { keyConcrete: "yamlover/key/flat" }, "/human1/age": { keyConcrete: "yamlover/key/flat" } }}
        documentPath=":"
        nodePath=":"
      />,
    );
    const rows = [...container.querySelectorAll<HTMLElement>("[data-flat-paths]")];
    expect(rows.map((r) => r.dataset.flatPaths)).toEqual([
      ":human1 :human1:name",
      ":human1 :human1:age",
    ]);
  });
});

describe("Render — a K&R DOCUMENT", () => {
  it("draws the whole document as written, at every level", () => {
    const value = [{ name: "Eurasia", children: [{ name: "Europe" }, { name: "Asia" }] }];
    const comments = { "": { concrete: "json5p" }, "/0/name": { raw: '"Eurasia"' },
      "/0/children/0/name": { raw: '"Europe"' }, "/0/children/1/name": { raw: '"Asia"' } };
    const { container } = render(<Render value={value} syntax="yaml" onNavigate={() => {}} comments={comments as never} />);
    expect(container.textContent).toBe(
      '[\n  {\n    name: "Eurasia",\n    children: [\n      {\n        name: "Europe"\n      },\n      {\n        name: "Asia"\n      }\n    ]\n  }\n]\n',
    );
  });
});
