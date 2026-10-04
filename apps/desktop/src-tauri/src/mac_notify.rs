//! macOS notifications through UNUserNotificationCenter (docs/PUSH_NOTIFICATIONS.md §9.1).
//!
//! tauri-plugin-notification shows desktop notifications with notify-rust → mac-notification-sys, which uses the
//! deprecated NSUserNotificationCenter. Its delegate does not implement `shouldPresentNotification:`, so macOS files a
//! notification silently in Notification Center whenever the app is frontmost: the settings' test notification and every
//! message in another channel while Taylis is in front never showed a banner. Here our own delegate answers
//! `willPresentNotification:` with banner + list + sound, the permission is UNUserNotificationCenter's own (the settings
//! show what System Settings say), and a click brings the window up and tells the page (`notification-clicked`).
//!
//! UNUserNotificationCenter needs an app bundle: `currentNotificationCenter` throws for a bare binary (`tauri dev`). There
//! `available()` is false and the page keeps using the plugin (platform/notify.ts).
//!
//! Threads: UNUserNotificationCenter may be used from any thread, and its completion handlers run on a queue of its own;
//! they only send on a channel (`wait`). The delegate's methods only call thread-safe Tauri APIs (window show / focus are
//! posted to the event loop, `emit`). A build that macOS does not allow to notify (an unsigned / ad-hoc one may be
//! refused) reads as "denied", never as a crash.

use std::sync::mpsc;
use std::sync::OnceLock;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions, UNNotificationRequest,
    UNNotificationResponse, UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use tauri::{AppHandle, Emitter};

/// Set once in `init` when this process runs from an app bundle; `None` = use the plugin.
static DELEGATE: OnceLock<usize> = OnceLock::new();

struct Ivars {
    app: AppHandle,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "TaylisNotificationDelegate"]
    #[ivars = Ivars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        /// The app is frontmost: show the banner anyway (the page decides what is worth a notification).
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler.call((presentation_options(),));
        }

        /// A click on the banner (or the entry in Notification Center): the window comes up, the page runs its action.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            // SAFETY: an extern static of the framework, always set.
            let default_action = unsafe { UNNotificationDefaultActionIdentifier };
            if response.actionIdentifier().isEqualToString(default_action) {
                let app = &self.ivars().app;
                crate::show_main_window(app);
                let id = response.notification().request().identifier().to_string();
                if let Err(err) = app.emit("notification-clicked", id) {
                    eprintln!("could not report the notification click: {err}");
                }
            }
            handler.call(());
        }
    }
);

#[allow(deprecated)] // Alert is what macOS 10.15 and earlier know; Banner / List exist from 11.
fn presentation_options() -> UNNotificationPresentationOptions {
    if objc2::available!(macos = 11.0) {
        UNNotificationPresentationOptions::Banner
            | UNNotificationPresentationOptions::List
            | UNNotificationPresentationOptions::Sound
    } else {
        UNNotificationPresentationOptions::Alert | UNNotificationPresentationOptions::Sound
    }
}

/// Running from an app bundle (the built Taylis.app) on macOS 10.14 or later, where UNUserNotificationCenter exists and
/// works. `tauri dev` embeds the Info.plist in the bare binary, so a bundle identifier alone does not tell.
fn in_app_bundle() -> bool {
    if !objc2::available!(macos = 10.14) {
        return false;
    }
    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
}

/// At start-up (the delegate has to be there before a click can launch or reach the app).
pub fn init(app: &AppHandle) {
    if !in_app_bundle() {
        return;
    }
    let delegate = Delegate::alloc().set_ivars(Ivars { app: app.clone() });
    // SAFETY: NSObject's init on a freshly allocated object.
    let delegate: Retained<Delegate> = unsafe { msg_send![super(delegate), init] };
    UNUserNotificationCenter::currentNotificationCenter().setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center holds its delegate weakly: this one lives as long as the process.
    let _ = DELEGATE.set(Retained::into_raw(delegate) as usize);
}

pub fn available() -> bool {
    DELEGATE.get().is_some()
}

fn status_name(status: UNAuthorizationStatus) -> &'static str {
    match status {
        UNAuthorizationStatus::NotDetermined => "default",
        UNAuthorizationStatus::Denied => "denied",
        _ => "granted", // authorized, provisional, ephemeral
    }
}

/// "granted" / "denied" / "default" from System Settings.
pub async fn permission() -> Result<String, String> {
    let (tx, rx) = mpsc::channel();
    {
        let block = RcBlock::new(move |settings: std::ptr::NonNull<UNNotificationSettings>| {
            // SAFETY: the framework hands a valid settings object for the duration of the call.
            let status = unsafe { settings.as_ref() }.authorizationStatus();
            let _ = tx.send(status_name(status));
        });
        UNUserNotificationCenter::currentNotificationCenter().getNotificationSettingsWithCompletionHandler(&block);
    }
    wait(rx).await
}

/// Ask (the first time, macOS shows its prompt), then say what was decided.
pub async fn request_permission() -> Result<String, String> {
    let (tx, rx) = mpsc::channel();
    {
        let block = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            if !error.is_null() {
                // SAFETY: non-null, valid for the duration of the call.
                eprintln!("notification authorization failed: {}", unsafe { &*error }.localizedDescription());
            }
            let _ = tx.send(if granted.as_bool() { "granted" } else { "denied" });
        });
        UNUserNotificationCenter::currentNotificationCenter().requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &block,
        );
    }
    wait(rx).await
}

/// The completion handlers run on the framework's queue; wait for them off the async runtime's threads.
async fn wait(rx: mpsc::Receiver<&'static str>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map(str::to_owned)
        .map_err(|_| "the notification center did not answer".to_owned())
}

/// Show one notification now. `id` names it for the click (`notification-clicked`).
pub fn send(id: &str, title: &str, body: &str) {
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(title));
    content.setBody(&NSString::from_str(body));
    content.setSound(Some(&UNNotificationSound::defaultSound()));
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(id), &content, None);
    let done = RcBlock::new(|error: *mut NSError| {
        if !error.is_null() {
            // SAFETY: non-null, valid for the duration of the call.
            eprintln!("could not show the notification: {}", unsafe { &*error }.localizedDescription());
        }
    });
    UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, Some(&done));
}

/// Sign-out: take our notifications off the screen and out of Notification Center.
pub fn clear() {
    UNUserNotificationCenter::currentNotificationCenter().removeAllDeliveredNotifications();
}
