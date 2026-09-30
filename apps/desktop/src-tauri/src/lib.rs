//! Tauri shell: SQLite (tauri-plugin-sql), notifications, the system browser for external links
//! (tauri-plugin-opener), the OS credential store, and the `chikuwachat://` deep link that Google sign-in returns
//! through (tauri-plugin-deep-link, docs/SSO.md §6; the page reads the URL, this side only brings the window up).
//! Refresh tokens never touch the file system: they live in Keychain / Credential Manager.

use keyring::{Entry, Error as KeyringError};
use tauri::{AppHandle, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

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

/// The browser handed a link back (or the app was launched again): the main window comes to the front.
fn show_main_window(app: &AppHandle) {
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
        .setup(|app| {
            // Installers register the scheme (tauri.conf.json plugins.deep-link); a development build registers
            // itself so the link can be tried without installing (Windows / Linux; macOS needs the app bundle).
            #[cfg(all(debug_assertions, any(windows, target_os = "linux")))]
            app.deep_link().register_all()?;
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |_event| show_main_window(&handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![secret_get, secret_set, secret_delete])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
