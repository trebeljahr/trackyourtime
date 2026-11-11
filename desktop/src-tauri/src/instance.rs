//! One instance per profile. Two would each hold a socket and both write the
//! same offline queue. A second launch hands its arguments to the first
//! (which comes to the front, or switches window mode) and exits.
//!
//! Per profile, not per bundle identifier (which is what the Tauri plugin
//! keys on): the e2e harness runs several headless copies side by side, each
//! with its own `TRACKYOURTIME_USER_DATA_DIR`, and `dev:desktop` must not hand
//! over to the installed app.
//!
//! The lock is an OS file lock on `<profile>/instance.lock`, released by the
//! OS when the process dies, so a crash never strands it. The hand-over is a
//! loopback TCP connection to the port the first instance wrote into
//! `<profile>/instance.json` (0600) with a random token, std only and the
//! same on every platform.

use base64::Engine;
use rand::RngCore;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::time::Duration;

pub enum Instance {
    /// This process owns the profile. Keep the value alive for the whole run.
    Primary {
        _lock: File,
        listener: TcpListener,
        token: String,
    },
    /// Another process owns it and has been handed our arguments.
    Secondary,
}

pub fn acquire(profile: &Path) -> std::io::Result<Instance> {
    std::fs::create_dir_all(profile)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(profile.join("instance.lock"))?;
    match lock.try_lock() {
        Ok(()) => {
            let listener = TcpListener::bind(("127.0.0.1", 0))?;
            let mut token = [0u8; 24];
            rand::thread_rng().fill_bytes(&mut token);
            let token = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token);
            let info = serde_json::json!({ "port": listener.local_addr()?.port(), "token": token, "pid": std::process::id() });
            tyt_model::secure_store::write_private_atomic(
                profile,
                &profile.join("instance.json"),
                info.to_string().as_bytes(),
            )?;
            Ok(Instance::Primary {
                _lock: lock,
                listener,
                token,
            })
        }
        Err(std::fs::TryLockError::WouldBlock) => {
            hand_over(profile);
            Ok(Instance::Secondary)
        }
        Err(std::fs::TryLockError::Error(error)) => Err(error),
    }
}

/// Send our argv to the running instance; give up quietly after a few tries
/// (it may still be starting, or be on its way out).
fn hand_over(profile: &Path) {
    let argv: Vec<String> = std::env::args().collect();
    for _ in 0..20 {
        if let Ok(raw) = std::fs::read_to_string(profile.join("instance.json")) {
            if let Ok(info) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let (Some(port), Some(token)) = (info["port"].as_u64(), info["token"].as_str()) {
                    if let Ok(mut stream) = TcpStream::connect_timeout(
                        &([127, 0, 0, 1], port as u16).into(),
                        Duration::from_secs(2),
                    ) {
                        let line = serde_json::json!({ "token": token, "argv": argv }).to_string();
                        if stream
                            .write_all(line.as_bytes())
                            .and_then(|_| stream.write_all(b"\n"))
                            .is_ok()
                        {
                            return;
                        }
                    }
                }
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    eprintln!(
        "[instance] another instance holds {}; could not reach it",
        profile.display()
    );
}

/// Accept hand-overs for the rest of the run.
pub fn listen(
    listener: TcpListener,
    token: String,
    on_args: impl Fn(Vec<String>) + Send + 'static,
) {
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut line = String::new();
            if BufReader::new(&stream)
                .take_line(&mut line, 64 * 1024)
                .is_err()
            {
                continue;
            }
            let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if message["token"].as_str() != Some(token.as_str()) {
                continue;
            }
            let argv = message["argv"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            on_args(argv);
        }
    });
}

trait TakeLine {
    fn take_line(self, buf: &mut String, limit: usize) -> std::io::Result<usize>;
}

impl<R: std::io::Read> TakeLine for BufReader<R> {
    fn take_line(self, buf: &mut String, limit: usize) -> std::io::Result<usize> {
        use std::io::Read;
        BufReader::new(self.take(limit as u64)).read_line(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn a_second_acquire_of_the_same_profile_hands_over() {
        let profile = tempfile::tempdir().unwrap();
        let Instance::Primary {
            _lock,
            listener,
            token,
        } = acquire(profile.path()).unwrap()
        else {
            panic!("first acquire must own the profile");
        };
        let (tx, rx) = mpsc::channel();
        listen(listener, token, move |argv| tx.send(argv).unwrap());
        // A file lock is per open file description, so a second open in the
        // same process conflicts like a second process would.
        assert!(matches!(
            acquire(profile.path()).unwrap(),
            Instance::Secondary
        ));
        let argv = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(!argv.is_empty());
        let other = tempfile::tempdir().unwrap();
        assert!(matches!(
            acquire(other.path()).unwrap(),
            Instance::Primary { .. }
        ));
    }
}
