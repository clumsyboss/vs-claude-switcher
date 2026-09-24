// Integration harness: runs the real extension against a mocked `vscode` API
// and a throwaway root, so nothing touches ~/.claude or ~/.claude-switcher.
const Module = require('module')
const fs = require('fs')
const os = require('os')
const path = require('path')

const TEST_ROOT = path.join(os.tmpdir(), 'cs-test-' + Date.now())

// Point os.homedir() at a throwaway directory so no test can read or write
// the real ~/.claude or ~/.claude.json.
const FAKE_HOME = TEST_ROOT + '-home'
fs.mkdirSync(FAKE_HOME, { recursive: true })
process.env.USERPROFILE = FAKE_HOME
process.env.HOME = FAKE_HOME

// ---- queued user responses -------------------------------------------------
const q = { input: [], quick: [], info: [], warn: [] }
const shift = (a, name) => {
  if (!a.length) throw new Error('harness: no queued response for ' + name)
  return a.shift()
}

let settings = { claudeCode: {}, claudeswitcher: { root: TEST_ROOT, reloadPrompt: false } }
const terminals = []
const executed = []
const registered = {}
const messages = []

// Capture spawned windows instead of actually launching VS Code.
const cp = require('child_process')
const spawned = []
const realSpawn = cp.spawn
cp.spawn = function (bin, args, opts) {
  spawned.push({ bin, args, env: (opts && opts.env) || {} })
  return { unref() {}, on() {} }
}

const bars = []

const vscode = {
  env: { appRoot: path.join(os.tmpdir(), 'no-such-approot', 'resources', 'app') },
  StatusBarAlignment: { Right: 2 },
  ProgressLocation: { Notification: 15 },
  ConfigurationTarget: { Global: 1 },
  ThemeColor: class { constructor(id) { this.id = id } },
  ThemeIcon: class { constructor(id) { this.id = id } },
  MarkdownString: class { constructor(v) { this.value = v } },
  Uri: { file: (p) => ({ fsPath: p }) },
  window: {
    createOutputChannel: () => ({
      appendLine: (l) => messages.push('OUT: ' + l), show() {}, dispose() {},
    }),
    // Two bars are created: [0] account, [1] usage. Keep their state separate.
    createStatusBarItem: () => {
      const s = {}
      bars.push(s)
      return {
        show() { s.shown = true },
        hide() {}, dispose() {},
        set text(v) { s.text = v },
        get text() { return s.text },
        set tooltip(v) { s.tooltip = v && v.value ? v.value : v },
        get tooltip() { return s.tooltip },
        set backgroundColor(v) { s.bg = v },
        get backgroundColor() { return s.bg },
        set command(v) { s.command = v },
        set name(v) { s.name = v },
      }
    },
    showOpenDialog: async () => undefined,
    onDidChangeWindowState: () => ({ dispose() {} }),
    showTextDocument: async () => ({}),
    createTerminal: (opts) => {
      const t = { opts, sent: [], show() {}, sendText(s) { t.sent.push(s) }, dispose() {} }
      terminals.push(t)
      return t
    },
    showInputBox: async () => shift(q.input, 'showInputBox'),
    showQuickPick: async (items) => {
      const want = shift(q.quick, 'showQuickPick')
      if (want === null) return undefined
      const list = await items
      return list.find((i) => (i.name || i) === want || (i.label || '').includes(want)) || want
    },
    showInformationMessage: async (m) => { messages.push('INFO: ' + m); return shift(q.info, 'info') },
    showWarningMessage: async (m) => { messages.push('WARN: ' + m); return shift(q.warn, 'warn') },
    showErrorMessage: async (m) => { messages.push('ERROR: ' + m) },
    withProgress: async (_o, fn) => fn({ report() {} }),
  },
  commands: {
    registerCommand: (id, fn) => { registered[id] = fn; return { dispose() {} } },
    executeCommand: async (id) => { executed.push(id) },
  },
  workspace: {
    getConfiguration: (section) => ({
      get: (key) => (settings[section] || {})[key],
      update: async (key, val) => { settings[section] = { ...(settings[section] || {}), [key]: val } },
      inspect: () => undefined,
    }),
    workspaceFolders: [],
    onDidChangeConfiguration: () => ({ dispose() {} }),
    openTextDocument: async (uri) => ({ uri }),
  },
}

