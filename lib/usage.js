const fs = require('fs')
const os = require('os')
const path = require('path')

/**
 * Claude Code writes .claude.json inside CLAUDE_CONFIG_DIR when that is set,
 * and at ~/.claude.json when it is not. Pass null for the default login.
 */
function claudeJsonPath(configDir) {
  return configDir
    ? path.join(configDir, '.claude.json')
    : path.join(os.homedir(), '.claude.json')
}

/**
 * Read the usage percentages Claude Code caches after each request.
 * This is a cache, not a live query: an account that has not run recently
 * reports stale numbers, which is why `fetchedAtMs` is surfaced to callers.
 */
function shape(cached) {
  const u = cached && cached.utilization
  if (!u) return null

  const limits = Array.isArray(u.limits) ? u.limits : []
  const session = limits.find((l) => l.kind === 'session') || null
  const weekly = limits.find((l) => l.kind === 'weekly_all') || null
  const scoped = limits
    .filter((l) => l.kind === 'weekly_scoped')
    .sort((a, b) => (b.percent || 0) - (a.percent || 0))

  return {
    fetchedAtMs: cached.fetchedAtMs || null,
    session,
    weekly,
    scoped,
    extra: u.extra_usage && u.extra_usage.is_enabled ? u.extra_usage : null,
  }
}

function readUsage(configDir) {
  try {
    const j = JSON.parse(fs.readFileSync(claudeJsonPath(configDir), 'utf8'))
    return shape(j && j.cachedUsageUtilization)
  } catch {
    return null
  }
}

/**
 * Live results are cached in our own directory rather than written back into
 * .claude.json: that file holds project history and settings, and a
 * read-modify-write race with Claude Code could lose them.
 */
function accountKey(configDir) {
  try {
    const j = JSON.parse(fs.readFileSync(claudeJsonPath(configDir), 'utf8'))
    const o = j && j.oauthAccount
    if (o && o.accountUuid) return String(o.accountUuid).replace(/[^A-Za-z0-9_.-]/g, '')
  } catch { /* fall through */ }
  return 'default'
}

function cachePath(root, configDir) {
  return path.join(root, 'usage', accountKey(configDir) + '.json')
}

function writeLiveCache(root, configDir, utilization) {
  const file = cachePath(root, configDir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify({ fetchedAtMs: Date.now(), utilization }))
  fs.renameSync(tmp, file)
}

function readLiveCache(root, configDir) {
  try {
    return shape(JSON.parse(fs.readFileSync(cachePath(root, configDir), 'utf8')))
  } catch {
    return null
  }
}

/** Whichever of the two caches is more recent. */
function readBest(root, configDir) {
  const claudeSide = readUsage(configDir)
  const liveSide = root ? readLiveCache(root, configDir) : null
  if (claudeSide) claudeSide.source = 'claude'
  if (liveSide) liveSide.source = 'live'
  if (!claudeSide) return liveSide
  if (!liveSide) return claudeSide
  return (liveSide.fetchedAtMs || 0) >= (claudeSide.fetchedAtMs || 0) ? liveSide : claudeSide
}

function modelName(limit) {
  const m = limit && limit.scope && limit.scope.model
  return (m && m.display_name) || 'scoped'
}

const pct = (l) => (l && typeof l.percent === 'number' ? Math.round(l.percent) : null)

/** "53% | 22% | 37%" — session, top scoped model, weekly. Missing parts become "–". */
function compactText(usage) {
  if (!usage) return null
  const cells = [pct(usage.session), pct(usage.scoped[0]), pct(usage.weekly)]
  if (cells.every((c) => c === null)) return null
  return cells.map((c) => (c === null ? '–' : c + '%')).join(' | ')
}

/** Highest percentage across the headline limits, for severity colouring. */
function peak(usage) {
  if (!usage) return 0
  return Math.max(0, ...[usage.session, usage.weekly, ...usage.scoped]
    .map(pct).filter((n) => n !== null))
}

function relTime(ms) {
  if (!ms) return 'unknown'
  const d = Math.abs(Date.now() - ms)
  const mins = Math.round(d / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return mins + ' min ago'
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago')
  const days = Math.round(hrs / 24)
  return days + (days === 1 ? ' day ago' : ' days ago')
}

function untilTime(iso) {
  if (!iso) return null
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  let mins = Math.round((t - Date.now()) / 60000)
  if (mins <= 0) return 'now'
  const days = Math.floor(mins / 1440); mins -= days * 1440
  const hrs = Math.floor(mins / 60); mins -= hrs * 60
  return [days ? days + 'd' : null, hrs ? hrs + 'h' : null,
    !days && mins ? mins + 'm' : null].filter(Boolean).join(' ') || 'now'
}

/** Markdown rows explaining each number in plain language. */
function detailLines(usage) {
  if (!usage) return ['Usage data not available yet for this account.']
  const row = (label, limit) => {
    const p = pct(limit)
    if (p === null) return null
    const resets = untilTime(limit.resets_at)
    return '`' + String(p).padStart(3) + '%`  ' + label + (resets ? '  — resets in ' + resets : '')
  }
  const lines = [
    row('Session (5 hour)', usage.session),
    ...usage.scoped.map((s) => row(modelName(s) + ' (weekly)', s)),
    row('Weekly (all models)', usage.weekly),
  ].filter(Boolean)

  if (usage.extra) {
    const e = usage.extra
    const dp = typeof e.decimal_places === 'number' ? e.decimal_places : 2
    const money = (c) => '$' + (c / Math.pow(10, dp)).toFixed(dp)
    lines.push('`' + String(Math.round(e.utilization)).padStart(3) + '%`  Extra usage — ' +
      money(e.used_credits) + ' of ' + money(e.monthly_limit))
  }
  lines.push('')
  lines.push(usage.source === 'live'
    ? '_Fetched live ' + relTime(usage.fetchedAtMs) + '. Click to refresh again._'
    : '_Cached by Claude Code ' + relTime(usage.fetchedAtMs) + '. Click to fetch live._')
  return lines
}

module.exports = {
  readUsage, readBest, readLiveCache, writeLiveCache, cachePath, accountKey,
  compactText, detailLines, peak, claudeJsonPath, modelName, shape,
}
