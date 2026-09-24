const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const keychain = require('./keychain')

/**
 * Where Claude Code itself keeps a login.
 *
 * Every read or write of a *live* login — the one Claude Code will actually
 * use — goes through here, because it is not the same place on every OS:
 *
 *   Windows, Linux   <configDir>/.credentials.json
 *   macOS            the login Keychain, with that same file as a fallback
 *
 * This mirrors Claude Code 2.1.280 (read from its macOS build), so an item
 * written here is exactly what Claude Code would have written itself:
 *
 *   service  "Claude Code-credentials", plus "-" and the first 8 hex digits of
 *            sha256(CLAUDE_CONFIG_DIR) when a config dir is set
 *   account  $USER, or "claude-code-user" if that is missing or unusual
 *   value    the same JSON as .credentials.json
 *   reads    keychain first, file only if the keychain has nothing
 *   writes   keychain; the file is deleted if this is the keychain's first
 *            copy, so a stale login cannot be fallen back to later
 *
 * `configDir` is the exact string Claude Code is launched with as
 * CLAUDE_CONFIG_DIR, or null for "unset" — the default login. The service
 * name hashes that raw string, so callers must pass the very string they put
 * in the environment, not a resolved or normalised version of it.
 */

const FILE = '.credentials.json'
const SERVICE_BASE = 'Claude Code'
const SERVICE_SUFFIX = '-credentials'
const FALLBACK_ACCOUNT = 'claude-code-user'
const ACCOUNT_RE = /^[a-zA-Z0-9._-]+$/

function platform(opts) { return (opts && opts.platform) || process.platform }
function env(opts) { return (opts && opts.env) || process.env }
function home(opts) { return (opts && opts.home) || os.homedir() }

function usesKeychain(opts) { return platform(opts) === 'darwin' }

/**
 * The directory Claude Code keeps the plaintext file in. It honours
 * CLAUDE_SECURESTORAGE_CONFIG_DIR over the config dir, and so do we.
 */
function storageDir(configDir, opts) {
  const ssd = env(opts).CLAUDE_SECURESTORAGE_CONFIG_DIR
  if (ssd !== undefined) return ssd || path.join(home(opts), '.claude')
  return configDir || path.join(home(opts), '.claude')
}

function filePath(configDir, opts) { return path.join(storageDir(configDir, opts), FILE) }

/** Claude Code's keychain service name for a config dir. */
function service(configDir, opts) {
  const ssd = env(opts).CLAUDE_SECURESTORAGE_CONFIG_DIR
  const isDefault = ssd !== undefined ? !ssd : !configDir
  const input = ssd !== undefined ? ssd : (configDir || path.join(home(opts), '.claude'))
  const tail = isDefault ? ''
    : '-' + crypto.createHash('sha256').update(input.normalize('NFC')).digest('hex').substring(0, 8)
  return SERVICE_BASE + SERVICE_SUFFIX + tail
}

/** Claude Code's keychain account name: the login user. */
function account(opts) {
  let n
  try { n = env(opts).USER || os.userInfo().username } catch { n = FALLBACK_ACCOUNT }
  return n && ACCOUNT_RE.test(n) ? n : FALLBACK_ACCOUNT
}

/**
 * `security -w` prints a stored value as text, or as hex when the bytes are
 * not printable. Accept either.
 */
function parseValue(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  try { return JSON.parse(text) } catch { /* maybe hex */ }
  if (/^(?:[0-9a-fA-F]{2})+$/.test(text)) {
    try { return JSON.parse(Buffer.from(text, 'hex').toString('utf8')) } catch { /* fall through */ }
  }
  return null
}

function readFile(configDir, opts) {
  try { return JSON.parse(fs.readFileSync(filePath(configDir, opts), 'utf8')) } catch { return null }
}

