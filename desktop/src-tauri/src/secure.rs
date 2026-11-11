//! What the session token and the activity device key are encrypted with:
//! AES-256-GCM under a random key the OS keeps (the macOS Keychain, the
//! Windows Credential Manager, the Secret Service on Linux) — the scheme
//! Electron's `safeStorage` used, without Chromium.
//!
//! Three rules, each of which fails quietly if broken:
//!
//! - **Headless runs never touch the OS store.** They use a fixed in-process
//!   key (Chromium's mock keychain did the same), so a test run never creates
//!   a Keychain item or raises a password prompt that takes focus. Their
//!   ciphertext is only readable by another headless run, which is why a
//!   headless run gets its own profile (tyt_model::profile).
//! - **The key is read on first use, not at launch.** A Keychain access from a
//!   binary whose signature differs from the item's creator can prompt; doing
//!   it at launch would prompt on every start, even signed out.
//! - **Blobs Electron wrote still decrypt.** `session.bin` and
//!   `activity-device-key.bin` from the Electron build start with `v10`/`v11`
//!   (safeStorage's prefixes). They are decrypted with the legacy key
//!   (`legacy.rs`) once; the next write re-encrypts them under the new key.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use rand::RngCore;
use std::path::PathBuf;
use std::sync::Mutex;
use tyt_wire::Encryption;

const MAGIC: &[u8] = b"tyt1";
const KEY_SERVICE: &str = "com.ricoslabs.trackyourtime";
const KEY_ACCOUNT: &str = "storage-key";

enum KeyState {
    Unread,
    Ready([u8; 32]),
    Unavailable,
}

pub struct OsEncryption {
    headless: bool,
    profile: PathBuf,
    key: Mutex<KeyState>,
}

impl OsEncryption {
    pub fn new(headless: bool, profile: PathBuf) -> Self {
        let key = if headless {
            // Fixed, so headless runs round-trip their own files; not a secret.
            KeyState::Ready(*b"trackyourtime-headless-mock-key!")
        } else {
            KeyState::Unread
        };
        OsEncryption {
            headless,
            profile,
            key: Mutex::new(key),
        }
    }

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(KEY_SERVICE, KEY_ACCOUNT).map_err(|e| e.to_string())
    }

    /// The key, creating it in the OS store on first use when `create`.
    fn key(&self, create: bool) -> Result<[u8; 32], String> {
        let mut state = self.key.lock().unwrap();
        match *state {
            KeyState::Ready(key) => return Ok(key),
            KeyState::Unavailable => return Err("OS secret store unavailable".into()),
            KeyState::Unread => {}
        }
        let entry = Self::entry()?;
        match entry.get_password() {
            Ok(stored) => {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(stored.trim())
                    .map_err(|e| e.to_string())?;
                let key: [u8; 32] = bytes
                    .try_into()
                    .map_err(|_| "stored key has the wrong length".to_string())?;
                *state = KeyState::Ready(key);
                Ok(key)
            }
            Err(keyring::Error::NoEntry) if create => {
                let mut key = [0u8; 32];
                rand::thread_rng().fill_bytes(&mut key);
                entry
                    .set_password(&base64::engine::general_purpose::STANDARD.encode(key))
                    .map_err(|e| {
                        *state = KeyState::Unavailable;
                        e.to_string()
                    })?;
                *state = KeyState::Ready(key);
                Ok(key)
            }
            Err(keyring::Error::NoEntry) => Err("no key yet".into()),
            Err(error) => {
                if matches!(
                    error,
                    keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_)
                ) {
                    *state = KeyState::Unavailable;
                }
                Err(error.to_string())
            }
        }
    }
}

impl Encryption for OsEncryption {
    fn is_available(&self) -> bool {
        if self.headless {
            return true;
        }
        // macOS and Windows always have their store; asking would read the
        // Keychain item, which may prompt. Linux may have no Secret Service at
        // all (a bare window manager), and that is probed once.
        if cfg!(target_os = "linux") {
            if matches!(*self.key.lock().unwrap(), KeyState::Unavailable) {
                return false;
            }
            return match self.key(false) {
                Ok(_) => true,
                Err(_) => !matches!(*self.key.lock().unwrap(), KeyState::Unavailable),
            };
        }
        !matches!(*self.key.lock().unwrap(), KeyState::Unavailable)
    }

    fn backend(&self) -> String {
        if self.headless {
            return "mock".into();
        }
        if cfg!(target_os = "macos") {
            "keychain".into()
        } else if cfg!(windows) {
            "dpapi".into()
        } else {
            "secret-service".into()
        }
    }

    fn encrypt(&self, plain: &str) -> Result<Vec<u8>, String> {
        let key = self.key(true)?;
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let sealed = cipher
            .encrypt(Nonce::from_slice(&nonce), plain.as_bytes())
            .map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(MAGIC.len() + nonce.len() + sealed.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&nonce);
        out.extend_from_slice(&sealed);
        Ok(out)
    }

    fn decrypt(&self, data: &[u8]) -> Result<String, String> {
        if let Some(rest) = data.strip_prefix(MAGIC) {
            if rest.len() < 12 + 16 {
                return Err("ciphertext too short".into());
            }
            let key = self.key(false)?;
            let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
            let plain = cipher
                .decrypt(Nonce::from_slice(&rest[..12]), &rest[12..])
                .map_err(|_| "ciphertext does not decrypt".to_string())?;
            return String::from_utf8(plain).map_err(|e| e.to_string());
        }
        if self.headless {
            // Never ask the OS for the Electron key from a test run.
            return Err("not a headless ciphertext".into());
        }
        crate::legacy::decrypt_safe_storage(data, &self.profile)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headless_round_trips_without_the_os_store() {
        let enc = OsEncryption::new(true, PathBuf::from("/nonexistent"));
        assert!(enc.is_available());
        assert_eq!(enc.backend(), "mock");
        let sealed = enc.encrypt("token-123").unwrap();
        assert!(sealed.starts_with(MAGIC));
        assert!(!String::from_utf8_lossy(&sealed).contains("token-123"));
        assert_eq!(enc.decrypt(&sealed).unwrap(), "token-123");
        let other = enc.encrypt("token-123").unwrap();
        assert_ne!(sealed, other, "nonce must differ per write");
    }

    #[test]
    fn headless_refuses_legacy_and_tampered_blobs() {
        let enc = OsEncryption::new(true, PathBuf::from("/nonexistent"));
        assert!(enc.decrypt(b"v10abcdefabcdefabcdef").is_err());
        let mut sealed = enc.encrypt("x").unwrap();
        let last = sealed.len() - 1;
        sealed[last] ^= 1;
        assert!(enc.decrypt(&sealed).is_err());
        assert!(enc.decrypt(b"tyt1short").is_err());
    }
}
