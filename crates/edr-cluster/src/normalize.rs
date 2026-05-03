//! Target string normalization, used as part of dedup / first-seen keys.
//!
//! The goal is "different surface, same source" — two events that target the
//! same logical resource (e.g. the same host:any-port, or the same parent dir)
//! should fold into one cluster.

use edr_core::Category;

/// Normalize a raw target into a stable cluster key.
pub fn normalize_target(category: Category, target: &str) -> String {
    match category {
        Category::Network => normalize_network(target),
        Category::File => normalize_file(target),
        Category::Registry => normalize_registry(target),
        // Process / ImageLoad / Thread / Handle / Integrity — keep as-is.
        _ => target.to_string(),
    }
}

/// `1.2.3.4:443` -> `1.2.3.4:*`
/// `[::1]:443`   -> `[::1]:*`
/// `host.com:443` -> `host.com:*`
/// Unrecognised forms pass through unchanged.
fn normalize_network(t: &str) -> String {
    // IPv6 literal `[..]:port`
    if let Some(rest) = t.strip_prefix('[') {
        if let Some(end) = rest.find(']') {
            let host = &rest[..end];
            return format!("[{}]:*", host);
        }
    }
    if let Some(idx) = t.rfind(':') {
        // Avoid butchering an IPv6 address without brackets.
        let host = &t[..idx];
        if !host.contains(':') {
            return format!("{}:*", host);
        }
    }
    t.to_string()
}

/// `C:\Users\x\a.txt` -> `C:\Users\x`
/// `/var/log/syslog` -> `/var/log`
fn normalize_file(t: &str) -> String {
    // Pick the rightmost separator of either flavour.
    let last = t
        .rfind(|c| c == '\\' || c == '/')
        .unwrap_or(usize::MAX);
    if last == usize::MAX {
        return t.to_string();
    }
    // Preserve drive root ("C:\") — don't collapse to "C:".
    if last == 0 {
        return t[..=0].to_string();
    }
    t[..last].to_string()
}

/// `HKLM\Software\Foo\BarValue` -> `HKLM\Software\Foo`
/// We treat the last path component as the value name.
fn normalize_registry(t: &str) -> String {
    let last = t.rfind('\\').unwrap_or(usize::MAX);
    if last == usize::MAX {
        return t.to_string();
    }
    t[..last].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_strips_port() {
        assert_eq!(normalize_network("1.2.3.4:443"), "1.2.3.4:*");
        assert_eq!(normalize_network("1.2.3.4:80"), "1.2.3.4:*");
        assert_eq!(normalize_network("host.com:443"), "host.com:*");
    }

    #[test]
    fn network_ipv6_bracketed() {
        assert_eq!(normalize_network("[::1]:443"), "[::1]:*");
    }

    #[test]
    fn file_to_parent_dir() {
        assert_eq!(
            normalize_file(r"C:\Users\x\a.txt"),
            r"C:\Users\x"
        );
        assert_eq!(
            normalize_file(r"C:\Users\x\b.txt"),
            r"C:\Users\x"
        );
    }

    #[test]
    fn registry_drops_value() {
        assert_eq!(
            normalize_registry(r"HKLM\Software\Foo\Run"),
            r"HKLM\Software\Foo"
        );
    }
}
