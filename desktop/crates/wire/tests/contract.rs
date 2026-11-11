//! The TypeScript bridge is the contract; this crate must name the same
//! channels and the same app origin.

use std::collections::BTreeSet;

const BRIDGE: &str = include_str!("../../../../packages/shared/src/desktop-bridge.ts");

fn ts_channels() -> BTreeSet<String> {
    let start = BRIDGE
        .find("export const DESKTOP_IPC = {")
        .expect("DESKTOP_IPC in desktop-bridge.ts");
    let body = &BRIDGE[start..];
    let end = body.find("} as const;").expect("end of DESKTOP_IPC");
    body[..end]
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.starts_with("//") || line.starts_with("/*") || line.starts_with('*') {
                return None;
            }
            let (_, rest) = line.split_once(": \"")?;
            Some(rest.split('"').next()?.to_string())
        })
        .collect()
}

#[test]
fn every_channel_is_named_on_both_sides() {
    let ts = ts_channels();
    let rust: BTreeSet<String> = tyt_wire::channels::ALL
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert!(ts.len() > 30, "parsed only {} channels", ts.len());
    assert_eq!(ts, rust, "DESKTOP_IPC and tyt_wire::channels differ");
}

#[test]
fn the_origin_constants_agree() {
    assert!(BRIDGE.contains("export const DESKTOP_APP_SCHEME = \"app\";"));
    assert!(BRIDGE.contains("export const DESKTOP_APP_HOST = \"-\";"));
    assert_eq!(tyt_wire::DESKTOP_APP_ORIGIN, "app://-");
}
