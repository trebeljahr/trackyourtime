/**
 * A tag-balance check for serializer output. Not a parser and not a schema
 * check — the Java validators own those. It catches the things a string
 * builder gets wrong: an unclosed or mis-nested tag, a raw `&` or `<` in
 * text, an entity other than the five predefined ones, a second root.
 */

const NAME = "[A-Za-z_][A-Za-z0-9_.:-]*";
const TOKEN = new RegExp(
  `<\\?xml[^?]*\\?>|<(/?)(${NAME})((?:\\s+${NAME}\\s*=\\s*"[^"<]*")*)\\s*(/?)>|<|&(?!(?:amp|lt|gt|quot|apos);)`,
  "g",
);

/** Throws an Error naming the first problem found. */
export function assertWellFormedXml(xml: string): void {
  const stack: string[] = [];
  let roots = 0;
  let declarationSeen = false;
  let position = 0;
  for (const match of xml.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    const text = xml.slice(position, index);
    if (stack.length === 0 && text.trim() !== "") {
      throw new Error(`text outside the root element at offset ${position}`);
    }
    position = index + match[0].length;
    const token = match[0];
    if (token.startsWith("<?xml")) {
      if (index !== 0 || declarationSeen) throw new Error("XML declaration not at the start");
      declarationSeen = true;
      continue;
    }
    if (token === "<") throw new Error(`unescaped "<" at offset ${index}`);
    if (token.startsWith("&")) throw new Error(`unknown or raw entity at offset ${index}`);
    const [, closing, name, attrs, selfClosing] = match;
    if (name === undefined) throw new Error(`unreadable tag at offset ${index}`);
    const attrNames = [...(attrs ?? "").matchAll(new RegExp(`(${NAME})\\s*=`, "g"))].map((m) => m[1]);
    if (new Set(attrNames).size !== attrNames.length) throw new Error(`duplicate attribute on <${name}>`);
    if (closing === "/") {
      const open = stack.pop();
      if (open !== name) throw new Error(`</${name}> closes <${open ?? "nothing"}> at offset ${index}`);
      continue;
    }
    if (stack.length === 0) roots++;
    if (roots > 1) throw new Error(`second root element <${name}> at offset ${index}`);
    if (selfClosing !== "/") stack.push(name);
  }
  if (xml.slice(position).trim() !== "") throw new Error("text after the root element");
  if (stack.length > 0) throw new Error(`unclosed <${stack[stack.length - 1]}>`);
  if (roots === 0) throw new Error("no root element");
}
