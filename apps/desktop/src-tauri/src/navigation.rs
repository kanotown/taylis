//! The window shows the app and nothing else (2026-11-16, a hostile-server review): a navigation to any other page —
//! a link that slipped past the page's click handler (external links open in the system browser, platform/external.ts),
//! a link or file dropped onto the window, or script — is cancelled. Otherwise a server's content could put a page of
//! its own in the app's window, one that looks like Taylis (asking for a password), with the app's IPC.
//!
//! Allowed: the app's own origin (`tauri://localhost` on macOS / Linux, `http(s)://tauri.localhost` on Windows), the
//! dev server of `tauri dev` (tauri.conf.json `devUrl`, a development build only), and `about:blank` / `about:srcdoc`
//! (empty frames a library may make; WebKit asks for every frame, not only the window's).

use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime, Url,
};

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let dev = if tauri::is_dev() { webview.app_handle().config().build.dev_url.clone() } else { None };
            let allowed = is_app_url(url, dev.as_ref());
            if !allowed {
                // Scheme and host only: the rest of a URL may carry a token.
                eprintln!("blocked a navigation away from the app: {}://{}", url.scheme(), url.host_str().unwrap_or(""));
            }
            allowed
        })
        .build()
}

/// Whether `url` is the app itself (see the module's comment). `dev`: the dev server's URL in a development build.
fn is_app_url(url: &Url, dev: Option<&Url>) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => (url.host_str() == Some("tauri.localhost") && url.port().is_none()) || dev.is_some_and(|dev| dev.origin() == url.origin()),
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(url: &str, dev: Option<&str>) -> bool {
        let dev = dev.map(|d| Url::parse(d).unwrap());
        is_app_url(&Url::parse(url).unwrap(), dev.as_ref())
    }

    #[test]
    fn only_the_app() {
        for url in ["tauri://localhost/", "tauri://localhost/index.html#/c/1", "http://tauri.localhost/", "https://tauri.localhost/p/x", "about:blank", "about:srcdoc"] {
            assert!(allowed(url, None), "{url}");
        }
        for url in [
            "https://evil.example/login",
            "http://tauri.localhost.evil.example/",
            "http://tauri.localhost:8080/",
            "tauri://evil/",
            "file:///Users/me/Downloads/page.html",
            "blob:tauri://localhost/0f9c",
            "data:text/html,<h1>x</h1>",
            "javascript:alert(1)",
            "chikuwachat://sso?ticket=x",
            "about:config",
            "http://localhost:1420/",
        ] {
            assert!(!allowed(url, None), "{url}");
        }
    }

    #[test]
    fn the_dev_server_in_a_development_build() {
        assert!(allowed("http://localhost:1420/", Some("http://localhost:1420")));
        assert!(allowed("http://localhost:1420/src/main.tsx", Some("http://localhost:1420/")));
        assert!(!allowed("http://localhost:1421/", Some("http://localhost:1420")));
        assert!(!allowed("https://evil.example/", Some("http://localhost:1420")));
    }
}
