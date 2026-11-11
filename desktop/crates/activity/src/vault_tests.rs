//! `protection.test.ts` and `vault.test.ts`: synthetic history and a fake OS
//! encryption only, never the real keychain.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use tyt_wire::{DesktopActivitySettings, Encryption};

use crate::core::{ActivityInterval, ActivityRule, ActivitySource};
use crate::ipc_parse::SettingsPatch;
use crate::model::{OpenSegment, StoredSegment};
use crate::protection::{
    activity_account, activity_protection, base64url_encode, create_activity_codec,
    finish_activity_swap, protect_activity, random_bytes, read_utf8, recover_activity_swap,
    verify_activity_protection,
};
use crate::service_tests::service_for;
use crate::settings::default_activity_settings;
use crate::source_fake::FakeFrontmostSource;
use crate::store::{day_file_of, ActivityStore, Clock};
use crate::test_hook::HookClock;
use crate::vault::{ActivityVault, TRUSTED_KEY_FILE};

const SCOPE: &str = "user:workspace";
/// `Date.UTC(2026, 9, 23)`.
const AT: f64 = 1_792_713_600_000.0;

fn clock() -> Clock {
    Arc::new(|| 1.0)
}

fn account() -> String {
    activity_account("user", "https://example.test")
}

fn segment(start: f64, end: f64, key: &str, name: &str, label: Option<&str>) -> StoredSegment {
    StoredSegment {
        scope: SCOPE.into(),
        source: ActivitySource::Desktop,
        start,
        end,
        key: key.into(),
        name: name.into(),
        label: label.map(str::to_string),
        afk: false,
    }
}

fn fixture(dir: &Path) -> ActivityStore {
    let mut store = ActivityStore::open(dir, clock(), None);
    store
        .save_state(
            DesktopActivitySettings {
                enabled: true,
                store_titles: true,
                ..default_activity_settings()
            },
            Some(SCOPE.into()),
        )
        .unwrap();
    store
        .append(segment(
            AT,
            AT + 10_000.0,
            "secret.app",
            "Private app",
            Some("Confidential client"),
        ))
        .unwrap();
    store
        .put_rule(
            SCOPE,
            ActivityRule {
                id: "rule".into(),
                pattern: "secret.app".into(),
                description: Some("Private work".into()),
                project_id: None,
                task_id: None,
                tag_ids: None,
                billable: None,
            },
            AT,
        )
        .unwrap();
    store
}

fn every_file(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        for entry in fs::read_dir(next).unwrap().flatten() {
            if entry.file_type().unwrap().is_dir() {
                stack.push(entry.path());
            } else {
                out.push(entry.path());
            }
        }
    }
    out
}

mod protection {
    use super::*;

    #[test]
    fn migrates_and_verifies_every_source_file_then_reads_and_writes_only_ciphertext() {
        let dir = tempfile::tempdir().unwrap();
        let before = fixture(dir.path()).files();
        let codec = create_activity_codec(&random_bytes::<32>(), &account()).unwrap();
        protect_activity(dir.path(), &codec, &account()).unwrap();
        assert_eq!(activity_protection(dir.path()).unwrap(), Some(account()));
        assert!(!dir.path().join("activity.previous").exists());
        assert_eq!(
            ActivityStore::open(dir.path(), clock(), Some(codec.clone())).files(),
            before
        );
        let backup_text = codec
            .decode(
                &read_utf8(&dir.path().join("activity/migration-backup.bin")).unwrap(),
                "migration-backup.bin",
            )
            .unwrap();
        let backup: Value = serde_json::from_str(&backup_text).unwrap();
        let key = format!("segments/{}", day_file_of(AT).unwrap());
        assert!(backup[&key]
            .as_str()
            .unwrap()
            .contains("Confidential client"));

        let mut reopened = ActivityStore::open(dir.path(), clock(), Some(codec.clone()));
        let open = OpenSegment {
            scope: SCOPE.into(),
            key: "secret.app".into(),
            name: "Private app".into(),
            label: Some("Confidential client".into()),
            start: AT,
            last_seen: AT,
        };
        reopened.write_open(Some(&open)).unwrap();
        reopened
            .add_dismissal(
                SCOPE,
                ActivityInterval {
                    start: AT,
                    end: AT + 1000.0,
                },
            )
            .unwrap();
        reopened
            .append(segment(
                AT + 20_000.0,
                AT + 30_000.0,
                "another.secret",
                "Other",
                None,
            ))
            .unwrap();
        verify_activity_protection(dir.path(), &codec, false).unwrap();
        for file in every_file(&dir.path().join("activity")) {
            let content = read_utf8(&file).unwrap();
            for secret in [
                "Confidential client",
                "Private work",
                "secret.app",
                "another.secret",
                "user:workspace",
            ] {
                assert!(
                    !content.contains(secret),
                    "{} holds {secret}",
                    file.display()
                );
            }
        }
        assert!(!dir.path().join("activity/migration-backup.bin").exists());
        assert_eq!(reopened.all_segments(SCOPE).len(), 2);
        assert_eq!(
            reopened.read_open().unwrap().label.as_deref(),
            Some("Confidential client")
        );
    }

