/**
 * Turns a docs source file into the plain Markdown an AI assistant reads.
 *
 * Two callers, one implementation: the docs site's `llms-markdown` plugin
 * writes a `.md` copy next to every page, and `scripts/llms/build-llms.mjs`
 * concatenates the same pages into trackyourtime.dev's `llms-full.txt`. Both
 * need the same three things done to a source file — front matter gone, the
 * page title kept as its first heading, and links pointed somewhere a reader
 * outside the docs build can follow — so a fix to one is a fix to both.
 *
 * No Markdown parser: the docs are plain CommonMark with a handful of MDX
 * comments, and a dependency here would be the docs site's only one outside
 * Docusaurus. The line walker below tracks fenced code blocks, which is the
 * one piece of structure that matters — `import` and `{/* … *\/}` inside a code
 * sample are content, not MDX.
 */

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Split a source file into its front matter fields and its body.
 *
 * Only flat `key: value` pairs are read, which is every field these docs use
 * (`slug`, `sidebar_position`, `description`, `title`). Quotes around a value
 * are removed. A file with no front matter comes back with `data` empty.
 *
 * @param {string} source
 * @returns {{ data: Record<string, string>, body: string }}
 */
export function splitFrontMatter(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { data: {}, body: normalized };

  /** @type {Record<string, string>} */
  const data = {};
  for (const line of match[1].split("\n")) {
    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!field) continue;
    let value = field[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    data[field[1]] = value;
  }
  return { data, body: normalized.slice(match[0].length) };
}

/**
 * The page title a reader sees: front matter `title`, else the first `# H1`.
 *
 * @param {string} source
 * @returns {string | null}
 */
export function titleOf(source) {
  const { data, body } = splitFrontMatter(source);
  if (data.title) return data.title;
  let inFence = false;
  for (const line of body.split("\n")) {
    if (FENCE.test(line)) inFence = !inFence;
    if (inFence) continue;
    const heading = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) return heading[1];
  }
  return null;
}

/**
 * Apply `rewrite` to every inline link and link reference definition target
 * in one line of prose. Inline code spans are left alone.
 *
 * @param {string} line
 * @param {(target: string) => string} rewrite
 * @returns {string}
 */
function rewriteLinksInLine(line, rewrite) {
  const definition = /^(\s{0,3}\[[^\]]+\]:\s*)(<[^>]*>|\S+)(.*)$/.exec(line);
  if (definition) {
    return `${definition[1]}${rewriteTarget(definition[2], rewrite)}${definition[3]}`;
  }

  // Split on inline code spans so a `](x)` inside backticks is not touched.
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part.replace(
            /\]\((\s*)(<[^>]*>|[^)\s]+)((?:\s+(?:"[^"]*"|'[^']*'))?\s*)\)/g,
            (_all, lead, target, rest) => `](${lead}${rewriteTarget(target, rewrite)}${rest})`,
          ),
    )
    .join("");
}

/**
 * @param {string} target
 * @param {(target: string) => string} rewrite
 */
function rewriteTarget(target, rewrite) {
  if (target.startsWith("<") && target.endsWith(">")) {
    return `<${rewrite(target.slice(1, -1))}>`;
  }
  return rewrite(target);
}

/**
 * Remove the MDX-only syntax these docs can contain: `{/* comments *\/}`
 * (single- or multi-line) and top-level ESM `import`/`export` statements.
 * Code fences are passed through untouched.
 *
 * @param {string[]} lines
 * @returns {string[]}
 */
function stripMdx(lines) {
  /** @type {string[]} */
  const out = [];
  let inFence = false;
  let inComment = false;

  for (const line of lines) {
    if (!inComment && FENCE.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    let text = line;
    if (inComment) {
      const end = text.indexOf("*/}");
      if (end === -1) continue;
      text = text.slice(end + 3);
      inComment = false;
    }
    text = text.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const open = text.indexOf("{/*");
    if (open !== -1) {
      text = text.slice(0, open);
      inComment = true;
    }

    if (/^import\s+(?:[\w*{][^'"]*\s+from\s+)?["'][^"']+["'];?\s*$/.test(text)) continue;
    if (/^export\s+(?:const|let|default|function|\{)/.test(text)) continue;

    // A line that held only a comment disappears rather than leaving a blank.
    if (text.trim() === "" && line.trim() !== "") continue;
    out.push(text);
  }
  return out;
}

/**
 * Clean Markdown for one docs page.
 *
 * @param {string} source The file as it sits in the repo.
 * @param {{ title?: string, rewriteLink?: (target: string) => string }} [options]
 *   `title` is used when the body has no `# H1` of its own. `rewriteLink`
 *   receives every link target outside code and returns its replacement.
 * @returns {string}
 */
export function toCleanMarkdown(source, options = {}) {
  const { body } = splitFrontMatter(source);
  const rewrite = options.rewriteLink ?? ((target) => target);

  const lines = stripMdx(body.split("\n"));
  let inFence = false;
  const rewritten = lines.map((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return line;
    }
    return inFence ? line : rewriteLinksInLine(line, rewrite);
  });

  let text = rewritten.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const title = options.title ?? titleOf(source);
  if (!/^#\s/.test(text) && title) text = `# ${title}\n\n${text}`;
  return `${text}\n`;
}

/**
 * Split a link target into its path and its `#fragment` / `?query` suffix.
 *
 * @param {string} target
 * @returns {{ path: string, suffix: string }}
 */
export function splitTarget(target) {
  const index = target.search(/[#?]/);
  return index === -1
    ? { path: target, suffix: "" }
    : { path: target.slice(0, index), suffix: target.slice(index) };
}

/**
 * True for a target with a scheme (`https:`, `mailto:`, `pathname:`) or a
 * protocol-relative `//host`.
 *
 * @param {string} target
 */
export function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//");
}
