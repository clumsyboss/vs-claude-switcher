const fs = require('fs')
const os = require('os')
const path = require('path')

const secrets = require('./secrets')

/**
 * Global account switching: one config dir (~/.claude), swap only the login.
 *
 * Conversations, history, todos, project settings and memory all live in
 * ~/.claude and are deliberately left untouched, so switching accounts never
 * moves where Claude looks for a chat. This is the opposite trade from
 * per-account config dirs: no concurrent accounts, but nothing is split.
 */

const CRED_FILE = '.credentials.json'

/**
 * Caches in ~/.claude.json that carry a single accountUuid and would be wrong
 * after a switch. Entries keyed *by* uuid (groveConfigCache, passesEligibility…)
 * are left alone: they self-select the right record.
 */
const STALE_AFTER_SWITCH = [
  'cachedUsageUtilization',
  'cachedArtifactRoster',
  'githubWebConnectionStatusCache',
  'cachedExtraUsageDisabledReason',
]

/** Identity + machine keys that belong to the account, not the machine. */
const IDENTITY_KEYS = ['oauthAccount', 'userID']

function paths(opts) {
  const home = (opts && opts.home) || os.homedir()
  return {
    claudeDir: path.join(home, '.claude'),
    credPath: path.join(home, '.claude', CRED_FILE),
    claudeJson: path.join(home, '.claude.json'),
  }
}

function profilesDir(root) { return path.join(root, 'profiles') }
function blobPath(root, name) { return path.join(profilesDir(root), name + '.enc') }
function metaPath(root, name) { return path.join(profilesDir(root), name + '.meta.json') }

/** Write via temp + rename so a crash can never leave a half-written login. */
function writeAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

/** Is there a login in ~/.claude right now? */
function hasCurrentLogin(opts) {
  return fs.existsSync(paths(opts).credPath)
}

/** Non-secret identity of whatever is logged in right now. */
function currentIdentity(opts) {
  const j = readJson(paths(opts).claudeJson, null)
  const o = j && j.oauthAccount
  if (!o) return null
  return { email: o.emailAddress || null, org: o.organizationName || null }
}

/**
 * Snapshot the active login into an encrypted profile.
 * Always call this before switching away, so a token refreshed since the last
 * capture is not lost.
 */
function capture(root, name, opts) {
  const p = paths(opts)
  if (!fs.existsSync(p.credPath)) throw new Error('No active login found at ' + p.credPath)

  const credentials = readJson(p.credPath, null)
  if (!credentials) throw new Error('Could not parse ' + p.credPath)

  return writeProfile(root, name, credentials, pickIdentity(readJson(p.claudeJson, {})))
}

function pickIdentity(cfg) {
  const identity = {}
  for (const k of IDENTITY_KEYS) if (cfg && cfg[k] !== undefined) identity[k] = cfg[k]
  return identity
}

/** Encrypt and store one profile, plus a non-secret sidecar for display. */
function writeProfile(root, name, credentials, identity, fallback) {
  const payload = { credentials, identity, capturedAt: new Date().toISOString() }
  fs.mkdirSync(profilesDir(root), { recursive: true })
  writeAtomic(blobPath(root, name), secrets.protect(Buffer.from(JSON.stringify(payload), 'utf8')))

  const o = identity.oauthAccount || {}
  const email = o.emailAddress || (fallback && fallback.email) || null
  const org = o.organizationName || (fallback && fallback.org) || null
  writeAtomic(metaPath(root, name), JSON.stringify({
    email, org, subscription: o.seatTier || null, capturedAt: payload.capturedAt,
  }, null, 2))
  return { email, org }
}

/**
 * Promote a login made in an isolated config dir into a global profile.
 *
 * With `move`, the source credential file is deleted once the encrypted copy
 * has been read back and matches — so there is only ever one live copy of a
 * refresh token, and a failed write can never leave the account with none.
 */
function importFromDir(root, name, dir, opts) {
  const credPath = path.join(dir, CRED_FILE)
  const credentials = readJson(credPath, null)
  if (!credentials || !credentials.claudeAiOauth) throw new Error('No login found in ' + dir)

  const result = writeProfile(root, name, credentials,
    pickIdentity(readJson(path.join(dir, '.claude.json'), {})), opts && opts.fallback)

  if (opts && opts.move) {
    const back = JSON.parse(secrets.unprotect(fs.readFileSync(blobPath(root, name))).toString('utf8'))
    const same = back.credentials && back.credentials.claudeAiOauth &&
      back.credentials.claudeAiOauth.refreshToken === credentials.claudeAiOauth.refreshToken
    if (!same) throw new Error('Encrypted copy did not verify; source login left in place')
    fs.rmSync(credPath, { force: true })
  }
  return result
}

/** Saved profile (other than `except`) holding the same account, by email. */
function findByEmail(root, email, except) {
  if (!email) return null
  const hit = list(root).find((p) => p.email === email && p.name !== except)
  return hit ? hit.name : null
}

function capturedAt(root, name) {
  const m = readJson(metaPath(root, name), null)
  const t = m && Date.parse(m.capturedAt)
  return Number.isNaN(t) ? 0 : t || 0
}

/**
 * Make a saved profile the active login. Only the credential file and the
 * identity keys are replaced; everything else in ~/.claude and ~/.claude.json
 * is preserved, which is what keeps conversations working across a switch.
 */
function apply(root, name, opts) {
  const p = paths(opts)
  const blob = fs.readFileSync(blobPath(root, name))
  const payload = JSON.parse(secrets.unprotect(blob).toString('utf8'))

  fs.mkdirSync(p.claudeDir, { recursive: true })
  writeAtomic(p.credPath, JSON.stringify(payload.credentials))

  const cfg = readJson(p.claudeJson, {}) || {}
  for (const k of IDENTITY_KEYS) {
    if (payload.identity && payload.identity[k] !== undefined) cfg[k] = payload.identity[k]
  }
  for (const k of STALE_AFTER_SWITCH) delete cfg[k]
  writeAtomic(p.claudeJson, JSON.stringify(cfg, null, 2))

  const o = (payload.identity && payload.identity.oauthAccount) || {}
  return { email: o.emailAddress || null, org: o.organizationName || null }
}

function list(root) {
  let files = []
  try { files = fs.readdirSync(profilesDir(root)) } catch { return [] }
  return files
    .filter((f) => f.endsWith('.enc'))
    .map((f) => f.slice(0, -4))
    .sort()
    .map((name) => ({ name, ...(readJson(metaPath(root, name), {}) || {}) }))
}

function exists(root, name) { return fs.existsSync(blobPath(root, name)) }

function remove(root, name) {
  for (const f of [blobPath(root, name), metaPath(root, name)]) {
    try { fs.rmSync(f, { force: true }) } catch { /* best effort */ }
  }
}

/** Which saved profile matches the active login, by account uuid then email. */
function activeProfile(root, opts) {
  const cfg = readJson(paths(opts).claudeJson, null)
  const o = cfg && cfg.oauthAccount
  if (!o) return null
  for (const meta of list(root)) {
    if (meta.email && o.emailAddress && meta.email === o.emailAddress) return meta.name
  }
  return null
}

module.exports = {
  capture, apply, list, exists, remove, activeProfile,
  importFromDir, findByEmail, capturedAt,
  hasCurrentLogin, currentIdentity, paths, profilesDir,
  STALE_AFTER_SWITCH, IDENTITY_KEYS,
}
