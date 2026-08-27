fn main() {
    tauri_build::build();
    globalize_swift_cdecl_symbols();
}

/// Xcode 27's SwiftPM internalizes @_cdecl exports in the static archives that
/// swift-rs builds for Tauri/plugins. swift-rs 1.0.8 re-exports each package's
/// own symbols, but the shared SwiftRs helpers (retain_object, release_object,
/// string_from_bytes) stay local inside every consumer archive, failing the
/// final link with "symbol(s) not found for architecture arm64". Promote those
/// three back to global in every SwiftPM archive under target/<triple>/release
/// before our lib links. Idempotent: already-global symbols are skipped.
fn globalize_swift_cdecl_symbols() {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os != "ios" {
        return;
    }
    let wanted = ["_retain_object", "_release_object", "_string_from_bytes"];

    let target_dir = std::env::var("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("target"));
    let triple = std::env::var("TARGET").unwrap_or_default();
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let build_root = target_dir.join(triple).join(profile).join("build");

    let Ok(entries) = std::fs::read_dir(&build_root) else {
        return;
    };

    let sysroot = match std::process::Command::new("rustc")
        .args(["--print", "sysroot"])
        .output()
    {
        Ok(out) => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        Err(_) => return,
    };
    let host = format!("{}-apple-darwin", std::env::consts::ARCH);
    let objcopy = std::path::Path::new(&sysroot)
        .join("lib/rustlib")
        .join(host)
        .join("bin/llvm-objcopy");
    if !objcopy.exists() {
        println!(
            "cargo:warning=llvm-objcopy not found (run `rustup component add llvm-tools`); \
             Swift @_cdecl helper symbols may fail to link on Xcode 27"
        );
        return;
    }

    for entry in entries.flatten() {
        let swift_dirs = walkdir(entry.path().join("out").join("swift-rs"));
        for dir in swift_dirs {
            let mut candidates = vec![dir.join("release")];
            // Xcode 27 SwiftPM layout: out/Products/<Config>-<platform>
            if let Ok(products) = std::fs::read_dir(dir.join("out").join("Products")) {
                for p in products.flatten() {
                    candidates.push(p.path());
                }
            }
            for candidate in candidates {
                let entries = match std::fs::read_dir(&candidate) {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                for archive in entries.flatten() {
                    let name = archive.file_name().to_string_lossy().to_string();
                    if name.starts_with("lib") && name.ends_with(".a") {
                        promote(&objcopy, &archive.path(), &wanted);
                    }
                }
            }
        }
    }
}

fn walkdir(root: std::path::PathBuf) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        found.push(dir.clone());
        for e in entries.flatten() {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(e.path());
            }
        }
    }
    found
}

fn promote(objcopy: &std::path::Path, archive: &std::path::Path, wanted: &[&str]) {
    let Ok(nm) = std::process::Command::new("nm").arg(archive).output() else {
        return;
    };
    let stdout = String::from_utf8_lossy(&nm.stdout);
    let mut to_promote = Vec::new();
    for symbol in wanted {
        let needle = format!(" {symbol}");
        let count = stdout.lines().filter(|l| l.ends_with(&needle)).count();
        // only promote when defined exactly once and as a local symbol (' t ')
        if count == 1 && stdout.lines().any(|l| l.ends_with(&format!(" t{needle}"))) {
            to_promote.push(*symbol);
        }
    }
    if to_promote.is_empty() {
        return;
    }
    let mut cmd = std::process::Command::new(objcopy);
    for s in &to_promote {
        cmd.arg(format!("--globalize-symbol={s}"));
    }
    cmd.arg(archive);
    if cmd.status().map(|s| s.success()).unwrap_or(false) {
        println!(
            "cargo:warning=globalized {} in {:?}",
            to_promote.join(","),
            archive
        );
    }
}

use std::path::PathBuf;