    #[test]
    fn stays_read_only_without_the_key_and_rejects_wrong_keys_accounts_files_and_tampering() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let key = random_bytes::<32>();
        let codec = create_activity_codec(&key, &account()).unwrap();
        protect_activity(dir.path(), &codec, &account()).unwrap();
        let mut locked = ActivityStore::open(dir.path(), clock(), None);
        let state_path = dir.path().join("activity/state.json");
        let before = fs::read_to_string(&state_path).unwrap();
        assert_eq!(locked.status(), crate::store::StoreStatus::Locked);
        assert!(locked.all_segments(SCOPE).is_empty());
        locked.wipe().unwrap();
        locked
            .save_state(
                default_activity_settings(),
                Some("intruder:workspace".into()),
            )
            .unwrap();
        assert_eq!(fs::read_to_string(&state_path).unwrap(), before);
        let wrong = create_activity_codec(&random_bytes::<32>(), &account()).unwrap();
        assert!(verify_activity_protection(dir.path(), &wrong, false).is_err());
        let other = create_activity_codec(&key, &activity_account("other", "https://example.test"))
            .unwrap();
        assert!(verify_activity_protection(dir.path(), &other, false).is_err());
        assert!(codec.decode(&before, "open.json").is_err());
        let mut boxed: Value = serde_json::from_str(&before).unwrap();
        boxed["tag"] = json!(base64url_encode(&[0u8; 16]));
        assert!(codec.decode(&boxed.to_string(), "state.json").is_err());
        codec.destroy();
        assert!(codec.decode(&before, "state.json").is_err());
    }

    #[test]
    fn recovers_an_interrupted_final_encrypted_append_without_losing_readable_history() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let codec = create_activity_codec(&random_bytes::<32>(), &account()).unwrap();
        protect_activity(dir.path(), &codec, &account()).unwrap();
        let segments = dir.path().join("activity/segments");
        let file = segments.join(day_file_of(AT).unwrap());
        fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(br#"{"v":2,"data":"interrupted"#)
            .unwrap();
        assert!(verify_activity_protection(dir.path(), &codec, false).is_err());
        finish_activity_swap(dir.path(), &codec).unwrap();
        let mut store = ActivityStore::open(dir.path(), clock(), Some(codec.clone()));
        assert_eq!(store.all_segments(SCOPE).len(), 1);
        let saved = fs::read_dir(&segments)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .find(|name| name.contains(".torn."))
            .expect("the torn tail is kept");
        assert_eq!(
            codec
                .decode(
                    &read_utf8(&segments.join(&saved)).unwrap(),
                    &format!("segments/{saved}")
                )
                .unwrap(),
            r#"{"v":2,"data":"interrupted"#
        );
        store
            .append(segment(AT + 30_000.0, AT + 40_000.0, "app", "App", None))
            .unwrap();
        verify_activity_protection(dir.path(), &codec, false).unwrap();
        assert!(!fs::read_dir(&segments)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains(".torn.")));
        assert_eq!(
            ActivityStore::open(dir.path(), clock(), Some(codec))
                .all_segments(SCOPE)
                .len(),
            2
        );
    }

    #[test]
    fn preserves_source_bytes_and_repairs_an_interrupted_directory_swap() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let old = fs::read_to_string(dir.path().join("activity/state.json")).unwrap();
        fs::rename(
            dir.path().join("activity"),
            dir.path().join("activity.previous"),
        )
        .unwrap();
        recover_activity_swap(dir.path()).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("activity/state.json")).unwrap(),
            old
        );
        let codec = create_activity_codec(&random_bytes::<32>(), &account()).unwrap();
        protect_activity(dir.path(), &codec, &account()).unwrap();
        // A crash after the new folder was installed keeps the original until
        // the successor's key and all ciphertext have been verified.
        let other = dir.path().join("activity.previous");
        fs::write(dir.path().join("old-copy"), "source").unwrap();
        fs::rename(dir.path().join("old-copy"), &other).unwrap();
        let wrong = create_activity_codec(&random_bytes::<32>(), &account()).unwrap();
        assert!(finish_activity_swap(dir.path(), &wrong).is_err());
        assert!(other.exists());
        finish_activity_swap(dir.path(), &codec).unwrap();
        assert!(!other.exists());
    }
}

mod vault {
    use super::*;

