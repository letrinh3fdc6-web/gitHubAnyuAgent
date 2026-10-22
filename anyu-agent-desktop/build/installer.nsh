Var AnyuProcessResult
Var AnyuProcessOutput
Var AnyuInstallerPid

!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro AnyuCheckProcesses MODE
  nsExec::ExecToStack /TIMEOUT=15000 '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\anyu-installer-processes.ps1" -InstallDirectory "$INSTDIR" -Mode "${MODE}" -InstallerProcessId $AnyuInstallerPid -LogPath "$TEMP\AnyuAgent-install.log"'
  Pop $AnyuProcessResult
  Pop $AnyuProcessOutput
!macroend

!macro customCheckAppRunning
  InitPluginsDir
  File /oname=$PLUGINSDIR\anyu-installer-processes.ps1 "${BUILD_RESOURCES_DIR}\installer-processes.ps1"
  ${If} ${FileExists} "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy $PowerShellPath "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  System::Call 'kernel32::GetCurrentProcessId() i .r0'
  StrCpy $AnyuInstallerPid $0
  SetDetailsPrint both
  DetailPrint "Checking installation processes (15 second timeout)..."
  !insertmacro AnyuCheckProcesses Inspect
  ${If} $AnyuProcessResult == "10"
    ${IfNot} ${Silent}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" IDOK +3
      SetErrorLevel 2
      Quit
      DetailPrint "Closing processes owned by this installation..."
      !insertmacro AnyuCheckProcesses Stop
    ${EndIf}
  ${EndIf}
  ${If} $AnyuProcessResult != "0"
    DetailPrint "Process check stopped: $AnyuProcessResult $AnyuProcessOutput"
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Cannot safely continue installation. Close AnyuAgent and retry.$\r$\nDetails: $TEMP\AnyuAgent-install.log$\r$\nResult: $AnyuProcessResult"
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
  DetailPrint "Process check complete. Preparing application files..."
!macroend

!macro customInstall
  DetailPrint "AnyuAgent installation completed."
!macroend
