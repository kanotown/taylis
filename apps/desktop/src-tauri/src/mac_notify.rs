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

use std::ffi::c_void;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_foundation::{NSArray, NSBundle, NSData, NSError, NSObject, NSObjectProtocol, NSString, NSURL};
use objc2_intents::{
    INImage, INInteraction, INInteractionDirection, INOutgoingMessageType, INPerson, INPersonHandle, INPersonHandleType,
    INSendMessageIntent, INSpeakableString,
};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationAttachment, UNNotificationContent, UNNotificationDefaultActionIdentifier,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse, UNNotificationSettings,
    UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
};
use tauri::{AppHandle, Emitter};

use crate::{notify_avatar, NotificationPerson};

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

/// Show one notification. `id` names it for the click (`notification-clicked`). A message's notification (`person`)
/// shows its sender's picture: as a communication notification where Taylis is entitled to (the picture large, the app's
/// icon small at its corner, like Messages or Slack), else as an attachment (a thumbnail at the right). Runs off the
/// calling thread (a command handler): the donation is waited for briefly, the file written. `epoch`
/// (notify_avatar::current_epoch, read when asked): after a sign-out nothing is written or shown.
pub fn send(app: &AppHandle, epoch: u64, id: String, title: String, body: String, person: Option<NotificationPerson>) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if notify_avatar::current_epoch() != epoch {
            return;
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&title));
        content.setBody(&NSString::from_str(&body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let mut shown: Option<Retained<UNNotificationContent>> = None;
        if let Some(person) = &person {
            match communication_content(&content, person) {
                Some(updated) => shown = Some(updated),
                None => {
                    // As written (the body with 「名前: 」), the picture beside it (attached below).
                    content.setTitle(&NSString::from_str(&title));
                    content.setSubtitle(&NSString::from_str(""));
                    content.setBody(&NSString::from_str(&body));
                }
            }
        }
        // The picture's file and the request only while no sign-out came meanwhile (it waits for this, then clears).
        notify_avatar::while_current(epoch, || {
            let shown = shown.unwrap_or_else(|| {
                let picture = person.as_ref().and_then(|person| notify_avatar::file(&app, person));
                if let Some(attachment) = picture.and_then(|file| attachment(&file, &id)) {
                    content.setAttachments(&NSArray::from_retained_slice(&[attachment]));
                }
                content.clone().into_super()
            });
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&id), &shown, None);
            let done = RcBlock::new(|error: *mut NSError| {
                if !error.is_null() {
                    // SAFETY: non-null, valid for the duration of the call.
                    eprintln!("could not show the notification: {}", unsafe { &*error }.localizedDescription());
                }
            });
            UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, Some(&done));
        });
    });
}

const COMMUNICATION_ENTITLEMENT: &str = "com.apple.developer.usernotifications.communication";

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecTaskCreateFromSelf(allocator: *const c_void) -> *mut c_void;
    fn SecTaskCopyValueForEntitlement(task: *mut c_void, entitlement: *const c_void, error: *mut *mut c_void) -> *const c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFBooleanTrue: *const c_void;
    fn CFRelease(cf: *const c_void);
}

/// Whether this build is signed with the Communication Notifications entitlement (a release built with the Developer ID
/// provisioning profile that grants it, docs/PUSH_NOTIFICATIONS.md §9.1). Without it macOS does not turn the content
/// into a communication notification, so the attachment is used instead.
fn communication_entitled() -> bool {
    static ENTITLED: OnceLock<bool> = OnceLock::new();
    *ENTITLED.get_or_init(|| {
        if !objc2::available!(macos = 12.0) {
            return false;
        }
        let name = NSString::from_str(COMMUNICATION_ENTITLEMENT);
        // SAFETY: Security's documented calls on this process' own task; NSString is toll-free bridged with CFString;
        // every object copied / created here is released once.
        unsafe {
            let task = SecTaskCreateFromSelf(std::ptr::null());
            if task.is_null() {
                return false;
            }
            let value = SecTaskCopyValueForEntitlement(task, Retained::as_ptr(&name).cast(), std::ptr::null_mut());
            let entitled = !value.is_null() && value == kCFBooleanTrue;
            if !value.is_null() {
                CFRelease(value);
            }
            CFRelease(task);
            entitled
        }
    })
}

