// Global-switch tests. Everything runs against a fake home directory, so the
// real ~/.claude is never read or written.
const fs = require('fs')
const os = require('os')
const path = require('path')

const profiles = require('../lib/profiles.js')

const TMP = path.join(os.tmpdir(), 'cs-prof-' + Date.now())
const HOME = path.join(TMP, 'home')
const ROOT = path.join(TMP, 'switcher')
const OPTS = { home: HOME }

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  <- ' + extra : '')) }
}

const P = profiles.paths(OPTS)

function writeLogin(email, org, token) {
  fs.mkdirSync(P.claudeDir, { recursive: true })
  fs.writeFileSync(P.credPath, JSON.stringify({
    claudeAiOauth: { accessToken: token, refreshToken: token + '-r', expiresAt: 123 },
    trustedDeviceToken: 'device-' + email,
  }))
}

function writeConfig(email, org, extra) {
  fs.writeFileSync(P.claudeJson, JSON.stringify({
    oauthAccount: { emailAddress: email, organizationName: org, seatTier: 'max' },
    userID: 'uid-' + email,
    // The things that MUST survive a switch:
    projects: { 'c:/work/repo': { history: ['chat-1', 'chat-2'], allowedTools: ['Bash'] } },
    numStartups: 42,
    tipsHistory: { 'some-tip': 1 },
    // The things that must be cleared as stale:
    cachedUsageUtilization: { accountUuid: 'uuid-' + email, utilization: {} },
    cachedArtifactRoster: { accountUuid: 'uuid-' + email },
    githubWebConnectionStatusCache: { accountUuid: 'uuid-' + email },
    // Keyed-by-uuid caches that should be left alone:
    groveConfigCache: { 'uuid-a': {}, 'uuid-b': {} },
    ...(extra || {}),
  }, null, 2))
}

