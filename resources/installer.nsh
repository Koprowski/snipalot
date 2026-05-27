; Snipalot NSIS customization (must live under buildResources = resources/).
; Keep the running-app check short. Long silent sleeps make Windows look
; frozen while launching/upgrading the setup EXE, especially when Defender
; is already scanning the unsigned installer.

!ifndef nsProcess::FindProcess
  !include "nsProcess.nsh"
!endif
!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  ${GetProcessInfo} 0 $pid $1 $2 $3 $4
  ${if} $3 != "${APP_EXECUTABLE_FILENAME}"
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${if} $R0 == 0
      ${if} ${isUpdated}
        Goto doStopProcess
      ${endIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK doStopProcess
      Quit

      doStopProcess:
      DetailPrint `Closing running "${PRODUCT_NAME}"...`

      !ifdef INSTALL_MODE_PER_ALL_USERS
        nsExec::Exec `taskkill /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $pid"`
      !else
        nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $pid" /fi "USERNAME eq %USERNAME%"`
      !endif
      Sleep 300

      StrCpy $R1 0

      loop:
        IntOp $R1 $R1 + 1

        !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
        ${if} $R0 == 0
          Sleep 500
          !ifdef INSTALL_MODE_PER_ALL_USERS
            nsExec::Exec `taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $pid"`
          !else
            nsExec::Exec `%SYSTEMROOT%\System32\cmd.exe /c taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /fi "PID ne $pid" /fi "USERNAME eq %USERNAME%"`
          !endif
          !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
          ${if} $R0 == 0
            DetailPrint `Waiting for "${PRODUCT_NAME}" to close ($R1/4)...`
            Sleep 700
          ${else}
            Goto not_running
          ${endIf}
        ${else}
          Goto not_running
        ${endIf}

        ${if} $R1 > 4
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "Snipalot is still running.$\n$\nClick the launcher X button or right-click the Snipalot tray icon and choose Quit Snipalot, then click Retry." /SD IDCANCEL IDRETRY loop
          Quit
        ${else}
          Goto loop
        ${endIf}
      not_running:
    ${endIf}
  ${endIf}
!macroend

!macro customInstall
  ; Electron-builder preserves existing shortcut state across upgrades, which can
  ; leave Start Menu search empty if the previous shortcut was missing. Repair it
  ; explicitly on every install/update.
  ; Also remove old per-user shortcuts from earlier current-user/dev installs.
  ; If one remains beside the all-users shortcut with app.snipalot identity,
  ; Windows can keep using stale taskbar icon metadata even after the EXE and
  ; window icons are fixed.
  SetShellVarContext current
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Snipalot.lnk"
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Electron.lnk"
  Delete "$QUICKLAUNCH\User Pinned\TaskBar\Electron.lnk"
  CreateShortCut "$APPDATA\Microsoft\Windows\Start Menu\Programs\Snipalot.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\resources\icons\app.ico" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$APPDATA\Microsoft\Windows\Start Menu\Programs\Snipalot.lnk" "${APP_ID}"

  !ifdef INSTALL_MODE_PER_ALL_USERS
  SetShellVarContext all
  Delete "$SMPROGRAMS\Snipalot.lnk"
  Delete "$SMPROGRAMS\Electron.lnk"
  CreateShortCut "$SMPROGRAMS\Snipalot.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\resources\icons\app.ico" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$SMPROGRAMS\Snipalot.lnk" "${APP_ID}"
  !endif

  ; If Snipalot was pinned while the app still exposed Electron's default
  ; identity/icon, Windows can keep showing that stale taskbar metadata across
  ; upgrades. Repair the existing per-user pinned shortcut in place without
  ; pinning Snipalot for users who have not chosen to pin it.
  SetShellVarContext current
  IfFileExists "$QUICKLAUNCH\User Pinned\TaskBar\Snipalot.lnk" 0 taskbar_pin_done
  CreateShortCut "$QUICKLAUNCH\User Pinned\TaskBar\Snipalot.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\resources\icons\app.ico" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$QUICKLAUNCH\User Pinned\TaskBar\Snipalot.lnk" "${APP_ID}"
  taskbar_pin_done:

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  SetShellVarContext current
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Snipalot.lnk"
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Electron.lnk"
  Delete "$QUICKLAUNCH\User Pinned\TaskBar\Snipalot.lnk"
  Delete "$QUICKLAUNCH\User Pinned\TaskBar\Electron.lnk"
  !ifdef INSTALL_MODE_PER_ALL_USERS
  SetShellVarContext all
  Delete "$SMPROGRAMS\Electron.lnk"
  Delete "$SMPROGRAMS\Snipalot.lnk"
  !endif
!macroend