/// The content as a communication notification (macOS 12+, entitled): an incoming `INSendMessageIntent` from the sender
/// (`INPerson` with the picture), donated, then `contentByUpdatingWithProvider:`, as the iOS app's Notification
/// Service Extension does (apps/ios/ChikuwaChat/Platform/CommunicationNotification.swift). A channel or group DM is a
/// group conversation (its title, the sender's name above the text); a DM is the sender's conversation. None when not
/// entitled or macOS refuses (the caller restores the content and attaches the picture).
fn communication_content(content: &UNMutableNotificationContent, person: &NotificationPerson) -> Option<Retained<UNNotificationContent>> {
    if !communication_entitled() {
        return None;
    }
    let picture = person
        .avatar_png
        .as_deref()
        .filter(|png| notify_avatar::acceptable_png(png))
        // SAFETY: INImage copies the data.
        .map(|png| unsafe { INImage::imageWithImageData(&NSData::with_bytes(png)) });
    let ns = |text: &str| NSString::from_str(text);
    // SAFETY (the Intents initialisers below): plain value objects, all arguments valid for the call.
    let sender = unsafe {
        INPerson::initWithPersonHandle_nameComponents_displayName_image_contactIdentifier_customIdentifier(
            INPerson::alloc(),
            &INPersonHandle::initWithValue_type(INPersonHandle::alloc(), Some(&ns(&person.id)), INPersonHandleType::Unknown),
            None,
            Some(&ns(&person.name)),
            picture.as_deref(),
            None,
            Some(&ns(&person.id)),
        )
    };
    let group = person.group_name.as_deref().filter(|name| !name.trim().is_empty());
    let recipients = group.map(|name| {
        let channel = format!("channel:{}", person.conversation_id);
        let me = unsafe {
            INPerson::initWithPersonHandle_nameComponents_displayName_image_contactIdentifier_customIdentifier_isMe(
                INPerson::alloc(),
                &INPersonHandle::initWithValue_type(INPersonHandle::alloc(), Some(&ns("me")), INPersonHandleType::Unknown),
                None,
                None,
                None,
                None,
                Some(&ns("me")),
                true,
            )
        };
        let others = unsafe {
            INPerson::initWithPersonHandle_nameComponents_displayName_image_contactIdentifier_customIdentifier(
                INPerson::alloc(),
                &INPersonHandle::initWithValue_type(INPersonHandle::alloc(), Some(&ns(&channel)), INPersonHandleType::Unknown),
                None,
                Some(&ns(name)),
                None,
                None,
                Some(&ns(&channel)),
            )
        };
        NSArray::from_retained_slice(&[me, others])
    });
    let group_name = group.map(|name| unsafe { INSpeakableString::initWithSpokenPhrase(INSpeakableString::alloc(), &ns(name)) });
    let intent = unsafe {
        INSendMessageIntent::initWithRecipients_outgoingMessageType_content_speakableGroupName_conversationIdentifier_serviceName_sender_attachments(
            INSendMessageIntent::alloc(),
            recipients.as_deref(),
            INOutgoingMessageType::OutgoingMessageText,
            Some(&ns(&person.text)),
            group_name.as_deref(),
            Some(&ns(&person.conversation_id)),
            None,
            Some(&sender),
            None,
        )
    };
    let interaction = unsafe { INInteraction::initWithIntent_response(INInteraction::alloc(), &intent, None) };
    unsafe { interaction.setDirection(INInteractionDirection::Incoming) };
    // The donation tells macOS about the conversation; wait for it briefly (as the iOS extension awaits it).
    let (tx, rx) = mpsc::channel();
    let donated = RcBlock::new(move |error: *mut NSError| {
        if !error.is_null() {
            // SAFETY: non-null, valid for the duration of the call.
            eprintln!("could not donate the conversation: {}", unsafe { &*error }.localizedDescription());
        }
        let _ = tx.send(());
    });
    unsafe { interaction.donateInteractionWithCompletion(Some(&donated)) };
    let _ = rx.recv_timeout(Duration::from_secs(2));
    // A communication notification names the sender itself: the title is the conversation (a channel) or the sender (a
    // DM, already), the sender's name the subtitle in a group, and the body the text alone.
    if group.is_some() {
        content.setSubtitle(&ns(&person.name));
    }
    content.setBody(&ns(&person.text));
    // SAFETY: INSendMessageIntent conforms to UNNotificationContentProviding (Intents' UserNotifications category);
    // objc2-intents does not declare the conformance, so the method is sent directly.
    let updated: Result<Retained<UNNotificationContent>, Retained<NSError>> =
        unsafe { msg_send![&**content, contentByUpdatingWithProvider: &*intent, error: _] };
    match updated {
        Ok(updated) => Some(updated),
        Err(error) => {
            eprintln!("not a communication notification: {}", error.localizedDescription());
            None
        }
    }
}

/// The picture as an attachment (a thumbnail at the right of the banner). macOS moves the attached file into its own
/// store, so a one-use copy of the cached picture is attached.
fn attachment(file: &std::path::Path, id: &str) -> Option<Retained<UNNotificationAttachment>> {
    let copy = notify_avatar::one_use_copy(file, id)?;
    let url = NSURL::from_file_path(&copy)?;
    // SAFETY: a file URL to a PNG we just wrote; no options.
    match unsafe { UNNotificationAttachment::attachmentWithIdentifier_URL_options_error(&NSString::from_str("avatar"), &url, None) } {
        Ok(attachment) => Some(attachment),
        Err(error) => {
            eprintln!("could not attach the picture: {}", error.localizedDescription());
            let _ = std::fs::remove_file(copy);
            None
        }
    }
}

/// Sign-out: take our notifications off the screen and out of Notification Center.
pub fn clear() {
    UNUserNotificationCenter::currentNotificationCenter().removeAllDeliveredNotifications();
}
