//! Key lifetime and store replacement (`vault.ts`).
//!
//! The vault owns the current [`ActivityService`] and replaces it whenever
//! the key changes: protecting, unlocking, locking, signing out. It lives
//! outside the shell so tests use only synthetic history and a fake OS
//! encryption, never the real keychain.
//!
//! Rules that fail quietly if broken:
//! - A status read never opens the OS keychain ([`ActivityVault::status`]
//!   asks `Encryption::backend`, never `is_available` or `decrypt`).
//! - The remembered key is read at most once per launch, only for the
//!   account and server that remembered it; a refused keychain prompt is not
//!   retried (the secure store deletes the unreadable file).
//! - A protected folder never falls back to plaintext: without its key the
//!   store is locked, and a sign-out leaves a marker an older build also
//!   refuses to write past.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tyt_wire::{DesktopActivitySnapshot, Encryption};

use crate::ipc_parse::parse_scope;
use crate::protection::{
    activity_account, activity_protection, base64url_decode, create_activity_codec,
    finish_activity_swap, mark_empty_activity_protected, protect_activity, recover_activity_swap,
    remove_all, write_private, SharedCodec, ACTIVITY_PROTECTION_REQUIRED,
};
use crate::secure_store::SecureStore;
use crate::service::{ActivityService, ProtectionStatus, ProtectionStatusFn};
use crate::store::{ActivityStore, Clock};

pub const TRUSTED_KEY_FILE: &str = "activity-device-key.bin";
const CLOSED: &str = "Activity vault is closed";
const INVALID_KEY: &str = "Invalid activity key";
const UNTRUSTED_BACKENDS: [&str; 3] = ["basic_text", "unknown", "unavailable"];

pub type MakeService =
    Box<dyn FnMut(Option<SharedCodec>, ProtectionStatusFn) -> ActivityService + Send>;

