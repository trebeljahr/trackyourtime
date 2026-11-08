/**
 * A minimal XML tree writer for the CII serializer.
 *
 * Its one rule that matters: a node with nothing in it does not exist.
 * PEPPOL-EN16931-R008 rejects any empty element, so `el()` returns null for
 * blank text and for a parent whose children all dropped, and `render` never
 * sees an empty node. Optional business terms are therefore passed in
 * unconditionally — no if-branches in the builders, and no string templates.
 *
 * Output is deterministic: `\n` line endings, 2-space indent, a UTF-8
 * declaration without a BOM, leaf text on the same line as its tags.
 */

export type XmlNode = {
  name: string;
  attrs: Readonly<Record<string, string>>;
  children: readonly XmlNode[] | string;
};

// XML 1.0 Char: #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF].
// Lone surrogates are removed in a separate pass because a regex with the `u`
// flag cannot match half a pair.
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/** Removes code points illegal in XML 1.0: C0 except \t \n \r, U+FFFE, U+FFFF, lone surrogates. */
export function stripInvalidXmlChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i] + value[i + 1];
        i++;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    out += value[i];
  }
  return out.replace(INVALID_XML_CHARS, "");
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

/** & < > " ' → entities, after stripInvalidXmlChars. Used for text and attribute values. */
export function escapeXml(value: string): string {
  return stripInvalidXmlChars(value).replace(/[&<>"']/g, (ch) => ENTITIES[ch] ?? ch);
}

/**
 * Build a node, or null when there is nothing to write.
 * - children is a string: trimmed-empty → null (R008).
 * - children is an array: nulls are dropped; an empty result → null.
 */
export function el(
  name: string,
  children: string | ReadonlyArray<XmlNode | null>,
  attrs: Readonly<Record<string, string>> = {},
): XmlNode | null {
  if (typeof children === "string") {
    if (stripInvalidXmlChars(children).trim() === "") return null;
    return { name, attrs, children };
  }
  const kept = children.filter((child): child is XmlNode => child !== null);
  if (kept.length === 0) return null;
  return { name, attrs, children: kept };
}

function renderAttrs(attrs: Readonly<Record<string, string>>): string {
  return Object.entries(attrs)
    .map(([key, value]) => ` ${key}="${escapeXml(value)}"`)
    .join("");
}

function renderNode(node: XmlNode, depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  const open = `${node.name}${renderAttrs(node.attrs)}`;
  if (typeof node.children === "string") {
    out.push(`${indent}<${open}>${escapeXml(node.children)}</${node.name}>`);
    return;
  }
  out.push(`${indent}<${open}>`);
  for (const child of node.children) renderNode(child, depth + 1, out);
  out.push(`${indent}</${node.name}>`);
}

/** `<?xml version="1.0" encoding="UTF-8"?>\n` + 2-space indented tree + trailing "\n". */
export function render(root: XmlNode): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  renderNode(root, 0, lines);
  return `${lines.join("\n")}\n`;
}
