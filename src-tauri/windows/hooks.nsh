; MD Reader - NSIS installer hooks.
;
; Included near the top of Tauri's installer.nsi via `bundle.windows.nsis.installerHooks`.
; Tauri calls these macros (all optional):
;   NSIS_HOOK_PREINSTALL    before files/registry/shortcuts are written
;   NSIS_HOOK_POSTINSTALL   after files, registry keys (incl. file associations) and shortcuts
;   NSIS_HOOK_PREUNINSTALL  before files/registry/shortcuts are removed
;   NSIS_HOOK_POSTUNINSTALL after they have been removed
;
; Everything is written under SHCTX, which the Tauri template points at HKCU for per-user
; installs (installMode "currentUser", our default) and at HKLM for per-machine installs.
; `${MAINBINARYNAME}` / `${PRODUCTNAME}` are defined by installer.nsi *after* this file is
; included, so they are only referenced inside macro bodies (expanded at insert time).
;
; Explorer integration added here:
;   * "Open with MD Reader" on folders            (Directory\shell\MDReader, %1)
;   * "Open with MD Reader" on folder background  (Directory\Background\shell\MDReader, %V)
;   * "Open with MD Reader" on markdown files     (SystemFileAssociations\.<ext>\shell\MDReader)
;     - shown even when another app is the default for .md
;   * .<ext>\OpenWithProgids + Applications\<exe> so MD Reader is listed in "Open with" and
;     in Settings > Default apps
;   * the markdown document icon for Tauri's MDReader.Markdown ProgID
; On Windows 11 these classic verbs appear under "Show more options" (Shift+F10); the compact
; menu only lists IExplorerCommand handlers from packaged (MSIX / sparse-package) apps.

!define MDR_VERB "MDReader"
!define MDR_PROGID "MDReader.Markdown"
!define MDR_MENU_TEXT "Open with MD Reader"

; Must match bundle.fileAssociations[].ext in tauri.conf.json.
!macro MDR_FOR_EACH_EXT MACRO
  !insertmacro ${MACRO} "md"
  !insertmacro ${MACRO} "markdown"
  !insertmacro ${MACRO} "mdown"
  !insertmacro ${MACRO} "mkd"
  !insertmacro ${MACRO} "mkdn"
  !insertmacro ${MACRO} "mdwn"
  !insertmacro ${MACRO} "mdx"
!macroend

!macro MDR_ADD_EXT EXT
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\${MDR_VERB}" "" "${MDR_MENU_TEXT}"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\${MDR_VERB}" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\${MDR_VERB}\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${MDR_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".${EXT}" ""
!macroend

!macro MDR_REMOVE_EXT EXT
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell\${MDR_VERB}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\SystemFileAssociations\.${EXT}\shell"
  DeleteRegKey /ifempty SHCTX "Software\Classes\SystemFileAssociations\.${EXT}"
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${MDR_PROGID}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}\OpenWithProgids"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Folders
  WriteRegStr SHCTX "Software\Classes\Directory\shell\${MDR_VERB}" "" "${MDR_MENU_TEXT}"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\${MDR_VERB}" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Directory\shell\${MDR_VERB}\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  ; Folder background (right-click on empty space inside a folder window)
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\${MDR_VERB}" "" "${MDR_MENU_TEXT}"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\${MDR_VERB}" "Icon" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Directory\Background\shell\${MDR_VERB}\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%V$\""

  ; Markdown files (+ "Open with" registration)
  !insertmacro MDR_FOR_EACH_EXT MDR_ADD_EXT
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",0"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""

  ; Document icon for the ProgID that Tauri's file association created (document.ico is
  ; installed next to the exe via bundle.resources in tauri.windows.conf.json).
  ${If} ${FileExists} "$INSTDIR\document.ico"
    WriteRegStr SHCTX "Software\Classes\${MDR_PROGID}\DefaultIcon" "" "$\"$INSTDIR\document.ico$\""
  ${EndIf}

  ; Tell Explorer that associations changed so icons/menus refresh without a sign-out.
  !insertmacro UPDATEFILEASSOC
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\Directory\shell\${MDR_VERB}"
  DeleteRegKey SHCTX "Software\Classes\Directory\Background\shell\${MDR_VERB}"
  !insertmacro MDR_FOR_EACH_EXT MDR_REMOVE_EXT
  DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro UPDATEFILEASSOC
!macroend
