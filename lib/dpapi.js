const cp = require('child_process')

/**
 * DPAPI (CurrentUser scope) via PowerShell's ProtectedData — no native modules.
 * Blobs are decryptable only by this Windows user on this machine, so a copied
 * backup file is inert elsewhere.
 */
const PROTECT = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security | Out-Null
$in=[Console]::In.ReadToEnd()
$bytes=[Convert]::FromBase64String($in)
$out=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($out))
`

const UNPROTECT = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security | Out-Null
$in=[Console]::In.ReadToEnd()
$bytes=[Convert]::FromBase64String($in)
$out=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($out))
`

function run(script, inputB64) {
  return cp.execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { input: inputB64, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 32 * 1024 * 1024 },
  ).trim()
}

function available() { return process.platform === 'win32' }

/** @param {Buffer} buf @returns {Buffer} DPAPI blob */
function protect(buf) {
  if (!available()) throw new Error('DPAPI is only available on Windows.')
  return Buffer.from(run(PROTECT, buf.toString('base64')), 'base64')
}

/** @param {Buffer} blob @returns {Buffer} plaintext */
function unprotect(blob) {
  if (!available()) throw new Error('DPAPI is only available on Windows.')
  return Buffer.from(run(UNPROTECT, blob.toString('base64')), 'base64')
}

module.exports = { protect, unprotect, available }
