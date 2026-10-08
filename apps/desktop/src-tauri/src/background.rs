//! Closing the window keeps Taylis running, as Slack does (docs/PUSH_NOTIFICATIONS.md §9.2).
//!
//! - The main window's close (its button, ⌘W, Alt+F4, our own close button on Windows) only hides it: the page keeps its
//!   WebSocket, notifications and the badge. macOS: the app stays in the Dock; a click on the Dock icon (or launching
//!   Taylis again) brings the window back (`RunEvent::Reopen`), and Window → 「ウィンドウを表示」 too. Windows: a tray
//!   icon in the notification area (left click / double click, or its menu's 「Taylis を開く」) brings it back, and the
//!   first time a one-off notification says where Taylis went; launching it again goes through the single-instance
//!   plugin (lib.rs).
//! - Quitting is never intercepted: ⌘Q, the app menu's Quit, the Dock's 「終了」, logging out (macOS terminates the app
//!   without asking its windows), the tray's 「終了」 (`AppHandle::exit`) and the updater's restart all end in an exit
//!   request with an exit code, which goes through. Only `CloseRequested` is held back.
//! - 「ウィンドウを閉じてもバックグラウンドで動かす」 (settings → 通知 → この端末; on by default) turns it off: the close
//!   goes through, the last window closes and the app quits. Kept in `window.json` in the app's config directory (this
//!   device only), so it applies before the page has loaded.
//!
//! The texts of the tray menu, the macOS menu item and the hint follow the app's language: the page sends them
//! (`shell_labels_set`, src/platform/background.ts); Japanese until it does.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::MenuItem;
use tauri::{App, AppHandle, Manager, Window, WindowEvent, Wry};

const PREFS_FILE: &str = "window.json";
const SHOW_WINDOW_ID: &str = "taylis-show-window";
#[cfg(windows)]
const TRAY_OPEN_ID: &str = "taylis-tray-open";
#[cfg(windows)]
const TRAY_QUIT_ID: &str = "taylis-tray-quit";

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Prefs {
    run_in_background: bool,
    /// The Windows hint 「Taylis は通知領域で動き続けます」 has been shown (once per device).
    tray_hint_shown: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self { run_in_background: true, tray_hint_shown: false }
    }
}

/// The texts in the app's language (src/platform/background.ts sends them; Japanese until then).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellLabels {
    /// macOS Window menu: 「ウィンドウを表示」.
    show_window: String,
    /// Tray menu: 「Taylis を開く」 / 「終了」.
    open: String,
    quit: String,
    /// The one-off notification the first time the window goes to the tray (Windows).
    #[cfg_attr(not(windows), allow(dead_code))]
    hint_title: String,
    #[cfg_attr(not(windows), allow(dead_code))]
    hint_body: String,
}

impl Default for ShellLabels {
    fn default() -> Self {
        Self {
            show_window: "ウィンドウを表示".to_owned(),
            open: "Taylis を開く".to_owned(),
            quit: "終了".to_owned(),
            hint_title: "Taylis は通知領域で動き続けます".to_owned(),
            hint_body: "ウィンドウを閉じても新しいメッセージの通知は届きます。終了するには通知領域の Taylis のアイコンから「終了」を選んでください。".to_owned(),
        }
    }
}

/// Menu items whose text follows the language.
#[derive(Default)]
struct Items {
    show_window: Option<MenuItem<Wry>>,
    tray_open: Option<MenuItem<Wry>>,
    tray_quit: Option<MenuItem<Wry>>,
}

pub struct Background {
    path: Option<PathBuf>,
    prefs: Mutex<Prefs>,
    labels: Mutex<ShellLabels>,
    items: Mutex<Items>,
}