function main() {
  fs.mkdirSync(HOME, { recursive: true })
  fs.mkdirSync(ROOT, { recursive: true })
  console.log('fake home:', HOME)

  console.log('\n-- capture account A --')
  writeLogin('a@example.com', 'Org A', 'TOKEN-A')
  writeConfig('a@example.com', 'Org A')
  check('sees a current login', profiles.hasCurrentLogin(OPTS))
  const capA = profiles.capture(ROOT, 'acctA', OPTS)
  check('captured identity', capA.email === 'a@example.com', JSON.stringify(capA))
  check('profile blob written', profiles.exists(ROOT, 'acctA'))
  const blob = fs.readFileSync(path.join(ROOT, 'profiles', 'acctA.enc'))
  check('blob is encrypted (no token in plaintext)', !blob.toString('utf8').includes('TOKEN-A'))
  check('sidecar meta is readable and non-secret', (() => {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'profiles', 'acctA.meta.json'), 'utf8'))
    return m.email === 'a@example.com' && !JSON.stringify(m).includes('TOKEN-A')
  })())

  console.log('\n-- log in as account B, capture it --')
  writeLogin('b@example.com', 'Org B', 'TOKEN-B')
  writeConfig('b@example.com', 'Org B')
  profiles.capture(ROOT, 'acctB', OPTS)
  check('two profiles listed', profiles.list(ROOT).length === 2,
    JSON.stringify(profiles.list(ROOT).map((p) => p.name)))
  check('active profile detected as B', profiles.activeProfile(ROOT, OPTS) === 'acctB',
    String(profiles.activeProfile(ROOT, OPTS)))

  console.log('\n-- add a conversation, then switch A -> verify nothing is lost --')
  const proj = path.join(P.claudeDir, 'projects', 'c--work-repo')
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, 'session-xyz.jsonl'), '{"msg":"my important chat"}\n')
  fs.mkdirSync(path.join(P.claudeDir, 'todos'), { recursive: true })
  fs.writeFileSync(path.join(P.claudeDir, 'todos', 't.json'), '{"todo":1}')

  const applied = profiles.apply(ROOT, 'acctA', OPTS)
  check('switch reports account A', applied.email === 'a@example.com', JSON.stringify(applied))

  const creds = JSON.parse(fs.readFileSync(P.credPath, 'utf8'))
  check('credentials are now A', creds.claudeAiOauth.accessToken === 'TOKEN-A',
    creds.claudeAiOauth.accessToken)
  check('trustedDeviceToken swapped too', creds.trustedDeviceToken === 'device-a@example.com')

  const cfg = JSON.parse(fs.readFileSync(P.claudeJson, 'utf8'))
  check('oauthAccount is now A', cfg.oauthAccount.emailAddress === 'a@example.com')
  check('userID swapped', cfg.userID === 'uid-a@example.com', cfg.userID)

  // The whole point of the global design:
  check('CONVERSATION FILE SURVIVES',
    fs.readFileSync(path.join(proj, 'session-xyz.jsonl'), 'utf8').includes('my important chat'))
  check('project history survives',
    cfg.projects['c:/work/repo'].history.length === 2, JSON.stringify(cfg.projects))
  check('allowedTools survive', cfg.projects['c:/work/repo'].allowedTools[0] === 'Bash')
  check('todos survive', fs.existsSync(path.join(P.claudeDir, 'todos', 't.json')))
  check('unrelated machine state survives', cfg.numStartups === 42 && !!cfg.tipsHistory)

  console.log('\n-- stale account caches cleared --')
  check('cachedUsageUtilization cleared', cfg.cachedUsageUtilization === undefined)
  check('cachedArtifactRoster cleared', cfg.cachedArtifactRoster === undefined)
  check('githubWebConnectionStatusCache cleared', cfg.githubWebConnectionStatusCache === undefined)
  check('uuid-keyed cache left intact', !!cfg.groveConfigCache && Object.keys(cfg.groveConfigCache).length === 2)

  console.log('\n-- switch back to B --')
  profiles.apply(ROOT, 'acctB', OPTS)
  const creds2 = JSON.parse(fs.readFileSync(P.credPath, 'utf8'))
  const cfg2 = JSON.parse(fs.readFileSync(P.claudeJson, 'utf8'))
  check('credentials are B again', creds2.claudeAiOauth.accessToken === 'TOKEN-B')
  check('identity is B again', cfg2.oauthAccount.emailAddress === 'b@example.com')
  check('conversation still there after 2 switches',
    fs.existsSync(path.join(proj, 'session-xyz.jsonl')))
  check('project history still there', cfg2.projects['c:/work/repo'].history.length === 2)

  console.log('\n-- refresh capture does not lose a rotated token --')
  writeLogin('b@example.com', 'Org B', 'TOKEN-B-ROTATED')
  profiles.capture(ROOT, 'acctB', OPTS)          // re-capture before switching away
  profiles.apply(ROOT, 'acctA', OPTS)
  profiles.apply(ROOT, 'acctB', OPTS)
  const creds3 = JSON.parse(fs.readFileSync(P.credPath, 'utf8'))
  check('rotated token preserved through a round trip',
    creds3.claudeAiOauth.accessToken === 'TOKEN-B-ROTATED', creds3.claudeAiOauth.accessToken)

  console.log('\n-- remove a profile --')
  profiles.remove(ROOT, 'acctA')
  check('profile gone', !profiles.exists(ROOT, 'acctA'))
  check('meta gone', !fs.existsSync(path.join(ROOT, 'profiles', 'acctA.meta.json')))
  check('live login untouched by removal', fs.existsSync(P.credPath))

  console.log('\n-- importFromDir: move a staged login into a profile --')
  const stage = path.join(TMP, 'stage-c')
  fs.mkdirSync(stage, { recursive: true })
  fs.writeFileSync(path.join(stage, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'TOKEN-C', refreshToken: 'REFRESH-C' },
  }))
  fs.writeFileSync(path.join(stage, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'c@example.com', organizationName: 'Org C' }, userID: 'uid-c',
    projects: { should: 'not be copied' },
  }))
  const imp = profiles.importFromDir(ROOT, 'acctC', stage, { move: true })
  check('import reports identity', imp.email === 'c@example.com', JSON.stringify(imp))
  check('profile created', profiles.exists(ROOT, 'acctC'))
  check('source credentials removed after verified copy', !fs.existsSync(path.join(stage, '.credentials.json')))
  check('source config left in place', fs.existsSync(path.join(stage, '.claude.json')))
  check('encrypted blob holds no plaintext token',
    !fs.readFileSync(path.join(ROOT, 'profiles', 'acctC.enc')).toString('utf8').includes('TOKEN-C'))

  profiles.apply(ROOT, 'acctC', OPTS)
  const credsC = JSON.parse(fs.readFileSync(P.credPath, 'utf8'))
  const cfgC = JSON.parse(fs.readFileSync(P.claudeJson, 'utf8'))
  check('imported profile applies as the live login', credsC.claudeAiOauth.accessToken === 'TOKEN-C')
  check('staged project state was not carried over', cfgC.projects && !cfgC.projects.should)

  console.log('\n-- importFromDir: copy mode keeps the source --')
  const stageD = path.join(TMP, 'stage-d')
  fs.mkdirSync(stageD, { recursive: true })
  fs.writeFileSync(path.join(stageD, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'TOKEN-D', refreshToken: 'REFRESH-D' },
  }))
  profiles.importFromDir(ROOT, 'acctD', stageD, { fallback: { email: 'd@example.com', org: 'Org D' } })
  check('copy mode leaves the source login', fs.existsSync(path.join(stageD, '.credentials.json')))
  check('fallback identity used when .claude.json is missing',
    (profiles.list(ROOT).find((p) => p.name === 'acctD') || {}).email === 'd@example.com')

  console.log('\n-- importFromDir: nothing to import --')
  let threw = false
  try { profiles.importFromDir(ROOT, 'acctE', path.join(TMP, 'no-such-dir'), { move: true }) } catch { threw = true }
  check('throws when the folder has no login', threw)
  check('no empty profile left behind', !profiles.exists(ROOT, 'acctE'))

  console.log('\n-- findByEmail / capturedAt --')
  check('finds the profile holding an email', profiles.findByEmail(ROOT, 'c@example.com') === 'acctC')
  check('ignores the excluded name', profiles.findByEmail(ROOT, 'c@example.com', 'acctC') === null)
  check('unknown email finds nothing', profiles.findByEmail(ROOT, 'nobody@example.com') === null)
  check('capturedAt is a recent timestamp', Date.now() - profiles.capturedAt(ROOT, 'acctC') < 60000)
  console.log('\n-- remote control switch writes settings.json safely --')
  const remote = require('../lib/remote.js')
  const settingsFile = remote.settingsPath(OPTS)
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify({
    env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_HEADERS: 'secret-header' },
    hooks: { SessionEnd: [{ matcher: '*', hooks: [{ type: 'command', command: 'relay.bat' }] }] },
    theme: 'dark',
    remoteControlAtStartup: true,
  }, null, 2))

  check('starts enabled', remote.isDisabled(OPTS) === false)

  const off = remote.setDisabled(true, OPTS)
  check('reports the change', off.changed === true && off.disabled === true)
  check('flag written', remote.isDisabled(OPTS) === true)
  const afterOff = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  check('disableRemoteControl set to true', afterOff.disableRemoteControl === true)
  check('hooks preserved', afterOff.hooks.SessionEnd[0].hooks[0].command === 'relay.bat')
  check('env preserved', afterOff.env.OTEL_EXPORTER_OTLP_HEADERS === 'secret-header')
  check('other settings preserved', afterOff.theme === 'dark' && afterOff.remoteControlAtStartup === true)

  check('setting it again is a no-op', remote.setDisabled(true, OPTS).changed === false)

  const on = remote.setDisabled(false, OPTS)
  check('turning it back on reports a change', on.changed === true && on.disabled === false)
  const afterOn = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  check('flag removed rather than left as false', !('disableRemoteControl' in afterOn))
  check('everything else still intact',
    afterOn.theme === 'dark' && afterOn.env.CLAUDE_CODE_ENABLE_TELEMETRY === '1' &&
    afterOn.hooks.SessionEnd[0].hooks[0].command === 'relay.bat')
  check('no temp files left behind',
    fs.readdirSync(path.dirname(settingsFile)).every((f) => !f.includes('.tmp-')))

  console.log('\n-- remote control preference is per account --')
  const store2 = require('../lib/store.js')
  store2.setRemote(ROOT, 'acctB', 'off')
  check('stored for one account', store2.getRemote(ROOT, 'acctB') === 'off')
  check('other accounts unaffected', store2.getRemote(ROOT, 'acctC') === 'on')
  check('survives a registry round trip',
    JSON.parse(fs.readFileSync(path.join(ROOT, 'registry.json'), 'utf8')).remote.acctB === 'off')
  store2.setRemote(ROOT, 'acctB', 'on')
  check('clearing removes the entry',
    !JSON.parse(fs.readFileSync(path.join(ROOT, 'registry.json'), 'utf8')).remote.acctB)

  console.log('\n-- a missing settings.json is created, not crashed on --')
  fs.rmSync(settingsFile, { force: true })
  check('reads as enabled when absent', remote.isDisabled(OPTS) === false)
  remote.setDisabled(true, OPTS)
  check('creates the file with just the flag', (() => {
    const j = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    return j.disableRemoteControl === true && Object.keys(j).length === 1
  })())
  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====')
  fs.rmSync(TMP, { recursive: true, force: true })
  process.exit(fail ? 1 : 0)
}

main()
