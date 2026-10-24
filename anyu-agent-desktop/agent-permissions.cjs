function normalizePermissionMode(value) {
  return ['auto', 'confirm', 'full'].includes(value) ? value : 'auto'
}

function resolvePermissionMode(requested, persisted = 'auto') {
  const selected = requested ? normalizePermissionMode(requested) : normalizePermissionMode(persisted)
  // Model capabilities never grant filesystem or administrator permissions.
  return selected === 'full' ? 'full' : 'confirm'
}

module.exports = { normalizePermissionMode, resolvePermissionMode }
