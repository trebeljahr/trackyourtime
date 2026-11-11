//! Optional encryption of the activity folder (`protection.ts`).
//!
//! Activity encryption is independent of the OS keychain: the key is derived
//! from the account (the renderer hands it over), and a trusted device may
//! remember it in a separate, secure OS store ([`crate::vault`]).
//!
//! Every box is `{"v":2,"algorithm":"AES-256-GCM","nonce","data","tag"}`,
//! base64url without padding, with the additional data
//! `JSON.stringify(["trackyourtime-activity-v1", account, file])` — byte for
//! byte what Node's `createCipheriv("aes-256-gcm")` path wrote, so a folder an
//! Electron build protected opens here and the other way round.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::alphabet;
use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::Engine;
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::store::default_state_json;

pub const ACTIVITY_PROTECTION_FILE: &str = "protection.json";
/// Device policy survives sign-out; it contains no key or captured history.
pub const ACTIVITY_PROTECTION_REQUIRED: &str = "activity-protection-required";
pub const KEY_CHECK_PLAINTEXT: &str = "trackyourtime-activity-key-v1";
const AAD_TAG: &str = "trackyourtime-activity-v1";
const MAX_BOX_DATA: usize = 128 * 1024 * 1024;

/// base64url with Node's leniency on decode (padding either way, stray
/// trailing bits), and none on encode (no padding, as `toString("base64url")`).
const BASE64URL: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new()
        .with_encode_padding(false)
        .with_decode_padding_mode(DecodePaddingMode::Indifferent)
        .with_decode_allow_trailing_bits(true),
);

pub fn base64url_encode(bytes: &[u8]) -> String {
    BASE64URL.encode(bytes)
}

/// `Buffer.from(text, "base64url")`, which also accepts the `+/` alphabet.
pub fn base64url_decode(text: &str) -> Result<Vec<u8>, String> {
    let normalized: String = text
        .chars()
        .map(|c| match c {
            '+' => '-',
            '/' => '_',
            other => other,
        })
        .collect();
    BASE64URL
        .decode(normalized.trim_end_matches('='))
        .map_err(|error| error.to_string())
}

/// What encrypts and decrypts activity files. One account, one key.
pub trait ActivityCodec: Send + Sync {
    fn encode(&self, plain: &str, file: &str) -> Result<String, String>;
    fn decode(&self, encrypted: &str, file: &str) -> Result<String, String>;
    /// Zero the key; every later call fails. Idempotent.
    fn destroy(&self);
}

pub type SharedCodec = Arc<dyn ActivityCodec>;

/// `sha256(JSON.stringify([origin, userId]))`, hex: the account a protected
/// folder belongs to, without naming the user.
pub fn activity_account(user_id: &str, origin: &str) -> String {
    let json = serde_json::to_string(&[origin, user_id]).expect("strings serialize");
    hex(&Sha256::digest(json.as_bytes()))
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn is_account(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    getrandom::getrandom(&mut bytes).expect("the OS random source is available");
    bytes
}

struct AesCodec {
    key: Mutex<Option<[u8; 32]>>,
    account: String,
}

#[derive(Serialize)]
struct EncryptedBox<'a> {
    v: u8,
    algorithm: &'a str,
    nonce: String,
    data: String,
    tag: String,
}

impl AesCodec {
    fn aad(&self, file: &str) -> Vec<u8> {
        serde_json::to_vec(&[AAD_TAG, &self.account, file]).expect("strings serialize")
    }

    fn cipher(&self) -> Result<Aes256Gcm, String> {
        let key = self.key.lock().expect("codec lock");
        let key = key
            .as_ref()
            .ok_or_else(|| "Activity key is locked".to_string())?;
        Aes256Gcm::new_from_slice(key).map_err(|_| "Invalid activity key".to_string())
    }
}

impl ActivityCodec for AesCodec {
    fn encode(&self, plain: &str, file: &str) -> Result<String, String> {
        let cipher = self.cipher()?;
        let iv: [u8; 12] = random_bytes();
        let aad = self.aad(file);
        let mut sealed = cipher
            .encrypt(
                Nonce::from_slice(&iv),
                Payload {
                    msg: plain.as_bytes(),
                    aad: &aad,
                },
            )
            .map_err(|_| "Activity encryption failed".to_string())?;
        let tag = sealed.split_off(sealed.len() - 16);
        // v2 is deliberately unreadable to older activity stores: they stop
        // capture instead of replacing the encrypted state with defaults.
        let boxed = EncryptedBox {
            v: 2,
            algorithm: "AES-256-GCM",
            nonce: base64url_encode(&iv),
            data: base64url_encode(&sealed),
            tag: base64url_encode(&tag),
        };
        Ok(serde_json::to_string(&boxed).expect("box serializes"))
    }

