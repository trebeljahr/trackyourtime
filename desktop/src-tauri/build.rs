fn main() {
    // The export is embedded into the binary (tauri.conf.json → frontendDist);
    // a missing one is a build that serves nothing but 404s.
    let export = std::path::Path::new("../../packages/client/out-desktop/index.html");
    println!("cargo:rerun-if-changed=../../packages/client/out-desktop/.build-target.json");
    assert!(
        export.exists(),
        "No desktop export at packages/client/out-desktop. Run: NEXT_PUBLIC_API_URL=… node scripts/build-desktop.mjs --export-only"
    );
    // App commands get permissions of their own (allow-desktop-call, …), so
    // a capability can grant them to a remote origin: the dev server in a dev
    // run (shell.rs adds that capability at runtime, debug builds only).
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["desktop_call", "e2e_result"]),
        ),
    )
    .expect("tauri build script failed");
}
