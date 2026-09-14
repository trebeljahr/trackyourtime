/**
 * Host globs, for filing rules and exclusion lists alike.
 */
import type { ActivityRule } from "./types.js";

const escapeRegExp = (text: string): string =>
  text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/**
 * Normalise what a person typed into a host pattern.
 *
 * Tolerates a pasted URL (`https://docs.example.com/a/b` → `docs.example.com`),
 * a port and surrounding whitespace, lowercases, and strips a trailing dot.
 * Returns an empty string for input with nothing host-like in it.
 */
export function normalizeHostPattern(input: string): string {
  let text = input.trim().toLowerCase();
  const scheme = text.indexOf("://");
  if (scheme !== -1) text = text.slice(scheme + 3);
  const slash = text.indexOf("/");
  if (slash !== -1) text = text.slice(0, slash);
  const colon = text.lastIndexOf(":");
  if (colon !== -1 && /^\d+$/.test(text.slice(colon + 1))) {
    text = text.slice(0, colon);
  }
  return text.replace(/\.$/, "");
}

/**
 * Whether `host` matches the glob `pattern`.
 *
 * `*` matches any run of characters, dots included. A pattern starting `*.`
 * also matches the bare domain after it, because "everything on example.com"
 * is what a person means by `*.example.com`. Both sides are normalised, so
 * matching is case-insensitive.
 */
export function hostMatches(pattern: string, host: string): boolean {
  const normalizedPattern = normalizeHostPattern(pattern);
  const normalizedHost = normalizeHostPattern(host);
  if (normalizedPattern === "" || normalizedHost === "") return false;

  if (
    normalizedPattern.startsWith("*.") &&
    normalizedHost === normalizedPattern.slice(2)
  ) {
    return true;
  }

  const source = normalizedPattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`).test(normalizedHost);
}

/** Whether any pattern in the list matches `host`. */
export function hostMatchesAny(
  patterns: readonly string[],
  host: string,
): boolean {
  return patterns.some((pattern) => hostMatches(pattern, host));
}

/**
 * The rule that files a block, given its keys with the most time first.
 *
 * The dominant key decides: keys are tried in order, and for each key the
 * first rule in list order that matches it wins. A block that is mostly an
 * issue tracker with a little chat is filed by the tracker's rule even when
 * the chat rule sits higher in the list.
 */
export function matchRule(
  rules: readonly ActivityRule[],
  keysByTime: readonly string[],
): ActivityRule | null {
  for (const key of keysByTime) {
    const rule = rules.find((candidate) => hostMatches(candidate.pattern, key));
    if (rule !== undefined) return rule;
  }
  return null;
}