/// `/^[A-Za-z0-9_-]{43}$/`: 32 bytes, base64url.
fn is_key(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub struct ActivityVault {
    user_data: PathBuf,
    clock: Clock,
    trusted: Option<SecureStore>,
    trusted_path: PathBuf,
    codec: Option<SharedCodec>,
    protected_account: Option<String>,
    explicitly_locked: bool,
    disposed: bool,
    has_codec: Arc<AtomicBool>,
    status_fn: ProtectionStatusFn,
    make_service: MakeService,
    on_replace: Arc<dyn Fn() + Send + Sync>,
    pub service: ActivityService,
}

impl ActivityVault {
    pub fn new(
        user_data: &Path,
        clock: Clock,
        encryption: Option<Arc<dyn Encryption>>,
        mut make_service: MakeService,
        on_replace: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        if let Err(error) = recover_activity_swap(user_data) {
            eprintln!("[activity] could not recover an interrupted swap: {error}");
        }
        let trusted_path = user_data.join(TRUSTED_KEY_FILE);
        let has_codec = Arc::new(AtomicBool::new(false));
        let status_fn: ProtectionStatusFn = {
            let (user_data, trusted_path, has_codec) = (
                user_data.to_path_buf(),
                trusted_path.clone(),
                has_codec.clone(),
            );
            let encryption = encryption.clone();
            Arc::new(move || {
                compute_status(
                    &user_data,
                    has_codec.load(Ordering::SeqCst),
                    &trusted_path,
                    encryption.as_deref(),
                )
            })
        };
        let service = make_service(None, status_fn.clone());
        ActivityVault {
            user_data: user_data.to_path_buf(),
            clock,
            trusted: encryption.map(|e| SecureStore::new(e, trusted_path.clone())),
            trusted_path,
            codec: None,
            protected_account: None,
            explicitly_locked: false,
            disposed: false,
            has_codec,
            status_fn,
            make_service,
            on_replace,
            service,
        }
    }

    pub fn status(&self) -> ProtectionStatus {
        (self.status_fn)()
    }

    fn check_open(&self) -> Result<(), String> {
        if self.disposed {
            Err(CLOSED.into())
        } else {
            Ok(())
        }
    }

    fn reset(&mut self) {
        self.service = (self.make_service)(self.codec.clone(), self.status_fn.clone());
        (self.on_replace)();
    }

    fn stop(&mut self) -> Result<(), String> {
        self.check_open()?;
        self.service.dispose();
        Ok(())
    }

    fn discard_key(&mut self) {
        if let Some(codec) = self.codec.take() {
            codec.destroy();
        }
        self.protected_account = None;
        self.has_codec.store(false, Ordering::SeqCst);
    }

    fn take_key(&mut self, codec: SharedCodec, account: String) {
        self.codec = Some(codec);
        self.protected_account = Some(account);
        self.has_codec.store(true, Ordering::SeqCst);
    }

    fn require_protection(&self) -> Result<(), String> {
        fs::create_dir_all(&self.user_data).map_err(|e| e.to_string())?;
        write_private(&self.user_data.join(ACTIVITY_PROTECTION_REQUIRED), b"1\n")
    }

    fn remove_folders(&self) -> Result<(), String> {
        for name in ["activity", "activity.previous", "activity.protecting"] {
            remove_all(&self.user_data.join(name))?;
        }
        mark_empty_activity_protected(&self.user_data)
    }

    pub fn protect(&mut self, input: &Value) -> Result<DesktopActivitySnapshot, String> {
        self.check_open()?;
        let record = input.as_object().ok_or(INVALID_KEY)?;
        let key = record
            .get("key")
            .and_then(Value::as_str)
            .filter(|k| is_key(k))
            .ok_or(INVALID_KEY)?;
        let user_id = record
            .get("userId")
            .and_then(Value::as_str)
            .filter(|u| !u.is_empty() && crate::js::utf16_len(u) <= 100 && !u.contains(':'))
            .ok_or(INVALID_KEY)?;
        let origin = record
            .get("origin")
            .and_then(Value::as_str)
            .filter(|o| crate::js::utf16_len(o) <= 2048)
            .ok_or(INVALID_KEY)?;
        let remember = record.get("remember").and_then(Value::as_bool);

        let account = activity_account(user_id, origin);
        let existing = activity_protection(&self.user_data)?;
        if existing
            .as_ref()
            .is_some_and(|existing| existing != &account)
        {
            return Err("Activity belongs to another account".into());
        }
        if existing.is_none() {
            let scope = ActivityStore::open(&self.user_data, self.clock.clone(), None).scope();
            if scope.is_some_and(|scope| !scope.starts_with(&format!("{user_id}:"))) {
                return Err("Activity belongs to another account".into());
            }
        }
        let mut raw = base64url_decode(key).map_err(|_| INVALID_KEY.to_string())?;
        let next = create_activity_codec(&raw, &account);
        raw.fill(0);
        let next = next?;

        let prepared = (|| {
            if existing.is_some() {
                finish_activity_swap(&self.user_data, &next)?;
            }
            match remember {
                Some(true) => {
                    let persistent = self.trusted.as_ref().is_some_and(|t| t.status().persistent);
                    let trusted = self.trusted.as_mut().filter(|_| persistent);
                    let Some(trusted) = trusted else {
                        return Err(
                            "A secure OS keychain is required to trust this device".to_string()
                        );
                    };
                    let saved = serde_json::json!({ "account": account, "key": key });
                    trusted.set_token(&serde_json::to_string(&saved).expect("json"))?;
                }
                Some(false) => {
                    if let Some(trusted) = self.trusted.as_mut() {
                        trusted.delete_token();
                    }
                }
                None => {}
            }
            Ok(())
        })();
        if let Err(error) = prepared {
            next.destroy();
            return Err(error);
        }
        self.stop()?;
        let installed = (|| {
            if existing.is_none() {
                protect_activity(&self.user_data, &next, &account)?;
            }
            self.require_protection()
        })();
        if let Err(error) = installed {
            next.destroy();
            self.reset();
            return Err(error);
        }
        self.discard_key();
        self.take_key(next, account);
        self.explicitly_locked = false;
        self.reset();
        Ok(self.service.snapshot())
    }

    pub fn lock(&mut self) -> Result<DesktopActivitySnapshot, String> {
        self.check_open()?;
        self.explicitly_locked = true;
        if self.codec.is_some() {
            self.stop()?;
            self.discard_key();
            self.reset();
        }
        Ok(self.service.snapshot())
    }

    pub fn set_scope(&mut self, input: &Value) -> Result<(), String> {
        self.check_open()?;
        let Some(scope) = parse_scope(input) else {
            return Ok(());
        };
        let existing = activity_protection(&self.user_data)?;
        let origin = input.get("origin").and_then(Value::as_str);
        let account = origin.map(|origin| activity_account(&scope.user_id, origin));
        if let (Some(existing), Some(account)) = (&existing, &account) {
            if self.codec.is_none()
                && !self.explicitly_locked
                && self.trusted_path.exists()
                && existing == account
            {
                // One attempt only; never retry a denied keychain prompt.
                let saved: Option<Value> = self
                    .trusted
                    .as_mut()
                    .and_then(|t| t.get_token())
                    .and_then(|text| serde_json::from_str(&text).ok());
                let saved_account = saved
                    .as_ref()
                    .and_then(|s| s.get("account"))
                    .and_then(Value::as_str);
                let saved_key = saved
                    .as_ref()
                    .and_then(|s| s.get("key"))
                    .and_then(Value::as_str)
                    .filter(|k| is_key(k));
                if let (Some(saved_account), Some(saved_key)) = (saved_account, saved_key) {
                    if saved_account == existing {
                        let mut raw = base64url_decode(saved_key).unwrap_or_default();
                        let next = create_activity_codec(&raw, existing);
                        raw.fill(0);
                        if let Ok(next) = next {
                            let unlocked = finish_activity_swap(&self.user_data, &next)
                                .and_then(|_| self.stop());
                            match unlocked {
                                Ok(()) => {
                                    self.take_key(next, existing.clone());
                                    self.reset();
                                }
                                Err(_) => {
                                    next.destroy();
                                    if let Some(trusted) = self.trusted.as_mut() {
                                        trusted.delete_token();
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if let Some(existing) = &existing {
            let matches = self.protected_account.is_some() && account.as_ref() == Some(existing);
            if !matches {
                self.stop()?;
                self.discard_key();
                self.reset();
                return Ok(());
            }
        }
        self.service.set_scope(&scope)
    }

    pub fn forget(&mut self) -> Result<(), String> {
        self.check_open()?;
        if let Some(trusted) = self.trusted.as_mut() {
            trusted.delete_token();
        }
        self.explicitly_locked = false;
        if !self.status().encrypted {
            return self.service.forget();
        }
        self.require_protection()?;
        self.stop()?;
        self.discard_key();
        self.remove_folders()?;
        self.reset();
        Ok(())
    }

    pub fn wipe_locked(&mut self) -> Result<DesktopActivitySnapshot, String> {
        self.check_open()?;
        if !self.status().locked {
            return self.service.wipe();
        }
        self.require_protection()?;
        if let Some(trusted) = self.trusted.as_mut() {
            trusted.delete_token();
        }
        self.stop()?;
        self.discard_key();
        self.remove_folders()?;
        self.reset();
        Ok(self.service.snapshot())
    }

    /// On quit. Idempotent.
    pub fn dispose(&mut self) {
        self.disposed = true;
        self.service.dispose();
        self.discard_key();
    }
}

fn compute_status(
    user_data: &Path,
    has_codec: bool,
    trusted_path: &Path,
    encryption: Option<&dyn Encryption>,
) -> ProtectionStatus {
    // Fail closed: an unreadable marker reads as encrypted.
    let encrypted = user_data.join(ACTIVITY_PROTECTION_REQUIRED).exists()
        || activity_protection(user_data).map_or(true, |a| a.is_some());
    let backend = encryption
        .map(|e| e.backend())
        .unwrap_or_else(|| "unavailable".into());
    ProtectionStatus {
        encrypted,
        locked: encrypted && !has_codec,
        trusted: trusted_path.exists(),
        can_trust: encryption.is_some() && !UNTRUSTED_BACKENDS.contains(&backend.as_str()),
    }
}
