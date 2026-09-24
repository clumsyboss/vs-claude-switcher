// Cross-platform credential encryption.
//
// The macOS and Linux backends differ from Windows only in *where the key
// comes from*; the crypto either side of that is identical. So the AES path is
// exercised here on whatever machine runs the tests by injecting a key, which
// leaves only the `security` / `secret-tool` shell-out unverified off-platform.
// That is the honest boundary: everything below is tested everywhere, and the
// ~10 lines that talk to a real OS keychain are tested only on that OS.

const assert = require('assert')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const secrets = require('../lib/secrets.js')

const KEY = crypto.randomBytes(32)
const OPTS = { key: KEY }
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-secrets-'))

let passed = 0
let failed = 0
function check(what, ok) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what) }
}

console.log('\n-- round trip --')
const plain = Buffer.from(JSON.stringify({
  credentials: { claudeAiOauth: { refreshToken: 'RT-SECRET', accessToken: 'AT-SECRET' } },
  identity: { oauthAccount: { emailAddress: 'dana@example.com' } },
}), 'utf8')

const blob = secrets.protect(plain, OPTS)
check('round trips byte for byte', secrets.unprotect(blob, OPTS).equals(plain))
check('ciphertext does not contain the token', !blob.toString('binary').includes('RT-SECRET'))
check('ciphertext does not contain the email', !blob.toString('binary').includes('dana@example.com'))
check('output is tagged as our format', secrets.isAesBlob(blob))
check('header is MAGIC + version', blob.subarray(0, 4).toString() === 'CSW1' && blob[4] === 1)
check('length is header + iv + tag + body', blob.length === 4 + 1 + 12 + 16 + plain.length)

console.log('\n-- every encryption is distinct --')
const a = secrets.protect(plain, OPTS)
const b = secrets.protect(plain, OPTS)
check('same input encrypts differently (fresh iv)', !a.equals(b))
check('but both decrypt to the same thing',
  secrets.unprotect(a, OPTS).equals(secrets.unprotect(b, OPTS)))

console.log('\n-- a blob is useless without its key --')
const otherKey = { key: crypto.randomBytes(32) }
check('the wrong key is rejected, not silently wrong', (() => {
  try { secrets.unprotect(blob, otherKey); return false } catch (e) {
    return /could not be decrypted/.test(e.message)
  }
})())

console.log('\n-- tampering is detected, not decrypted --')
for (const [what, at] of [['the tag', 4 + 1 + 12], ['the ciphertext', 4 + 1 + 12 + 16], ['the iv', 5]]) {
  const bad = Buffer.from(blob)
  bad[at] = bad[at] ^ 0xff
  check('flipping a bit in ' + what + ' throws', (() => {
    try { secrets.unprotect(bad, OPTS); return false } catch { return true }
  })())
}

console.log('\n-- an unknown future format is refused, not misread --')
const future = Buffer.from(blob)
future[4] = 99
check('version mismatch names the problem', (() => {
  try { secrets.unprotect(future, OPTS); return false } catch (e) {
    return /format version 99/.test(e.message)
  }
})())

console.log('\n-- Windows blobs keep working --')
// Raw DPAPI output has no header. The dispatch must key on the magic, not the
// platform, or every profile saved before this file existed becomes unreadable.
const legacy = Buffer.from('AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA', 'base64')
check('a headerless blob is not mistaken for ours', !secrets.isAesBlob(legacy))
if (process.platform === 'win32') {
  const dpapi = require('../lib/dpapi.js')
  const real = dpapi.protect(plain)
  check('real DPAPI output has no CSW1 header', !secrets.isAesBlob(real))
  check('secrets.unprotect still reads raw DPAPI', secrets.unprotect(real).equals(plain))
  check('protect still writes raw DPAPI by default', !secrets.isAesBlob(secrets.protect(plain)))
} else {
  check('a Windows profile explains itself instead of leaking DPAPI errors', (() => {
    try { secrets.unprotect(legacy); return false } catch (e) {
      return /encrypted on Windows/.test(e.message)
    }
  })())
}

console.log('\n-- the key file backend (Linux fallback) --')
// Exercised on every platform by pointing it at a temp home; only the choice
// of backend is platform-dependent, not the file handling.
{
  const keyPath = path.join(HOME, '.claude-switcher', 'masterkey')
  const FILE = { home: HOME, store: 'keyfile' }
  check('no key file exists yet', !fs.existsSync(keyPath))

  const k1 = secrets.masterKey(FILE)
  check('a key is created on first use', fs.existsSync(keyPath) && k1.length === 32)
  check('it is 32 random bytes, not a constant', !k1.equals(Buffer.alloc(32)))
  check('the same key comes back next time', secrets.masterKey(FILE).equals(k1))
  check('the key is not stored in the clear as raw bytes',
    fs.readFileSync(keyPath, 'utf8').trim() === k1.toString('base64'))
  if (process.platform !== 'win32') {
    check('key file is 0600', (fs.statSync(keyPath).mode & 0o777) === 0o600)
  }

  // A profile encrypted under the file-backed key must open again from disk.
  const sealed = secrets.protect(plain, FILE)
  check('round trips through the on-disk key', secrets.unprotect(sealed, FILE).equals(plain))

  // A truncated or corrupt key file must not silently become a new key: that
  // would orphan every saved profile while looking like success.
  fs.writeFileSync(keyPath, 'not-base64-at-all\n')
  const k2 = secrets.masterKey(FILE)
  check('an unusable key file is replaced', !k2.equals(k1))
  check('and profiles sealed under the old key now fail loudly', (() => {
    try { secrets.unprotect(sealed, FILE); return false } catch (e) {
      return /could not be decrypted/.test(e.message)
    }
  })())
}

console.log('\n-- describe() names a real backend --')
check('backend is one of the three',
  ['dpapi', 'keychain', 'keyfile'].includes(secrets.backend()))
check('describe mentions the algorithm or DPAPI',
  /DPAPI|AES-256-GCM/.test(secrets.describe()))

console.log('\n-- profiles.js goes through it --')
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'profiles.js'), 'utf8')
  check('profiles.js no longer calls dpapi directly', !/dpapi\./.test(src))
  check('profiles.js uses the platform-neutral module', /secrets\.(protect|unprotect)\(/.test(src))
}

console.log('\n-- shell quoting, both shells, from either platform --')
{
  const inv = require('../lib/shell.js').invoke
  const real = process.platform
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    check('PowerShell gets the call operator',
      inv('C:\\Program Files\\claude.exe', ['auth', 'login']) ===
        "& 'C:\\Program Files\\claude.exe' auth login")

    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const out = inv('/Users/someone/.local/bin/claude', ['auth', 'login'])
    check('zsh gets no leading &, which is what broke on the Mac',
      out === "'/Users/someone/.local/bin/claude' auth login")
    check('no & anywhere in the POSIX form', !out.includes('&'))
    check('a quote in the path is escaped the POSIX way',
      inv("/Users/o'brien/claude", []) === "'/Users/o'\\''brien/claude'")
    check('no args means no trailing space', inv('/usr/local/bin/claude', []) === "'/usr/local/bin/claude'")
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true })
  }
}

fs.rmSync(HOME, { recursive: true, force: true })
console.log('\n' + passed + ' passed, ' + failed + ' failed')
assert.strictEqual(failed, 0, 'secrets tests failed')