    fn decode(&self, encrypted: &str, file: &str) -> Result<String, String> {
        let cipher = self.cipher()?;
        let invalid = || "Invalid encrypted activity".to_string();
        let boxed: Value = serde_json::from_str(encrypted).map_err(|error| error.to_string())?;
        let field = |name: &str| boxed.get(name).and_then(Value::as_str);
        let (Some(nonce), Some(data), Some(tag)) = (field("nonce"), field("data"), field("tag"))
        else {
            return Err(invalid());
        };
        if boxed.get("v").and_then(Value::as_f64) != Some(2.0)
            || field("algorithm") != Some("AES-256-GCM")
            || crate::js::utf16_len(data) > MAX_BOX_DATA
        {
            return Err(invalid());
        }
        let iv = base64url_decode(nonce).map_err(|_| invalid())?;
        let tag = base64url_decode(tag).map_err(|_| invalid())?;
        if iv.len() != 12 || tag.len() != 16 {
            return Err(invalid());
        }
        let mut sealed = base64url_decode(data).map_err(|_| invalid())?;
        sealed.extend_from_slice(&tag);
        let aad = self.aad(file);
        let plain = cipher
            .decrypt(
                Nonce::from_slice(&iv),
                Payload {
                    msg: &sealed,
                    aad: &aad,
                },
            )
            .map_err(|_| "Unsupported state or unable to authenticate data".to_string())?;
        Ok(String::from_utf8_lossy(&plain).into_owned())
    }

    fn destroy(&self) {
        let mut key = self.key.lock().expect("codec lock");
        if let Some(bytes) = key.as_mut() {
            bytes.fill(0);
        }
        *key = None;
    }
}

/// `createActivityCodec`: a 32-byte key and a 64-hex account, or an error.
pub fn create_activity_codec(key: &[u8], account: &str) -> Result<SharedCodec, String> {
    if key.len() != 32 || !is_account(account) {
        return Err("Invalid activity key".into());
    }
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(key);
    Ok(Arc::new(AesCodec {
        key: Mutex::new(Some(bytes)),
        account: account.to_string(),
    }))
}

// ── files ─────────────────────────────────────────────────────────────

fn io(error: std::io::Error) -> String {
    error.to_string()
}

/// `writeFileSync(tmp, content, { mode: 0o600 })` then rename.
pub fn write_atomic(target: &Path, content: &[u8]) -> Result<(), String> {
    let mut temp = target.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    write_private(&temp, content)?;
    fs::rename(&temp, target).map_err(io)
}

/// Create or truncate `target` with mode 0600 on creation, like Node's `mode` option.
pub fn write_private(target: &Path, content: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(target).map_err(io)?;
    file.write_all(content).map_err(io)
}

/// `mkdirSync(dir, { recursive: true, mode: 0o700 })`.
pub fn make_private_dir(dir: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(dir).map_err(io)
}

/// `rmSync(target, { recursive: true, force: true })`.
pub fn remove_all(target: &Path) -> Result<(), String> {
    match fs::symlink_metadata(target) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io(error)),
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(target).map_err(io),
        Ok(_) => fs::remove_file(target).map_err(io),
    }
}

pub fn read_utf8(target: &Path) -> Result<String, String> {
    fs::read(target)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(io)
}

/// An older build must also stay closed after protected history is wiped.
pub fn mark_empty_activity_protected(user_data: &Path) -> Result<(), String> {
    let dir = user_data.join("activity");
    make_private_dir(&dir)?;
    write_atomic(
        &dir.join("state.json"),
        br#"{"v":2,"protectionRequired":true}"#,
    )
}

/// Every regular file under `dir`, relative and `/`-separated, sorted.
pub fn raw_files(dir: &Path) -> Vec<String> {
    fn walk(root: &Path, current: &Path, out: &mut Vec<String>) {
        let Ok(entries) = fs::read_dir(current) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                walk(root, &path, out);
            } else if kind.is_file() {
                if let Ok(relative) = path.strip_prefix(root) {
                    let parts: Vec<String> = relative
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy().into_owned())
                        .collect();
                    out.push(parts.join("/"));
                }
            }
        }
    }
    let mut out = Vec::new();
    if dir.exists() {
        walk(dir, dir, &mut out);
    }
    out.sort_by(|a, b| crate::js::cmp_strings(a, b));
    out
}