const origLoad = Module._load
Module._load = function (req, parent, isMain) {
  if (req === 'vscode') return vscode
  return origLoad.call(this, req, parent, isMain)
}

// ---- run -------------------------------------------------------------------
const ext = require('../extension.js')
const store = require('../lib/store.js')
const liveLib = require('../lib/live.js')

// Never spawn the real CLI from tests; login tests set what it reports.
const claudeLib = require('../lib/claude.js')
let authMock = { ok: false, error: 'mocked' }
claudeLib.authStatus = () => authMock
ext._test.setLoginPollMs(20)

// Never touch the network from tests; each test sets the next response.
let nextFetch = { ok: false, reason: 'mocked offline' }
liveLib.fetchUsage = async () => nextFetch

let pass = 0, fail = 0
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label) }
  else { fail++; console.log('  FAIL  ' + label + (extra ? '  <- ' + extra : '')) }
}

async function main() {
  console.log('test root:', TEST_ROOT)
  console.log('\n-- activate --')
  const ctx = { subscriptions: [] }
  ext.activate(ctx)
  check('root directory created', fs.existsSync(TEST_ROOT))
  check('accounts/ created', fs.existsSync(path.join(TEST_ROOT, 'accounts')))
  check('all 22 commands registered', Object.keys(registered).length === 22,
    Object.keys(registered).join(','))
  check('defaults to machine-wide mode', store.getMode(TEST_ROOT) === 'global')

  console.log('\n-- addAccount (work) --')
  q.input.push('work', 'work@example.com')
  await registered['claudeswitcher.addAccount']()   // no Verify prompt any more
  let reg = store.readRegistry(TEST_ROOT)
  check('account registered', reg.accounts.length === 1 && reg.accounts[0].name === 'work')
  check('became active automatically', reg.active === 'work')
  check('config dir created', fs.existsSync(path.join(TEST_ROOT, 'accounts', 'work')))
  check('login terminal opened', terminals.length === 1)
  check('terminal got isolated CLAUDE_CONFIG_DIR',
    terminals[0].opts.env.CLAUDE_CONFIG_DIR === path.join(TEST_ROOT, 'accounts', 'work'),
    terminals[0].opts.env.CLAUDE_CONFIG_DIR)
  check('login command includes --email',
    terminals[0].sent[0].includes('auth login --email work@example.com'), terminals[0].sent[0])

  console.log('\n-- addAccount (personal) --')
  q.input.push('personal', '')
  await registered['claudeswitcher.addAccount']()
  ext._test.stopLoginWatchers()   // these two logins never complete in this test
  reg = store.readRegistry(TEST_ROOT)
  check('two accounts registered', reg.accounts.length === 2)
  check('active unchanged by second add', reg.active === 'work')
  check('no --email when blank', !terminals[1].sent[0].includes('--email'), terminals[1].sent[0])

  console.log('\n-- duplicate name rejected --')
  let dupErr = null
  try { store.addAccount(TEST_ROOT, 'work') } catch (e) { dupErr = e.message }
  check('duplicate add throws', !!dupErr, String(dupErr))

  console.log('\n-- switchAccount --')
  settings.claudeCode.environmentVariables = [{ name: 'KEEP_ME', value: 'yes' }]
  q.quick.push('personal')
  q.warn.push('Switch Anyway')   // new modal: open chats become unresumable
  q.info.push('Not Now')
  await registered['claudeswitcher.switchAccount']()
  reg = store.readRegistry(TEST_ROOT)
  const envArr = settings.claudeCode.environmentVariables
  const ccd = envArr.find((e) => e.name === 'CLAUDE_CONFIG_DIR')
  check('active switched to personal', reg.active === 'personal', reg.active)
  check('CLAUDE_CONFIG_DIR written to settings', !!ccd)
  check('points at personal config dir',
    ccd && ccd.value === path.join(TEST_ROOT, 'accounts', 'personal'), ccd && ccd.value)
  check('unrelated env var preserved', envArr.some((e) => e.name === 'KEEP_ME'),
    JSON.stringify(envArr))
  check('no duplicate CLAUDE_CONFIG_DIR entries',
    envArr.filter((e) => e.name === 'CLAUDE_CONFIG_DIR').length === 1)

  console.log('\n-- switch again (no key duplication) --')
  q.quick.push('work'); q.warn.push('Switch Anyway'); q.info.push('Not Now')
  await registered['claudeswitcher.switchAccount']()
  const envArr2 = settings.claudeCode.environmentVariables
  check('still exactly one CLAUDE_CONFIG_DIR',
    envArr2.filter((e) => e.name === 'CLAUDE_CONFIG_DIR').length === 1)
  check('now points at work',
    envArr2.find((e) => e.name === 'CLAUDE_CONFIG_DIR').value.endsWith('work'))

  console.log('\n-- newChatAs: blocks unauthenticated account --')
  q.quick.push('personal'); q.warn.push(undefined)
  await registered['claudeswitcher.newChatAs']()
  check('did NOT open a conversation for signed-out account',
    !executed.includes('claude-vscode.newConversation'), executed.join(','))
  check('warned the user', messages.some((m) => m.startsWith('WARN:') && m.includes('not signed in')))

  console.log('\n-- newChatAs: works once credentials exist --')
  const workDir = path.join(TEST_ROOT, 'accounts', 'work')
  fs.writeFileSync(path.join(workDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { fake: true } }))
  fs.writeFileSync(path.join(workDir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'work@example.com', organizationName: 'Acme' },
  }))
  q.quick.push('work')
  await registered['claudeswitcher.newChatAs']()
  check('opened a new conversation', executed.includes('claude-vscode.newConversation'))
  check('env pinned to work before spawn',
    settings.claudeCode.environmentVariables
      .find((e) => e.name === 'CLAUDE_CONFIG_DIR').value === workDir)

  console.log('\n-- identity read from .claude.json --')
  const id = store.identity(TEST_ROOT, 'work')
  check('email parsed', id && id.email === 'work@example.com', JSON.stringify(id))
  check('org parsed', id && id.org === 'Acme')

  console.log('\n-- newTerminalAs --')
  const before = terminals.length
  q.quick.push('work')
  await registered['claudeswitcher.newTerminalAs']()
  check('terminal created', terminals.length === before + 1)
  check('terminal bound to work dir',
    terminals[terminals.length - 1].opts.env.CLAUDE_CONFIG_DIR === workDir)

  console.log('\n-- backup / restore round-trip --')
  q.quick.push('work'); q.info.push(undefined)
  await registered['claudeswitcher.backup']()
  const backups = fs.readdirSync(path.join(TEST_ROOT, 'backups'))
    .filter((f) => f.endsWith('.enc') || f.endsWith('.dpapi'))
  check('backup file written', backups.length === 1, backups.join(','))
  check('written with the platform-neutral extension', backups[0].endsWith('.enc'), backups[0])
  const blob = fs.readFileSync(path.join(TEST_ROOT, 'backups', backups[0]))
  check('backup is encrypted (no plaintext marker)', !blob.toString('utf8').includes('claudeAiOauth'))

  // corrupt the live file, then restore over it
  fs.writeFileSync(path.join(workDir, '.credentials.json'), '{"corrupted":true}')
  q.quick.push(backups[0]); q.warn.push('Restore'); q.info.push(undefined)
  await registered['claudeswitcher.restore']()
  const restored = fs.readFileSync(path.join(workDir, '.credentials.json'), 'utf8')
  check('credentials restored from encrypted backup', restored.includes('claudeAiOauth'), restored)

  // Builds before macOS support wrote .dpapi. Those files must still restore,
  // or upgrading would quietly strip every backup a user already had.
  const legacyName = backups[0].replace(/\.enc$/, '.dpapi')
  fs.copyFileSync(path.join(TEST_ROOT, 'backups', backups[0]),
    path.join(TEST_ROOT, 'backups', legacyName))
  fs.writeFileSync(path.join(workDir, '.credentials.json'), '{"corrupted":"again"}')
  q.quick.push(legacyName); q.warn.push('Restore'); q.info.push(undefined)
  await registered['claudeswitcher.restore']()
  check('a legacy .dpapi backup still restores',
    fs.readFileSync(path.join(workDir, '.credentials.json'), 'utf8').includes('claudeAiOauth'))

  console.log('\n-- removeAccount --')
  q.quick.push('personal'); q.warn.push('Remove'); q.info.push(undefined)
  await registered['claudeswitcher.removeAccount']()
  reg = store.readRegistry(TEST_ROOT)
  check('account removed from registry', reg.accounts.length === 1)
  check('config dir deleted', !fs.existsSync(path.join(TEST_ROOT, 'accounts', 'personal')))
  check('active fell back to remaining account', reg.active === 'work', reg.active)

  console.log('\n-- per-window mode --')
  q.info.push(undefined)
  await registered['claudeswitcher.usePerWindowAccounts']()
  check('mode switched to window', store.getMode(TEST_ROOT) === 'window')
  const cleared = settings.claudeCode.environmentVariables
  check('machine-wide CLAUDE_CONFIG_DIR cleared',
    !cleared.some((e) => e.name === 'CLAUDE_CONFIG_DIR'), JSON.stringify(cleared))
  check('unrelated env var still preserved', cleared.some((e) => e.name === 'KEEP_ME'))

  console.log('\n-- per-chat refuses in window mode --')
  q.warn.push('Cancel')
  await registered['claudeswitcher.newChatAs']()
  check('newChatAs did not write machine-wide setting',
    !settings.claudeCode.environmentVariables.some((e) => e.name === 'CLAUDE_CONFIG_DIR'))
  check('explained why', messages.some((m) =>
    m.startsWith('WARN:') && m.includes('override every pinned window')))

  console.log('\n-- switchAccount steers instead of clobbering --')
  q.info.push('Cancel')
  await registered['claudeswitcher.switchAccount']()
  check('switchAccount left machine-wide setting unset',
    !settings.claudeCode.environmentVariables.some((e) => e.name === 'CLAUDE_CONFIG_DIR'))

  console.log('\n-- openWindowAs launches a pinned window --')
  q.quick.push('work')                 // account
  q.quick.push('Empty window')         // folder choice
  await registered['claudeswitcher.openWindowAs']()
  check('spawned a window', spawned.length === 1, JSON.stringify(spawned))
  check('used --new-window', spawned[0] && spawned[0].args.includes('--new-window'),
    spawned[0] && spawned[0].args.join(' '))
  check('launch env carries the account dir',
    spawned[0] && spawned[0].env.CLAUDE_CONFIG_DIR === workDir,
    spawned[0] && spawned[0].env.CLAUDE_CONFIG_DIR)

  console.log('\n-- status bar reflects a pinned window --')
  process.env.CLAUDE_CONFIG_DIR = workDir
  q.info.push(undefined)
  await registered['claudeswitcher.usePerWindowAccounts']()   // triggers updateStatusBar
  check('shows pin icon', (bars[0].text || '').includes('$(pin)'), bars[0].text)
  check('names the pinned account', (bars[0].text || '').includes('work'), bars[0].text)
  check('tooltip says scope is this window',
    (bars[0].tooltip || '').includes('this window'), bars[0].tooltip)
  delete process.env.CLAUDE_CONFIG_DIR

  console.log('\n-- machine-wide setting overrides a pinned window (warned) --')
  // Window pinned to a DIFFERENT account than the machine-wide one: this is the
  // case that silently sends chats to the wrong account, so it must be flagged.
  process.env.CLAUDE_CONFIG_DIR = path.join(TEST_ROOT, 'accounts', 'someother')
  q.quick.push('work'); q.info.push(undefined)
  await registered['claudeswitcher.useMachineWideAccount']()
  check('back to machine-wide mode', store.getMode(TEST_ROOT) === 'global')
  check('setting written again',
    settings.claudeCode.environmentVariables.some((e) => e.name === 'CLAUDE_CONFIG_DIR'))
  check('status bar warns about the override', !!bars[0].bg, String(bars[0].bg))
  delete process.env.CLAUDE_CONFIG_DIR

  console.log('\n-- default account is first-class --')
  q.quick.push('(default)')
  q.warn.push('Clear and Continue')   // machine-wide setting must be cleared first
  q.quick.push('Empty window')
  await registered['claudeswitcher.openWindowAs']()
  const lastWin = spawned[spawned.length - 1]
  check('opened a window for the default login', spawned.length === 2, String(spawned.length))
  check('default window carries NO CLAUDE_CONFIG_DIR',
    !('CLAUDE_CONFIG_DIR' in lastWin.env), String(lastWin.env.CLAUDE_CONFIG_DIR))

  console.log('\n-- default terminal runs unpinned --')
  q.quick.push('(default)')
  await registered['claudeswitcher.newTerminalAs']()
  const lastTerm = terminals[terminals.length - 1]
  check('default terminal clears the variable',
    lastTerm.opts.env.CLAUDE_CONFIG_DIR === '', JSON.stringify(lastTerm.opts.env))

  console.log('\n-- usage bar --')
  const iso = (ms) => new Date(Date.now() + ms).toISOString()
  fs.writeFileSync(path.join(workDir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'work@example.com', organizationName: 'Acme' },
    cachedUsageUtilization: {
      fetchedAtMs: Date.now() - 120000,
      utilization: {
        limits: [
          { kind: 'session', percent: 36, resets_at: iso(3600e3) },
          { kind: 'weekly_all', percent: 57, resets_at: iso(2 * 86400e3) },
          { kind: 'weekly_scoped', percent: 53, resets_at: iso(2 * 86400e3),
            scope: { model: { display_name: 'Fable' } } },
        ],
        extra_usage: { is_enabled: true, used_credits: 3670, monthly_limit: 12500,
          utilization: 29.36, decimal_places: 2 },
      },
    },
  }))
  process.env.CLAUDE_CONFIG_DIR = workDir
  q.info.push(undefined)
  await registered['claudeswitcher.usePerWindowAccounts']()
  check('usage reads session | fable | weekly',
    bars[1].text === '$(pulse) 36% | 53% | 57%', bars[1].text)
  check('tooltip names the scoped model', (bars[1].tooltip || '').includes('Fable'),
    bars[1].tooltip)
  check('tooltip explains session limit', (bars[1].tooltip || '').includes('Session (5 hour)'))
  check('tooltip includes extra usage in dollars',
    (bars[1].tooltip || '').includes('$36.70 of $125.00'), bars[1].tooltip)
  check('tooltip notes cache age', (bars[1].tooltip || '').includes('ago'))
  check('no warning colour below 80%', !bars[1].bg, String(bars[1].bg))

  console.log('\n-- usage severity --')
  const hot = JSON.parse(fs.readFileSync(path.join(workDir, '.claude.json'), 'utf8'))
  hot.cachedUsageUtilization.utilization.limits[0].percent = 97
  fs.writeFileSync(path.join(workDir, '.claude.json'), JSON.stringify(hot))
  nextFetch = { ok: false, reason: 'mocked offline' }
  q.warn.push(undefined)
  await registered['claudeswitcher.refreshUsage']()
  check('turns red at 97%',
    !!bars[1].bg && /error/i.test(bars[1].bg.id), String(bars[1].bg && bars[1].bg.id))
  delete process.env.CLAUDE_CONFIG_DIR

  console.log('\n-- missing usage degrades gracefully --')
  nextFetch = { ok: false, reason: 'mocked offline' }
  q.warn.push(undefined)
  await registered['claudeswitcher.refreshUsage']()
  check('never throws without usage data', typeof bars[1].text === 'string', bars[1].text)

  console.log('\n-- live usage refresh --')
  process.env.CLAUDE_CONFIG_DIR = workDir
  nextFetch = {
    ok: true,
    utilization: {
      limits: [
        { kind: 'session', percent: 11, resets_at: new Date(Date.now() + 3600e3).toISOString() },
        { kind: 'weekly_all', percent: 22, resets_at: new Date(Date.now() + 86400e3).toISOString() },
        { kind: 'weekly_scoped', percent: 33, resets_at: new Date(Date.now() + 86400e3).toISOString(),
          scope: { model: { display_name: 'Fable' } } },
      ],
    },
  }
  await registered['claudeswitcher.refreshUsage']()
  check('bar shows the LIVE numbers, not the cached ones',
    bars[1].text === '$(pulse) 11% | 33% | 22%', bars[1].text)
  check('tooltip says the figures are live',
    (bars[1].tooltip || '').includes('Fetched live'), bars[1].tooltip)
  check('live result cached under our own dir, not .claude.json',
    fs.existsSync(require('../lib/usage.js').cachePath(TEST_ROOT, workDir)))
  check('.claude.json was NOT rewritten', (() => {
    const j = JSON.parse(fs.readFileSync(path.join(workDir, '.claude.json'), 'utf8'))
    return j.cachedUsageUtilization.utilization.limits[0].percent === 97
  })(), 'claude cache should be left alone')

  console.log('\n-- failed refresh falls back, never blanks the bar --')
  nextFetch = { ok: false, reason: 'mocked 401' }
  q.warn.push(undefined)
  await registered['claudeswitcher.refreshUsage']()
  check('still shows live numbers after a failed refresh',
    bars[1].text === '$(pulse) 11% | 33% | 22%', bars[1].text)
  check('user was told why', messages.some((m) => m.includes('mocked 401')))
  delete process.env.CLAUDE_CONFIG_DIR
  console.log('\n-- rename an account (label only) --')
  q.quick.push('work')
  q.input.push('Work / Acme')
  q.info.push(undefined)
  await registered['claudeswitcher.renameAccount']()
  check('label updated', store.displayOf(TEST_ROOT, 'work').label === 'Work / Acme',
    store.displayOf(TEST_ROOT, 'work').label)
  check('directory NOT moved', fs.existsSync(path.join(TEST_ROOT, 'accounts', 'work')))
  check('account key unchanged',
    store.readRegistry(TEST_ROOT).accounts.some((a) => a.name === 'work'))
  check('credentials still in place',
    fs.existsSync(path.join(TEST_ROOT, 'accounts', 'work', '.credentials.json')))

  console.log('\n-- rename the default account --')
  q.quick.push('(default)')
  q.input.push('Personal (main)')
  q.info.push(undefined)
  await registered['claudeswitcher.renameAccount']()
  check('default label updated',
    store.displayOf(TEST_ROOT, '(default)').label === 'Personal (main)',
    store.displayOf(TEST_ROOT, '(default)').label)
  check('stored under defaults key',
    store.readRegistry(TEST_ROOT).defaults.label === 'Personal (main)')

  console.log('\n-- set an account icon --')
  q.quick.push('work')
  q.quick.push('briefcase')
  q.info.push(undefined)
  await registered['claudeswitcher.setAccountIcon']()
  check('icon stored', store.displayOf(TEST_ROOT, 'work').icon === 'briefcase',
    store.displayOf(TEST_ROOT, 'work').icon)

  console.log('\n-- custom icon via free text --')
  q.quick.push('(default)')
  q.quick.push('Custom')
  q.input.push('rocket')
  q.info.push(undefined)
  await registered['claudeswitcher.setAccountIcon']()
  check('custom icon stored', store.displayOf(TEST_ROOT, '(default)').icon === 'rocket',
    store.displayOf(TEST_ROOT, '(default)').icon)

  console.log('\n-- status bar uses label + icon --')
  process.env.CLAUDE_CONFIG_DIR = workDir
  q.info.push(undefined)
  await registered['claudeswitcher.usePerWindowAccounts']()
  check('shows the custom icon', (bars[0].text || '').includes('$(briefcase)'), bars[0].text)
  check('shows the new label', (bars[0].text || '').includes('Work / Acme'), bars[0].text)
  check('pin suffix still present', (bars[0].text || '').includes('$(pin)'), bars[0].text)
  check('tooltip reveals the real folder name',
    (bars[0].tooltip || '').includes('Folder: work'), bars[0].tooltip)
  delete process.env.CLAUDE_CONFIG_DIR

  console.log('\n-- labels and icons live in registry.json --')
  const raw = JSON.parse(fs.readFileSync(path.join(TEST_ROOT, 'registry.json'), 'utf8'))
  check('registry holds label', raw.accounts.find((a) => a.name === 'work').label === 'Work / Acme')
  check('registry holds icon', raw.accounts.find((a) => a.name === 'work').icon === 'briefcase')
  check('registry holds default display', !!raw.defaults && raw.defaults.icon === 'rocket')

  console.log('\n-- hand-edited registry is honoured --')
  raw.accounts.find((a) => a.name === 'work').label = 'Edited By Hand'
  fs.writeFileSync(path.join(TEST_ROOT, 'registry.json'), JSON.stringify(raw, null, 2))
  check('reads the hand-edited label',
    store.displayOf(TEST_ROOT, 'work').label === 'Edited By Hand',
    store.displayOf(TEST_ROOT, 'work').label)

  console.log('\n-- label / icon validation --')
  check('rejects blank label', !store.validLabel('   '))
  check('rejects overlong label', !store.validLabel('x'.repeat(41)))
  check('accepts normal label', store.validLabel('Work / Acme'))
  check('rejects icon with spaces', !store.validIcon('my icon'))
  check('accepts hyphenated icon', store.validIcon('star-full'))

  console.log('\n-- open config file --')
  await registered['claudeswitcher.openConfigFile']()
  check('registry.json exists to edit', fs.existsSync(path.join(TEST_ROOT, 'registry.json')))
  console.log('\n-- login mode: adding an account needs no Verify click --')
  const profiles = require('../lib/profiles.js')
  delete process.env.CLAUDE_CONFIG_DIR
  store.setMode(TEST_ROOT, 'login')
  authMock = { ok: true, loggedIn: true, email: 'dana@example.com', orgName: 'Acme' }
  const infoBefore = q.info.length
  q.input.push('dana', '')
  await registered['claudeswitcher.addAccount']()
  check('command returns immediately, without waiting on a prompt', q.info.length === infoBefore)
  const danaDir = path.join(TEST_ROOT, 'accounts', 'dana')
  // Simulate the CLI finishing the login a moment later.
  fs.writeFileSync(path.join(danaDir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'dana@example.com', organizationName: 'Acme', accountUuid: 'uuid-d' },
    userID: 'u-ash',
  }))
  fs.writeFileSync(path.join(danaDir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'AT-D', refreshToken: 'RT-D', expiresAt: Date.now() + 3600e3 },
  }))
  q.info.push(undefined)   // "Added ... Switch to It Now" -> dismissed
  await ext._test.settle()
  check('completed login detected and added to the switcher', profiles.exists(TEST_ROOT, 'dana'))
  check('saved profile knows its email',
    (profiles.list(TEST_ROOT).find((p) => p.name === 'dana') || {}).email === 'dana@example.com')
  check('login moved into the switcher, not left duplicated in the folder',
    !fs.existsSync(path.join(danaDir, '.credentials.json')))
  check('user told it is in the switcher',
    messages.some((m) => m.includes('It is in the account switcher now')))

  console.log('\n-- login mode: signing in to an account you already have is caught --')
  q.input.push('second-dev', '')
  await registered['claudeswitcher.addAccount']()
  const dupDir = path.join(TEST_ROOT, 'accounts', 'second-dev')
  fs.writeFileSync(path.join(dupDir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'dana@example.com' },
  }))
  fs.writeFileSync(path.join(dupDir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'AT-2', refreshToken: 'RT-2' },
  }))
  q.warn.push('Discard This Login')
  await ext._test.settle()
  check('same account is not saved twice under a new name', !profiles.exists(TEST_ROOT, 'second-dev'))
  check('its throwaway folder entry is removed',
    !store.readRegistry(TEST_ROOT).accounts.some((a) => a.name === 'second-dev'))
  check('user told it is already saved',
    messages.some((m) => m.includes('already saved as "dana"')))

  console.log('\n-- login mode: a login interrupted by a reload is rescued on startup --')
  store.addAccount(TEST_ROOT, 'late')
  const lateDir = path.join(TEST_ROOT, 'accounts', 'late')
  fs.writeFileSync(path.join(lateDir, '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'late@example.com' },
  }))
  fs.writeFileSync(path.join(lateDir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'AT-L', refreshToken: 'RT-L' },
  }))
  const rescued = ext._test.syncStagedLogins()
  check('startup sync adds it to the switcher',
    rescued.includes('late') && profiles.exists(TEST_ROOT, 'late'), JSON.stringify(rescued))
  check('rescued login moved out of the folder', !fs.existsSync(path.join(lateDir, '.credentials.json')))
  check('running sync again changes nothing', ext._test.syncStagedLogins().length === 0)

  console.log('\n-- login mode: a half-written login is left for the next pass --')
  store.addAccount(TEST_ROOT, 'halfway')
  const halfDir = path.join(TEST_ROOT, 'accounts', 'halfway')
  fs.writeFileSync(path.join(halfDir, '.credentials.json'), JSON.stringify({
    claudeAiOauth: { accessToken: 'AT-H', refreshToken: 'RT-H' },
  }))
  ext._test.syncStagedLogins()
  check('not imported before its identity is written', !profiles.exists(TEST_ROOT, 'halfway'))
  check('credentials left untouched meanwhile', fs.existsSync(path.join(halfDir, '.credentials.json')))
  authMock = { ok: false, error: 'mocked' }
  console.log('\n-- name validation --')
  check('rejects path traversal', !store.validName('../evil'))
  check('rejects spaces', !store.validName('my account'))
  check('rejects empty', !store.validName(''))
  check('accepts normal name', store.validName('work-2'))

  console.log('\n-- main edition activates with only the minimal palette --')
  {
    const editionLib = require('../lib/edition.js')
    const mainPkg = { claudeswitcher: { edition: 'main' } }
    for (const id of Object.keys(registered)) delete registered[id]
    const ctx2 = { subscriptions: [], extension: { packageJSON: mainPkg } }
    ext.activate(ctx2)
    const ids = Object.keys(registered).map((i) => i.replace('claudeswitcher.', '')).sort()
    check('registers exactly the main set',
      ids.join(',') === editionLib.MAIN_COMMANDS.slice().sort().join(','), ids.join(','))
    check('per-window commands are unreachable',
      !registered['claudeswitcher.usePerWindowAccounts'] && !registered['claudeswitcher.openWindowAs'])
    check('forces global mode', store.getMode(TEST_ROOT) === 'login')
    for (const d of ctx2.subscriptions) { try { d.dispose() } catch { /* ignore */ } }
    ext._test.stopLoginWatchers()
  }

  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====')
  fs.rmSync(TEST_ROOT, { recursive: true, force: true })
  fs.rmSync(FAKE_HOME, { recursive: true, force: true })
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1) })
