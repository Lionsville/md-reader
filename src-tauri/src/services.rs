//! macOS Finder integration via the Services menu ("Open in MD Reader" on files & folders).
//!
//! The service is declared statically in `src-tauri/Info.plist` (`NSServices`: message
//! `openInMDReader`, send types = folders + markdown UTIs). At launch we register an
//! Objective-C object as the application's services provider; AppKit then calls
//! `-openInMDReader:userData:error:` on the main thread with a pasteboard holding the
//! selected file URLs. If the app isn't running, macOS launches it first.
//!
//! In Finder the item shows up under right-click › Quick Actions / Services (the user may need
//! to enable it once in System Settings › Keyboard › Keyboard Shortcuts › Services › Files and
//! Folders; see docs/INSTALL.md).

use std::path::PathBuf;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{define_class, msg_send, ClassType, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{NSApplication, NSPasteboard, NSPasteboardURLReadingFileURLsOnlyKey, NSUpdateDynamicServices};
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString, NSURL};

pub struct Ivars {
    app: tauri::AppHandle,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and we don't implement Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MDReaderServicesProvider"]
    #[ivars = Ivars]
    struct ServicesProvider;

    impl ServicesProvider {
        /// `- (void)openInMDReader:(NSPasteboard *)pboard userData:(NSString *)userData error:(NSString **)error`
        #[unsafe(method(openInMDReader:userData:error:))]
        fn open_in_md_reader(&self, pboard: &NSPasteboard, _user_data: Option<&NSString>, _error: *mut *mut NSString) {
            let paths = file_paths(pboard);
            if paths.is_empty() {
                return;
            }
            let app = &self.ivars().app;
            for path in paths {
                let _ = crate::open_reader_window(app, Some(&path));
            }
            // A service request doesn't activate the provider; bring the new windows forward.
            #[allow(deprecated)] // `activate()` is macOS 14+, we support 11+.
            NSApplication::sharedApplication(self.mtm()).activateIgnoringOtherApps(true);
        }
    }
);

impl ServicesProvider {
    fn new(mtm: MainThreadMarker, app: tauri::AppHandle) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(Ivars { app });
        // SAFETY: plain NSObject initializer.
        unsafe { msg_send![super(this), init] }
    }
}

/// File URLs (files and folders) on the service pasteboard, as paths that exist.
fn file_paths(pboard: &NSPasteboard) -> Vec<PathBuf> {
    let classes = NSArray::from_slice(&[NSURL::class()]);
    let yes = NSNumber::new_bool(true);
    // SAFETY: reading an AppKit-provided constant.
    let key = unsafe { NSPasteboardURLReadingFileURLsOnlyKey };
    let options: Retained<NSDictionary<NSString, AnyObject>> = NSDictionary::from_slices(&[key], &[yes.as_ref()]);
    // SAFETY: the class array only contains NSURL (which implements NSPasteboardReading) and the
    // options dictionary uses a documented key with an NSNumber value.
    let Some(objects) = (unsafe { pboard.readObjectsForClasses_options(&classes, Some(&options)) }) else {
        return Vec::new();
    };
    objects
        .iter()
        .filter_map(|obj| obj.downcast::<NSURL>().ok())
        .filter_map(|url| url.to_file_path())
        .filter(|p| p.exists())
        .collect()
}

/// Registers the services provider. Called once from `setup` (main thread) on macOS.
pub fn register(app: &tauri::AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let provider = ServicesProvider::new(mtm, app.clone());
    let nsapp = NSApplication::sharedApplication(mtm);
    let obj: &AnyObject = &provider;
    // SAFETY: `provider` implements the selector declared as NSMessage in Info.plist.
    unsafe { nsapp.setServicesProvider(Some(obj)) };
    // The provider must live for the whole process; AppKit doesn't retain it for us.
    std::mem::forget(provider);
    // Ask the pasteboard server to pick up our NSServices entry (it otherwise does so lazily,
    // e.g. after the app was first copied to /Applications). Cheap and asynchronous.
    NSUpdateDynamicServices();
}
