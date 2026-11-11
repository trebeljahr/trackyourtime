//! The trusted-device key's home: `userData/activity-device-key.bin`,
//! encrypted by the shell's [`Encryption`] (Keychain, Credential Manager,
//! Secret Service). A port of `createSecureStore` (`secure-store.ts`), which
//! the activity vault used for this one file.
//!
//! **The Linux trap.** With no keyring, a backend that answers `basic_text`
//! "encrypts" with a key compiled into the binary. That is obfuscation, and
//! writing a credential under it would look secure and not be. So this store
//! refuses to persist there: the value lives in memory for this run only.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tyt_wire::{DesktopSecureStoreStatus, Encryption};

use crate::protection::{remove_all, write_private};

/// Linux backends that are not encryption, whatever the API calls them.
const INSECURE_BACKENDS: [&str; 2] = ["basic_text", "unknown"];

pub struct SecureStore {
    encryption: Arc<dyn Encryption>,
    path: PathBuf,
    /// This run's value. The only copy when the backend cannot persist.
    memory: Option<String>,
    loaded: bool,
}

impl SecureStore {
    pub fn new(encryption: Arc<dyn Encryption>, path: PathBuf) -> Self {
        SecureStore {
            encryption,
            path,
            memory: None,
            loaded: false,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn status(&self) -> DesktopSecureStoreStatus {
        if !self.encryption.is_available() {
            return DesktopSecureStoreStatus {
                persistent: false,
                backend: "unavailable".into(),
            };
        }
        let backend = self.encryption.backend();
        DesktopSecureStoreStatus {
            persistent: !INSECURE_BACKENDS.contains(&backend.as_str()),
            backend,
        }
    }

    fn load(&mut self) {
        if self.loaded {
            return;
        }
        self.loaded = true;
        if !self.status().persistent {
            // A file left from a run that did persist (a keyring since
            // removed) cannot be read safely either way; it is not decrypted.
            return;
        }
        let Ok(data) = fs::read(&self.path) else {
            return;
        };
        if data.is_empty() {
            return;
        }
        match self.encryption.decrypt(&data) {
            Ok(token) => self.memory = (!token.is_empty()).then_some(token),
            Err(_) => {
                // The key changed (a new keychain, a profile copied to
                // another machine): this ciphertext will never decrypt again.
                // The dead file goes, so the next launch does not try again.
                self.memory = None;
                let _ = remove_all(&self.path);
            }
        }
    }

    pub fn get_token(&mut self) -> Option<String> {
        self.load();
        self.memory.clone()
    }

    pub fn set_token(&mut self, token: &str) -> Result<DesktopSecureStoreStatus, String> {
        self.load();
        let current = self.status();
        if token.is_empty() {
            return Ok(current);
        }
        self.memory = Some(token.to_string());
        if current.persistent {
            let cipher = self.encryption.encrypt(token)?;
            if let Some(parent) = self.path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut temp = self.path.as_os_str().to_owned();
            temp.push(".tmp");
            let temp = PathBuf::from(temp);
            write_private(&temp, &cipher)?;
            fs::rename(&temp, &self.path).map_err(|e| e.to_string())?;
        } else {
            // Never leave an older ciphertext behind a value that was not written.
            remove_all(&self.path)?;
        }
        Ok(current)
    }

    pub fn delete_token(&mut self) {
        self.loaded = true;
        self.memory = None;
        let _ = remove_all(&self.path);
    }
}
