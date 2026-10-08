//! Windows toasts whose click brings Taylis up and opens what they are about (docs/PUSH_NOTIFICATIONS.md §9.1).
//!
//! tauri-plugin-notification (2.4.0) shows a toast with notify-rust → tauri-winrt-notification and drops the handle that
//! would report its click: notify-rust registers an `Activated` handler that only sends on a channel nobody reads. A click
//! on a toast therefore only dismissed it; the window stayed where it was, hidden in the notification area since closing
//! it keeps Taylis running (background.rs, v0.1.41). Here we show the toast with tauri-winrt-notification ourselves (the
//! same crate and version the plugin uses, so the toast looks the same) and handle `Activated` in this process: the main
//! window comes up and the page hears `notification-clicked` with the toast's id, exactly as on macOS (mac_notify.rs), so
//! platform/notify.ts runs the notification's own click action (open the message / thread / DM, the task, …).
//!
//! The toast is attributed to the installed app's AppUserModelID, the bundle identifier, which the NSIS installer puts on
//! the Start-menu shortcut; a build run from `target\debug` / `target\release` has no such shortcut and uses PowerShell's,
//! as the plugin does. Toasts carry no `launch` / COM activator: a click reaches us only while this process runs (the same
//! as the click actions on macOS, which live in the page). A toast left in the Action Center after quitting Taylis does
//! not open it.
//!
//! Threads: `Activated` runs on a WinRT thread-pool thread; `show_main_window` and `emit` are safe from any thread (the
//! window calls are posted to the event loop). `Toast::show` sleeps briefly, so it runs off the async runtime's threads.

use tauri::{AppHandle, Emitter};
use tauri_winrt_notification::Toast;

/// The AppUserModelID the toast is shown under (see the module comment).
fn app_id(app: &AppHandle) -> String {
    let identifier = app.config().identifier.clone();
    let Ok(exe) = tauri::utils::platform::current_exe() else {
        return identifier;
    };
    let in_target = exe
        .parent()
        .map(|dir| dir.ends_with(r"target\debug") || dir.ends_with(r"target\release"))
        .unwrap_or(false);
    if in_target {
        Toast::POWERSHELL_APP_ID.to_owned()
    } else {
        identifier
    }
}

/// Show one toast now. `id` names it for the click (`notification-clicked`); `None` = a click only brings the window up.
pub fn send(app: &AppHandle, id: Option<String>, title: String, body: String) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let on_click = app.clone();
        // Default sound (Toast::new's), like macOS' banner; the plugin's toasts were silent (notify-rust's `sound(None)`).
        let toast = Toast::new(&app_id(&app)).title(&title).text1(&body).on_activated(move |_action| {
            crate::show_main_window(&on_click);
            if let Some(id) = &id {
                if let Err(err) = on_click.emit("notification-clicked", id.clone()) {
                    eprintln!("could not report the notification click: {err}");
                }
            }
            Ok(())
        });
        if let Err(err) = toast.show() {
            eprintln!("could not show the notification: {err:?}");
        }
    });
}
