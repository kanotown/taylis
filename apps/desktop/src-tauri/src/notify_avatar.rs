//! The sender's picture of a message notification as a local PNG file (docs/PUSH_NOTIFICATIONS.md §9.1, §16).
//!
//! The page draws the picture (the profile picture fetched with its session, or the default initials avatar, already a
//! 128 px circle: src/platform/notificationAvatar.ts) and hands its PNG bytes here with a key naming the user and the
//! picture's version. Windows' toast takes an image only as a file (`appLogoOverride`), and macOS' fallback
//! attachment too, so each picture is written once under the app's cache folder (`notification-avatars/`, the file
//! named by a hash of the key) and reused. A toast left in the Action Center still points at its file, so files are not
//! removed right after showing: the folder keeps the newest `KEEP` pictures and is emptied at sign-out.
//!
//! Sign-out also ends the notification epoch: a send still on its way (it runs off the command's thread) that started
//! before the sign-out neither writes its picture nor shows (`while_current`), so nothing comes back after the clear.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use tauri::{AppHandle, Manager};

use crate::NotificationPerson;

const DIR: &str = "notification-avatars";
/// Pictures kept (a few kB each); older ones are removed when a new one is written.
const KEEP: usize = 200;
/// A 128 px PNG is a few kB; anything far larger is not what the page draws.
const MAX_BYTES: usize = 512 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
/// Prefix of the one-use copies macOS' attachments move away (mac_notify.rs); swept when older than this.
pub const ONE_USE_PREFIX: &str = "attach-";
const ONE_USE_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(600);

/// The notification epoch: bumped at each sign-out (`end_epoch`). A send runs its last steps (the picture's file, showing)
/// under this lock, and only while the epoch it started in is still the current one.
static EPOCH: Mutex<u64> = Mutex::new(0);

fn epoch_lock() -> MutexGuard<'static, u64> {
    EPOCH.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The epoch a send starts in (read when the command arrives, before it moves off the command's thread).
pub fn current_epoch() -> u64 {
    *epoch_lock()
}

/// Run `f` (write the picture, show the notification) unless a sign-out came after `epoch`; None when it did. A
/// sign-out waits for a running `f` and then removes what it showed / wrote.
pub fn while_current<T>(epoch: u64, f: impl FnOnce() -> T) -> Option<T> {
    let current = epoch_lock();
    if *current != epoch {
        return None;
    }
    let result = f();
    drop(current);
    Some(result)
}

/// Sign-out: end the epoch (sends started before it are dropped) and run `clear` (remove what was shown and written)
/// while no send can show or write.
pub fn end_epoch(clear: impl FnOnce()) {
    let mut current = epoch_lock();
    *current = current.wrapping_add(1);
    clear();
}

fn dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|cache| cache.join(DIR))
}

/// FNV-1a, 64 bits: a stable file name for a key (the key itself has ids and a timestamp, not file-name safe).
fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3))
}

/// Whether bytes look like the PNG the page draws (a signature, a sane size).
pub fn acceptable_png(png: &[u8]) -> bool {
    png.len() <= MAX_BYTES && png.len() > PNG_SIGNATURE.len() && png.starts_with(PNG_SIGNATURE)
}

/// The picture's file, written now if it is not there yet; None without a picture or when it cannot be written (the
/// notification then shows without it).
pub fn file(app: &AppHandle, person: &NotificationPerson) -> Option<PathBuf> {
    let key = person.avatar_key.as_deref()?;
    let png = person.avatar_png.as_deref()?;
    if !acceptable_png(png) {
        return None;
    }
    let dir = dir(app)?;
    let path = dir.join(format!("{:016x}.png", fnv1a(key)));
    if path.is_file() {
        return Some(path);
    }
    let written = fs::create_dir_all(&dir).and_then(|()| {
        // Whole or not at all: a toast shown meanwhile never reads half a file.
        let partial = path.with_extension("part");
        fs::write(&partial, png)?;
        fs::rename(&partial, &path)
    });
    if let Err(err) = written {
        eprintln!("could not keep the notification picture: {err}");
        return None;
    }
    prune(&dir);
    Some(path)
}

/// A copy of a picture for one use (an attachment that macOS moves into its own store), next to the cached ones.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn one_use_copy(path: &Path, id: &str) -> Option<PathBuf> {
    let safe: String = id.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    let copy = path.with_file_name(format!("{ONE_USE_PREFIX}{safe}.png"));
    fs::copy(path, &copy).ok().map(|_| copy)
}

/// Keep the newest `KEEP` pictures, and drop one-use copies left behind.
fn prune(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    let mut pictures = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let modified = entry.metadata().and_then(|m| m.modified()).unwrap_or(now);
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with(ONE_USE_PREFIX) {
            if now.duration_since(modified).unwrap_or_default() > ONE_USE_MAX_AGE {
                let _ = fs::remove_file(&path);
            }
        } else if name.ends_with(".png") {
            pictures.push((modified, path));
        }
    }
    if pictures.len() <= KEEP {
        return;
    }
    pictures.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    for (_, path) in pictures.into_iter().skip(KEEP) {
        let _ = fs::remove_file(path);
    }
}

/// Sign-out: no one's picture stays behind.
pub fn clear(app: &AppHandle) {
    if let Some(dir) = dir(app) {
        if dir.exists() {
            if let Err(err) = fs::remove_dir_all(&dir) {
                eprintln!("could not remove the notification pictures: {err}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_names_and_png_check() {
        assert_eq!(fnv1a(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a("a"), 0xaf63_dc4c_8601_ec8c);
        assert_ne!(fnv1a("srv|u1|v1"), fnv1a("srv|u1|v2"));
        assert!(acceptable_png(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"));
        assert!(!acceptable_png(b"GIF89a......"));
        assert!(!acceptable_png(PNG_SIGNATURE));
        let mut big = PNG_SIGNATURE.to_vec();
        big.resize(MAX_BYTES + 1, 0);
        assert!(!acceptable_png(&big));
    }

    #[test]
    fn a_send_started_before_sign_out_does_nothing() {
        let before = current_epoch();
        assert_eq!(while_current(before, || 1), Some(1));
        let mut cleared = false;
        end_epoch(|| cleared = true);
        assert!(cleared);
        let mut ran = false;
        assert_eq!(while_current(before, || ran = true), None);
        assert!(!ran);
        assert_eq!(while_current(current_epoch(), || 2), Some(2));
    }
}
