# Installing MD Reader

- [macOS](#macos) — install, make it the default for `.md`, Finder "Open in MD Reader"
- [Windows](#windows) — install, Explorer context menu, default app
- [Uninstalling](#uninstalling)
- [Troubleshooting](#troubleshooting)

## macOS

Requires macOS 11 (Big Sur) or later. The download is a single *universal* build that runs
natively on both Apple Silicon and Intel Macs.

1. Open `MD Reader_<version>_universal.dmg`.
2. Drag **MD Reader** onto the **Applications** folder.
3. Start it from Launchpad / Spotlight, or double-click a markdown file.

> **Unsigned test builds** (built without a Developer ID certificate) are blocked by Gatekeeper
> on first launch. Right-click the app › **Open** › **Open**, or run
> `xattr -dr com.apple.quarantine "/Applications/MD Reader.app"`. Released builds are signed and
> notarized and open normally.

### Open markdown files and folders

MD Reader registers itself for `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdwn` and `.mdx`
files, and for folders:

- **Double-click** a markdown file (once MD Reader is the default, see below).
- Right-click a file › **Open With** › **MD Reader**.
- **Drop** a file *or a folder* on the MD Reader icon in the Dock.
- From Terminal: `open -a "MD Reader" README.md` or `open -a "MD Reader" ~/notes`.

### Make MD Reader the default app for markdown

1. Select any `.md` file in Finder and press <kbd>⌘</kbd><kbd>I</kbd> (**Get Info**).
2. Under **Open with**, choose **MD Reader**.
3. Click **Change All…** and confirm.

Repeat for other extensions (e.g. `.markdown`) if you use them.

### Finder right-click: "Open in MD Reader" (Quick Actions / Services)

MD Reader adds an **Open in MD Reader** service for markdown files **and folders**. In Finder it
appears when you right-click a selection:

- under **Quick Actions** (macOS 13+ shows it there, sometimes under **Quick Actions › Customize…**), or
- under **Services** at the bottom of the context menu (older macOS / when there are many services).

macOS discovers the service after MD Reader has been in `/Applications` and launched once.
If it doesn't show up:

1. Open **System Settings › Keyboard › Keyboard Shortcuts… › Services**
   (macOS 12 and earlier: *System Preferences › Keyboard › Shortcuts › Services*).
2. Under **Files and Folders**, tick **Open in MD Reader**. You can also assign it a keyboard
   shortcut here.
3. Still missing? Log out and back in, or run
   `/System/Library/CoreServices/pbs -update` in Terminal to refresh the services cache.

Selecting several files/folders opens one window for each.

## Windows

Requires Windows 10 (1809+) or Windows 11, x64 (an ARM64 build is available on request).
MD Reader uses the Microsoft Edge **WebView2** runtime, which is preinstalled on Windows 11 and on
up-to-date Windows 10; if it is missing, the installer installs it (internet connection needed).

1. Run `MD Reader_<version>_x64-setup.exe`.
2. The installer is **per-user**: it installs to `%LOCALAPPDATA%\MD Reader` and needs **no
   administrator rights**.

> **Unsigned test builds** trigger a SmartScreen warning ("Windows protected your PC"):
> click **More info › Run anyway**. Signed release builds don't show this (or only briefly while
> a new certificate builds up reputation).

### Explorer context menu

The installer adds **Open with MD Reader** to Explorer's right-click menu for:

| Where you right-click | What opens |
|---|---|
| a markdown file (`.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdwn`, `.mdx`) | that file |
| a folder | the folder (sidebar with all its markdown files) |
| the empty background inside a folder window | the current folder |

**Windows 11:** the compact context menu only shows entries from packaged (Store/MSIX) apps, so
these entries are under **Show more options** (or press <kbd>Shift</kbd>+<kbd>F10</kbd>, or
<kbd>Shift</kbd>+right-click to go straight to the full menu).

### Make MD Reader the default app for markdown

The installer registers MD Reader for markdown files and adds it to the **Open with** list, but
Windows lets only *you* change the default:

- Right-click a `.md` file › **Open with** › **Choose another app** › pick **MD Reader** ›
  tick/click **Always**; or
- **Settings › Apps › Default apps** › search for `.md` › choose **MD Reader**.

### Command line

```bat
"%LOCALAPPDATA%\MD Reader\md-reader.exe" README.md
"%LOCALAPPDATA%\MD Reader\md-reader.exe" C:\path\to\notes
```

If MD Reader is already running, the path opens in a new window of the running instance.

## Uninstalling

- **macOS:** quit MD Reader and drag it from Applications to the Trash. Settings live in
  `~/Library/Application Support/nl.lionsville.mdreader` (user plugins in its `plugins` folder).
- **Windows:** *Settings › Apps › Installed apps › MD Reader › Uninstall*. This removes the
  context-menu entries and file associations too. Tick *Delete the application data* to also
  remove settings and plugins (`%APPDATA%\nl.lionsville.mdreader`).

## Troubleshooting

- **"Open in MD Reader" missing on macOS** — see the Services steps above. It only appears for
  markdown files and folders, not for other file types.
- **Double-click opens another app** — set the default app as described above; Windows and macOS
  never let an installer silently take over an existing default.
- **Context-menu entries missing on Windows** — they are per-user (`HKCU\Software\Classes`). If
  you installed as another user, re-run the installer as yourself. Restarting Explorer
  (Task Manager › Windows Explorer › Restart) refreshes menus immediately.
