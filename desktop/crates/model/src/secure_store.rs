//! The session token's home: `<userData>/session.bin`, encrypted with a key
//! the OS guards (see the shell's `Encryption` implementation). The renderer
//! reaches it only through the bridge and never sees the file, the path or
//! the key. Ported from `electron/src/secure-store.ts`.
//!
//! Why a file and not localStorage: the token is a credential. The WebView's
//! storage sits in the profile as plain files anything able to read the
//! user's files can copy; `session.bin` is ciphertext whose key the OS guards.
//!
//! **The Linux trap.** With no keyring (a bare window manager, a headless
//! box) there is no real encryption to offer. Writing a credential under an
//! obfuscation key would look secure and not be, so the store refuses to
//! persist: the token lives in memory for this run, the next launch starts
//! signed out, and `status()` says so, which Settings → Devices shows.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tyt_wire::{DesktopSecureStoreStatus, Encryption};

pub const SESSION_FILE: &str = "session.bin";

/// Backends that are not encryption, whatever the API calls them.
pub const INSECURE_BACKENDS: [&str; 2] = ["basic_text", "unknown"];

pub trait SessionFile: Send + Sync {
    fn read(&self) -> Option<Vec<u8>>;
    fn write(&self, data: &[u8]) -> std::io::Result<()>;
    fn remove(&self);
}

struct State {
    /// This run's token. The only copy when the backend cannot persist.
    memory: Option<String>,
    loaded: bool,
}

pub struct SecureStore {
    encryption: Arc<dyn Encryption>,
    file: Box<dyn SessionFile>,
    state: Mutex<State>,
}

impl SecureStore {
    pub fn new(encryption: Arc<dyn Encryption>, file: Box<dyn SessionFile>) -> Self {
        SecureStore {
            encryption,
            file,
            state: Mutex::new(State {
                memory: None,
                loaded: false,
            }),
        }
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

    fn load(&self, state: &mut State) {
        if state.loaded {
            return;
        }
        state.loaded = true;
        if !self.status().persistent {
            // A file left from a run that did persist (a keyring since
            // removed) cannot be read safely either way; it is not decrypted.
            return;
        }
        let Some(data) = self.file.read().filter(|d| !d.is_empty()) else {
            return;
        };
        match self.encryption.decrypt(&data) {
            Ok(token) => state.memory = (!token.is_empty()).then_some(token),
            Err(_) => {
                // The key changed (a new keychain, a profile copied to another
                // machine): this ciphertext will never decrypt again. Signed
                // out, and the dead file goes, so the next launch does not try.
                state.memory = None;
                self.file.remove();
            }
        }
    }

    pub fn get_token(&self) -> Option<String> {
        let mut state = self.state.lock().unwrap();
        self.load(&mut state);
        state.memory.clone()
    }

    pub fn set_token(&self, token: &str) -> DesktopSecureStoreStatus {
        let mut state = self.state.lock().unwrap();
        self.load(&mut state);
        let current = self.status();
        if token.is_empty() {
            return current;
        }
        state.memory = Some(token.to_string());
        if current.persistent {
            match self
                .encryption
                .encrypt(token)
                .and_then(|c| self.file.write(&c).map_err(|e| e.to_string()))
            {
                Ok(()) => {}
                Err(error) => {
                    // Never leave an older ciphertext behind a token that was
                    // not written; this run keeps the token in memory.
                    eprintln!("[secure-store] could not persist the token: {error}");
                    self.file.remove();
                }
            }
        } else {
            self.file.remove();
        }
        current
    }

    pub fn delete_token(&self) {
        let mut state = self.state.lock().unwrap();
        state.loaded = true;
        state.memory = None;
        self.file.remove();
    }

    /// Whether a ciphertext is on disk, without decrypting it.
    pub fn has_file(&self) -> bool {
        self.file.read().is_some_and(|d| !d.is_empty())
    }
}

/// The file half, atomic and owner-only.
pub struct DiskSessionFile {
    dir: PathBuf,
    target: PathBuf,
}

impl DiskSessionFile {
    pub fn at(user_data: &Path, name: &str) -> Self {
        DiskSessionFile {
            dir: user_data.to_path_buf(),
            target: user_data.join(name),
        }
    }
}

/// Write `data` to `target` through a temp file in the same directory, mode
/// 0600, then rename: a crash never leaves half a file behind.
pub fn write_private_atomic(dir: &Path, target: &Path, data: &[u8]) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let temp = dir.join(format!("{name}.{}.tmp", std::process::id()));
    {
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(data)?;
        file.sync_all()?;
    }
    fs::rename(&temp, target).inspect_err(|_| {
        let _ = fs::remove_file(&temp);
    })
}