    struct FakeEncryption {
        reads: AtomicUsize,
        availability_reads: AtomicUsize,
        denied: AtomicBool,
        backend: &'static str,
    }

    impl Encryption for FakeEncryption {
        fn is_available(&self) -> bool {
            self.availability_reads.fetch_add(1, Ordering::SeqCst);
            true
        }
        fn backend(&self) -> String {
            self.backend.into()
        }
        fn encrypt(&self, plain: &str) -> Result<Vec<u8>, String> {
            Ok(plain.bytes().map(|b| b ^ 77).collect())
        }
        fn decrypt(&self, cipher: &[u8]) -> Result<String, String> {
            self.reads.fetch_add(1, Ordering::SeqCst);
            if self.denied.load(Ordering::SeqCst) {
                return Err("Denied".into());
            }
            Ok(String::from_utf8(cipher.iter().map(|b| b ^ 77).collect()).unwrap())
        }
    }

    fn fake(backend: &'static str) -> Arc<FakeEncryption> {
        Arc::new(FakeEncryption {
            reads: AtomicUsize::new(0),
            availability_reads: AtomicUsize::new(0),
            denied: AtomicBool::new(false),
            backend,
        })
    }

    fn open(dir: &Path, encryption: Option<Arc<FakeEncryption>>) -> ActivityVault {
        let user_data = dir.to_path_buf();
        let clock = Arc::new(HookClock::default());
        let make_clock = clock.clone();
        ActivityVault::new(
            dir,
            Arc::new(move || clock.now()),
            encryption.map(|e| e as Arc<dyn Encryption>),
            Box::new(move |codec, status| {
                service_for(
                    &user_data,
                    make_clock.clone(),
                    Arc::new(FakeFrontmostSource::new()),
                    true,
                    codec,
                    Some(status),
                )
                .0
            }),
            Arc::new(|| {}),
        )
    }

    struct Input {
        key: String,
    }

    fn input() -> Input {
        Input {
            key: base64url_encode(&random_bytes::<32>()),
        }
    }

    fn protect_args(input: &Input, user: &str, remember: Option<bool>) -> Value {
        let mut value =
            json!({ "key": input.key, "userId": user, "origin": "https://api.example.test" });
        if let Some(remember) = remember {
            value["remember"] = json!(remember);
        }
        value
    }

    fn scope(user: &str, origin: &str) -> Value {
        json!({ "userId": user, "workspaceId": "workspace", "origin": origin })
    }

    const ORIGIN: &str = "https://api.example.test";

    fn enabled() -> SettingsPatch {
        SettingsPatch {
            enabled: Some(true),
            ..Default::default()
        }
    }

    #[test]
    fn keeps_a_protected_store_closed_on_restart_then_unlocks_without_losing_history() {
        let dir = tempfile::tempdir().unwrap();
        let key = input();
        let mut vault = open(dir.path(), None);
        vault.set_scope(&scope("owner", ORIGIN)).unwrap();
        vault.service.update_settings(&enabled()).unwrap();
        vault.protect(&protect_args(&key, "owner", None)).unwrap();
        assert!(!vault.status().locked);
        let original = fs::read_to_string(dir.path().join("activity/state.json")).unwrap();
        assert!(vault
            .protect(&protect_args(&input(), "owner", None))
            .is_err());
        assert!(!vault.status().locked);
        assert_eq!(
            fs::read_to_string(dir.path().join("activity/state.json")).unwrap(),
            original
        );
        vault.dispose();

        let mut vault = open(dir.path(), None);
        assert!(vault.status().locked);
        vault.service.update_settings(&enabled()).unwrap();
        assert!(!vault.service.snapshot().recording);
        vault.protect(&protect_args(&key, "owner", None)).unwrap();
        assert!(!vault.status().locked);
        assert!(vault.service.snapshot().settings.enabled);
        vault.dispose();
    }

