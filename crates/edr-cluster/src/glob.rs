//! Tiny glob matcher supporting `*`, `**`, and `?`.
//!
//! Semantics:
//!   - `?`  -> matches exactly one character (any).
//!   - `*`  -> matches zero or more characters, but does NOT cross a path separator (`/` or `\`).
//!   - `**` -> matches zero or more characters including path separators.
//!
//! Match is case-insensitive — Windows paths and DNS names are both case-insensitive,
//! and the spec keys are folded by case for `proc` matching anyway.

/// Returns true if `pattern` matches the entire string `text`.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let pat: Vec<char> = pattern.chars().collect();
    let txt: Vec<char> = text.chars().collect();
    matches(&pat, 0, &txt, 0)
}

fn eq_ci(a: char, b: char) -> bool {
    a.to_ascii_lowercase() == b.to_ascii_lowercase()
}

fn is_sep(c: char) -> bool {
    c == '/' || c == '\\'
}

fn matches(pat: &[char], mut pi: usize, txt: &[char], mut ti: usize) -> bool {
    while pi < pat.len() {
        match pat[pi] {
            '*' => {
                // Detect `**` (cross-separator) vs single `*`.
                let double = pi + 1 < pat.len() && pat[pi + 1] == '*';
                let next_pi = if double { pi + 2 } else { pi + 1 };

                // Try matching zero or more chars at this position.
                // We greedily try the longest match first (standard glob backtracking).
                let mut k = txt.len();
                loop {
                    if k >= ti {
                        // Check separator constraint for single `*`.
                        let span_ok = if double {
                            true
                        } else {
                            !txt[ti..k].iter().any(|&c| is_sep(c))
                        };
                        if span_ok && matches(pat, next_pi, txt, k) {
                            return true;
                        }
                    }
                    if k == ti {
                        break;
                    }
                    k -= 1;
                }
                return false;
            }
            '?' => {
                if ti >= txt.len() {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
            c => {
                if ti >= txt.len() || !eq_ci(c, txt[ti]) {
                    return false;
                }
                pi += 1;
                ti += 1;
            }
        }
    }
    ti == txt.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn star_matches_subdomain() {
        assert!(glob_match("*.google.com", "mail.google.com"));
        assert!(glob_match("*.google.com", "www.google.com"));
        assert!(!glob_match("*.google.com", "notgoogle.com"));
        assert!(!glob_match("*.google.com", "google.com"));
    }

    #[test]
    fn star_does_not_cross_separator() {
        assert!(!glob_match(
            r"C:\Users\*\foo",
            r"C:\Users\a\b\foo"
        ));
        assert!(glob_match(r"C:\Users\*\foo", r"C:\Users\a\foo"));
    }

    #[test]
    fn double_star_crosses_separators() {
        assert!(glob_match(
            r"C:\Users\**\foo",
            r"C:\Users\a\b\c\foo"
        ));
    }

    #[test]
    fn question_mark_one_char() {
        assert!(glob_match("h?llo", "hello"));
        assert!(!glob_match("h?llo", "heello"));
    }

    #[test]
    fn case_insensitive() {
        assert!(glob_match("*.GOOGLE.com", "mail.google.com"));
    }

    #[test]
    fn windows_user_appdata_path() {
        assert!(glob_match(
            r"C:\Users\*\AppData\Local\*",
            r"C:\Users\moomin\AppData\Local\foo"
        ));
    }
}