/// The account a protected folder belongs to, or None when it is not
/// protected. A damaged marker is an error: it must never turn protected
/// history back into plaintext.
pub fn activity_protection(user_data: &Path) -> Result<Option<String>, String> {
    let file = user_data.join("activity").join(ACTIVITY_PROTECTION_FILE);
    if !file.exists() {
        return Ok(None);
    }
    let value: Value =
        serde_json::from_str(&read_utf8(&file)?).map_err(|error| error.to_string())?;
    let account = value.get("account").and_then(Value::as_str).unwrap_or("");
    if value.get("v").and_then(Value::as_f64) != Some(1.0) || !is_account(account) {
        return Err("Unreadable activity protection marker".into());
    }
    Ok(Some(account.to_string()))
}

/// The key decodes the marker's check and every record in the folder. With
/// `recover_torn_tail`, an unterminated final line of a JSONL file (a crash
/// mid-append) is kept encrypted beside it and trimmed — only after every
/// other record verified.
pub fn verify_activity_protection(
    user_data: &Path,
    codec: &SharedCodec,
    recover_torn_tail: bool,
) -> Result<(), String> {
    let dir = user_data.join("activity");
    let marker: Value = serde_json::from_str(&read_utf8(&dir.join(ACTIVITY_PROTECTION_FILE))?)
        .map_err(|error| error.to_string())?;
    let check = marker
        .get("check")
        .and_then(Value::as_str)
        .ok_or("Wrong activity key")?;
    if codec.decode(check, "key-check")? != KEY_CHECK_PLAINTEXT {
        return Err("Wrong activity key".into());
    }
    struct Repair {
        file: String,
        prefix: String,
        tail: String,
    }
    let mut repairs = Vec::new();
    for file in raw_files(&dir) {
        if file == ACTIVITY_PROTECTION_FILE {
            continue;
        }
        let text = read_utf8(&dir.join(&file))?;
        if file.ends_with(".jsonl") {
            let lines: Vec<&str> = text.split('\n').collect();
            for (i, line) in lines.iter().enumerate() {
                if line.is_empty() {
                    continue;
                }
                if let Err(error) = codec.decode(line, &file) {
                    // Only an unterminated final append can be a crash tear.
                    // Preserve its exact bytes under authenticated encryption
                    // before trimming it.
                    if !recover_torn_tail || i != lines.len() - 1 || text.ends_with('\n') {
                        return Err(error);
                    }
                    let prefix = lines[..i].join("\n") + if i > 0 { "\n" } else { "" };
                    repairs.push(Repair {
                        file: file.clone(),
                        prefix,
                        tail: line.to_string(),
                    });
                }
            }
        } else {
            codec.decode(&text, &file)?;
        }
    }
    // Do not touch any file until the key and every other record verified.
    for repair in repairs {
        let recovery = format!("{}.torn.{}", repair.file, hex(&random_bytes::<8>()));
        write_atomic(
            &dir.join(&recovery),
            codec.encode(&repair.tail, &recovery)?.as_bytes(),
        )?;
        write_atomic(&dir.join(&repair.file), repair.prefix.as_bytes())?;
    }
    Ok(())
}

/// `JSON.stringify(record)` for an insertion-ordered list of string pairs.
struct OrderedStrings<'a>(&'a [(String, String)]);

impl Serialize for OrderedStrings<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

