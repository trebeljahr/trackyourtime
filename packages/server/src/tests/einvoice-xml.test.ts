import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { el, escapeXml, render, stripInvalidXmlChars, type XmlNode } from "../services/einvoice/xml.js";
import { assertWellFormedXml } from "./support/xml-well-formed.js";

const must = (node: XmlNode | null): XmlNode => {
  assert.ok(node, "expected a node");
  return node;
};

describe("el", () => {
  it("drops blank text leaves", () => {
    assert.equal(el("a:B", ""), null);
    assert.equal(el("a:B", "   \n\t"), null);
    assert.equal(el("a:B", "\u0007"), null);
  });

  it("keeps non-blank text as written", () => {
    assert.deepEqual(el("a:B", " x "), { name: "a:B", attrs: {}, children: " x " });
  });

  it("drops null children and a parent left with none", () => {
    assert.equal(el("a:P", [null, el("a:C", "")]), null);
    assert.equal(el("a:P", []), null);
    const parent = must(el("a:P", [null, el("a:C", "1")]));
    assert.equal((parent.children as readonly XmlNode[]).length, 1);
  });

  it("drops a grandparent whose whole subtree is empty", () => {
    assert.equal(el("a:G", [el("a:P", [el("a:C", " ")])]), null);
  });
});

describe("escapeXml", () => {
  it("escapes the five predefined entities", () => {
    assert.equal(escapeXml(`a & b < c > d " e ' f`), "a &amp; b &lt; c &gt; d &quot; e &apos; f");
  });

  it("does not double-escape", () => {
    assert.equal(escapeXml("&amp;"), "&amp;amp;");
  });

  it("keeps non-ASCII text and astral characters", () => {
    assert.equal(escapeXml("ä – 😀"), "ä – 😀");
  });
});

describe("stripInvalidXmlChars", () => {
  it("removes C0 controls except tab, LF and CR", () => {
    assert.equal(stripInvalidXmlChars("a\u0000b\u0007c\u001Fd\te\nf\rg"), "abcd\te\nf\rg");
  });

  it("removes U+FFFE and U+FFFF", () => {
    assert.equal(stripInvalidXmlChars("a\uFFFEb\uFFFFc"), "abc");
  });

  it("removes lone surrogates and keeps pairs", () => {
    assert.equal(stripInvalidXmlChars("a\uD800b\uDC00c"), "abc");
    assert.equal(stripInvalidXmlChars("x😀y"), "x😀y");
  });
});

describe("render", () => {
  it("writes the declaration, 2-space indent, leaf text inline and a trailing newline", () => {
    const root = must(
      el("r:Root", [el("r:A", [el("r:Leaf", "1 & 2", { schemeID: `E"M` })]), el("r:B", "x")], {
        "xmlns:r": "urn:example",
      }),
    );
    assert.equal(
      render(root),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<r:Root xmlns:r="urn:example">',
        "  <r:A>",
        '    <r:Leaf schemeID="E&quot;M">1 &amp; 2</r:Leaf>',
        "  </r:A>",
        "  <r:B>x</r:B>",
        "</r:Root>",
        "",
      ].join("\n"),
    );
  });

  it("produces well-formed output with no BOM", () => {
    const xml = render(must(el("r:Root", [el("r:Note", "line one\nline two <b>")])));
    assert.notEqual(xml.charCodeAt(0), 0xfeff);
    assert.doesNotThrow(() => assertWellFormedXml(xml));
  });
});