function writeFile(configDir, obj, opts) {
  const file = filePath(configDir, opts)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  // 0600, as Claude Code writes it: this file is a live refresh token.
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch { /* not meaningful on Windows */ }
}

function removeFile(configDir, opts) {
  try { fs.rmSync(filePath(configDir, opts), { force: true }); return true } catch { return false }
}

function fileModified(configDir, opts) {
  try { return fs.statSync(filePath(configDir, opts)).mtimeMs } catch { return 0 }
}

/** The login Claude Code would use for this config dir, or null. */
function read(configDir, opts) {
  if (usesKeychain(opts)) {
    const hit = keychain.find(service(configDir, opts), account(opts), { secret: true })
    if (hit.state === 'present') {
      const v = parseValue(hit.value)
      if (v) return v
    }
    // Only an empty or absent keychain falls through; locked or denied throws
    // above rather than quietly serving a stale file in its place.
  }
  return readFile(configDir, opts)
}

/**
 * Store a login where Claude Code will find it.
 * @returns {{where: 'keychain'|'file'}}
 */
function write(configDir, obj, opts) {
  if (!usesKeychain(opts)) {
    writeFile(configDir, obj, opts)
    return { where: 'file' }
  }

  const svc = service(configDir, opts)
  const acct = account(opts)
  const before = keychain.find(svc, acct)
  if (before.state === 'no-keychain') {
    // No keychain for this user at all — Claude Code falls back to the file
    // in this case too, so that is where it will look.
    writeFile(configDir, obj, opts)
    return { where: 'file' }
  }

  keychain.set(svc, acct, JSON.stringify(obj))

  // Read back: `security -i` does not reliably report a failed inner command,
  // and a switch that silently kept the old login would be worse than one
  // that fails loudly.
  const back = keychain.find(svc, acct, { secret: true })
  const got = back.state === 'present' ? parseValue(back.value) : null
  const want = obj && obj.claudeAiOauth && obj.claudeAiOauth.refreshToken
  if (!got || (want && !(got.claudeAiOauth && got.claudeAiOauth.refreshToken === want))) {
    throw new keychain.KeychainError('error',
      'Wrote the login to the Keychain but could not read the same login back.')
  }

  if (before.state === 'absent') removeFile(configDir, opts)
  return { where: 'keychain' }
}

/** Delete a login from wherever Claude Code might find it. */
function remove(configDir, opts) {
  let removed = false
  if (usesKeychain(opts)) removed = keychain.remove(service(configDir, opts), account(opts))
  const hadFile = fs.existsSync(filePath(configDir, opts))
  removeFile(configDir, opts)
  return removed || hadFile
}

/**
 * Whether a login exists, and when it last changed — without ever reading
 * the token itself.
 * @returns {{exists: boolean, modifiedMs: number, where: 'keychain'|'file'|null}}
 */
function stat(configDir, opts) {
  if (usesKeychain(opts)) {
    const hit = keychain.find(service(configDir, opts), account(opts))
    if (hit.state === 'present') {
      // The keychain's own timestamp, or the file's if this release does not
      // print one; "now" last, so a login is never treated as older than it is.
      const t = hit.modifiedMs || fileModified(configDir, opts) || Date.now()
      return { exists: true, modifiedMs: t, where: 'keychain' }
    }
  }
  const t = fileModified(configDir, opts)
  return t ? { exists: true, modifiedMs: t, where: 'file' } : { exists: false, modifiedMs: 0, where: null }
}

function exists(configDir, opts) { return stat(configDir, opts).exists }

/** Human-readable location, for messages and Show Status. */
function describe(configDir, opts) {
  if (usesKeychain(opts)) {
    return 'Keychain "' + service(configDir, opts) + '" (account ' + account(opts) + '), then ' +
      filePath(configDir, opts)
  }
  return filePath(configDir, opts)
}

module.exports = {
  read, write, remove, stat, exists, describe,
  service, account, filePath, usesKeychain, parseValue,
  FILE,
}
