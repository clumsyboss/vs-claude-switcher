const crypto = require('crypto')
const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const dpapi = require('./dpapi')

/**
 * Encryption at rest for saved logins, one interface over three platforms.
 *
 *   Windows  DPAPI at CurrentUser scope (lib/dpapi.js), byte-for-byte as before
 *   macOS    AES-256-GCM under a master key held in the login Keychain
 *   Linux    AES-256-GCM under a master key held by libsecret, or a 0600 file
 *
 * The shape is deliberately the same on all three: a first-party OS credential
 * store driven through its CLI, so there is no native module to compile and
 * nothing to rebuild against each Electron version.
 *
 * ## Blob format
 *
 * Windows writes **raw DPAPI bytes with no header**, exactly as it always has.
 * That is not laziness: profiles saved before this file existed must keep
 * opening, and a header would have made every one of them unreadable.
 *
 * The AES backends write:
 *
 *     'CSW1' | version(1) | iv(12) | tag(16) | ciphertext
 *
 * `unprotect` dispatches on that magic rather than on the current platform, so
 * a blob always decrypts the way it was written.
 *
 * ## What this does and does not protect against
 *
 * A copied profile is inert on another machine or user account, because the
 * master key never leaves the OS store. It is not protection against something
 * already running as you — that process can ask the same OS store for the same
 * key, on any of the three platforms.
 */

const MAGIC = Buffer.from('CSW1', 'ascii')
const VERSION = 1
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32

const SERVICE = 'claude-account-switcher'
const ACCOUNT = 'profile-encryption-key'

/** Which backend this machine uses. */
function backend() {
  if (process.platform === 'win32') return 'dpapi'
  if (process.platform === 'darwin') return 'keychain'
  return 'keyfile'
}

function run(cmd, args, input) {
  return cp.execFileSync(cmd, args, {
    encoding: 'utf8', input, timeout: 15000, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

function has(cmd) {
  try {
    run(process.platform === 'win32' ? 'where' : 'which', [cmd])
    return true
  } catch { return false }
}

// ------------------------------------------------------------------ macOS

/**
 * `security` writes the password to stdout with a trailing newline and no
 * other decoration when given -w. A missing item exits non-zero, which is the
 * only way to tell "no key yet" from "keychain is locked" — the latter prints
 * to stderr, so it is surfaced rather than silently regenerating a key that
 * would orphan every existing profile.
 */
function keychainRead() {
  try {
    return Buffer.from(run('security',
      ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']).trim(), 'base64')
  } catch (e) {
    const err = (e && (e.stderr || e.message) || '').toString()
    if (/could not be found/i.test(err)) return null
    throw new Error('Could not read the encryption key from the macOS Keychain: ' + err.trim())
  }
}

function keychainWrite(key) {
  // -U updates in place if another window created the item between our read
  // and this write, instead of failing with "item already exists".
  run('security', ['add-generic-password', '-s', SERVICE, '-a', ACCOUNT,
    '-D', 'encryption key', '-U', '-w', key.toString('base64')])
}

// ------------------------------------------------------------------ Linux

function secretToolRead() {
  try {
    const out = run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT])
    const trimmed = out.trim()
    return trimmed ? Buffer.from(trimmed, 'base64') : null
  } catch { return null }
}

function secretToolWrite(key) {
  run('secret-tool', ['store', '--label=Claude Account Switcher',
    'service', SERVICE, 'account', ACCOUNT], key.toString('base64'))
}

function keyFilePath(opts) {
  const home = (opts && opts.home) || os.homedir()
  return path.join(home, '.claude-switcher', 'masterkey')
}

function keyFileRead(opts) {
  try {
    const key = Buffer.from(fs.readFileSync(keyFilePath(opts), 'utf8').trim(), 'base64')
    return key.length === KEY_LEN ? key : null
  } catch { return null }
}

function keyFileWrite(key, opts) {
  const file = keyFilePath(opts)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, key.toString('base64') + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch { /* best effort */ }
}

// ------------------------------------------------------------- master key

let cachedKey

/**
 * Fetch the master key, creating it on first use.
 *
 * Losing this key makes every saved profile unreadable, so it is only ever
 * generated when the store says there is none — never as a fallback after an
 * error, which would quietly strand accounts the user believes are saved.
 */
function masterKey(opts) {
  if (opts && opts.key) return opts.key
  if (cachedKey) return cachedKey

  // `store` is how the tests drive a backend this machine is not running, so
  // the file path is covered on every platform rather than only on Linux.
  const kind = (opts && opts.store) || (backend() === 'keychain' ? 'keychain'
    : has('secret-tool') ? 'secrettool' : 'keyfile')
  const read = () => (kind === 'keychain' ? keychainRead()
    : kind === 'secrettool' ? secretToolRead() : keyFileRead(opts))
  const write = (k) => (kind === 'keychain' ? keychainWrite(k)
    : kind === 'secrettool' ? secretToolWrite(k) : keyFileWrite(k, opts))

  let key = read()
  if (!key || key.length !== KEY_LEN) {
    key = crypto.randomBytes(KEY_LEN)
    write(key)
    // Read back: a store that accepted the write but returns something else
    // would hand us profiles we can never open again.
    const back = read()
    if (!back || !back.equals(key)) {
      throw new Error('Stored a new encryption key but could not read it back; refusing to ' +
        'encrypt anything that could not be decrypted later.')
    }
  }
  if (!(opts && (opts.home || opts.store))) cachedKey = key
  return key
}

// ---------------------------------------------------------------- the API

function isAesBlob(blob) {
  return blob.length > MAGIC.length && blob.subarray(0, MAGIC.length).equals(MAGIC)
}

/** @param {Buffer} buf @returns {Buffer} */
function protect(buf, opts) {
  // An explicit key or store means a caller chose the backend; honour it.
  if (backend() === 'dpapi' && !(opts && (opts.key || opts.store))) return dpapi.protect(buf)

  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(opts), iv)
  const body = Buffer.concat([cipher.update(buf), cipher.final()])
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, cipher.getAuthTag(), body])
}

