//! Host globs, for filing rules and exclusion lists alike
//! (`packages/core/src/activity/rules.ts`).

use super::types::{ActivityRule, ProposedEntryFields};
use crate::js;

/// Normalise what a person typed into a host pattern.
///
/// Tolerates a pasted URL (`https://docs.example.com/a/b` → `docs.example.com`),
/// a port and surrounding whitespace, lowercases, and strips a trailing dot.
/// Returns an empty string for input with nothing host-like in it.
pub fn normalize_host_pattern(input: &str) -> String {
    let mut text = js::lower(js::trim(input));
    if let Some(scheme) = text.find("://") {
        text = text[scheme + 3..].to_string();
    }
    if let Some(slash) = text.find('/') {
        text.truncate(slash);
    }
    if let Some(colon) = text.rfind(':') {
        let port = &text[colon + 1..];
        // `/^\d+$/` without the `u` flag: ASCII digits only.
        if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) {
            text.truncate(colon);
        }
    }
    if text.ends_with('.') {
        text.pop();
    }
    text
}

/// `^piece.*piece…$`, where `.*` is JavaScript's: any run of characters except
/// line terminators (no `s` flag). A DP over (pattern token, text position),
/// since a restricted `*` breaks the usual single-backtrack glob algorithm.
fn glob_matches(pattern: &str, text: &str) -> bool {
    enum Token {
        Char(char),
        Star,
    }
    let tokens: Vec<Token> = pattern
        .chars()
        .map(|c| {
            if c == '*' {
                Token::Star
            } else {
                Token::Char(c)
            }
        })
        .collect();
    let chars: Vec<char> = text.chars().collect();
    // reach[j]: the tokens consumed so far can end at text position j.
    let mut reach = vec![false; chars.len() + 1];
    reach[0] = true;
    for token in &tokens {
        let mut next = vec![false; chars.len() + 1];
        match token {
            Token::Char(expected) => {
                for j in 0..chars.len() {
                    if reach[j] && chars[j] == *expected {
                        next[j + 1] = true;
                    }
                }
            }
            Token::Star => {
                for j in 0..=chars.len() {
                    if reach[j]
                        || (j > 0 && next[j - 1] && !js::is_js_line_terminator(chars[j - 1]))
                    {
                        next[j] = true;
                    }
                }
            }
        }
        reach = next;
    }
    reach[chars.len()]
}

/// Whether `host` matches the glob `pattern`.
///
/// `*` matches any run of characters, dots included. A pattern starting `*.`
/// also matches the bare domain after it, because "everything on
/// example.com" is what a person means by `*.example.com`. Both sides are
/// normalised, so matching is case-insensitive.
pub fn host_matches(pattern: &str, host: &str) -> bool {
    let normalized_pattern = normalize_host_pattern(pattern);
    let normalized_host = normalize_host_pattern(host);
    if normalized_pattern.is_empty() || normalized_host.is_empty() {
        return false;
    }
    if let Some(bare) = normalized_pattern.strip_prefix("*.") {
        if normalized_host == bare {
            return true;
        }
    }
    glob_matches(&normalized_pattern, &normalized_host)
}

/// Whether any pattern in the list matches `host`.
pub fn host_matches_any(patterns: &[String], host: &str) -> bool {
    patterns.iter().any(|pattern| host_matches(pattern, host))
}

/// The rule that files a block, given its keys with the most time first.
///
/// The dominant key decides: keys are tried in order, and for each key the
/// first rule in list order that matches it wins. A block that is mostly an
/// issue tracker with a little chat is filed by the tracker's rule even when
/// the chat rule sits higher in the list.
pub fn match_rule<'a, S: AsRef<str>>(
    rules: &'a [ActivityRule],
    keys_by_time: &[S],
) -> Option<&'a ActivityRule> {
    keys_by_time.iter().find_map(|key| {
        rules
            .iter()
            .find(|candidate| host_matches(&candidate.pattern, key.as_ref()))
    })
}

/// What a rule files a block with, in the shape an entry create takes.
pub fn rule_proposal(rule: &ActivityRule) -> ProposedEntryFields {
    ProposedEntryFields {
        description: rule.description.clone(),
        project_id: rule.project_id.clone(),
        task_id: rule.task_id.clone(),
        tag_ids: rule.tag_ids.clone(),
        billable: rule.billable,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub fn rule(id: &str, pattern: &str) -> ActivityRule {
        ActivityRule {
            id: id.into(),
            pattern: pattern.into(),
            description: None,
            project_id: None,
            task_id: None,
            tag_ids: None,
            billable: None,
        }
    }

    #[test]
    fn host_globs() {
        assert!(host_matches("example.com", "example.com"));
        assert!(!host_matches("example.com", "docs.example.com"));
        assert!(host_matches("*.example.com", "docs.example.com"));
        assert!(host_matches("*.example.com", "example.com"));
        assert!(!host_matches("*.example.com", "badexample.com"));
        assert!(host_matches("docs.*", "docs.example.com"));
        assert!(host_matches("EXAMPLE.com", "example.COM"));
        assert!(!host_matches("exa?ple.com", "example.com"));
        assert!(!host_matches("", "example.com"));
    }

    #[test]
    fn patterns_tolerate_pasted_urls_and_ports() {
        assert_eq!(
            normalize_host_pattern(" https://Docs.Example.com:8080/a/b "),
            "docs.example.com"
        );
        assert!(host_matches("https://example.com/path", "example.com"));
    }

    #[test]
    fn a_star_never_crosses_a_line_terminator() {
        assert!(!glob_matches("a*b", "a\nb"));
        assert!(glob_matches("a*b*c", "axxbyyc"));
        assert!(glob_matches("*", ""));
        assert!(glob_matches("a**", "a"));
    }

    #[test]
    fn match_rule_tries_keys_by_time_then_rules_in_order() {
        let rules = vec![
            rule("1", "b.test"),
            rule("2", "a.test"),
            rule("3", "*.test"),
        ];
        assert_eq!(
            match_rule(&rules, &["a.test", "b.test"]).map(|r| r.id.as_str()),
            Some("2")
        );
        assert_eq!(
            match_rule(&rules, &["z.test"]).map(|r| r.id.as_str()),
            Some("3")
        );
        assert!(match_rule(&rules, &["z.other"]).is_none());
    }
}
