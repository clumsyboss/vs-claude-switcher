const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const REGISTRY = 'registry.json'

function defaultRoot() {
  return path.join(os.homedir(), '.claude-switcher')
}

function getRoot(vscode) {
  const cfg = vscode ? vscode.workspace.getConfiguration('claudeswitcher').get('root') : ''
  return cfg && cfg.trim() ? cfg.trim() : defaultRoot()
}

/**
 * Restrict a directory to the current Windows user only. These directories hold
 * live OAuth refresh tokens, so we strip inherited ACEs rather than relying on
 * whatever the profile happens to grant.
 */
function lockdown(dir) {
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700) } catch { /* best effort */ }
    return
  }
  const user = process.env.USERNAME
  if (!user) return
  try {
    cp.execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], {
      stdio: 'ignore', windowsHide: true, timeout: 15000,
    })
  } catch { /* non-fatal: the switcher still works, just with inherited ACLs */ }
}

function ensureRoot(root) {
  const fresh = !fs.existsSync(root)
  fs.mkdirSync(path.join(root, 'accounts'), { recursive: true })
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true })
  if (fresh) lockdown(root)
  return root
}

function registryPath(root) { return path.join(root, REGISTRY) }

function readRegistry(root) {
  ensureRoot(root)
  try {
    const r = JSON.parse(fs.readFileSync(registryPath(root), 'utf8'))
    if (!Array.isArray(r.accounts)) r.accounts = []
    return r
  } catch {
    return { accounts: [], active: null }
  }
}

function writeRegistry(root, reg) {
  ensureRoot(root)
  const tmp = registryPath(root) + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf8')
  fs.renameSync(tmp, registryPath(root))
}

function configDir(root, name) { return path.join(root, 'accounts', name) }

function validName(name) { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(name) }

function addAccount(root, name) {
  const reg = readRegistry(root)
  if (reg.accounts.some((a) => a.name === name)) throw new Error(`Account "${name}" already exists.`)
  const dir = configDir(root, name)
  fs.mkdirSync(dir, { recursive: true })
  lockdown(dir)
  reg.accounts.push({ name, createdAt: new Date().toISOString() })
  if (!reg.active) reg.active = name
  writeRegistry(root, reg)
  return dir
}

function removeAccount(root, name) {
  const reg = readRegistry(root)
  reg.accounts = reg.accounts.filter((a) => a.name !== name)
  if (reg.active === name) reg.active = reg.accounts.length ? reg.accounts[0].name : null
  writeRegistry(root, reg)
  fs.rmSync(configDir(root, name), { recursive: true, force: true })
}

function setActive(root, name) {
  const reg = readRegistry(root)
  reg.active = name
  writeRegistry(root, reg)
}

function getActive(root) { return readRegistry(root).active }

/**
 * Read the non-secret identity block Claude Code writes into <configdir>/.claude.json.
 * Never touches .credentials.json.
 */
function identity(root, name) {
  const p = path.join(configDir(root, name), '.claude.json')
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const o = j.oauthAccount
    if (!o) return null
    return {
      email: o.emailAddress || null,
      org: o.organizationName || null,
      displayName: o.displayName || null,
      tier: o.userRateLimitTier || o.organizationRateLimitTier || null,
    }
  } catch { return null }
}

/** True when this account has credentials on disk (i.e. has been logged in). */
function isAuthed(root, name) {
  return fs.existsSync(path.join(configDir(root, name), '.credentials.json'))
}

module.exports = {
  defaultRoot, getRoot, ensureRoot, readRegistry, writeRegistry,
  configDir, validName, addAccount, removeAccount, setActive, getActive,
  identity, isAuthed, lockdown,
}

/** Reverse lookup: which registered account owns this config dir (if any). */
function nameForConfigDir(root, dir) {
  if (!dir) return null
  const want = path.resolve(dir).toLowerCase()
  const reg = readRegistry(root)
  for (const a of reg.accounts) {
    if (path.resolve(configDir(root, a.name)).toLowerCase() === want) return a.name
  }
  return null
}

module.exports.nameForConfigDir = nameForConfigDir

/**
 * 'global'  - one machine-wide account drives every window's new chats.
 * 'window'  - the machine-wide setting is cleared and each window is pinned by
 *             the CLAUDE_CONFIG_DIR it was launched with.
 */
const MODES = ['login', 'window', 'global']

function getMode(root) {
  const m = readRegistry(root).mode
  return MODES.includes(m) ? m : 'global'
}

function setMode(root, mode) {
  const reg = readRegistry(root)
  reg.mode = MODES.includes(mode) ? mode : 'global'
  writeRegistry(root, reg)
  return reg.mode
}

module.exports.getMode = getMode
module.exports.setMode = setMode

/** Parse the non-secret identity block out of any .claude.json path. */
function identityFromFile(p) {
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'))
    const o = j.oauthAccount
    if (!o) return null
    return {
      email: o.emailAddress || null,
      org: o.organizationName || null,
      displayName: o.displayName || null,
      tier: o.userRateLimitTier || o.organizationRateLimitTier || null,
    }
  } catch { return null }
}

module.exports.identityFromFile = identityFromFile

/**
 * The pseudo-account for Claude Code's own login (~/.claude), used whenever
 * CLAUDE_CONFIG_DIR is unset. Parentheses keep it from colliding with a real
 * account name, which validName rejects.
 */
const DEFAULT_NAME = '(default)'

/** Codicon ids are plain slugs, e.g. "briefcase", "home", "rocket". */
function validIcon(icon) { return /^[a-zA-Z0-9-]{1,40}$/.test(icon) }

/** Labels are cosmetic, so they only need to be short and non-blank. */
function validLabel(label) { return typeof label === 'string' && label.trim().length > 0 && label.length <= 40 }

/**
 * Display name and icon for an account. Deliberately separate from the
 * directory name: renaming a folder would strand any window already pinned to
 * the old path, so only the label changes and the directory stays put.
 */
function displayOf(root, name) {
  const reg = readRegistry(root)
  if (name === DEFAULT_NAME) {
    const d = reg.defaults || {}
    return { label: d.label || DEFAULT_NAME, icon: d.icon || 'home' }
  }
  const a = reg.accounts.find((x) => x.name === name)
  return { label: (a && a.label) || name, icon: (a && a.icon) || 'account' }
}

/** Patch {label, icon} for an account, including the default pseudo-account. */
function setDisplay(root, name, patch) {
  const reg = readRegistry(root)
  if (name === DEFAULT_NAME) {
    reg.defaults = { ...(reg.defaults || {}), ...patch }
  } else {
    const a = reg.accounts.find((x) => x.name === name)
    if (!a) throw new Error('No such account: ' + name)
    Object.assign(a, patch)
  }
  writeRegistry(root, reg)
  return displayOf(root, name)
}

module.exports.DEFAULT_NAME = DEFAULT_NAME
module.exports.validIcon = validIcon
module.exports.validLabel = validLabel
module.exports.displayOf = displayOf
module.exports.setDisplay = setDisplay

/**
 * Per-account Remote Control preference: 'off' disables it while that account
 * is active, anything else leaves Claude Code's own setting alone.
 */
function getRemote(root, name) {
  const r = readRegistry(root).remote || {}
  return r[name] === 'off' ? 'off' : 'on'
}

function setRemote(root, name, value) {
  const reg = readRegistry(root)
  reg.remote = { ...(reg.remote || {}) }
  if (value === 'off') reg.remote[name] = 'off'
  else delete reg.remote[name]
  writeRegistry(root, reg)
  return getRemote(root, name)
}

module.exports.getRemote = getRemote
module.exports.setRemote = setRemote
