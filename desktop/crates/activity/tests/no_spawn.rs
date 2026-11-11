//! `headless.test.ts` and `import-graph.test.ts`, for the Rust crate.
//!
//! Headless runs must never read the real frontmost app, spawn a process or
//! raise a permission prompt, and captured activity must not be able to leave
//! the device: the only way any of it reaches a server is as an entry the
//! person accepted, which the renderer creates. The behaviour tests cover
//! what happens; these pin the source text, so a refactor cannot quietly move
//! a real source, a timer or a network call into the wrong place.

use std::fs;
use std::path::{Path, PathBuf};

fn src() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// Every non-test source file, relative to `src/`.
fn sources() -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut stack = vec![src()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "rs")
                && !path.to_string_lossy().ends_with("_tests.rs")
            {
                let relative = path
                    .strip_prefix(src())
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((relative, code(&fs::read_to_string(&path).unwrap())));
            }
        }
    }
    out.sort();
    out
}

/// Source text without comments and without the inline test module, so an
/// explanation cannot satisfy or break a check.
fn code(text: &str) -> String {
    let text = match text.find("#[cfg(test)]\nmod tests") {
        Some(index) => &text[..index],
        None => text,
    };
    let mut out = String::new();
    let mut in_block = false;
    for line in text.lines() {
        let mut line = line.to_string();
        if in_block {
            match line.find("*/") {
                Some(end) => {
                    line = line[end + 2..].to_string();
                    in_block = false;
                }
                None => continue,
            }
        }
        if let Some(start) = line.find("/*") {
            in_block = !line[start..].contains("*/");
            line.truncate(start);
        }
        // A `//` that is not inside "https://…".
        let bytes = line.as_bytes();
        let cut = (1..bytes.len()).find(|&i| {
            bytes[i] == b'/'
                && bytes[i - 1] == b'/'
                && (i < 2 || !matches!(bytes[i - 2], b':' | b'"'))
        });
        if let Some(i) = cut {
            line.truncate(i - 1);
        }
        out.push_str(&line);
        out.push('\n');
    }
    out
}

/// The body of the first block opened by `opener`, and the text outside it.
fn block(text: &str, opener: &str) -> (String, String) {
    let start = text
        .find(opener)
        .unwrap_or_else(|| panic!("no `{opener}` block"));
    let open = start + text[start..].find('{').unwrap();
    let mut depth = 0;
    let mut end = open;
    for (i, c) in text[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = open + i + 1;
                    break;
                }
            }
            _ => {}
        }
    }
    (
        text[start..end].to_string(),
        format!("{}{}", &text[..start], &text[end..]),
    )
}

fn file(name: &str) -> String {
    sources()
        .into_iter()
        .find(|(path, _)| path == name)
        .map(|(_, text)| text)
        .unwrap()
}

#[test]
fn constructs_a_platform_source_only_outside_headless() {
    let calls: Vec<String> = sources()
        .into_iter()
        .filter(|(_, text)| {
            text.replace("fn create_platform_source(", "")
                .contains("create_platform_source(")
        })
        .map(|(path, _)| path)
        .collect();
    assert_eq!(calls, ["install.rs"]);
    let (inside, outside) = block(&file("install.rs"), "if !options.headless {");
    assert!(inside.contains("create_platform_source("));
    assert!(!outside.contains("create_platform_source("));
}

#[test]
fn starts_no_timer_and_reads_no_idle_sample_headless() {
    let install = file("install.rs");
    // The heartbeat and the prune are armed only when not headless.
    for timer in ["let mut heartbeat_at", "let mut prune_at"] {
        let line = install
            .lines()
            .find(|l| l.contains(timer))
            .unwrap_or_else(|| panic!("{timer}"));
        assert!(line.contains("(!inner.headless).then("), "{line}");
    }
    let (idle, _) = block(&install, "pub fn idle(");
    let first = idle.lines().nth(1).unwrap().trim();
    assert!(first.starts_with("if self.inner.headless"), "{first}");
    // Real timers exist only for a platform source.
    let users: Vec<String> = sources()
        .into_iter()
        .filter(|(path, text)| path != "timers.rs" && text.contains("RealTimers::new("))
        .map(|(p, _)| p)
        .collect();
    assert_eq!(users, ["platform_source.rs"]);
}

#[test]
fn touches_std_process_only_in_the_process_runner() {
    let spawners: Vec<String> = sources()
        .into_iter()
        .filter(|(_, text)| {
            ["std::process", "Command::new", "Stdio::"]
                .iter()
                .any(|needle| text.contains(needle))
        })
        .map(|(path, _)| path)
        .collect();
    assert_eq!(spawners, ["process_runner.rs"]);
    // And the real runner is built in one place only.
    let builders: Vec<String> = sources()
        .into_iter()
        .filter(|(path, text)| path != "process_runner.rs" && text.contains("StdProcessRunner"))
        .map(|(path, _)| path)
        .collect();
    assert_eq!(builders, ["platform_source.rs"]);
}

#[test]
fn reaches_no_network_code() {
    const NETWORK: [&str; 9] = [
        "std::net",
        "TcpStream",
        "TcpListener",
        "UdpSocket",
        "reqwest",
        "ureq",
        "hyper",
        "tokio",
        "ToSocketAddrs",
    ];
    let mut problems = Vec::new();
    for (path, text) in sources() {
        for needle in NETWORK {
            if text.contains(needle) {
                problems.push(format!("{path} mentions {needle}"));
            }
        }
    }
    assert!(problems.is_empty(), "{problems:?}");

    // Dependencies are an allowlist: none of them opens a connection.
    let manifest =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml")).unwrap();
    let deps = manifest
        .split("[dependencies]")
        .nth(1)
        .unwrap()
        .split("\n[")
        .next()
        .unwrap();
    let names: Vec<&str> = deps
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| l.split(['=', ' ']).next().unwrap())
        .collect();
    assert_eq!(
        names,
        [
            "tyt-wire",
            "serde",
            "serde_json",
            "aes-gcm",
            "sha2",
            "base64",
            "getrandom"
        ]
    );
}

#[test]
fn asks_for_no_os_permission() {
    for (path, text) in sources() {
        for needle in [
            "CGRequestScreenCaptureAccess",
            "AXIsProcessTrusted",
            "askForMediaAccess",
            "desktopCapturer",
        ] {
            assert!(!text.contains(needle), "{path} mentions {needle}");
        }
    }
    // Titles on macOS are read only through the reader that checks the grant first.
    let (read, _) = block(&file("macos_titles.rs"), "fn read(&self, pid");
    assert!(read.lines().nth(1).unwrap().contains("(self.permitted)()"));
}
