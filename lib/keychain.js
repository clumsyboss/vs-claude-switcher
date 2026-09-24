const cp = require('child_process')

/**
 * The macOS `security` CLI, and nothing else.
 *
 * Two callers share it: secrets.js keeps this extension's own encryption key
 * here, and credstore.js reads and writes the logins Claude Code itself keeps
 * here. Both need the same things from it — the exit code classified rather
 * than guessed at, and secrets kept off the command line.
 *
 * ## Exit codes
 *
 * `security` exits with the low byte of the Security framework's OSStatus, so
 * the codes are stable across macOS releases. Claude Code keys on the same two
 * (44 and 36) in its own keychain store.
 *
 *    0   success
 *   44   errSecItemNotFound         (-25300)  — nothing stored yet
 *   36   errSecInteractionNotAllowed (-25308) — keychain locked, or no UI
 *   37   errSecNoDefaultKeychain    (-25307)  — this user has no keychain
 *   50   errSecNoSuchKeychain       (-25294)
 *  128   errSecUserCanceled         (-128)    — the user clicked Deny
 *
 * "Not found" and "locked" must never be confused. Treating a locked keychain
 * as empty is how a tool ends up reading a stale fallback file, or minting a
 * new key and orphaning everything encrypted under the old one.
 */

const TIMEOUT_MS = 15000
/** Longest line `security -i` accepts on stdin; longer writes fall back to argv. */
const STDIN_LIMIT = 4032

class KeychainError extends Error {
  constructor(kind, message) {
    super(message)
    this.kind = kind
  }
}

function defaultRunner(args, input) {
  return cp.spawnSync('security', args, {
    input, encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true,
  })
}

let runner = defaultRunner

function classify(r) {
  if (r.error) return r.error.code === 'ENOENT' ? 'no-keychain' : 'error'
  const text = String(r.stderr || '').toLowerCase()
  if (r.status === 0) return 'ok'
  if (r.status === 44 || text.includes('could not be found')) return 'absent'
  if (r.status === 36 || text.includes('interaction is not allowed') || text.includes('locked')) return 'locked'
  if (r.status === 37 || r.status === 50 || text.includes('no default keychain')) return 'no-keychain'
  if (r.status === 128 || text.includes('cancel')) return 'canceled'
  return 'error'
}

function fail(kind, r) {
  const detail = String((r && (r.stderr || (r.error && r.error.message))) || '').trim()
  switch (kind) {
    case 'locked':
      return new KeychainError(kind, 'The macOS login Keychain is locked. Unlock it (log out and ' +
        'back in, or open Keychain Access) and try again.')
    case 'canceled':
      return new KeychainError(kind, 'Keychain access was denied. When macOS asks, choose ' +
        '"Always Allow", then try again.')
    default:
      return new KeychainError(kind, 'Keychain error' +
        (r && r.status !== undefined && r.status !== null ? ' (security exited ' + r.status + ')' : '') +
        (detail ? ': ' + detail : ''))
  }
}

/** `"mdat"<timedate>=0x…  "20260924123456Z\000"` → epoch ms, or 0 when absent. */
function parseModified(text) {
  const m = /"mdat"<timedate>=\S*\s+"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/.exec(text || '')
  if (!m) return 0
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])
}

/**
 * Look an item up.
 *
 * With `secret`, returns the stored value as text. Without it, returns only
 * whether it exists and when it last changed — the value never leaves the
 * keychain, which is what an existence check should cost.
 *
 * @returns {{state:'present', value?:string, modifiedMs?:number}
 *          |{state:'absent'}|{state:'no-keychain'}}
 * @throws {KeychainError} locked, denied, or anything unexpected
 */
function find(service, account, opts) {
  const secret = !!(opts && opts.secret)
  const args = ['find-generic-password', '-a', account, '-s', service]
  if (secret) args.push('-w')
  const r = runner(args)
  const kind = classify(r)
  if (kind === 'absent' || kind === 'no-keychain') return { state: kind }
  if (kind !== 'ok') throw fail(kind, r)
  if (secret) return { state: 'present', value: String(r.stdout || '').replace(/\r?\n$/, '') }
  // Attributes are printed to stdout; include stderr in case a release moves them.
  return { state: 'present', modifiedMs: parseModified(String(r.stdout || '') + String(r.stderr || '')) }
}

function assertSafe(label, v) {
  // Both end up inside a double-quoted token on the `security -i` command line.
  if (typeof v !== 'string' || !v || /["\\\r\n]/.test(v)) {
    throw new KeychainError('error', 'Refusing to use ' + label + ' ' + JSON.stringify(v) + ' with the keychain.')
  }
}

/**
 * Create or replace an item.
 *
 * The value goes in hex through `security -i`'s stdin, so it never appears in
 * the process list the way an argv secret would. This is the same command
 * Claude Code sends, so an item written here is indistinguishable from one it
 * wrote itself.
 */
function set(service, account, value) {
  assertSafe('service', service)
  assertSafe('account', account)
  const hex = Buffer.from(String(value), 'utf8').toString('hex')
  const line = 'add-generic-password -U -a "' + account + '" -s "' + service + '" -X "' + hex + '"\n'
  const r = line.length <= STDIN_LIMIT
    ? runner(['-i'], line)
    : runner(['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex])
  const kind = classify(r)
  if (kind !== 'ok') throw fail(kind, r)
}

/** Delete an item. Returns false if there was nothing to delete. */
function remove(service, account) {
  const r = runner(['delete-generic-password', '-a', account, '-s', service])
  const kind = classify(r)
  if (kind === 'ok') return true
  if (kind === 'absent' || kind === 'no-keychain') return false
  throw fail(kind, r)
}

module.exports = {
  find, set, remove, classify, parseModified, KeychainError, STDIN_LIMIT,
  _test: {
    setRunner(fn) { runner = fn || defaultRunner },
  },
}
