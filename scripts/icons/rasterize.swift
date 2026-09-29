// Rasterize an SVG to a PNG with transparency, using the WebKit SVG engine
// (full SVG support incl. filters/gradients).
// Usage: swift rasterize.swift in.svg out.png [size | WIDTHxHEIGHT]   (default 1024)
import AppKit
import WebKit

let args = CommandLine.arguments
guard args.count >= 3 else {
    FileHandle.standardError.write("usage: rasterize.swift in.svg out.png [size]\n".data(using: .utf8)!)
    exit(2)
}
let svgURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])
let dims = (args.count > 3 ? args[3] : "1024").split(separator: "x").map { Int($0)! }
let width = dims[0]
let height = dims.count > 1 ? dims[1] : dims[0]

final class Snapper: NSObject, WKNavigationDelegate {
    let web: WKWebView
    override init() {
        let cfg = WKWebViewConfiguration()
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: cfg)
        web.setValue(false, forKey: "drawsBackground")
        super.init()
        web.navigationDelegate = self
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let cfg = WKSnapshotConfiguration()
        cfg.rect = NSRect(x: 0, y: 0, width: width, height: height)
        cfg.snapshotWidth = NSNumber(value: width)
        cfg.afterScreenUpdates = true
        webView.takeSnapshot(with: cfg) { image, error in
            guard let image = image else {
                FileHandle.standardError.write("snapshot failed: \(String(describing: error))\n".data(using: .utf8)!)
                exit(1)
            }
            let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                                       bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                       colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
            rep.size = NSSize(width: width, height: height)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            NSColor.clear.set()
            NSRect(x: 0, y: 0, width: width, height: height).fill()
            image.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
            NSGraphicsContext.restoreGraphicsState()
            try! rep.representation(using: .png, properties: [:])!.write(to: outURL)
            exit(0)
        }
    }
}

let app = NSApplication.shared
let svg = try! String(contentsOf: svgURL, encoding: .utf8)
let html = """
<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{display:block;width:\(width)px;height:\(height)px}</style></head><body>\(svg)</body></html>
"""
let snapper = Snapper()
snapper.web.loadHTMLString(html, baseURL: nil)
DispatchQueue.main.asyncAfter(deadline: .now() + 20) {
    FileHandle.standardError.write("timeout\n".data(using: .utf8)!)
    exit(1)
}
app.run()
