/**
 * Catalog tooling shared by every package that ships translated text: the web
 * client, the server's invoice/email dictionaries and the browser extension.
 *
 * Nothing here formats a message — that is `use-intl`'s job. This is what makes
 * a catalog safe to change: the type that forces a translation to have exactly
 * the source's keys, the ICU walker the parity tests use to prove placeholders
 * match, and the pseudo-localiser that finds truncation before a translator
 * does.
 */

/** A nested message tree: leaves are ICU message strings. */
export type MessageTree = { readonly [key: string]: string | MessageTree };

/**
 * The shape a translation must have: every key of the source catalog, every
 * leaf a string, nothing extra.
 *
 * The source is declared `as const`, so its leaves are string literals; this
 * widens them to `string` so a translation can say something different while a
 * missing key, a misspelled key or an extra key still fails `tsc`. (Extra keys
 * fail through TypeScript's excess-property check, which applies because each
 * catalog file annotates its object literal directly — assigning through an
 * intermediate variable would lose that half.)
 */
export type Translation<T> = {
  -readonly [K in keyof T]: T[K] extends string ? string : Translation<T[K]>;
};

/** Every leaf of a tree as `[dotted.key, message]`. */
export const flattenMessages = (
  tree: MessageTree,
  prefix = "",
): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") out.push([path, value]);
    else out.push(...flattenMessages(value, path));
  }
  return out;
};

/** The same tree with every leaf passed through `fn`. */
export const mapMessages = <T extends MessageTree>(
  tree: T,
  fn: (message: string, key: string) => string,
  prefix = "",
): T => {
  const out: Record<string, string | MessageTree> = {};
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    out[key] = typeof value === "string" ? fn(value, path) : mapMessages(value, fn, path);
  }
  return out as T;
};

// ── ICU walking ──────────────────────────────────────────────────────
//
// A deliberately small reader of the ICU MessageFormat subset use-intl
// accepts: `{arg}`, `{arg, number|date|time, style}`,
// `{arg, plural|select|selectordinal, … {branch}}`, `#`, apostrophe quoting and
// rich-text tags `<b>…</b>`. It never has to FORMAT anything, only to tell
// literal text apart from syntax, which is what both consumers need.

type Visitor = {
  /** Literal, translatable text. Returned string replaces it. */
  text: (literal: string) => string;
  /** An argument name was seen (`{name}` or the selector of a plural). */
  argument?: (name: string) => void;
  /** A rich-text tag name was seen (`<name>`). */
  tag?: (name: string) => void;
};

const SELECT_TYPES = new Set(["plural", "select", "selectordinal"]);

/** Walks `message`, rewriting literal text through the visitor. */
const walk = (message: string, visitor: Visitor): string => {
  let i = 0;

  const readMessage = (inPlural: boolean, closeOnBrace: boolean): string => {
    let out = "";
    let literal = "";
    const flush = (): void => {
      if (literal !== "") out += visitor.text(literal);
      literal = "";
    };

    while (i < message.length) {
      const ch = message[i];

      if (ch === "}" && closeOnBrace) {
        flush();
        return out;
      }

      if (ch === "'") {
        // '' is a literal apostrophe; '{…}' quotes syntax characters.
        if (message[i + 1] === "'") {
          flush();
          out += "''";
          i += 2;
          continue;
        }
        const next = message[i + 1];
        if (next === "{" || next === "}" || next === "<" || (inPlural && next === "#")) {
          const end = message.indexOf("'", i + 1);
          flush();
          const stop = end === -1 ? message.length : end + 1;
          out += message.slice(i, stop);
          i = stop;
          continue;
        }
        literal += ch;
        i += 1;
        continue;
      }

      if (ch === "#" && inPlural) {
        flush();
        out += "#";
        i += 1;
        continue;
      }

      if (ch === "<") {
        const match = /^<\/?([A-Za-z][\w-]*)\s*\/?>/.exec(message.slice(i));
        if (match) {
          flush();
          visitor.tag?.(match[1]);
          out += match[0];
          i += match[0].length;
          continue;
        }
      }

      if (ch === "{") {
        flush();
        out += readArgument();
        continue;
      }

      literal += ch;
      i += 1;
    }

    flush();
    return out;
  };

  const readArgument = (): string => {
    const start = i;
    i += 1; // {
    const nameMatch = /^\s*([^\s,{}]+)\s*/.exec(message.slice(i));
    const name = nameMatch?.[1] ?? "";
    visitor.argument?.(name);
    i += nameMatch?.[0].length ?? 0;

    if (message[i] === "}") {
      i += 1;
      return message.slice(start, i);
    }

    // `, type`
    i += 1;
    const typeMatch = /^\s*(\w+)\s*/.exec(message.slice(i));
    const type = typeMatch?.[1] ?? "";
    i += typeMatch?.[0].length ?? 0;

    if (!SELECT_TYPES.has(type)) {
      // number/date/time: the style is syntax, copied verbatim.
      let depth = 1;
      while (i < message.length && depth > 0) {
        if (message[i] === "{") depth += 1;
        else if (message[i] === "}") depth -= 1;
        i += 1;
      }
      return message.slice(start, i);
    }

    let out = message.slice(start, i);
    if (message[i] === ",") {
      out += ",";
      i += 1;
    }

    // selector {branch} pairs, optionally `offset:n` first.
    while (i < message.length) {
      const ws = /^\s*/.exec(message.slice(i))?.[0] ?? "";
      out += ws;
      i += ws.length;
      if (message[i] === "}") {
        i += 1;
        return `${out}}`;
      }
      const selector = /^[^\s{}]+/.exec(message.slice(i))?.[0] ?? "";
      out += selector;
      i += selector.length;
      const gap = /^\s*/.exec(message.slice(i))?.[0] ?? "";
      out += gap;
      i += gap.length;
      if (selector.startsWith("offset:")) continue;
      if (message[i] !== "{") break;
      i += 1;
      const branch = readMessage(type !== "select", true);
      i += 1; // }
      out += `{${branch}}`;
    }
    return out;
  };

  return readMessage(false, false);
};

