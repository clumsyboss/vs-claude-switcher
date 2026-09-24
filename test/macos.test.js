// End-to-end on the macOS code path, from any machine.
//
// process.platform is forced to 'darwin', and every `security` call is served
// by an in-memory keychain that reproduces the real tool: exit codes 44 / 36,
// its stderr wording, `-w` output, the `"mdat"` attribute line, and `-i` stdin
// commands with hex (-X) values. Everything else is the real code.
//
// The keychain layout Claude Code uses on macOS was read from its own darwin
// build (2.1.280): service "Claude Code-credentials[-<sha256(dir)[:8]>]",
// account $USER. The first block reproduces the bug a Mac user reported —
// "No active Claude login found in ~/.claude" — where the login exists only in
// the Keychain and there is no .credentials.json at all.
//
// What this cannot prove: that Apple's `security` binary prints exactly what
// is mimicked here. That, and only that, needs a real Mac.

const assert = require('assert')
const cp = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const realPlatform = process.platform
const realUser = process.env.USER
Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
process.env.USER = 'someone'

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-mac-'))
const ROOT = path.join(HOME, '.claude-switcher')
const OPTS = { home: HOME }

// ---- a fake `security` that behaves like the real one ---------------------
const items = new Map()   // "service\0account" -> { value, mdat }
const argvLog = []        // every argv, to prove no secret is ever passed on it
let locked = false

const NOT_FOUND = 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n'
const NO_UI = 'security: SecKeychainSearchCopyNext: User interaction is not allowed.\n'

function stamp(ms) {
  const d = new Date(ms)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z'
}

function opt(args, flag) { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1] }

function exec(args) {
  const [cmd] = args
  if (locked) return { status: 36, stdout: '', stderr: NO_UI }
  const key = opt(args, '-s') + '\0' + opt(args, '-a')
  if (cmd === 'find-generic-password') {
    const it = items.get(key)
    if (!it) return { status: 44, stdout: '', stderr: NOT_FOUND }
    if (args.includes('-w')) return { status: 0, stdout: it.value + '\n', stderr: '' }
    return {
      status: 0,
      stdout: 'keychain: "/Users/someone/Library/Keychains/login.keychain-db"\nclass: "genp"\nattributes:\n' +
        '    "acct"<blob>="' + opt(args, '-a') + '"\n' +
        '    "mdat"<timedate>=0x' + Buffer.from(stamp(it.mdat)).toString('hex') + '00  "' + stamp(it.mdat) + '\\000"\n' +
        '    "svce"<blob>="' + opt(args, '-s') + '"\n',
      stderr: '',
    }
  }
  if (cmd === 'add-generic-password') {
    if (items.has(key) && !args.includes('-U')) return { status: 45, stdout: '', stderr: 'already exists\n' }
    const hex = opt(args, '-X')
    const value = hex !== undefined ? Buffer.from(hex, 'hex').toString('utf8') : opt(args, '-w')
    items.set(key, { value, mdat: Date.now() })
    return { status: 0, stdout: '', stderr: '' }
  }
  if (cmd === 'delete-generic-password') {
    if (!items.delete(key)) return { status: 44, stdout: '', stderr: NOT_FOUND }
    return { status: 0, stdout: '', stderr: '' }
  }
  return { status: 1, stdout: '', stderr: 'unknown command ' + cmd }
}

/** `security -i`: one command per line, quoted tokens, like the real shell. */
function interactive(input) {
  let last = { status: 0, stdout: '', stderr: '' }
  for (const line of String(input).split('\n').filter(Boolean)) {
    const toks = (line.match(/"[^"]*"|\S+/g) || []).map((t) => t.replace(/^"|"$/g, ''))
    last = exec(toks)
  }
  return last
}

const keychain = require('../lib/keychain.js')
keychain._test.setRunner((args, input) => {
  argvLog.push(args.slice())
  return args[0] === '-i' ? interactive(input) : exec(args)
})
// Nothing may reach the real `security`, or the real child_process for it.
const realExecFileSync = cp.execFileSync
cp.execFileSync = function (cmd, args, o) {
  if (cmd === 'security') throw new Error('test leak: security called outside keychain.js')
  return realExecFileSync.call(this, cmd, args, o)
}

const secrets = require('../lib/secrets.js')
const credstore = require('../lib/credstore.js')
const profiles = require('../lib/profiles.js')
const store = require('../lib/store.js')

let passed = 0
let failed = 0
function check(what, ok, extra) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what + (extra ? '  <- ' + extra : '')) }
}
function throws(fn, re) { try { fn(); return false } catch (e) { return re ? re.test(e.message) : true } }

const sha8 = (s) => crypto.createHash('sha256').update(s.normalize('NFC')).digest('hex').slice(0, 8)
const CC_DEFAULT = 'Claude Code-credentials'
const login = (rt) => ({ claudeAiOauth: { accessToken: 'AT-' + rt, refreshToken: 'RT-' + rt, expiresAt: Date.now() + 3600e3 } })

