const os = require('os')
const path = require('path')
const https = require('https')

const credstore = require('./credstore')

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
  try { j = credstore.read(configDir) } catch { return null }
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
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers || {} }))
    })
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }))
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '', error: 'timed out' }) })
    req.end()
  })
}

/** Retry-After is either seconds or an HTTP date. */
function retryAfterMs(headers, now) {
  const v = headers && (headers['retry-after'] || headers['Retry-After'])
  if (!v) return 0
  const secs = Number(v)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const at = Date.parse(v)
  return Number.isNaN(at) ? 0 : Math.max(0, at - (now || Date.now()))
}

/**
 * Turn a raw response into a result. Pure, so every branch is testable.
 *
 * A 200 is not proof of data: the endpoint sometimes answers a refused request
 * with 200 and an error in the body — Claude Code logs these as "fieldless or
 * non-object body (in-band error)". Accepting one used to overwrite the good
 * cached figures with an empty record and blank the meter.
 */
function interpret(res, now) {
  if (res.status === 200) {
    let body
    try { body = JSON.parse(res.body) } catch {
      return { ok: false, reason: 'could not parse the response' }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, reason: 'the server sent no usage data (in-band error)' }
    }
    if (body.type === 'error' || body.error) {
      const e = body.error || {}
      const what = e.type === 'rate_limit_error' ? 'rate-limited' : (e.message || e.type || 'an error')
      return {
        ok: false,
        reason: 'the server answered with ' + what + ' instead of usage data',
        rateLimited: e.type === 'rate_limit_error',
        retryAfterMs: retryAfterMs(res.headers, now),
      }
    }
    if (!Array.isArray(body.limits)) {
      return { ok: false, reason: 'the server sent no usage data (in-band error)' }
    }
    return { ok: true, utilization: body }
  }
  if (res.status === 429) {
    return {
      ok: false,
      rateLimited: true,
      retryAfterMs: retryAfterMs(res.headers, now),
      reason: 'Anthropic is rate-limiting usage checks for this account (HTTP 429)',
    }
  }
  if (res.status === 401) return { ok: false, reason: 'not authorised (401) — token may need refreshing' }
  if (res.status === 0) return { ok: false, reason: res.error || 'network error' }
  return { ok: false, reason: 'server returned HTTP ' + res.status }
}

/**
 * @returns {Promise<{ok:boolean, utilization?:object, reason?:string,
 *                    rateLimited?:boolean, retryAfterMs?:number}>}
 * `utilization` matches the shape stored in .claude.json's
 * cachedUsageUtilization.utilization, so existing parsing applies unchanged.
 */
async function fetchUsage(configDir, timeoutMs) {
  const cred = readToken(configDir)
  if (!cred) return { ok: false, reason: 'no saved login for this account' }
  if (cred.expiresAt && Date.now() > cred.expiresAt) {
    return { ok: false, reason: 'access token expired — run Claude once to refresh it' }
  }
  return interpret(await request(cred.token, timeoutMs || 10000))
}

module.exports = { fetchUsage, credentialPath, interpret, retryAfterMs }
