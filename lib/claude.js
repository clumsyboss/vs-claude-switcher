const cp = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

let cached

/** Locate the claude launcher. Prefers the native .exe so we can spawn without a shell. */
function resolveBin() {
  if (cached !== undefined) return cached
  const candidates = [
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules',
      '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
  ]
  for (const c of candidates) if (fs.existsSync(c)) return (cached = c)
  try {
    const out = cp.execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    })
    const hit = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .sort((a, b) => (b.endsWith('.exe') ? 1 : 0) - (a.endsWith('.exe') ? 1 : 0))[0]
    if (hit) return (cached = hit)
  } catch { /* fall through */ }
  return (cached = null)
}

function envFor(configDir, extra) {
  return { ...process.env, CLAUDE_CONFIG_DIR: configDir, ...(extra || {}) }
}

/**
 * Read auth status for one isolated config dir. Never returns token material.
 * Note: `claude auth status --json` exits 1 when logged out but still prints
 * valid JSON, so the exit code is deliberately ignored in favour of stdout.
 */
function authStatus(configDir, timeout = 30000) {
  const bin = resolveBin()
  if (!bin) return { ok: false, error: 'claude CLI not found on PATH' }
  const r = cp.spawnSync(bin, ['auth', 'status', '--json'], {
    env: envFor(configDir), encoding: 'utf8', windowsHide: true, timeout,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
  })
  if (r.error) return { ok: false, error: r.error.message }
  let j
  try { j = JSON.parse((r.stdout || '').trim()) } catch {
    return { ok: false, error: (r.stderr || '').trim() || `claude exited ${r.status}` }
  }
  return {
    ok: true,
    loggedIn: !!j.loggedIn,
    email: j.email || null,
    orgName: j.orgName || null,
    subscriptionType: j.subscriptionType || null,
    authMethod: j.authMethod || null,
  }
}

module.exports = { resolveBin, envFor, authStatus }