/** What Claude Code itself does on a Mac when it signs in. */
function claudeSignsIn(configDir, email, rt) {
  const svc = configDir ? CC_DEFAULT + '-' + sha8(configDir) : CC_DEFAULT
  items.set(svc + '\0someone', { value: JSON.stringify(login(rt)), mdat: Date.now() })
  const cfgFile = configDir ? path.join(configDir, '.claude.json') : path.join(HOME, '.claude.json')
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
  const prev = (() => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')) } catch { return {} } })()
  fs.writeFileSync(cfgFile, JSON.stringify({ ...prev, oauthAccount: { emailAddress: email, organizationName: 'Acme' }, userID: 'uid-' + rt }))
}
const secretsOnArgv = () => argvLog.filter((a) => a.some((t) => /RT-|AT-/.test(t) ||
  (/^[0-9a-f]{40,}$/.test(t) && /RT-/.test(Buffer.from(t, 'hex').toString('utf8')))))

try {
  console.log('\n-- the reported bug: login lives only in the Keychain --')
  store.ensureRoot(ROOT)
  fs.writeFileSync(path.join(HOME, '.claude.json'), JSON.stringify({ projects: { '/Users/someone/work': { history: ['keep me'] } } }))
  claudeSignsIn(null, 'mine@example.com', 'MINE')
  check('there is no .credentials.json at all', !fs.existsSync(path.join(HOME, '.claude', '.credentials.json')))
  check('a login is detected anyway (was: "No active Claude login found")', profiles.hasCurrentLogin(OPTS))
  const saved = profiles.capture(ROOT, 'mine', OPTS)
  check('Save Current Login works', saved.email === 'mine@example.com', JSON.stringify(saved))
  check('and captured the Keychain login', JSON.parse(secrets.unprotect(
    fs.readFileSync(path.join(ROOT, 'profiles', 'mine.enc'))).toString()).credentials.claudeAiOauth.refreshToken === 'RT-MINE')

  console.log('\n-- the item names match Claude Code exactly --')
  check('default login -> "Claude Code-credentials"', credstore.service(null, OPTS) === CC_DEFAULT)
  const dirW = store.configDir(ROOT, 'work')
  check('config dir -> suffix of sha256(dir)[:8]', credstore.service(dirW, OPTS) === CC_DEFAULT + '-' + sha8(dirW))
  check('account is $USER', credstore.account(OPTS) === 'someone')
  check('unusual $USER falls back like Claude Code does',
    credstore.account({ env: { USER: 'some one' } }) === 'claude-code-user')
  check('hash input is NFC-normalised', credstore.service('/Users/cafe\u0301', OPTS) === credstore.service('/Users/caf\u00e9', OPTS))
  check('CLAUDE_SECURESTORAGE_CONFIG_DIR overrides, as in Claude Code',
    credstore.service(dirW, { ...OPTS, env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/x' } }) === CC_DEFAULT + '-' + sha8('/x'))
  check('an empty override means the default item',
    credstore.service(dirW, { ...OPTS, env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' } }) === CC_DEFAULT)

  console.log('\n-- adding an account: Claude Code signs in to the account folder --')
  store.addAccount(ROOT, 'work')
  const before = Date.now()
  claudeSignsIn(dirW, 'work@example.com', 'WORK')
  const st = credstore.stat(dirW, OPTS)
  check('the login is seen where Claude Code put it', st.exists && st.where === 'keychain', JSON.stringify(st))
  check('with the Keychain timestamp', Math.abs(st.modifiedMs - before) < 2000, st.modifiedMs + ' vs ' + before)
  check('store.isAuthed agrees', store.isAuthed(ROOT, 'work'))
  profiles.importFromDir(ROOT, 'work', dirW, { move: true, ...OPTS })
  check('imported into the switcher', profiles.exists(ROOT, 'work'))
  check('the folder login is moved out of the Keychain, not copied', !items.has(CC_DEFAULT + '-' + sha8(dirW) + '\0someone'))
  check('so exactly one copy of the refresh token remains', !credstore.exists(dirW, OPTS))

  console.log('\n-- switching writes where Claude Code will read --')
  profiles.apply(ROOT, 'work', OPTS)
  const live = JSON.parse(items.get(CC_DEFAULT + '\0someone').value)
  check('the Keychain now holds work', live.claudeAiOauth.refreshToken === 'RT-WORK')
  check('no plaintext file was created', !fs.existsSync(path.join(HOME, '.claude', '.credentials.json')))
  const cfg = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'))
  check('identity swapped', cfg.oauthAccount.emailAddress === 'work@example.com')
  check('chat history untouched', cfg.projects['/Users/someone/work'].history[0] === 'keep me')
  check('activeProfile follows', profiles.activeProfile(ROOT, OPTS) === 'work')
  profiles.apply(ROOT, 'mine', OPTS)
  check('and back again', JSON.parse(items.get(CC_DEFAULT + '\0someone').value).claudeAiOauth.refreshToken === 'RT-MINE')
  check('no token ever appeared on a command line', secretsOnArgv().length === 0, JSON.stringify(secretsOnArgv()))
  check('writes went through `security -i`', argvLog.some((a) => a[0] === '-i'))

  console.log('\n-- the plaintext fallback Claude Code also uses --')
  items.delete(CC_DEFAULT + '\0someone')
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(HOME, '.claude', '.credentials.json'), JSON.stringify(login('FILE')))
  check('an empty Keychain falls back to the file', credstore.read(null, OPTS).claudeAiOauth.refreshToken === 'RT-FILE')
  items.set(CC_DEFAULT + '\0someone', { value: JSON.stringify(login('KC')), mdat: Date.now() })
  check('but the Keychain wins when both exist', credstore.read(null, OPTS).claudeAiOauth.refreshToken === 'RT-KC')
  items.delete(CC_DEFAULT + '\0someone')
  profiles.apply(ROOT, 'work', OPTS)
  check('first Keychain write migrates: stale file removed, as Claude Code does',
    !fs.existsSync(path.join(HOME, '.claude', '.credentials.json')))

  console.log('\n-- `security -w` may print hex; both forms parse --')
  const hexed = Buffer.from(JSON.stringify(login('HEX'))).toString('hex')
  check('hex value decodes', credstore.parseValue(hexed).claudeAiOauth.refreshToken === 'RT-HEX')
  check('plain value parses', credstore.parseValue(JSON.stringify(login('TXT'))).claudeAiOauth.refreshToken === 'RT-TXT')

  console.log('\n-- a locked Keychain fails loudly and changes nothing --')
  const idBefore = fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8')
  const kcBefore = items.get(CC_DEFAULT + '\0someone').value
  locked = true
  secrets._test.reset()
  check('detecting a login says the Keychain is locked', throws(() => profiles.hasCurrentLogin(OPTS), /locked/))
  check('Save Current Login says so too', throws(() => profiles.capture(ROOT, 'x', OPTS), /locked|Keychain/))
  check('switching fails', throws(() => profiles.apply(ROOT, 'mine', OPTS), /locked|Keychain/))
  locked = false
  check('identity was not half-switched', fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8') === idBefore)
  check('Keychain login untouched', items.get(CC_DEFAULT + '\0someone').value === kcBefore)
  check('and no stale file was served in its place', !fs.existsSync(path.join(HOME, '.claude', '.credentials.json')))

  console.log('\n-- our own encryption key --')
  secrets._test.reset()
  const keyItems = () => [...items.keys()].filter((k) => k.startsWith('claude-account-switcher\0'))
  check('exactly one key item', keyItems().length === 1, keyItems().join(','))
  const keyBefore = items.get(keyItems()[0]).value
  profiles.capture(ROOT, 'again', OPTS)
  check('reused, never regenerated', keyItems().length === 1 && items.get(keyItems()[0]).value === keyBefore)
  check('profiles are AES-sealed', secrets.isAesBlob(fs.readFileSync(path.join(ROOT, 'profiles', 'again.enc'))))
  locked = true
  secrets._test.reset()
  check('a locked Keychain never mints a replacement key',
    throws(() => secrets.protect(Buffer.from('x'))) && items.get(keyItems()[0]).value === keyBefore)
  locked = false

  console.log('\n-- forgetting an account removes its Keychain item --')
  store.addAccount(ROOT, 'temp')
  const dirT = store.configDir(ROOT, 'temp')
  claudeSignsIn(dirT, 't@example.com', 'TEMP')
  check('staged item exists', items.has(CC_DEFAULT + '-' + sha8(dirT) + '\0someone'))
  store.removeAccount(ROOT, 'temp')
  check('no refresh token left behind in the Keychain', !items.has(CC_DEFAULT + '-' + sha8(dirT) + '\0someone'))

  console.log('\n-- a Windows profile copied over explains itself --')
  fs.writeFileSync(path.join(ROOT, 'profiles', 'fromwin.enc'), Buffer.from('AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA', 'base64'))
  check('refused with a plain explanation', throws(() => profiles.apply(ROOT, 'fromwin', OPTS), /encrypted on Windows/))

  console.log('\n-- the terminal command zsh will actually receive --')
  const { invoke } = require('../lib/shell.js')
  const line = invoke('/Users/someone/.local/bin/claude', ['auth', 'login'])
  check("no leading '&' (the first reported error)", line === "'/Users/someone/.local/bin/claude' auth login", line)
  const sh = ['/bin/sh', 'C:\\Program Files\\Git\\bin\\sh.exe'].find((p) => fs.existsSync(p))
  if (sh) {
    const probe = invoke("/tmp/it's a path/echo-args", ['auth', 'login'])
    const parsed = realExecFileSync(sh, ['-c', 'set -- ' + probe + '; for a; do printf "[%s]" "$a"; done'], { encoding: 'utf8' })
    check('a real POSIX shell splits it into the right words', parsed === "[/tmp/it's a path/echo-args][auth][login]", parsed)
  } else {
    check('skipped: no POSIX shell on this machine', true)
  }
} finally {
  keychain._test.setRunner(null)
  cp.execFileSync = realExecFileSync
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  if (realUser === undefined) delete process.env.USER; else process.env.USER = realUser
  fs.rmSync(HOME, { recursive: true, force: true })
}

console.log('\n' + passed + ' passed, ' + failed + ' failed')
assert.strictEqual(failed, 0, 'macOS path tests failed')
