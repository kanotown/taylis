//! Tauri shell: SQLite (tauri-plugin-sql), notifications, the system browser for external links
//! (tauri-plugin-opener), the OS credential store, and the `chikuwachat://` deep link that Google sign-in returns
//! through (tauri-plugin-deep-link, docs/SSO.md §6; the page reads the URL, this side only brings the window up).
//! Refresh tokens never touch the file system: they live in Keychain / Credential Manager.
//! In-app updates: tauri-plugin-updater (kanotown/taylis' latest.json, tauri.conf.json plugins.updater) and
//! tauri-plugin-process (relaunch after installing); the page drives both (src/state/updates.ts).
//! Notifications: tauri-plugin-notification, except in the macOS app bundle, where `native_notification_*` show them
//! through UNUserNotificationCenter so that they appear while Taylis is frontmost too (mac_notify.rs).
//! Closing the window keeps the app running (the Dock on macOS, the notification area on Windows) unless the reader
//! turned that off; quitting is ⌘Q / the tray's 「終了」 (background.rs).

use keyring::{Entry, Error as KeyringError};
use tauri::{AppHandle, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

mod background;
#[cfg(target_os = "macos")]
mod mac_notify;

const SERVICE: &str = "jp.chikuwachat.desktop";

fn entry(account: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, account).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(account: String) -> Result<Option<String>, String> {
    match entry(&account)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(KeyringError::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_set(account: String, value: String) -> Result<(), String> {
    entry(&account)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_delete(account: String) -> Result<(), String> {
    match entry(&account)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// "granted" / "denied" / "default" from the OS, or "unavailable" where the page uses tauri-plugin-notification
/// (Windows, Linux, and `tauri dev` on macOS, which runs outside an app bundle).
#[tauri::command]
async fn native_notification_permission() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    if mac_notify::available() {
        return mac_notify::permission().await;
    }
    Ok("unavailable".to_owned())
}

/// Ask the OS (its prompt the first time) and say what was decided; "unavailable" as above.
#[tauri::command]
async fn native_notification_request() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    if mac_notify::available() {
        return mac_notify::request_permission().await;
    }
    Ok("unavailable".to_owned())
}

/// Show a notification (only called after the permission said it is not "unavailable").
#[tauri::command]
fn native_notification_send(id: String, title: String, body: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if mac_notify::available() {
        mac_notify::send(&id, &title, &body);
        return Ok(());
    }
    let _ = (id, title, body);
    Err("native notifications are not available here".to_owned())
}

/// Sign-out: remove our delivered notifications (nothing to do where they are not native).
#[tauri::command]
fn native_notification_clear() {
    #[cfg(target_os = "macos")]
    if mac_notify::available() {
        mac_notify::clear();
    }
}

/// The computer's own name for the device list (「ログイン中の端末」, the test notification's list): macOS's Computer
/// Name (System Settings → General → About), Windows' COMPUTERNAME, Linux's hostname. None when it cannot be read;
/// the page then says just "Mac" / "Windows" (src/platform/deviceName.ts). The WebView's navigator.platform says
/// "MacIntel" on every Mac, Apple silicon too.
#[tauri::command]
async fn computer_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    let name = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok());
    #[cfg(windows)]
    let name = std::env::var("COMPUTERNAME").ok();
    #[cfg(not(any(target_os = "macos", windows)))]
    let name = std::fs::read_to_string("/etc/hostname").ok();
    name.map(|n| n.trim().to_owned()).filter(|n| !n.is_empty())
}

/// The browser handed a link back, the app was launched again, the Dock icon / tray icon / a notification was clicked:
/// the main window comes to the front (it may have been hidden by closing it, background.rs).
pub(crate) fn show_main_window(app: &AppHandle) {
    // A full-screen window's close hides the whole app (background.rs): unhide it first.
    #[cfg(target_os = "macos")]
    if let Err(err) = app.show() {
        eprintln!("could not unhide the app: {err}");
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    for (what, result) in [("unminimize", window.unminimize()), ("show", window.show()), ("focus", window.set_focus())] {
        if let Err(err) = result {
            eprintln!("could not {what} the main window: {err}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // Windows / Linux start a second process for a deep link; it hands its arguments (the URL) to this one and exits.
    // First plugin, as its docs ask. The "deep-link" feature passes the URL on as a deep-link event.
    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main_window(app)));
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(background::on_window_event)
        .setup(|app| {
            background::setup(app)?;
            // Installers register the scheme (tauri.conf.json plugins.deep-link); a development build registers
            // itself so the link can be tried without installing (Windows / Linux; macOS needs the app bundle).
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            app.deep_link().register_all()?;
            #[cfg(target_os = "macos")]
            mac_notify::init(app.handle());
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |_event| show_main_window(&handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_delete,
            native_notification_permission,
            native_notification_request,
            native_notification_send,
            native_notification_clear,
            computer_name,
            background::background_get,
            background::background_set,
            background::shell_labels_set
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Exit requests (⌘Q, the tray's 「終了」, the updater's restart) are left alone: only a window's close is held
        // back (background.rs), so quitting always quits.
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = _event {
                background::on_reopen(_app);
            }
        });
}