    #[test]
    fn remembers_only_an_opted_in_key_binds_it_to_account_and_server_and_clears_it_on_sign_out() {
        let dir = tempfile::tempdir().unwrap();
        let key = input();
        let encryption = fake("test-keychain");
        let mut vault = open(dir.path(), Some(encryption.clone()));
        vault.set_scope(&scope("owner", ORIGIN)).unwrap();
        vault
            .protect(&protect_args(&key, "owner", Some(true)))
            .unwrap();
        assert!(vault.status().trusted);
        vault.dispose();

        let encryption = fake("test-keychain");
        let mut vault = open(dir.path(), Some(encryption.clone()));
        // A status read never opens the keychain.
        assert_eq!(encryption.reads.load(Ordering::SeqCst), 0);
        vault
            .set_scope(&scope("owner", "https://other.example.test"))
            .unwrap();
        assert!(vault.status().locked);
        assert_eq!(encryption.reads.load(Ordering::SeqCst), 0);
        vault.set_scope(&scope("other", ORIGIN)).unwrap();
        assert!(vault.status().locked);
        assert_eq!(encryption.reads.load(Ordering::SeqCst), 0);
        vault.set_scope(&scope("owner", ORIGIN)).unwrap();
        assert!(!vault.status().locked);
        assert_eq!(encryption.reads.load(Ordering::SeqCst), 1);
        vault.lock().unwrap();
        vault.set_scope(&scope("owner", ORIGIN)).unwrap();
        assert!(vault.status().locked);
        vault.protect(&protect_args(&key, "owner", None)).unwrap();
        vault.forget().unwrap();
        assert!(!dir.path().join(TRUSTED_KEY_FILE).exists());
        assert!(vault.status().encrypted);
        assert!(vault.status().locked);
        assert!(!vault.service.snapshot().scoped);
        let state: Value = serde_json::from_str(
            &fs::read_to_string(dir.path().join("activity/state.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(state["v"], 2);
        vault.service.update_settings(&enabled()).unwrap();
        assert!(!vault.service.snapshot().recording);
        // Another account can set up its own key, but cannot silently resume
        // this device's history capture as plaintext after the prior sign-out.
        vault.protect(&protect_args(&key, "other", None)).unwrap();
        assert!(!vault.status().locked);
        assert!(vault.status().encrypted);
        vault.dispose();
    }

    #[test]
    fn never_falls_back_to_plaintext_or_retries_a_refused_os_credential_request() {
        let dir = tempfile::tempdir().unwrap();
        let key = input();
        let mut vault = open(dir.path(), Some(fake("test-keychain")));
        vault
            .protect(&protect_args(&key, "owner", Some(true)))
            .unwrap();
        vault.dispose();

        let encryption = fake("test-keychain");
        encryption.denied.store(true, Ordering::SeqCst);
        let mut vault = open(dir.path(), Some(encryption.clone()));
        vault.set_scope(&scope("owner", ORIGIN)).unwrap();
        vault.set_scope(&scope("owner", ORIGIN)).unwrap();
        assert_eq!(encryption.reads.load(Ordering::SeqCst), 1);
        assert!(vault.status().locked);
        assert!(!vault.service.snapshot().support.is_supported());
        vault.protect(&protect_args(&key, "owner", None)).unwrap();
        assert!(!vault.status().locked);
        vault.dispose();

        let mut vault = open(dir.path(), Some(fake("basic_text")));
        let refused = vault
            .protect(&protect_args(&key, "owner", Some(true)))
            .unwrap_err();
        assert!(refused.contains("secure OS keychain"), "{refused}");
        assert!(vault.status().locked);
        assert!(!vault.status().can_trust);
        vault.protect(&protect_args(&key, "owner", None)).unwrap();
        assert!(!vault.status().locked);
        vault.dispose();
    }

    #[test]
    fn does_not_query_or_open_the_os_keychain_for_status_or_an_unremembered_key() {
        let dir = tempfile::tempdir().unwrap();
        let key = input();
        let encryption = fake("test-keychain");
        let mut vault = open(dir.path(), Some(encryption.clone()));
        vault.status();
        vault.set_scope(&scope("owner", ORIGIN)).unwrap();
        assert_eq!(encryption.availability_reads.load(Ordering::SeqCst), 0);
        assert_eq!(encryption.reads.load(Ordering::SeqCst), 0);
        vault.protect(&protect_args(&key, "owner", None)).unwrap();
        vault.dispose();

        let mut vault = open(dir.path(), Some(encryption.clone()));
        vault.status();
        vault.set_scope(&scope("owner", ORIGIN)).unwrap();
        assert!(vault.status().locked);
        assert_eq!(encryption.availability_reads.load(Ordering::SeqCst), 0);
        assert_eq!(encryption.reads.load(Ordering::SeqCst), 0);
        vault.dispose();
    }

    #[test]
    fn refuses_to_encrypt_a_different_accounts_plaintext_history_under_the_new_users_key() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = open(dir.path(), None);
        vault.set_scope(&scope("owner", ORIGIN)).unwrap();
        let refused = vault
            .protect(&protect_args(&input(), "other", None))
            .unwrap_err();
        assert!(refused.contains("another account"), "{refused}");
        assert!(!vault.status().encrypted);
        vault.dispose();
    }

    #[test]
    fn a_closed_vault_refuses_every_transition() {
        let dir = tempfile::tempdir().unwrap();
        let mut vault = open(dir.path(), None);
        vault.dispose();
        assert_eq!(vault.lock().unwrap_err(), "Activity vault is closed");
        assert_eq!(
            vault.set_scope(&scope("owner", ORIGIN)).unwrap_err(),
            "Activity vault is closed"
        );
    }
}
