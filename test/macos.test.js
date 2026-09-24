// End-to-end on the macOS code path, from any machine.
//
// process.platform is forced to 'darwin' and the `security` CLI is replaced by
// an in-memory keychain that reproduces the real tool's stdout, exit codes and
// stderr text. Everything else — profiles.js, secrets.js, the blob format, the
// capture → switch → switch-back cycle — is the real code.
//
// What this cannot prove: that Apple's `security` binary still prints exactly
// what is mimicked here. That, and only that, needs a real Mac.

const assert = require('assert')
const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const realPlatform = process.platform
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-mac-'))
const ROOT = path.join(HOME, '.claude-switcher')

// ---- a fake `security` that behaves like the real one ---------------------
const keychain = new Map()
let keychainLocked = false
const calls = []
const realExecFileSync = cp.execFileSync

function fail(status, stderr) {
  const e = new Error('Command failed: security\n' + stderr)
  e.status = status
  e.stderr = stderr
  throw e
}

cp.execFileSync = function (cmd, args, opts) {
  if (cmd === 'security') {
    calls.push(args[0])
    const s = args[args.indexOf('-s') + 1]
    const a = args[args.indexOf('-a') + 1]
    const id = s + '/' + a
    if (keychainLocked) {
      fail(51, 'security: SecKeychainSearchCopyNext: User interaction is not allowed.\n')
    }
    if (args[0] === 'find-generic-password') {
      // Real output of `-w`: the password and a newline, nothing else.
      if (!keychain.has(id)) {
        fail(44, 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n')
      }
      return keychain.get(id) + '\n'
    }
    if (args[0] === 'add-generic-password') {
      if (keychain.has(id) && !args.includes('-U')) {
        fail(45, 'security: SecKeychainItemCreateFromContent (<default>): The specified item already exists in the keychain.\n')
      }
      keychain.set(id, args[args.indexOf('-w') + 1])
      return ''
    }
    throw new Error('unexpected security subcommand ' + args[0])
  }
  if (cmd === 'which' || cmd === 'where') fail(1, '')   // nothing extra on PATH
  return realExecFileSync.call(this, cmd, args, opts)
}

const secrets = require('../lib/secrets.js')
const profiles = require('../lib/profiles.js')
const store = require('../lib/store.js')

const OPTS = { home: HOME }

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) }
  else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}

function writeLogin(email, token) {
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'AT-' + token, refreshToken: 'RT-' + token, expiresAt: Date.now() + 3600e3 },
  }))
  fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: email, organizationName: 'Acme' },
    userID: 'uid-' + token,
    projects: { '/Users/someone/work': { history: ['keep me'] } },
  }))
}

