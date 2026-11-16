//! The local store's SQLite files (docs/SYNC_PROTOCOL.md §11: one per server and user, `chikuwa-<hex>.db` in the app's
//! config folder), opened here instead of by tauri-plugin-sql's `load` (2026-11-16, a hostile-server review: what an
//! injected script could reach). `load` takes any connection string — an absolute path replaces the folder — so with
//! `execute` a script could create or open an SQLite file anywhere; the capability no longer allows it. This command
//! takes only the profile's hex name, puts the pool where the plugin's `execute` / `select` find it (its
//! `DbInstances`, under the same `sqlite:chikuwa-<hex>.db` key `load` would have used), and each connection refuses
//! `ATTACH` of a named file (and so `VACUUM INTO`, which attaches its target): the other way SQL can write a file.
//!
//! The page then uses `Database.get(<key>)` (src/platform/sqlite.ts). Every connection also gets `secure_delete`
//! (the page's PRAGMA reached only the pool's first connection).

use std::ffi::{c_char, c_int, c_void, CStr};

use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqlitePoolOptions};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_sql::{DbInstances, DbPool};

/// `profileKey` in src/state/app.ts: 16 bytes of a SHA-256 in lower-case hex (a little room either way).
fn valid_profile(profile: &str) -> bool {
    (16..=64).contains(&profile.len()) && profile.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// SQLite's authorizer: `ATTACH` only of the unnamed temporary database (what a plain `VACUUM` attaches), never of a
/// file (`ATTACH '/any/path'`, `VACUUM INTO '/any/path'`, or a name SQLite cannot read before running); and no
/// `load_extension()` (off anyway unless enabled).
unsafe extern "C" fn authorize(_: *mut c_void, action: c_int, first: *const c_char, second: *const c_char, _: *const c_char, _: *const c_char) -> c_int {
    // SAFETY: SQLite passes NUL-terminated strings or null.
    let text = |arg: *const c_char| (!arg.is_null()).then(|| unsafe { CStr::from_ptr(arg) }.to_bytes());
    match action {
        libsqlite3_sys::SQLITE_ATTACH if text(first) != Some(b"") => libsqlite3_sys::SQLITE_DENY,
        libsqlite3_sys::SQLITE_FUNCTION if text(second).is_some_and(|name| name.eq_ignore_ascii_case(b"load_extension")) => libsqlite3_sys::SQLITE_DENY,
        _ => libsqlite3_sys::SQLITE_OK,
    }
}

async fn restrict(conn: &mut SqliteConnection) -> Result<(), sqlx::Error> {
    let mut handle = conn.lock_handle().await?;
    // SAFETY: the handle is this connection's, locked for the call; the callback keeps no state.
    let code = unsafe { libsqlite3_sys::sqlite3_set_authorizer(handle.as_raw_handle().as_ptr(), Some(authorize), std::ptr::null_mut()) };
    if code == libsqlite3_sys::SQLITE_OK {
        Ok(())
    } else {
        Err(sqlx::Error::Protocol(format!("could not restrict the local store (SQLite {code})")))
    }
}

/// Opens (creating when missing) the local store `chikuwa-<profile>.db` and returns its key for `Database.get`.
#[tauri::command]
pub async fn local_store_open(app: AppHandle, instances: State<'_, DbInstances>, profile: String) -> Result<String, String> {
    if !valid_profile(&profile) {
        return Err("not a local store name".to_owned());
    }
    let key = format!("sqlite:chikuwa-{profile}.db");
    if instances.0.read().await.contains_key(&key) {
        return Ok(key);
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let options = SqliteConnectOptions::new()
        .filename(dir.join(format!("chikuwa-{profile}.db")))
        .create_if_missing(true)
        .pragma("secure_delete", "ON");
    let pool = SqlitePoolOptions::new()
        .after_connect(|conn, _meta| Box::pin(async move { restrict(conn).await }))
        .connect_with(options)
        .await
        .map_err(|e| e.to_string())?;
    let mut open = instances.0.write().await;
    // Opened twice at once (a workspace restarted while its first start still ran): the first pool stays.
    open.entry(key.clone()).or_insert(DbPool::Sqlite(pool));
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Connection, Executor};

    #[test]
    fn only_profile_names() {
        assert!(valid_profile("0123456789abcdef0123456789abcdef"));
        for bad in ["", "short", "../../etc/passwd0000", "0123456789ABCDEF0123456789ABCDEF", "/tmp/x.db0123456789abcdef", "0123456789abcdef0123456789abcdeg"] {
            assert!(!valid_profile(bad), "{bad}");
        }
    }

    #[test]
    fn attach_of_a_file_and_vacuum_into_are_refused_plain_vacuum_works() {
        let dir = std::env::temp_dir().join(format!("taylis-store-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let outside = dir.join("outside.db");
        let attach = format!("ATTACH '{}' AS other", outside.display());
        let into = format!("VACUUM INTO '{}'", outside.display());
        let concatenated = format!("ATTACH '{}' || '' AS other", outside.display());
        let options = SqliteConnectOptions::new().filename(dir.join("a.db")).create_if_missing(true);
        let runtime = tauri::async_runtime::block_on(async {
            // Without the authorizer the same statements work (so the refusals below are the authorizer's).
            let mut open = SqliteConnection::connect_with(&options).await.unwrap();
            open.execute(attach.as_str()).await.unwrap();
            open.execute("DETACH other").await.unwrap();
            assert!(outside.exists());
            std::fs::remove_file(&outside).unwrap();
            open.close().await.unwrap();

            let mut conn = SqliteConnection::connect_with(&options).await.unwrap();
            restrict(&mut conn).await.unwrap();
            conn.execute("CREATE TABLE t (x)").await.unwrap();
            let refused = [conn.execute(attach.as_str()).await.is_err(), conn.execute(into.as_str()).await.is_err(), conn.execute(concatenated.as_str()).await.is_err()];
            let vacuum = conn.execute("VACUUM").await;
            (refused, vacuum.is_ok(), outside.exists())
        });
        assert_eq!(runtime, ([true, true, true], true, false));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