impl SessionFile for DiskSessionFile {
    fn read(&self) -> Option<Vec<u8>> {
        fs::read(&self.target).ok()
    }
    fn write(&self, data: &[u8]) -> std::io::Result<()> {
        write_private_atomic(&self.dir, &self.target, data)
    }
    fn remove(&self) {
        let _ = fs::remove_file(&self.target);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// Reversible "encryption" that marks its output, so a test can tell
    /// ciphertext from the token.
    struct Fake {
        available: AtomicBool,
        backend: Mutex<String>,
        broken: AtomicBool,
    }

    impl Fake {
        fn new(backend: &str) -> Arc<Fake> {
            Arc::new(Fake {
                available: AtomicBool::new(true),
                backend: Mutex::new(backend.into()),
                broken: AtomicBool::new(false),
            })
        }
    }

    impl Encryption for Fake {
        fn is_available(&self) -> bool {
            self.available.load(Ordering::SeqCst)
        }
        fn backend(&self) -> String {
            self.backend.lock().unwrap().clone()
        }
        fn encrypt(&self, plain: &str) -> Result<Vec<u8>, String> {
            Ok(format!("enc:{}", plain.chars().rev().collect::<String>()).into_bytes())
        }
        fn decrypt(&self, cipher: &[u8]) -> Result<String, String> {
            if self.broken.load(Ordering::SeqCst) {
                return Err("bad key".into());
            }
            let text = String::from_utf8(cipher.to_vec()).map_err(|e| e.to_string())?;
            text.strip_prefix("enc:")
                .map(|s| s.chars().rev().collect())
                .ok_or_else(|| "not ours".into())
        }
    }

    #[derive(Default, Clone)]
    struct MemFile(Arc<Mutex<Option<Vec<u8>>>>);

    impl SessionFile for MemFile {
        fn read(&self) -> Option<Vec<u8>> {
            self.0.lock().unwrap().clone()
        }
        fn write(&self, data: &[u8]) -> std::io::Result<()> {
            *self.0.lock().unwrap() = Some(data.to_vec());
            Ok(())
        }
        fn remove(&self) {
            *self.0.lock().unwrap() = None;
        }
    }

    fn store(enc: &Arc<Fake>, file: &MemFile) -> SecureStore {
        SecureStore::new(enc.clone(), Box::new(file.clone()))
    }

    #[test]
    fn writes_ciphertext_never_the_token_and_reads_it_back_in_a_new_run() {
        let enc = Fake::new("keychain");
        let file = MemFile::default();
        let status = store(&enc, &file).set_token("tok-123");
        assert_eq!(
            status,
            DesktopSecureStoreStatus {
                persistent: true,
                backend: "keychain".into()
            }
        );
        let raw = String::from_utf8(file.read().unwrap()).unwrap();
        assert!(!raw.contains("tok-123"));
        assert_eq!(store(&enc, &file).get_token().as_deref(), Some("tok-123"));
    }

    #[test]
    fn refuses_to_persist_on_basic_text() {
        let enc = Fake::new("basic_text");
        let file = MemFile::default();
        let s = store(&enc, &file);
        assert!(!s.set_token("tok").persistent);
        assert_eq!(s.get_token().as_deref(), Some("tok"));
        assert!(file.read().is_none());
        assert_eq!(store(&enc, &file).get_token(), None);
    }

    #[test]
    fn does_not_persist_when_encryption_is_unavailable() {
        let enc = Fake::new("keychain");
        enc.available.store(false, Ordering::SeqCst);
        let file = MemFile::default();
        assert_eq!(
            store(&enc, &file).set_token("t"),
            DesktopSecureStoreStatus {
                persistent: false,
                backend: "unavailable".into()
            }
        );
        assert!(file.read().is_none());
    }

    #[test]
    fn removes_an_older_ciphertext_when_a_new_token_cannot_be_written() {
        let enc = Fake::new("keychain");
        let file = MemFile::default();
        store(&enc, &file).set_token("old");
        *enc.backend.lock().unwrap() = "basic_text".into();
        store(&enc, &file).set_token("new");
        assert!(file.read().is_none());
    }

    #[test]
    fn signs_out_and_deletes_the_file_when_the_ciphertext_no_longer_decrypts() {
        let enc = Fake::new("keychain");
        let file = MemFile::default();
        store(&enc, &file).set_token("tok");
        enc.broken.store(true, Ordering::SeqCst);
        assert_eq!(store(&enc, &file).get_token(), None);
        assert!(file.read().is_none());
    }

    #[test]
    fn forgets_on_delete_in_memory_and_on_disk() {
        let enc = Fake::new("keychain");
        let file = MemFile::default();
        let s = store(&enc, &file);
        s.set_token("tok");
        s.delete_token();
        assert_eq!(s.get_token(), None);
        assert!(file.read().is_none());
    }

    #[test]
    fn ignores_an_empty_token() {
        let enc = Fake::new("keychain");
        let file = MemFile::default();
        let s = store(&enc, &file);
        s.set_token("tok");
        s.set_token("");
        assert_eq!(s.get_token().as_deref(), Some("tok"));
    }

    #[test]
    fn disk_file_is_owner_only_and_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let file = DiskSessionFile::at(dir.path(), SESSION_FILE);
        file.write(b"cipher").unwrap();
        assert_eq!(file.read().unwrap(), b"cipher");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.path().join(SESSION_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        file.remove();
        assert!(file.read().is_none());
    }
}
