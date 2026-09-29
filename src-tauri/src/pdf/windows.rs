//! Windows: print the window's WebView2 straight into a PDF file with
//! `ICoreWebView2_7::PrintToPdf` (WebView2 runtime ≥ 1.0.1020, which every supported runtime is).
//!
//! UNTESTED on real hardware at the time of writing; written against webview2-com 0.39 /
//! windows 0.62 (the versions wry uses).

use std::path::Path;
use std::time::Duration;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment6, ICoreWebView2_7, COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE,
    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT,
};
use webview2_com::PrintToPdfCompletedHandler;
use ::windows::core::{Interface, HSTRING};

type Done = std::sync::mpsc::Sender<Result<(), String>>;

const MM_PER_INCH: f64 = 25.4;

/// Runs on the UI thread (inside `with_webview`); completion arrives on the UI thread too.
fn start(pw: &tauri::webview::PlatformWebview, out: &str, w_mm: f64, h_mm: f64, done: Done) -> ::windows::core::Result<()> {
    unsafe {
        let webview = pw.controller().CoreWebView2()?;
        let webview7: ICoreWebView2_7 = webview.cast()?;
        let env6: ICoreWebView2Environment6 = pw.environment().cast()?;

        let settings = env6.CreatePrintSettings()?;
        // Page width/height describe the sheet in portrait; orientation rotates it.
        let landscape = w_mm > h_mm;
        let (short_mm, long_mm) = if landscape { (h_mm, w_mm) } else { (w_mm, h_mm) };
        settings.SetOrientation(if landscape {
            COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
        } else {
            COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
        })?;
        settings.SetPageWidth(short_mm / MM_PER_INCH)?;
        settings.SetPageHeight(long_mm / MM_PER_INCH)?;
        settings.SetMarginTop(0.0)?;
        settings.SetMarginBottom(0.0)?;
        settings.SetMarginLeft(0.0)?;
        settings.SetMarginRight(0.0)?;
        settings.SetScaleFactor(1.0)?;
        settings.SetShouldPrintBackgrounds(true)?;
        settings.SetShouldPrintHeaderAndFooter(false)?;
        settings.SetShouldPrintSelectionOnly(false)?;

        let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
            let _ = done.send(match result {
                Ok(()) if ok => Ok(()),
                Ok(()) => Err("WebView2 could not write the PDF".into()),
                Err(e) => Err(format!("WebView2 PrintToPdf failed: {e}")),
            });
            Ok(())
        }));
        let path = HSTRING::from(out);
        webview7.PrintToPdf(&path, &settings, &handler)?;
    }
    Ok(())
}

pub async fn print(window: &tauri::WebviewWindow, out: &Path, w_mm: f64, h_mm: f64) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let out_str = out.to_string_lossy().into_owned();
    let err_tx = tx.clone();
    window
        .with_webview(move |pw| {
            if let Err(e) = start(&pw, &out_str, w_mm, h_mm, tx) {
                let _ = err_tx.send(Err(format!("WebView2 PrintToPdf failed: {e}")));
            }
        })
        .map_err(|e| e.to_string())?;
    super::wait_for(rx, Duration::from_secs(600)).await?;
    if std::fs::metadata(out).map(|m| m.len() > 0).unwrap_or(false) {
        Ok(())
    } else {
        Err("the PDF file was not written".into())
    }
}
