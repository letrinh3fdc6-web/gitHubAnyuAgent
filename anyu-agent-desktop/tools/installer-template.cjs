'use strict'
const fs = require('node:fs')
const path = require('node:path')

function replaceOnce(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw new Error(`NSIS template changed; review instrumentation: ${needle}`)
  return source.replace(needle, replacement)
}

function instrumentInstaller(originalScript) {
  const root = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis')
  const read = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')
  let extract = read('include/extractAppPackage.nsh')
  extract = replaceOnce(extract, '  Nsis7z::Extract "${FILE}"\n  Pop $R0', '  !insertmacro AnyuInstallPhase "extracting"\n  Nsis7z::Extract "${FILE}"\n  Pop $R0')
  extract = replaceOnce(extract, '    CopyFiles /SILENT', '    !insertmacro AnyuInstallPhase "copying"\n    CopyFiles /SILENT')
  let util = replaceOnce(read('include/installUtil.nsh'), '    SetErrorLevel 2\n    Quit', '    !insertmacro AnyuInstallPhase "failed-old-uninstall:$R0"\n    SetErrorLevel 2\n    Quit')
  util = replaceOnce(util, '    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"', '    MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0" /SD IDOK')
  util = replaceOnce(util, '  ${if} $R0 != 0', '  Call AnyuRecoverLegacyUninstall\n  ${if} $R0 != 0')
  util += `
Function AnyuRecoverLegacyUninstall
  \${if} $R0 != 2
    Return
  \${endif}
  \${if} $rootKey_uninstallResult != "SHELL_CONTEXT"
    Return
  \${endif}
  GetFullPathName $AnyuSourcePath "$installationDir"
  GetFullPathName $AnyuTargetPath "$INSTDIR"
  \${if} $AnyuSourcePath != $AnyuTargetPath
    Return
  \${endif}
  !insertmacro AnyuInstallPhase "recovering-old"
  File /oname=$PLUGINSDIR\\anyu-recovery-uninstaller.exe "\${UNINSTALLER_OUT_FILE}"
  ExecWait '"$PLUGINSDIR\\anyu-recovery-uninstaller.exe" /S /KEEP_APP_DATA $0 --anyu-progress="$AnyuPhaseFile" _?=$INSTDIR' $R0
FunctionEnd
`
  let files = replaceOnce(read('include/installer.nsh'), '!include "extractAppPackage.nsh"', extract)
  files = replaceOnce(files, '!macro installApplicationFiles\n', '!macro installApplicationFiles\n  !insertmacro AnyuInstallPhase "unpacking"\n')
  files = replaceOnce(files, '!macro registryAddInstallInfo\n', '!macro registryAddInstallInfo\n  !insertmacro AnyuInstallPhase "registering"\n')
  let section = replaceOnce(read('installSection.nsh'), '!include installer.nsh', files)
  section = replaceOnce(section, '!insertmacro uninstallOldVersion SHELL_CONTEXT', '!insertmacro AnyuInstallPhase "removing-old"\n!insertmacro uninstallOldVersion SHELL_CONTEXT')
  section = replaceOnce(section, '  !insertmacro uninstallOldVersion HKEY_CURRENT_USER', '  !insertmacro AnyuInstallPhase "removing-old-user"\n  !insertmacro uninstallOldVersion HKEY_CURRENT_USER')
  let uninstaller = replaceOnce(read('uninstaller.nsh'), '        DetailPrint "File is busy, aborting: $R0"', '        !insertmacro AnyuInstallPhase "failed-file-busy:$R0"\n        DetailPrint "File is busy, aborting: $R0"')
  // The legacy uninstaller moves files into TEMP, where an otherwise valid path can exceed MAX_PATH.
  const directoryTest = 'IfFileExists "$INSTDIR$R0\\$R2\\*.*"'
  if (uninstaller.split(directoryTest).length !== 3) throw new Error('NSIS directory checks changed; review long-path handling')
  uninstaller = uninstaller.replaceAll(directoryTest, '!insertmacro AnyuLongPath $AnyuSourcePath "$INSTDIR$R0\\$R2\\*.*"\n    IfFileExists "$AnyuSourcePath"')
  const longPaths = [
    ['StrCpy $R3 "$INSTDIR$R0\\*.*"', '!insertmacro AnyuLongPath $R3 "$INSTDIR$R0\\*.*"'],
    ['CreateDirectory "$PLUGINSDIR\\old-install$R0\\$R2"', '!insertmacro AnyuLongPath $AnyuTargetPath "$PLUGINSDIR\\old-install$R0\\$R2"\n      CreateDirectory "$AnyuTargetPath"'],
    ['Rename "$INSTDIR$R0\\$R2" "$PLUGINSDIR\\old-install$R0\\$R2"', '!insertmacro AnyuLongPath $AnyuSourcePath "$INSTDIR$R0\\$R2"\n      !insertmacro AnyuLongPath $AnyuTargetPath "$PLUGINSDIR\\old-install$R0\\$R2"\n      Rename "$AnyuSourcePath" "$AnyuTargetPath"'],
    ['StrCpy $R3 "$PLUGINSDIR\\old-install$R0\\*.*"', '!insertmacro AnyuLongPath $R3 "$PLUGINSDIR\\old-install$R0\\*.*"'],
    ['CreateDirectory "$INSTDIR$R0\\$R2"', '!insertmacro AnyuLongPath $AnyuTargetPath "$INSTDIR$R0\\$R2"\n      CreateDirectory "$AnyuTargetPath"'],
    ['Rename "$PLUGINSDIR\\old-install$R0\\$R2" "$INSTDIR$R0\\$R2"', '!insertmacro AnyuLongPath $AnyuSourcePath "$PLUGINSDIR\\old-install$R0\\$R2"\n      !insertmacro AnyuLongPath $AnyuTargetPath "$INSTDIR$R0\\$R2"\n      Rename "$AnyuSourcePath" "$AnyuTargetPath"'],
    ['RMDir /r $INSTDIR', '!insertmacro AnyuLongPath $AnyuTargetPath "$INSTDIR"\n    RMDir /r "$AnyuTargetPath"'],
  ]
  for (const [needle, replacement] of longPaths) uninstaller = replaceOnce(uninstaller, needle, replacement)
  let script = replaceOnce(originalScript.replace(/\r\n/g, '\n'), '!include "installSection.nsh"', section)
  script = replaceOnce(script, '!include "installUtil.nsh"', util)
  return replaceOnce(script, '!include "uninstaller.nsh"', uninstaller)
}

// Keep electron-builder's own uninstaller generation/signing and lifecycle.
// Patch the pinned file-migration template and diagnostics; template drift stops the build.
module.exports = function instrumentTargets(targets) {
  for (const target of targets) {
    if (target.name !== 'nsis' || target.anyuPhaseMarkers) continue
    const original = target.computeFinalScript
    if (typeof original !== 'function') throw new Error('NSIS build API changed')
    target.anyuPhaseMarkers = true
    target.computeFinalScript = function (script, isInstaller, archs) {
      return original.call(this, instrumentInstaller(script), isInstaller, archs)
    }
  }
}
module.exports.instrumentInstaller = instrumentInstaller
