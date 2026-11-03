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
  let files = replaceOnce(read('include/installer.nsh'), '!include "extractAppPackage.nsh"', extract)
  files = replaceOnce(files, '!macro installApplicationFiles\n', '!macro installApplicationFiles\n  !insertmacro AnyuInstallPhase "unpacking"\n')
  files = replaceOnce(files, '!macro registryAddInstallInfo\n', '!macro registryAddInstallInfo\n  !insertmacro AnyuInstallPhase "registering"\n')
  let section = replaceOnce(read('installSection.nsh'), '!include installer.nsh', files)
  section = replaceOnce(section, '!insertmacro uninstallOldVersion SHELL_CONTEXT', '!insertmacro AnyuInstallPhase "removing-old"\n!insertmacro uninstallOldVersion SHELL_CONTEXT')
  return replaceOnce(originalScript.replace(/\r\n/g, '\n'), '!include "installSection.nsh"', section)
}

// Keep electron-builder's own uninstaller generation/signing and lifecycle.
// Only add phase markers to its pinned template; template drift stops the build.
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
