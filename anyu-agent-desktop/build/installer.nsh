Var AnyuProcessResult
Var AnyuProcessOutput
Var AnyuInstallerPid
Var AnyuPhaseFile
Var AnyuPhaseHandle
Var AnyuSourcePath
Var AnyuTargetPath
!ifdef BUILD_UNINSTALLER
Var AnyuPathPrefix
!else
Var AnyuReadyFile
Var AnyuCommitFile
Var AnyuCancelFile
Var AnyuUpdateSession
Var AnyuHandoffCount
Var AnyuHandoffValue
!endif

!macro AnyuLongPath OUTPUT INPUT
  StrCpy ${OUTPUT} "${INPUT}"
  StrCpy $AnyuPathPrefix ${OUTPUT} 4
  ${If} $AnyuPathPrefix != "\\?\"
    StrCpy $AnyuPathPrefix ${OUTPUT} 2
    ${If} $AnyuPathPrefix == "\\"
      StrCpy ${OUTPUT} ${OUTPUT} "" 2
      StrCpy ${OUTPUT} "\\?\UNC\${OUTPUT}"
    ${Else}
      StrCpy ${OUTPUT} "\\?\${OUTPUT}"
    ${EndIf}
  ${EndIf}
!macroend

!macro AnyuInstallPhase PHASE
  ReadEnvStr $AnyuPhaseFile ANYU_UPDATE_STAGE_FILE
  ${StdUtils.GetParameter} $AnyuPhaseFile "anyu-progress" "$AnyuPhaseFile"
  ${If} $AnyuPhaseFile == ""
    StrCpy $AnyuPhaseFile "$TEMP\AnyuAgent-installer-stages.log"
  ${EndIf}
  ${If} $AnyuPhaseFile != ""
    ClearErrors
    FileOpen $AnyuPhaseHandle "$AnyuPhaseFile" a
    ${IfNot} ${Errors}
      FileSeek $AnyuPhaseHandle 0 END
      FileWriteUTF16LE $AnyuPhaseHandle "${PHASE}$\r$\n"
      FileClose $AnyuPhaseHandle
    ${EndIf}
  ${EndIf}
  DetailPrint "AnyuAgent: ${PHASE}"
  ClearErrors
!macroend

!macro customHeader
  ShowInstDetails show
  ShowUninstDetails show
!macroend

!macro AnyuCheckProcesses MODE
  nsExec::ExecToStack /TIMEOUT=15000 '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\anyu-installer-processes.ps1" -InstallDirectory "$INSTDIR" -Mode "${MODE}" -InstallerProcessId $AnyuInstallerPid -LogPath "$TEMP\AnyuAgent-install.log"'
  Pop $AnyuProcessResult
  Pop $AnyuProcessOutput
!macroend

!macro AnyuUpdateHandoff
  ${StdUtils.GetParameter} $AnyuReadyFile "anyu-ready" ""
  ${If} $AnyuReadyFile != ""
    ${StdUtils.GetParameter} $AnyuCommitFile "anyu-commit" ""
    ${StdUtils.GetParameter} $AnyuCancelFile "anyu-cancel" ""
    ${StdUtils.GetParameter} $AnyuUpdateSession "anyu-session" ""
    ${If} $AnyuCommitFile == ""
    ${OrIf} $AnyuCancelFile == ""
    ${OrIf} $AnyuUpdateSession == ""
      SetErrorLevel 34
      Quit
    ${EndIf}
    ClearErrors
    FileOpen $AnyuPhaseHandle "$AnyuReadyFile.tmp" w
    ${If} ${Errors}
      SetErrorLevel 34
      Quit
    ${EndIf}
    FileWrite $AnyuPhaseHandle "$AnyuUpdateSession"
    FileClose $AnyuPhaseHandle
    Rename "$AnyuReadyFile.tmp" "$AnyuReadyFile"
    ${If} ${Errors}
      SetErrorLevel 34
      Quit
    ${EndIf}
    !insertmacro AnyuInstallPhase "authorized"
    StrCpy $AnyuHandoffCount 0
    ${Do}
      ${If} ${FileExists} "$AnyuCancelFile"
        SetErrorLevel 1223
        Quit
      ${EndIf}
      ${If} ${FileExists} "$AnyuCommitFile"
        ClearErrors
        FileOpen $AnyuPhaseHandle "$AnyuCommitFile" r
        FileRead $AnyuPhaseHandle $AnyuHandoffValue
        FileClose $AnyuPhaseHandle
        ${IfNot} ${Errors}
        ${AndIf} $AnyuHandoffValue == $AnyuUpdateSession
          ${ExitDo}
        ${EndIf}
        SetErrorLevel 34
        Quit
      ${EndIf}
      IntOp $AnyuHandoffCount $AnyuHandoffCount + 1
      ${If} $AnyuHandoffCount >= 1800
        SetErrorLevel 35
        Quit
      ${EndIf}
      Sleep 100
    ${Loop}
  ${EndIf}
!macroend

!macro customCheckAppRunning
  !ifndef BUILD_UNINSTALLER
    !insertmacro AnyuUpdateHandoff
  !endif
  !insertmacro AnyuInstallPhase "checking-processes"
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
    !insertmacro AnyuInstallPhase "failed-processes:$AnyuProcessResult"
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONEXCLAMATION "Cannot safely continue installation. Close AnyuAgent and retry.$\r$\nDetails: $TEMP\AnyuAgent-install.log$\r$\nResult: $AnyuProcessResult"
    ${EndIf}
    ${If} $AnyuProcessResult == "10"
      SetErrorLevel 31
    ${ElseIf} $AnyuProcessResult == "timeout"
      SetErrorLevel 32
    ${Else}
      SetErrorLevel 33
    ${EndIf}
    Quit
  ${EndIf}
  DetailPrint "Process check complete. Preparing application files..."
!macroend

!macro customInstall
  !insertmacro AnyuInstallPhase "installed"
  DetailPrint "AnyuAgent installation completed."
!macroend
