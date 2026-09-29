//! macOS: print the window's WKWebView straight into a PDF file with an NSPrintOperation.
//!
//! WKWebView only prints correctly through `runOperationModalForWindow:…` (a synchronous
//! `runOperation` yields blank pages because WebKit renders the pages asynchronously in the web
//! content process), and the operation's view needs a non-empty frame.

use std::cell::RefCell;
use std::ffi::c_void;
use std::path::Path;
use std::sync::mpsc::Sender;
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject};
use objc2::{define_class, msg_send, sel, AnyThread, DefinedClass, MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSPaperOrientation, NSPrintInfo, NSPrintJobSavingURL, NSPrintOperation, NSPrintSaveJob, NSWindow,
};
use objc2_foundation::{NSObjectProtocol, NSSize, NSString, NSURL};
use objc2_web_kit::WKWebView;

type Done = Sender<Result<(), String>>;

pub struct DelegateIvars {
    done: RefCell<Option<Done>>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and we don't implement Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "MDReaderPdfPrintDelegate"]
    #[ivars = DelegateIvars]
    struct PrintDelegate;

    unsafe impl NSObjectProtocol for PrintDelegate {}

    impl PrintDelegate {
        // - (void)printOperationDidRun:(NSPrintOperation *)op success:(BOOL)ok contextInfo:(void *)ctx
        #[unsafe(method(printOperationDidRun:success:contextInfo:))]
        fn did_run(&self, _op: &NSPrintOperation, success: Bool, _ctx: *mut c_void) {
            if let Some(tx) = self.ivars().done.borrow_mut().take() {
                let _ = tx.send(if success.as_bool() { Ok(()) } else { Err("printing was cancelled or failed".into()) });
            }
        }
    }
);

impl PrintDelegate {
    fn new(mtm: MainThreadMarker, done: Done) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(DelegateIvars { done: RefCell::new(Some(done)) });
        unsafe { msg_send![super(this), init] }
    }
}

thread_local! {
    // The running operation and its delegate must outlive `runOperationModalForWindow`; they
    // are released when the next export starts.
    static CURRENT: RefCell<Option<(Retained<PrintDelegate>, Retained<NSPrintOperation>)>> = const { RefCell::new(None) };
}

const MM_TO_PT: f64 = 72.0 / 25.4;

/// Runs on the main thread (inside `with_webview`).
fn start(webview: &WKWebView, out: &Path, w_mm: f64, h_mm: f64, done: Done) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("not on the main thread")?;
    let ns_window: Retained<NSWindow> = webview.window().ok_or("webview has no window")?;

    let info: Retained<NSPrintInfo> = NSPrintInfo::init(NSPrintInfo::alloc());
    let (w_pt, h_pt) = (w_mm * MM_TO_PT, h_mm * MM_TO_PT);
    info.setPaperSize(NSSize::new(w_pt, h_pt));
    info.setOrientation(if w_pt > h_pt { NSPaperOrientation::Landscape } else { NSPaperOrientation::Portrait });
    // setOrientation may swap the paper dimensions; re-apply the exact size.
    info.setPaperSize(NSSize::new(w_pt, h_pt));
    info.setTopMargin(0.0);
    info.setBottomMargin(0.0);
    info.setLeftMargin(0.0);
    info.setRightMargin(0.0);
    info.setHorizontallyCentered(false);
    info.setVerticallyCentered(false);
    // Pagination and scaling stay at their defaults: WebKit scales the document width to the
    // paper width and cuts pages every paperHeight/paperWidth × width px (see export-build.js).
    unsafe {
        info.setJobDisposition(NSPrintSaveJob);
        let url = NSURL::fileURLWithPath(&NSString::from_str(&out.to_string_lossy()));
        let dict = info.dictionary();
        let key: &NSString = NSPrintJobSavingURL;
        dict.insert(key, &*Retained::into_super(Retained::into_super(url)));
    }

    let op: Retained<NSPrintOperation> = unsafe { webview.printOperationWithPrintInfo(&info) };
    op.setShowsPrintPanel(false);
    op.setShowsProgressPanel(false);
    if let Some(view) = op.view() {
        // Without a frame WebKit produces empty pages.
        view.setFrame(webview.bounds());
    }

    let delegate = PrintDelegate::new(mtm, done);
    CURRENT.with(|c| *c.borrow_mut() = Some((delegate.clone(), op.clone())));
    unsafe {
        let d: &AnyObject = &delegate;
        op.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            &ns_window,
            Some(d),
            Some(sel!(printOperationDidRun:success:contextInfo:)),
            std::ptr::null_mut(),
        );
    }
    Ok(())
}

pub async fn print(window: &tauri::WebviewWindow, out: &Path, w_mm: f64, h_mm: f64) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let out_buf = out.to_path_buf();
    let err_tx = tx.clone();
    // `with_webview` runs the closure on the main thread.
    window
        .with_webview(move |pw| {
            let ptr = pw.inner() as *const WKWebView;
            if ptr.is_null() {
                let _ = err_tx.send(Err("no webview".into()));
                return;
            }
            let webview: &WKWebView = unsafe { &*ptr };
            if let Err(e) = start(webview, &out_buf, w_mm, h_mm, tx) {
                let _ = err_tx.send(Err(e));
            }
        })
        .map_err(|e| e.to_string())?;
    super::wait_for(rx, Duration::from_secs(600)).await?;

    // The delegate fires when the job has been handed off; make sure the file is really there.
    for _ in 0..100 {
        if std::fs::metadata(out).map(|m| m.len() > 0).unwrap_or(false) {
            return Ok(());
        }
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(50))).await.ok();
    }
    Err("the PDF file was not written".into())
}