/// Build and verify a complete encrypted replacement before moving a byte of
/// the original. A verified encrypted snapshot preserves even torn or corrupt
/// source files for recovery. Original files are removed only after the swap.
pub fn protect_activity(
    user_data: &Path,
    codec: &SharedCodec,
    account: &str,
) -> Result<(), String> {
    let dir = user_data.join("activity");
    let pending = user_data.join("activity.protecting");
    let previous = user_data.join("activity.previous");
    if activity_protection(user_data)?.is_some() {
        return verify_activity_protection(user_data, codec, false);
    }
    if previous.exists() {
        return Err("An interrupted activity migration needs recovery first".into());
    }
    let state_path = dir.join("state.json");
    if state_path.exists() {
        let state: Value =
            serde_json::from_str(&read_utf8(&state_path)?).map_err(|error| error.to_string())?;
        if let Some(v) = state.get("v").and_then(Value::as_f64) {
            let empty_protected = v == 2.0
                && state.get("protectionRequired") == Some(&Value::Bool(true))
                && user_data.join(ACTIVITY_PROTECTION_REQUIRED).exists();
            if v > 1.0 && !empty_protected {
                return Err("Newer activity format".into());
            }
        }
    }
    remove_all(&pending)?;
    make_private_dir(&pending)?;
    let attempt = || -> Result<(), String> {
        let mut source: Vec<(String, String)> = Vec::new();
        for file in raw_files(&dir) {
            let original = read_utf8(&dir.join(&file))?;
            source.push((file.clone(), original.clone()));
            let mut plain = original;
            if file == "state.json" {
                let state: Value =
                    serde_json::from_str(&plain).map_err(|error| error.to_string())?;
                if state.get("v").and_then(Value::as_f64) == Some(2.0)
                    && state.get("protectionRequired") == Some(&Value::Bool(true))
                {
                    plain = default_state_json();
                }
            }
            let (encrypted, check) = if file.ends_with(".jsonl") {
                let mut encrypted = Vec::new();
                for line in plain.split('\n') {
                    encrypted.push(if line.is_empty() {
                        String::new()
                    } else {
                        codec.encode(line, &file)?
                    });
                }
                let encrypted = encrypted.join("\n");
                let mut check = Vec::new();
                for line in encrypted.split('\n') {
                    check.push(if line.is_empty() {
                        String::new()
                    } else {
                        codec.decode(line, &file)?
                    });
                }
                (encrypted, check.join("\n"))
            } else {
                let encrypted = codec.encode(&plain, &file)?;
                let check = codec.decode(&encrypted, &file)?;
                (encrypted, check)
            };
            if check != plain {
                return Err("Activity migration verification failed".into());
            }
            let target = pending.join(&file);
            if let Some(parent) = target.parent() {
                make_private_dir(parent)?;
            }
            write_atomic(&target, encrypted.as_bytes())?;
        }
        let source_json =
            serde_json::to_string(&OrderedStrings(&source)).expect("strings serialize");
        let backup = codec.encode(&source_json, "migration-backup.bin")?;
        if codec.decode(&backup, "migration-backup.bin")? != source_json {
            return Err("Activity backup verification failed".into());
        }
        write_atomic(&pending.join("migration-backup.bin"), backup.as_bytes())?;
        let marker = serde_json::json!({ "v": 1, "account": account, "check": codec.encode(KEY_CHECK_PLAINTEXT, "key-check")? });
        write_atomic(
            &pending.join(ACTIVITY_PROTECTION_FILE),
            serde_json::to_string(&marker).expect("marker").as_bytes(),
        )?;
        if dir.exists() {
            fs::rename(&dir, &previous).map_err(io)?;
        }
        fs::rename(&pending, &dir).map_err(io)?;
        verify_activity_protection(user_data, codec, false)?;
        remove_all(&previous)
    };
    attempt().inspect_err(|_| {
        if !dir.exists() && previous.exists() {
            let _ = fs::rename(&previous, &dir);
        }
    })
}

/// Repair the narrow directory-swap crash window without guessing at a key.
/// If the new directory exists, keep the old copy until its successor verifies.
pub fn recover_activity_swap(user_data: &Path) -> Result<(), String> {
    let dir = user_data.join("activity");
    let previous = user_data.join("activity.previous");
    if !dir.exists() && previous.exists() {
        fs::rename(&previous, &dir).map_err(io)?;
    }
    Ok(())
}

pub fn finish_activity_swap(user_data: &Path, codec: &SharedCodec) -> Result<(), String> {
    verify_activity_protection(user_data, codec, true)?;
    remove_all(&user_data.join("activity.previous"))?;
    remove_all(&user_data.join("activity.protecting"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boxes_round_trip_and_bind_the_file_and_account() {
        let account = activity_account("user", "https://example.test");
        let codec = create_activity_codec(&random_bytes::<32>(), &account).unwrap();
        let sealed = codec.encode("secret", "state.json").unwrap();
        let boxed: Value = serde_json::from_str(&sealed).unwrap();
        assert_eq!(boxed["v"], 2);
        assert_eq!(boxed["algorithm"], "AES-256-GCM");
        assert!(sealed.starts_with(r#"{"v":2,"algorithm":"AES-256-GCM","nonce":""#));
        assert!(!sealed.contains('='));
        assert_eq!(codec.decode(&sealed, "state.json").unwrap(), "secret");
        assert!(codec.decode(&sealed, "open.json").is_err());
        codec.destroy();
        assert_eq!(
            codec.decode(&sealed, "state.json").unwrap_err(),
            "Activity key is locked"
        );
    }

    #[test]
    fn the_account_is_the_hash_node_computes() {
        // node -e 'crypto.createHash("sha256").update(JSON.stringify(["https://example.test","user"])).digest("hex")'
        assert_eq!(
            activity_account("user", "https://example.test"),
            "2ca434d056e1d193e70fb4f6ac8d3e6883ad6547b5d8113a593917ad309093ef"
        );
    }

    #[test]
    fn invalid_keys_and_accounts_are_refused() {
        assert!(create_activity_codec(&[0u8; 31], &"a".repeat(64)).is_err());
        assert!(create_activity_codec(&[0u8; 32], "not-hex").is_err());
    }
}
