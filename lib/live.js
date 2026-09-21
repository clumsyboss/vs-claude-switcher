const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')

/**
 * Live usage fetch against the same endpoint Claude Code uses.
 *
 * Deliberately read-only with the existing access token: no refresh is
 * attempted here. Refreshing rotates the token and rewrites the credential
 * file, and getting that wrong would sign the user out — Claude Code already
 * refreshes on its own schedule, so an expired token just falls back to cache.
 */

const HOST = 'api.anthropic.com'
const ENDPOINT = '/api/oauth/usage'

function credentialPath(configDir) {
  const dir = configDir || path.join(os.homedir(), '.claude')
  return path.join(dir, '.credentials.json')
}

/** Read the access token without ever returning or logging it. */
function readToken(configDir) {
  let j
  try { j = JSON.parse(fs.readFileSync(credentialPath(configDir), 'utf8')) } catch { return null }
  const o = j && j.claudeAiOauth
  if (!o || !o.accessToken) return null
  return { token: o.accessToken, expiresAt: o.expiresAt || 0 }
}

function request(token, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: HOST,
      path: ENDPOINT,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timed out' }) })
    req.end()
  })
}

/**
 * @returns {Promise<{ok:boolean, utilization?:object, reason?:string}>}
 * `utilization` matches the shape stored in .claude.json's
 * cachedUsageUtilization.utilization, so existing parsing applies unchanged.
 */
async function fetchUsage(configDir, timeoutMs) {
  const cred = readToken(configDir)
  if (!cred) return { ok: false, reason: 'no saved login for this account' }
  if (cred.expiresAt && Date.now() > cred.expiresAt) {
    return { ok: false, reason: 'access token expired — run Claude once to refresh it' }
  }

  const res = await request(cred.token, timeoutMs || 10000)
  if (res.status === 200) {
    try {
      return { ok: true, utilization: JSON.parse(res.body) }
    } catch {
      return { ok: false, reason: 'could not parse the response' }
    }
  }
  if (res.status === 401) return { ok: false, reason: 'not authorised (401) — token may need refreshing' }
  if (res.status === 0) return { ok: false, reason: res.error || 'network error' }
  return { ok: false, reason: 'server returned HTTP ' + res.status }
}

module.exports = { fetchUsage, credentialPath }