impl Background {
    fn load(path: Option<PathBuf>) -> Self {
        let prefs = path
            .as_ref()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| serde_json::from_slice::<Prefs>(&bytes).ok())
            .unwrap_or_default();
        Self { path, prefs: Mutex::new(prefs), labels: Mutex::new(ShellLabels::default()), items: Mutex::default() }
    }

    fn prefs(&self) -> Prefs {
        self.prefs.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn update(&self, change: impl FnOnce(&mut Prefs)) -> Result<(), String> {
        let mut prefs = self.prefs.lock().unwrap_or_else(|e| e.into_inner());
        change(&mut prefs);
        let Some(path) = &self.path else {
            return Err("no config directory".to_owned());
        };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_vec_pretty(&*prefs).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    #[cfg(windows)]
    fn labels(&self) -> ShellLabels {
        self.labels.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

/// 「ウィンドウを閉じてもバックグラウンドで動かす」.
#[tauri::command]
pub fn background_get(state: tauri::State<'_, Background>) -> bool {
    state.prefs().run_in_background
}

#[tauri::command]
pub fn background_set(state: tauri::State<'_, Background>, enabled: bool) -> Result<(), String> {
    state.update(|prefs| prefs.run_in_background = enabled)
}

/// The page's language changed (and at start): the menu texts follow.
#[tauri::command]
pub fn shell_labels_set(state: tauri::State<'_, Background>, labels: ShellLabels) {
    {
        let items = state.items.lock().unwrap_or_else(|e| e.into_inner());
        for (item, text) in [(&items.show_window, &labels.show_window), (&items.tray_open, &labels.open), (&items.tray_quit, &labels.quit)] {
            if let Some(item) = item {
                if let Err(err) = item.set_text(text) {
                    eprintln!("could not relabel a menu item: {err}");
                }
            }
        }
    }
    *state.labels.lock().unwrap_or_else(|e| e.into_inner()) = labels;
}

/// At start-up: the preference, the macOS menu item, the Windows tray icon.
pub fn setup(app: &mut App) -> tauri::Result<()> {
    let path = app.path().app_config_dir().ok().map(|dir| dir.join(PREFS_FILE));
    app.manage(Background::load(path));
    #[cfg(any(target_os = "macos", windows))]
    let labels = ShellLabels::default();

    // macOS: Window → 「ウィンドウを表示」 (the window may be hidden with the app still frontmost, e.g. after ⌘Tab).
    #[cfg(target_os = "macos")]
    if let Some(menu) = app.menu() {
        if let Some(tauri::menu::MenuItemKind::Submenu(window_menu)) = menu.get(tauri::menu::WINDOW_SUBMENU_ID) {
            let item = MenuItem::with_id(app, SHOW_WINDOW_ID, &labels.show_window, true, None::<&str>)?;
            window_menu.append_items(&[&tauri::menu::PredefinedMenuItem::separator(app)?, &item])?;
            app.state::<Background>().items.lock().unwrap_or_else(|e| e.into_inner()).show_window = Some(item);
        }
    }
    app.on_menu_event(|app, event| {
        if event.id() == SHOW_WINDOW_ID {
            crate::show_main_window(app);
        }
    });

    #[cfg(windows)]
    {
        use tauri::menu::Menu;
        use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

        let open = MenuItem::with_id(app, TRAY_OPEN_ID, &labels.open, true, None::<&str>)?;
        let quit = MenuItem::with_id(app, TRAY_QUIT_ID, &labels.quit, true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &tauri::menu::PredefinedMenuItem::separator(app)?, &quit])?;
        let mut tray = TrayIconBuilder::with_id("taylis")
            .tooltip("Taylis")
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id().as_ref() {
                TRAY_OPEN_ID => crate::show_main_window(app),
                TRAY_QUIT_ID => app.exit(0),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| match event {
                TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. }
                | TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => crate::show_main_window(tray.app_handle()),
                _ => {}
            });
        if let Some(icon) = app.default_window_icon() {
            tray = tray.icon(icon.clone());
        }
        tray.build(app)?;
        let state = app.state::<Background>();
        let mut items = state.items.lock().unwrap_or_else(|e| e.into_inner());
        items.tray_open = Some(open);
        items.tray_quit = Some(quit);
    }
    Ok(())
}

/// `on_window_event`: the main window's close hides it while running in the background is on.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    let state = app.state::<Background>();
    if !state.prefs().run_in_background {
        return; // the window closes; being the last one, the app quits
    }
    api.prevent_close();
    hide(window);
    #[cfg(windows)]
    if !state.prefs().tray_hint_shown {
        show_tray_hint(app, &state);
    }
}

fn hide(window: &Window) {
    // A full-screen window would leave its empty Space behind: hide the whole app instead (the Dock icon brings it
    // back, show_main_window unhides it).
    #[cfg(target_os = "macos")]
    if window.is_fullscreen().unwrap_or(false) {
        if let Err(err) = window.app_handle().hide() {
            eprintln!("could not hide the app: {err}");
        }
        return;
    }
    if let Err(err) = window.hide() {
        eprintln!("could not hide the main window: {err}");
    }
}

/// Windows, the first time the window goes to the tray: say where Taylis went (Slack does the same). A click on it brings
/// the window back (win_notify.rs).
#[cfg(windows)]
fn show_tray_hint(app: &AppHandle, state: &Background) {
    let labels = state.labels();
    crate::win_notify::send(app, None, labels.hint_title, labels.hint_body, None);
    if let Err(err) = state.update(|prefs| prefs.tray_hint_shown = true) {
        eprintln!("could not remember the tray hint: {err}");
    }
}

/// macOS: a click on the Dock icon, or Taylis opened again (Finder, Spotlight, `open -a`), brings the window back.
#[cfg(target_os = "macos")]
pub fn on_reopen(app: &AppHandle) {
    crate::show_main_window(app);
}
