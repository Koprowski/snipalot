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
  ; Also remove the old per-user shortcut from earlier current-user installs.
  ; If it remains beside the all-users shortcut, Windows can keep using stale
  ; taskbar identity/icon metadata even after the EXE resource icon is fixed.
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Snipalot.lnk"
  CreateShortCut "$SMPROGRAMS\Snipalot.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\resources\resources\icons\app.ico" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  WinShell::SetLnkAUMI "$SMPROGRAMS\Snipalot.lnk" "${APP_ID}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Snipalot.lnk"
  Delete "$SMPROGRAMS\Snipalot.lnk"
!macroend
