const fs = require('fs')
const os = require('os')
const path = require('path')

/**
 * Per-account Remote Control.
 *
 * `disableRemoteControl` turns Remote Control off completely: claude.ai,
 * `claude remote-control`, `--rc`, auto-start at session launch, and the
 * in-session toggle. Claude Code reads it from merged settings, so the user's
 * own settings.json counts even though the docs describe it as a managed
 * setting.
 *
 * Only that one key is managed here. It already blocks auto-start, so there is
 * no reason to also touch `remoteControlAtStartup` and leave more of a mark on
 * a file the user maintains by hand.
 */
const KEY = 'disableRemoteControl'

function settingsPath(opts) {
  const home = (opts && opts.home) || os.homedir()
  return path.join(home, '.claude', 'settings.json')
}

function readSettings(opts) {
  try {
    const raw = fs.readFileSync(settingsPath(opts), 'utf8')
    const j = JSON.parse(raw)
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

/** True when Remote Control is currently switched off on disk. */
function isDisabled(opts) {
  return readSettings(opts)[KEY] === true
}

/**
 * Set or clear the flag, preserving every other setting.
 * Written via temp + rename so a crash cannot truncate a file that also holds
 * the user's hooks and environment.
 */
function setDisabled(disabled, opts) {
  const file = settingsPath(opts)
  const current = readSettings(opts)
  const wanted = disabled === true

  if (wanted === (current[KEY] === true)) return { changed: false, disabled: wanted }

  const next = { ...current }
  if (wanted) next[KEY] = true
  else delete next[KEY]

  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  fs.renameSync(tmp, file)
  return { changed: true, disabled: wanted }
}

module.exports = { KEY, settingsPath, readSettings, isDisabled, setDisabled }