/** @param {Buffer} blob @returns {Buffer} */
function unprotect(blob, opts) {
  if (!isAesBlob(blob)) {
    // Raw DPAPI. Readable only on Windows, so say that plainly rather than
    // letting "DPAPI is only available on Windows" surface from three layers
    // down when someone copies a profile across.
    if (process.platform !== 'win32') {
      throw new Error('This saved login was encrypted on Windows and cannot be read on ' +
        (process.platform === 'darwin' ? 'macOS' : 'this system') +
        '. Sign in to that account again to save it here.')
    }
    return dpapi.unprotect(blob)
  }

  const version = blob[MAGIC.length]
  if (version !== VERSION) {
    throw new Error('This saved login uses format version ' + version +
      ', which this build does not understand. Update the extension.')
  }
  const at = MAGIC.length + 1
  const iv = blob.subarray(at, at + IV_LEN)
  const tag = blob.subarray(at + IV_LEN, at + IV_LEN + TAG_LEN)
  const body = blob.subarray(at + IV_LEN + TAG_LEN)

  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(opts), iv)
  decipher.setAuthTag(tag)
  try {
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new Error('This saved login could not be decrypted. It was encrypted by a ' +
      'different user or machine, or the key it used is gone.')
  }
}

/** One line for the status output, so a support request says which backend ran. */
function describe() {
  switch (backend()) {
    case 'dpapi': return 'Windows DPAPI (CurrentUser)'
    case 'keychain': return 'macOS Keychain + AES-256-GCM'
    default: return (has('secret-tool') ? 'libsecret' : 'key file (0600)') + ' + AES-256-GCM'
  }
}

module.exports = {
  protect, unprotect, backend, describe, isAesBlob, masterKey,
  MAGIC, VERSION, KEY_LEN,
  _test: { reset: () => { cachedKey = undefined } },
}
