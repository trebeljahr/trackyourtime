//! Reading what the Electron build left in the profile, so an update from it
//! loses nothing.
//!
//! The Tauri build keeps the Electron build's profile directory and reads its
//! own files there in place. Two kinds of data cannot be read in place:
//!
//! - **Chromium's localStorage** (`Local Storage/leveldb`): the offline queue,
//!   its owner stamp, the running-timer mirror, the workspace and server
//!   choices, theme and locale. WebKit and WebView2 keep their own storage,
//!   so the keys are read here, from a disposable copy of the database (the
//!   original is never opened, so a running Electron copy or a crash mid-read
//!   cannot corrupt it), and handed to the first page load (`migrate.rs`).
//! - **safeStorage ciphertext** (`session.bin`, `activity-device-key.bin`),
//!   which starts with `v10`/`v11`. Decrypted here with Electron's key, once;
//!   the next write re-encrypts it under the Tauri build's key.
//!
//! macOS: Keychain item "trackyourtime Safe Storage" / "trackyourtime Key"
//! (Electron names it after `app.getName()`, the root package.json `name`),
//! AES-128-CBC under PBKDF2-SHA1(password, "saltysalt", 1003). The item's
//! access list names the Electron app by its designated requirement, which
//! the Tauri app signed by the same team with the same identifier satisfies,
//! so a signed update reads it without a prompt.
//!
//! Windows: AES-256-GCM under the DPAPI-protected key in `Local State`.
//!
//! Linux: not decrypted. Electron refused to persist a token without a real
//! keyring, and a libsecret-held key is named by Chromium's own schema; a
//! Linux user who had a stored session signs in once more. Their offline
//! queue is migrated like everywhere else.

use rusty_leveldb::{LdbIterator, Options, DB};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// Chromium's keys for one origin: `_<origin>\0<encoded key>`.
pub const ELECTRON_ORIGIN: &str = "app://-";
const COPY_LIMIT: u64 = 256 * 1024 * 1024;

/// Chromium's string encoding in localStorage: a leading 0 means UTF-16LE,
/// a leading 1 means Latin-1.
pub fn decode_chromium_string(bytes: &[u8]) -> Result<String, String> {
    match bytes.split_first() {
        Some((1, rest)) => Ok(rest.iter().map(|b| char::from(*b)).collect()),
        Some((0, rest)) if rest.len() % 2 == 0 => String::from_utf16(
            &rest
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| u16::from_le_bytes(*b))
                .collect::<Vec<_>>(),
        )
        .map_err(|e| e.to_string()),
        _ => Err("unknown Chromium string encoding".into()),
    }
}

/// Every localStorage key the Electron build stored for `app://-`, or None
/// when there is no Chromium storage in the profile.
pub fn chromium_local_storage(profile: &Path) -> Result<Option<BTreeMap<String, String>>, String> {
    let dir = profile.join("Local Storage").join("leveldb");
    if !dir.is_dir() {
        return Ok(None);
    }
    let copy = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mut bytes = 0;
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_file() {
            continue;
        }
        if entry.file_name() == "LOCK" {
            continue;
        }
        bytes += entry.metadata().map_err(|e| e.to_string())?.len();
        if bytes > COPY_LIMIT {
            return Err("Chromium storage exceeds the migration limit".into());
        }
        fs::copy(entry.path(), copy.path().join(entry.file_name())).map_err(|e| e.to_string())?;
    }
    let mut db = DB::open(
        copy.path(),
        Options {
            create_if_missing: false,
            ..Default::default()
        },
    )
    .map_err(|e| e.to_string())?;
    let mut iter = db.new_iter().map_err(|e| e.to_string())?;
    let prefix = format!("_{ELECTRON_ORIGIN}\0");
    let mut data = BTreeMap::new();
    while iter.advance() {
        let Some((key, value)) = iter.current() else {
            continue;
        };
        let Some(encoded) = key.strip_prefix(prefix.as_bytes()) else {
            continue;
        };
        match (
            decode_chromium_string(encoded),
            decode_chromium_string(&value),
        ) {
            (Ok(k), Ok(v)) => {
                data.insert(k, v);
            }
            _ => eprintln!("[migrate] skipped an undecodable localStorage entry"),
        }
    }
    Ok(Some(data))
}

/// Decrypt a `safeStorage` blob the Electron build wrote in `profile`.
pub fn decrypt_safe_storage(data: &[u8], profile: &Path) -> Result<String, String> {
    if !(data.starts_with(b"v10") || data.starts_with(b"v11")) {
        return Err("not a safeStorage ciphertext".into());
    }
    platform::decrypt(data, profile)
}

