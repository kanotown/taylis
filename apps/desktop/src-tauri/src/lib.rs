//! Tauri shell: SQLite (tauri-plugin-sql), notifications and the OS credential store.
//! Refresh tokens never touch the file system: they live in Keychain / Credential Manager.

use keyring::{Entry, Error as KeyringError};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![secret_get, secret_set, secret_delete])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