/**
 * The argument and tag names a message uses, sorted and de-duplicated —
 * `"{count, plural, one {# entry} other {# entries}} in <b>{project}</b>"`
 * gives `["<b>", "count", "project"]`.
 *
 * The parity test compares these between locales: a translation that renames
 * `{project}` to `{projekt}` type-checks (the message is just a string) and
 * renders the raw placeholder at runtime, so nothing but this catches it.
 */
export const icuPlaceholders = (message: string): string[] => {
  const names = new Set<string>();
  walk(message, {
    text: (literal) => literal,
    argument: (name) => names.add(name),
    tag: (name) => names.add(`<${name}>`),
  });
  return [...names].sort();
};

const ACCENTED: Record<string, string> = {
  a: "á", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "í",
  j: "ĵ", k: "ķ", l: "ļ", m: "ɱ", n: "ñ", o: "ó", p: "þ", q: "ǫ", r: "ŕ",
  s: "š", t: "ţ", u: "ú", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "Á", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Í",
  J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ", N: "Ñ", O: "Ó", P: "Þ", Q: "Ǫ", R: "Ŕ",
  S: "Š", T: "Ţ", U: "Ú", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

/**
 * The pseudo-locale form of one message: every letter accented, roughly 35%
 * longer, wrapped in brackets — `"Start timer"` → `"[Šţáŕţ ţíɱéŕ ~~~~]"`.
 *
 * Placeholders, plural selectors, `#` and tags are left intact, so the result
 * is still a valid message with the same arguments. Text that shows up
 * un-accented in the pseudo locale was never extracted; text that is clipped
 * or wraps badly will do the same in German, which runs about a third longer
 * than English.
 */
/** Longest run of padding before a break — about one long German word. */
const PSEUDO_WORD = 8;

export const pseudoLocalize = (message: string): string => {
  let letters = 0;
  const body = walk(message, {
    text: (literal) =>
      literal.replace(/[A-Za-z]/g, (ch) => {
        letters += 1;
        return ACCENTED[ch] ?? ch;
      }),
  });
  if (body.trim() === "") return message;
  // The padding stands in for longer WORDS, so it comes in word-sized runs:
  // one unbroken run of forty tildes can never wrap, and would report a long
  // sentence as overflowing where German, which wraps between words, fits.
  const length = Math.max(1, Math.ceil(letters * 0.35));
  const pad = Array.from({ length: Math.ceil(length / PSEUDO_WORD) }, (_, index) =>
    "~".repeat(Math.min(PSEUDO_WORD, length - index * PSEUDO_WORD)),
  ).join(" ");
  return `[${body} ${pad}]`;
};