/// AES-128-CBC with Chromium's fixed salt and IV, for the macOS blob.
#[allow(dead_code)]
fn decrypt_cbc(password: &[u8], iterations: u32, body: &[u8]) -> Result<String, String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", iterations, &mut key);
    let iv = [b' '; 16];
    let mut buf = body.to_vec();
    let plain = cbc::Decryptor::<aes::Aes128>::new(&key.into(), &iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .map_err(|_| "safeStorage ciphertext does not decrypt".to_string())?;
    String::from_utf8(plain.to_vec()).map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
mod platform {
    use std::path::Path;

    pub fn decrypt(data: &[u8], _profile: &Path) -> Result<String, String> {
        if !data.starts_with(b"v10") {
            return Err("unexpected safeStorage version on macOS".into());
        }
        let entry = keyring::Entry::new("trackyourtime Safe Storage", "trackyourtime Key")
            .map_err(|e| e.to_string())?;
        let password = entry.get_password().map_err(|e| e.to_string())?;
        super::decrypt_cbc(password.as_bytes(), 1003, &data[3..])
    }
}

#[cfg(windows)]
mod platform {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};
    use base64::Engine;
    use std::path::Path;

    fn dpapi_unprotect(mut data: Vec<u8>) -> Result<Vec<u8>, String> {
        use windows::Win32::Foundation::{LocalFree, HLOCAL};
        use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};
        let input = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_mut_ptr(),
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        unsafe {
            CryptUnprotectData(&input, None, None, None, None, 0, &mut output)
                .map_err(|e| e.to_string())?;
            let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(output.pbData as _)));
            Ok(bytes)
        }
    }

    pub fn decrypt(data: &[u8], profile: &Path) -> Result<String, String> {
        if !data.starts_with(b"v10") || data.len() < 3 + 12 + 16 {
            return Err("unexpected safeStorage blob on Windows".into());
        }
        let state: serde_json::Value = serde_json::from_slice(
            &std::fs::read(profile.join("Local State")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let wrapped = state["os_crypt"]["encrypted_key"]
            .as_str()
            .ok_or("no os_crypt key in Local State")?;
        let wrapped = base64::engine::general_purpose::STANDARD
            .decode(wrapped)
            .map_err(|e| e.to_string())?;
        let wrapped = wrapped
            .strip_prefix(b"DPAPI")
            .ok_or("os_crypt key is not DPAPI-wrapped")?;
        let key = dpapi_unprotect(wrapped.to_vec())?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
        let plain = cipher
            .decrypt(Nonce::from_slice(&data[3..15]), &data[15..])
            .map_err(|_| "safeStorage ciphertext does not decrypt".to_string())?;
        String::from_utf8(plain).map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::path::Path;

    pub fn decrypt(_data: &[u8], _profile: &Path) -> Result<String, String> {
        Err("the Electron build's Linux keyring key is not migrated".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_both_chromium_encodings() {
        assert_eq!(decode_chromium_string(&[1, 233]).unwrap(), "é");
        assert_eq!(
            decode_chromium_string(&[0, 0x3d, 0xd8, 0x96, 0xdd]).unwrap(),
            "🖖"
        );
        assert!(decode_chromium_string(&[0, 1]).is_err());
        assert!(decode_chromium_string(&[]).is_err());
    }

    #[test]
    fn reads_only_this_origin_from_a_copy_and_leaves_the_source_alone() {
        let profile = tempfile::tempdir().unwrap();
        let dir = profile.path().join("Local Storage/leveldb");
        fs::create_dir_all(&dir).unwrap();
        {
            let mut db = DB::open(&dir, Options::default()).unwrap();
            db.put(
                b"_app://-\0\x01trackyourtime.offline-queue",
                b"\x01{\"v\":2,\"data\":[]}",
            )
            .unwrap();
            db.put(b"_app://-\0\x01theme", b"\x01dark").unwrap();
            db.put(b"_https://elsewhere\0\x01theme", b"\x01light")
                .unwrap();
            db.put(b"META:app://-", b"meta").unwrap();
            db.flush().unwrap();
        }
        let before: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        let data = chromium_local_storage(profile.path()).unwrap().unwrap();
        assert_eq!(
            data.get("trackyourtime.offline-queue").map(String::as_str),
            Some("{\"v\":2,\"data\":[]}")
        );
        assert_eq!(data.get("theme").map(String::as_str), Some("dark"));
        assert_eq!(data.len(), 2);
        let after: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(before.len(), after.len());
    }

    #[test]
    fn no_chromium_storage_is_none() {
        let profile = tempfile::tempdir().unwrap();
        assert_eq!(chromium_local_storage(profile.path()).unwrap(), None);
    }

    #[test]
    fn cbc_matches_chromium() {
        // Encrypt with the same parameters Chromium uses, then decrypt.
        use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        let mut key = [0u8; 16];
        pbkdf2::pbkdf2_hmac::<sha1::Sha1>(b"secret-password", b"saltysalt", 1003, &mut key);
        let iv = [b' '; 16];
        let plain = b"session-token-value";
        let mut buf = vec![0u8; 32];
        let sealed = cbc::Encryptor::<aes::Aes128>::new(&key.into(), &iv.into())
            .encrypt_padded_b2b_mut::<Pkcs7>(plain, &mut buf)
            .unwrap()
            .to_vec();
        assert_eq!(
            decrypt_cbc(b"secret-password", 1003, &sealed).unwrap(),
            "session-token-value"
        );
        assert!(decrypt_cbc(b"wrong", 1003, &sealed).is_err());
    }

    #[test]
    fn refuses_blobs_without_a_safe_storage_prefix() {
        let profile = tempfile::tempdir().unwrap();
        assert!(decrypt_safe_storage(b"tyt1whatever", profile.path()).is_err());
    }
}
