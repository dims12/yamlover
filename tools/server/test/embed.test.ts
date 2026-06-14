import { describe, it, expect } from "vitest";
import { appendAnnotation, upsertFragment, removeAnnotation, keyToken } from "../src/server/embed";

// Surgical embedding of fragments + annotations into a yamlover host body (ANNOTATIONS.md).
// Pure string transforms — no fs / Store; the round-trip target is "parses back to the same data".

const TAG = "- *::tags:colors:yellow";
const tagLines = () => [TAG];

describe("appendAnnotation", () => {
  it("creates yamlover-annotations on a fresh whole-document body", () => {
    const src = "title: A Paper\n";
    const out = appendAnnotation(src, [], (i) => [`${" ".repeat(i)}${TAG}`]);
    expect(out).toBe("title: A Paper\nyamlover-annotations:\n- *::tags:colors:yellow\n");
  });

  it("appends to an existing yamlover-annotations sequence", () => {
    const src = "title: A Paper\nyamlover-annotations:\n- *::tags:colors:green\n";
    const out = appendAnnotation(src, [], (i) => [`${" ".repeat(i)}${TAG}`]);
    expect(out).toBe(
      "title: A Paper\nyamlover-annotations:\n- *::tags:colors:green\n- *::tags:colors:yellow\n",
    );
  });

  it("creates a keyed file block in a fresh overlay, then its annotations", () => {
    const src = "";
    const fname = "S0002-9904.pdf";
    const out = appendAnnotation(src, [fname], (i) => [`${" ".repeat(i)}${TAG}`]);
    expect(out).toBe(
      `"S0002-9904.pdf":\n  yamlover-annotations:\n  - *::tags:colors:yellow\n`,
    );
  });

  it("appends under an existing keyed file block (indent preserved)", () => {
    const src = `"a.pdf":\n  yamlover-annotations:\n  - *::tags:colors:green\n`;
    const out = appendAnnotation(src, ["a.pdf"], (i) => [`${" ".repeat(i)}${TAG}`]);
    expect(out).toBe(
      `"a.pdf":\n  yamlover-annotations:\n  - *::tags:colors:green\n  - *::tags:colors:yellow\n`,
    );
  });

  it("targets a fragment's own annotations", () => {
    const src = `"a.pdf":\n  yamlover-fragments:\n    slug1:\n      type: pdf\n      page: 1\n`;
    const out = appendAnnotation(src, ["a.pdf", "yamlover-fragments", "slug1"], (i) => [`${" ".repeat(i)}${TAG}`]);
    expect(out).toBe(
      `"a.pdf":\n  yamlover-fragments:\n    slug1:\n      type: pdf\n      page: 1\n      yamlover-annotations:\n      - *::tags:colors:yellow\n`,
    );
  });
});

describe("upsertFragment", () => {
  const frag = (i: number) => [
    `${" ".repeat(i)}slug1:`,
    `${" ".repeat(i + 2)}type: pdf`,
    `${" ".repeat(i + 2)}page: 1`,
  ];

  it("creates yamlover-fragments + the slug on a fresh file block", () => {
    const out = upsertFragment("", ["a.pdf"], "slug1", frag);
    expect(out).toBe(
      `"a.pdf":\n  yamlover-fragments:\n    slug1:\n      type: pdf\n      page: 1\n`,
    );
  });

  it("adds a second slug into an existing fragments map", () => {
    const src = `"a.pdf":\n  yamlover-fragments:\n    slug0:\n      type: pdf\n`;
    const out = upsertFragment(src, ["a.pdf"], "slug1", frag);
    expect(out).toBe(
      `"a.pdf":\n  yamlover-fragments:\n    slug0:\n      type: pdf\n    slug1:\n      type: pdf\n      page: 1\n`,
    );
  });

  it("replaces an existing slug block", () => {
    const src = `"a.pdf":\n  yamlover-fragments:\n    slug1:\n      type: pdf\n      page: 9\n`;
    const out = upsertFragment(src, ["a.pdf"], "slug1", frag);
    expect(out).toBe(
      `"a.pdf":\n  yamlover-fragments:\n    slug1:\n      type: pdf\n      page: 1\n`,
    );
  });
});

describe("removeAnnotation", () => {
  it("removes the matching tag element", () => {
    const src = "yamlover-annotations:\n- *::tags:colors:green\n- *::tags:colors:yellow\n";
    const out = removeAnnotation(src, [], (t) => t === "*::tags:colors:green");
    expect(out).toBe("yamlover-annotations:\n- *::tags:colors:yellow\n");
  });

  it("is a no-op when nothing matches", () => {
    const src = "yamlover-annotations:\n- *::tags:colors:green\n";
    expect(removeAnnotation(src, [], (t) => t === "nope")).toBe(src);
  });
});

describe("keyToken", () => {
  it("quotes filenames with dots/dashes-as-needed and spaces", () => {
    expect(keyToken("plain_name")).toBe("plain_name");
    expect(keyToken("S0002-9904.pdf")).toBe('"S0002-9904.pdf"');
    expect(keyToken("has space")).toBe('"has space"');
  });
});