try {
  console.log('\n-- the macOS backend is selected --')
  check('backend is keychain', secrets.backend() === 'keychain')
  check('describe says so', /Keychain/.test(secrets.describe()), secrets.describe())

  console.log('\n-- first save creates exactly one keychain item --')
  store.ensureRoot(ROOT)
  writeLogin('a@example.com', 'A')
  profiles.capture(ROOT, 'alpha', OPTS)
  check('one key item stored', keychain.size === 1, [...keychain.keys()].join(','))
  check('looked up before creating', calls[0] === 'find-generic-password' && calls[1] === 'add-generic-password',
    calls.join(','))
  check('read back after creating', calls[2] === 'find-generic-password', calls.join(','))
  const stored = Buffer.from([...keychain.values()][0], 'base64')
  check('key is 32 bytes', stored.length === 32)

  const blobA = fs.readFileSync(path.join(ROOT, 'profiles', 'alpha.enc'))
  check('profile written in the AES format', secrets.isAesBlob(blobA))
  check('no token visible on disk', !blobA.toString('binary').includes('RT-A'))
  check('no email visible on disk', !blobA.toString('binary').includes('a@example.com'))

  console.log('\n-- the key is reused, never regenerated --')
  secrets._test.reset()
  writeLogin('b@example.com', 'B')
  profiles.capture(ROOT, 'beta', OPTS)
  check('still exactly one key item', keychain.size === 1)
  check('beta encrypted under the same key',
    secrets.unprotect(fs.readFileSync(path.join(ROOT, 'profiles', 'beta.enc'))).length > 0)

  console.log('\n-- switch and switch back --')
  profiles.apply(ROOT, 'alpha', OPTS)
  let creds = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', '.credentials.json'), 'utf8'))
  let cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'))
  check('alpha is live', creds.claudeAiOauth.refreshToken === 'RT-A')
  check('identity swapped', cfg.oauthAccount.emailAddress === 'a@example.com')
  check('project history survived the switch', cfg.projects['/Users/someone/work'].history[0] === 'keep me')

  profiles.apply(ROOT, 'beta', OPTS)
  creds = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', '.credentials.json'), 'utf8'))
  check('beta is live again', creds.claudeAiOauth.refreshToken === 'RT-B')
  check('active profile tracked', profiles.activeProfile(ROOT, OPTS) === 'beta')

  console.log('\n-- a login made in an account folder is imported --')
  const dir = store.addAccount(ROOT, 'gamma')
  fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'AT-G', refreshToken: 'RT-G' },
  }))
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'g@example.com' },
  }))
  profiles.importFromDir(ROOT, 'gamma', dir, { move: true })
  check('imported into an AES profile',
    secrets.isAesBlob(fs.readFileSync(path.join(ROOT, 'profiles', 'gamma.enc'))))
  check('plaintext source removed after verification', !fs.existsSync(path.join(dir, '.credentials.json')))

  console.log('\n-- account folders are locked to the user --')
  if (realPlatform !== 'win32') {
    check('chmod 700 applied', (fs.statSync(ROOT).mode & 0o777) === 0o700)
  } else {
    check('skipped: chmod is a no-op on NTFS, so this is checked on a real Mac', true)
  }

  console.log('\n-- a locked keychain must never mint a replacement key --')
  // The most dangerous failure: treating "locked" as "missing", generating a
  // new key, and silently orphaning every profile already saved.
  secrets._test.reset()
  keychainLocked = true
  const before = [...keychain.values()][0]
  let lockedErr = null
  try { profiles.apply(ROOT, 'alpha', OPTS) } catch (e) { lockedErr = e.message }
  check('the switch fails', !!lockedErr)
  check('and says why', /Keychain/.test(lockedErr || ''), lockedErr)
  check('the existing key is untouched', [...keychain.values()][0] === before)
  check('no second key was written', keychain.size === 1)
  keychainLocked = false
  secrets._test.reset()
  check('everything opens again once unlocked', (() => {
    profiles.apply(ROOT, 'alpha', OPTS); return true
  })())

  console.log('\n-- a Windows profile copied over explains itself --')
  fs.writeFileSync(path.join(ROOT, 'profiles', 'fromwin.enc'),
    Buffer.from('AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA', 'base64'))
  let winErr = null
  try { profiles.apply(ROOT, 'fromwin', OPTS) } catch (e) { winErr = e.message }
  check('refused with a plain explanation', /encrypted on Windows/.test(winErr || ''), winErr)

  console.log('\n-- the terminal command zsh will actually receive --')
  const { invoke } = require('../lib/shell.js')
  const line = invoke('/Users/someone/.local/bin/claude', ['auth', 'login'])
  check("no leading '&' (the reported parse error)", !line.startsWith('&'), line)
  check('exact expected line', line === "'/Users/someone/.local/bin/claude' auth login", line)
  // Prove it with a real POSIX shell where one exists (Git Bash on Windows).
  const sh = ['/bin/sh', 'C:\\Program Files\\Git\\bin\\sh.exe'].find((p) => fs.existsSync(p))
  if (sh) {
    const probe = invoke("/tmp/it's a path/echo-args", ['auth', 'login'])
    const parsed = realExecFileSync(sh, ['-c', 'set -- ' + probe + '; for a; do printf "[%s]" "$a"; done'],
      { encoding: 'utf8' })
    check('a real POSIX shell splits it into the right words',
      parsed === "[/tmp/it's a path/echo-args][auth][login]", parsed)
  } else {
    check('skipped: no POSIX shell on this machine', true)
  }
} finally {
  cp.execFileSync = realExecFileSync
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  fs.rmSync(HOME, { recursive: true, force: true })
}

console.log('\n' + passed + ' passed, ' + failed + ' failed')
assert.strictEqual(failed, 0, 'macOS path tests failed')
