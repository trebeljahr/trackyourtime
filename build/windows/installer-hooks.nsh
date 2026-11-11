; Track Your Time NSIS installer hooks (bundle.windows.nsis.installerHooks,
; set by scripts/lib/desktop-tauri.mjs). Included by the Tauri NSIS template.
;
; Moves the Electron build (v0.3.0 and earlier) out of the way before this
; installer writes the Tauri one. The two never shared a folder or a registry
; key: electron-builder installed per user into
; %LOCALAPPDATA%\Programs\trackyourtime and wrote its uninstall entry under
; HKCU\...\Uninstall\<UUID v5 of the app id>, while Tauri installs into
; %LOCALAPPDATA%\Track Your Time under its own key. Without this, an Electron
; install updated by electron-updater (which runs this installer with /S) would
; leave the old app, its Start menu and desktop shortcuts and its "Apps &
; features" entry beside the new one, both named Track Your Time.
;
; The GUID is pinned by scripts/lib/desktop-release.test.mjs against
; electronUninstallKeys(), which derives it the way app-builder-lib's
; NsisTarget did: UUID.v5("com.ricoslabs.trackyourtime",
; "50e065bc-3134-11e6-9bab-38c9862bdaf3").
;
; The old uninstaller is run the way electron-builder's own installer ran it
; when it replaced a previous version (installUtil.nsh, uninstallOldVersion):
; copied out of the folder it deletes, silent, per user, with --updated and
; /KEEP_APP_DATA. Those two are what keep %APPDATA%\trackyourtime — the
; profile, the offline queue, the session — which the Tauri app reads in place.
; The uninstaller removes the old shortcuts; this installer then creates its
; own, under the same names.
;
; It runs before the Tauri installer's own "is the app running" check, and the
; Electron uninstaller stops a running "Track Your Time.exe" on its own when it
; is silent, which is what electron-updater expects: the Electron app is
; quitting when it starts this installer.

!define TYT_ELECTRON_GUID "df978d67-ddd6-5da4-9e68-d9dbb1f39138"
!define TYT_ELECTRON_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${TYT_ELECTRON_GUID}"
!define TYT_ELECTRON_INSTALL_KEY "Software\${TYT_ELECTRON_GUID}"

!macro NSIS_HOOK_PREINSTALL
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4

  ReadRegStr $0 HKCU "${TYT_ELECTRON_UNINSTALL_KEY}" "UninstallString"
  ${If} $0 != ""
    ; UninstallString is `"<folder>\Uninstall Track Your Time.exe" /currentuser`:
    ; $1 is the path between the quotes.
    StrCpy $1 ""
    StrCpy $3 $0 1
    ${If} $3 == '"'
      StrCpy $2 1
      ${Do}
        StrCpy $3 $0 1 $2
        ${If} $3 == '"'
        ${OrIf} $3 == ""
          ${ExitDo}
        ${EndIf}
        StrCpy $1 "$1$3"
        IntOp $2 $2 + 1
      ${Loop}
    ${Else}
      StrCpy $1 $0
    ${EndIf}

    ; The folder it uninstalls: InstallLocation, else the uninstaller's own.
    ReadRegStr $4 HKCU "${TYT_ELECTRON_INSTALL_KEY}" "InstallLocation"
    ${If} $4 == ""
      StrLen $2 $1
      ${Do}
        IntOp $2 $2 - 1
        ${If} $2 < 0
          ${ExitDo}
        ${EndIf}
        StrCpy $3 $1 1 $2
        ${If} $3 == "\"
          StrCpy $4 $1 $2
          ${ExitDo}
        ${EndIf}
      ${Loop}
    ${EndIf}

    ${If} ${FileExists} "$1"
    ${AndIf} $4 != ""
      DetailPrint "Removing the previous (Electron) version of Track Your Time from $4"
      InitPluginsDir
      CopyFiles /SILENT "$1" "$PLUGINSDIR\tyt-electron-uninstall.exe"
      ClearErrors
      ExecWait '"$PLUGINSDIR\tyt-electron-uninstall.exe" /S /KEEP_APP_DATA /currentuser --updated _?=$4' $2
      ${If} ${Errors}
        DetailPrint "The previous version's uninstaller could not be started; it stays installed beside this one."
      ${Else}
        DetailPrint "The previous version's uninstaller exited with $2."
      ${EndIf}
    ${Else}
      ; An entry whose uninstaller is gone: drop the entry, keep the profile.
      DeleteRegKey HKCU "${TYT_ELECTRON_UNINSTALL_KEY}"
      DeleteRegKey HKCU "${TYT_ELECTRON_INSTALL_KEY}"
    ${EndIf}
  ${EndIf}

  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
