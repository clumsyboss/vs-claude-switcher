const vscode = require('vscode')
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const store = require('./lib/store')
const claude = require('./lib/claude')
const envBridge = require('./lib/env')
const usageLib = require('./lib/usage')
const profilesLib = require('./lib/profiles')
const liveLib = require('./lib/live')
const remoteLib = require('./lib/remote')
const secretsLib = require('./lib/secrets')
const shell = require('./lib/shell')
const editionLib = require('./lib/edition')

const NEW_CONVERSATION = 'claude-vscode.newConversation'

/** Claude Code's own login (~/.claude), used when CLAUDE_CONFIG_DIR is unset. */
const DEFAULT_NAME = store.DEFAULT_NAME

/** Which build this is. Set in activate(); see lib/edition.js. */
let edition = editionLib.EXPERIMENTAL

let statusBar
let usageBar
let usageTimer
let output

function log(msg) {
  if (output) output.appendLine('[' + new Date().toISOString() + '] ' + msg)
}

function root() { return store.getRoot(vscode) }

/** null means "the default login" — i.e. run with CLAUDE_CONFIG_DIR unset. */
function accountDirFor(name) {
  return name === DEFAULT_NAME ? null : store.configDir(root(), name)
}

/** Fast, file-based label for an account. Avoids spawning the CLI. */
function describe(name) {
  if (name === DEFAULT_NAME) {
    const id = store.identityFromFile(usageLib.claudeJsonPath(null))
    return id && id.email ? id.email + '  ·  your original login' : 'your original ~/.claude login'
  }
  const id = store.identity(root(), name)
  if (!id) return store.isAuthed(root(), name) ? 'signed in' : 'not signed in yet'
  return [id.email, id.org].filter(Boolean).join('  ·  ') || 'signed in'
}

async function pickAccount(placeHolder, opts) {
  const includeDefault = !opts || opts.includeDefault !== false
  const reg = store.readRegistry(root())
  if (!reg.accounts.length && !includeDefault) {
    const add = await vscode.window.showInformationMessage(
      'No Claude accounts registered yet.', 'Add Account')
    if (add) await vscode.commands.executeCommand('claudeswitcher.addAccount')
    return null
  }

  const cur = currentWindowAccount()
  const mark = (n) => {
    const d = store.displayOf(root(), n)
    return (cur.name === n ? '$(check) ' : '$(blank) ') + '$(' + d.icon + ') ' + d.label
  }
  const items = reg.accounts.map((a) => ({
    label: mark(a.name), description: describe(a.name), name: a.name,
  }))
  if (includeDefault) {
    items.push({
      label: mark(DEFAULT_NAME), description: describe(DEFAULT_NAME),
      detail: 'Runs with CLAUDE_CONFIG_DIR unset, exactly as before this extension',
      name: DEFAULT_NAME,
    })
  }

  const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true })
  return pick ? pick.name : null
}

// ------------------------------------------------------------ window account

/**
 * The CLAUDE_CONFIG_DIR this window's extension host was launched with, if any.
 * VS Code passes the launching environment through to each new window's host,
 * which is what makes per-window accounts possible.
 */
function windowPinnedDir() {
  const v = process.env.CLAUDE_CONFIG_DIR
  return v && v.trim() ? v.trim() : null
}

/**
 * What account this window's *new* chats will actually use.
 * The machine-wide setting overrides the launch env, because the Claude
 * extension overlays `environmentVariables` on top of process.env at spawn.
 */
function currentWindowAccount() {
  const setting = envBridge.currentConfigDir(vscode)
  const pinned = windowPinnedDir()
  if (setting) {
    return {
      dir: setting,
      name: store.nameForConfigDir(root(), setting) || null,
      source: 'machine-wide',
      overriding: !!(pinned && path.resolve(pinned) !== path.resolve(setting)),
    }
  }
  if (pinned) {
    return {
      dir: pinned,
      name: store.nameForConfigDir(root(), pinned) || null,
      source: 'this window',
      overriding: false,
    }
  }
  return { dir: null, name: DEFAULT_NAME, source: 'default', overriding: false }
}

// ------------------------------------------------------------- status bars

function updateStatusBar() {
  if (!statusBar) return
  const cur = currentWindowAccount()

  // Global mode: one config dir, so the account is simply whoever is logged in.
  if (edition === editionLib.MAIN || (store.getMode(root()) === 'login' && cur.source === 'default')) {
    const active = profilesLib.activeProfile(root())
    const id = profilesLib.currentIdentity()
    const disp = active ? store.displayOf(root(), active) : null
    const label = (disp && disp.label) || active || (id && id.email) || 'not saved'
    statusBar.command = 'claudeswitcher.globalSwitch'
    statusBar.text = '$(' + ((disp && disp.icon) || 'account') + ') ' + label
    statusBar.backgroundColor = active ? undefined
      : new vscode.ThemeColor('statusBarItem.warningBackground')
    statusBar.tooltip = new vscode.MarkdownString([
      '**Claude account: ' + label + '**',
      id && id.email ? 'Email: ' + id.email : null,
      id && id.org ? 'Org: ' + id.org : null,
      'Mode: global — one login for everything, chats never move.',
      active ? null : '⚠ This login is not saved yet. Run "Save Current Login as Profile".',
      active && store.getRemote(root(), active) === 'off'
        ? 'Remote Control: **off** for this account.' : null,
      cur.source !== 'default'
        ? '⚠ This window was launched pinned to ' + (cur.name || 'another account') +
          '. Close and reopen it to follow the switcher.' : null,
      '', 'Click to switch account.',
    ].filter((x) => x !== null).join('\n\n'))
    statusBar.show()
    return
  }

  statusBar.command = 'claudeswitcher.switchAccount'
  const pinnedHere = cur.source === 'this window'
  const disp = cur.name
    ? store.displayOf(root(), cur.name)
    : { label: '(unregistered)', icon: 'question' }
  const label = disp.label

  // Account icon carries the identity; the pin suffix marks a locked window.
  statusBar.text = '$(' + disp.icon + ') ' + label + (pinnedHere ? ' $(pin)' : '')
  statusBar.backgroundColor = cur.overriding
    ? new vscode.ThemeColor('statusBarItem.warningBackground')
    : undefined

  const lines = ['**Claude account: ' + label + '**', 'Scope: ' + cur.source]
  if (cur.name && cur.name !== DEFAULT_NAME && cur.name !== label) {
    lines.push('Folder: ' + cur.name)
  }
  const id = cur.name && cur.name !== DEFAULT_NAME ? store.identity(root(), cur.name) : null
  if (id && id.email) lines.push('Email: ' + id.email)
  if (id && id.org) lines.push('Org: ' + id.org)
  if (cur.name === DEFAULT_NAME) lines.push('Your original ~/.claude login, untouched by this extension.')
  if (cur.overriding) {
    lines.push('⚠ This window was opened for a different account, but a machine-wide ' +
      'account is set and overrides it. Run "Use Per-Window Accounts" to fix.')
  }
  if (pinnedHere) lines.push('This window is pinned. Switching elsewhere will not change it.')
  lines.push('', 'Click to switch account.')
  statusBar.tooltip = new vscode.MarkdownString(lines.join('\n\n'))
  statusBar.show()
}

function usageIcon() {
  const v = vscode.workspace.getConfiguration('claudeswitcher').get('usageIcon')
  return v && store.validIcon(v) ? v : 'pulse'
}

function updateUsageBar() {
  if (!usageBar) return
  const cur = currentWindowAccount()
  const usage = usageLib.readBest(root(), cur.dir)
  const text = usageLib.compactText(usage)

  if (!text) {
    usageBar.text = '$(' + usageIcon() + ') --'
    usageBar.tooltip = new vscode.MarkdownString(
      ['**Claude usage — ' + (cur.name || 'unknown') + '**', '',
        'No usage data cached for this account yet. It appears after the account ' +
        'is used once, and refreshes as Claude Code runs.'].join('\n\n'))
    usageBar.backgroundColor = undefined
    usageBar.show()
    return
  }

  const top = usageLib.peak(usage)
  usageBar.text = '$(' + usageIcon() + ') ' + text
  usageBar.backgroundColor = top >= 95
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : top >= 80 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
  usageBar.tooltip = new vscode.MarkdownString(
    ['**Claude usage — ' + (cur.name || 'unknown') + '**', '']
      .concat(usageLib.detailLines(usage))
      .concat(['', 'Order: session | model-scoped weekly | weekly total.'])
      .join('\n\n'))
  usageBar.show()
}

function refreshAll() {
  updateStatusBar()
  updateUsageBar()
}

// ---------------------------------------------------------------- helpers

/**
 * Point the native-UI chat spawner at an account's config dir, or clear it for
 * the default login. Skips redundant writes so activation does not churn
 * settings.json on every window.
 */
async function applyToNativeUI(name) {
  const dir = accountDirFor(name)
  if (envBridge.currentConfigDir(vscode) === (dir || null)) return
  await envBridge.setConfigDir(vscode, dir)
  log('native UI env -> ' + (dir || '(unset: default login)'))
}

/**
 * Launch `claude` in a terminal bound to one account.
 */
function launchTerminal(title, dir, args) {
  const bin = claude.resolveBin()
  if (!bin) {
    vscode.window.showErrorMessage('Could not find the claude CLI on PATH.')
    return null
  }
  // An empty string makes VS Code drop the variable, giving the default login.
  const env = { CLAUDE_CONFIG_DIR: dir || '' }
  const term = vscode.window.createTerminal({
    name: title, env, iconPath: new vscode.ThemeIcon('account'),
  })
  term.show()
  term.sendText(shell.invoke(bin, args))
  return term
}

// ------------------------------------------------------- login completion

let loginPollMs = 1500
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
/** How long to wait for .claude.json's identity block after credentials land. */
const IDENTITY_GRACE_MS = 10000
const loginWatchers = new Set()
const pendingLogins = new Set()

/**
 * Resolve once a login started at `startedAt` has written credentials into
 * `dir` and the CLI confirms them. This replaces a "Verify" button: a
 * notification toast hides as soon as focus moves to the browser or terminal,
 * and a window reload discards it, so the user could finish logging in and
 * the account would silently never be saved.
 */
function watchLogin(dir, startedAt, cancelToken) {
  return new Promise((resolve) => {
    const credPath = path.join(dir, '.credentials.json')
    let lastCheckedMtime = 0
    let confirmed = null
    let confirmedAt = 0

    const finish = (result) => {
      clearInterval(timer)
      loginWatchers.delete(stop)
      resolve(result)
    }
    const stop = () => finish({ ok: false, reason: 'stopped' })

    const timer = setInterval(() => {
      if (cancelToken && cancelToken.isCancellationRequested) return finish({ ok: false, reason: 'cancelled' })
      if (Date.now() - startedAt > LOGIN_TIMEOUT_MS) return finish({ ok: false, reason: 'timed out' })

      if (confirmed) {
        // Credentials are valid; give Claude Code a moment to write the
        // identity block too, so the saved profile knows its email.
        const id = store.identityFromFile(path.join(dir, '.claude.json'))
        if ((id && id.email) || Date.now() - confirmedAt > IDENTITY_GRACE_MS) {
          finish({ ok: true, status: confirmed })
        }
        return
      }

      let mtime = 0
      try { mtime = fs.statSync(credPath).mtimeMs } catch { return }
      // 2s slack for filesystem timestamp granularity; skip files we already checked.
      if (mtime < startedAt - 2000 || mtime === lastCheckedMtime) return
      lastCheckedMtime = mtime

      const st = claude.authStatus(dir)
      if (st.ok && st.loggedIn) {
        confirmed = st
        confirmedAt = Date.now()
      }
    }, loginPollMs)
    loginWatchers.add(stop)
  })
}

/** Start watching a login in the background; never blocks the command. */
function trackLogin(name, dir, startedAt, isNew) {
  const run = Promise.resolve(vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: 'Waiting for "' + name + '" to finish signing in. Complete the login in the browser or terminal; this closes on its own.',
    cancellable: true,
  }, (_progress, token) => watchLogin(dir, startedAt, token)))
    .then((res) => {
      if (res.ok) return finalizeLogin(name, dir, res.status, isNew)
      if (res.reason === 'timed out') {
        vscode.window.showWarningMessage(
          'Stopped waiting for "' + name + '" after 15 minutes. If you did finish, reload the ' +
          'window and it will be picked up automatically.')
      }
      return null
    })
    .catch((e) => {
      log('login tracking for ' + name + ' failed: ' + (e && e.stack))
      vscode.window.showErrorMessage('Claude Accounts: ' + (e && e.message))
    })
  pendingLogins.add(run)
  run.then(() => pendingLogins.delete(run), () => pendingLogins.delete(run))
  return run
}

/**
 * A login finished. In global mode, move it into the account switcher; in the
 * per-window modes the account folder is itself what gets used.
 */
async function finalizeLogin(name, dir, st, isNew) {
  store.lockdown(dir)
  const fallback = { email: st.email, org: st.orgName }

  if (store.getMode(root()) !== 'login') {
    refreshAll()
    vscode.window.showInformationMessage('"' + name + '" is signed in' +
      (st.email ? ' as ' + st.email : '') + (st.orgName ? ' (' + st.orgName + ')' : '') + '.')
    return
  }

  // The classic trap: the browser was already signed in, so the "new" account
  // is really one we already have. Saving it twice would duplicate its tokens.
  const dup = profilesLib.findByEmail(root(), st.email, name)
  if (dup) {
    const update = 'Update "' + dup + '"'
    const choice = await vscode.window.showWarningMessage(
      'You signed in as ' + st.email + ', which is already saved as "' + dup + '". ' +
      'Your browser most likely reused an account it was already logged in to — ' +
      'use a private window to sign in to a different one.',
      { modal: true }, update, 'Discard This Login')
    if (choice === update) {
      profilesLib.importFromDir(root(), dup, dir, { move: true, fallback })
      vscode.window.showInformationMessage('Refreshed the saved login for "' + dup + '".')
    } else {
      try { fs.rmSync(path.join(dir, '.credentials.json'), { force: true }) } catch { /* ignore */ }
    }
    if (isNew) store.removeAccount(root(), name)
    refreshAll()
    return
  }

  profilesLib.importFromDir(root(), name, dir, { move: true, fallback })

  // Re-logging in to the account that is live right now: put the fresh login
  // in place immediately, or the next switch-away would save the stale one back.
  if (profilesLib.activeProfile(root()) === name) {
    profilesLib.apply(root(), name)
    refreshAll()
    vscode.window.showInformationMessage('Signed "' + name + '" in again. Its fresh login is active now.')
    return
  }

  refreshAll()
  const go = await vscode.window.showInformationMessage(
    'Added "' + name + '"' + (st.email ? ' (' + st.email + ')' : '') + '. It is in the account switcher now.',
    'Switch to It Now')
  if (go === 'Switch to It Now') await switchToProfile(name)
}

/**
 * Global mode: promote logins sitting in account folders into the switcher.
 * Runs on startup and before the switcher opens, so a login interrupted by a
 * reload or a missed prompt is recovered without the user doing anything.
 */
function syncStagedLogins() {
  if (store.getMode(root()) !== 'login') return []
  const imported = []
  for (const a of store.readRegistry(root()).accounts) {
    const dir = store.configDir(root(), a.name)
    let mtime
    try { mtime = fs.statSync(path.join(dir, '.credentials.json')).mtimeMs } catch { continue }
    if (profilesLib.exists(root(), a.name) && mtime <= profilesLib.capturedAt(root(), a.name)) continue

    const id = store.identity(root(), a.name)
    if (!id || !id.email) continue   // login still being written; next pass will get it
    const dup = profilesLib.findByEmail(root(), id.email, a.name)
    if (dup) {
      log('not importing "' + a.name + '": it is the same account as "' + dup + '"')
      vscode.window.showWarningMessage('"' + a.name + '" is signed in as ' + id.email +
        ', which is already saved as "' + dup + '", so it was not added twice.')
      continue
    }
    try {
      profilesLib.importFromDir(root(), a.name, dir, { move: true })
      imported.push(a.name)
      log('imported staged login "' + a.name + '" (' + id.email + ')')
    } catch (e) {
      log('import of "' + a.name + '" failed: ' + (e && e.message))
    }
  }
  if (imported.length) refreshAll()
  return imported
}

// ---------------------------------------------------------------- commands

async function addAccount() {
  const loginMode = store.getMode(root()) === 'login'
  const name = await vscode.window.showInputBox({
    title: 'Add Claude Account',
    prompt: 'Short name for this account (letters, digits, . _ -)',
    placeHolder: 'work',
    validateInput: (v) => {
      if (!v) return 'Name is required'
      if (!store.validName(v)) return 'Use 1-32 chars: letters, digits, dot, underscore, hyphen'
      if (store.readRegistry(root()).accounts.some((a) => a.name === v)) return 'That name already exists'
      if (loginMode && profilesLib.exists(root(), v)) return 'That name already exists'
      return null
    },
  })
  if (!name) return

  const email = await vscode.window.showInputBox({
    title: 'Add "' + name + '"',
    prompt: 'Email to pre-fill on the login page (optional)',
    placeHolder: 'you@example.com',
  })
  if (email === undefined) return

  // The login always happens in the account's own folder, so the account you
  // are signed in as right now is never touched while adding another.
  const dir = store.addAccount(root(), name)
  refreshAll()

  const args = ['auth', 'login'].concat(email ? ['--email', email] : [])
  const startedAt = Date.now()
  if (!launchTerminal('Claude login: ' + name, dir, args)) return
  trackLogin(name, dir, startedAt, true)
}

async function verifyAccount(name) {
  const dir = store.configDir(root(), name)
  const st = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking "' + name + '"...' },
    () => Promise.resolve(claude.authStatus(dir)))
  if (!st.ok) {
    vscode.window.showErrorMessage('Could not read status for "' + name + '": ' + st.error)
    return false
  }
  if (!st.loggedIn) {
    vscode.window.showWarningMessage(
      '"' + name + '" is still not signed in. Re-run the login if the browser step did not finish.')
    return false
  }
  store.lockdown(dir)
  refreshAll()
  vscode.window.showInformationMessage(
    '"' + name + '" is signed in' + (st.email ? ' as ' + st.email : '') +
    (st.orgName ? ' (' + st.orgName + ')' : '') + '.')
  return true
}

async function switchAccount() {
  // In per-window mode, writing the machine-wide setting would override every
  // pinned window at once, so steer to opening a window instead.
  if (store.getMode(root()) === 'window') {
    const choice = await vscode.window.showInformationMessage(
      'You are in per-window mode, so accounts are chosen when a window opens. ' +
      'Switching here would override every pinned window.',
      'Open New Window as Account…', 'Switch Machine-Wide Anyway')
    if (choice === 'Open New Window as Account…') return openWindowAs()
    if (choice !== 'Switch Machine-Wide Anyway') return
    return useMachineWideAccount()
  }

  const name = await pickAccount('Select the active Claude account')
  if (!name) return

  const before = currentWindowAccount()
  if (before.name === name) {
    vscode.window.showInformationMessage('Already using "' + store.displayOf(root(), name).label + '".')
    return
  }

  // Conversations are stored inside each account's config dir, so a machine-wide
  // switch also moves where open chats look for their history. Anything already
  // open fails with "No conversation found" until the account is switched back.
  const choice = await vscode.window.showWarningMessage(
    'Switching the machine-wide account also changes where conversations are stored.\n\n' +
    'Every Claude chat that is currently open will fail with "No conversation found" ' +
    'until you switch back. Nothing is deleted.\n\n' +
    'Per-window accounts avoid this: each window keeps its own account and its own history.',
    { modal: true },
    'Open New Window Instead', 'Switch Anyway')
  if (choice === 'Open New Window Instead') return openWindowAs()
  if (choice !== 'Switch Anyway') return

  store.setActive(root(), name)
  await applyToNativeUI(name)
  refreshAll()

  const msg = 'Active Claude account: ' + name + '. Open chats must be reopened.'
  if (!vscode.workspace.getConfiguration('claudeswitcher').get('reloadPrompt')) {
    vscode.window.showInformationMessage(msg)
    return
  }
  const reloadChoice = await vscode.window.showInformationMessage(
    msg + ' Reopen them from Claude history after reloading.', 'Reload Window', 'Not Now')
  if (reloadChoice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow')
}

async function newChatAs() {
  // Per-chat selection works by writing the machine-wide setting, which would
  // override every pinned window. Refuse rather than break them silently.
  if (store.getMode(root()) === 'window') {
    const choice = await vscode.window.showWarningMessage(
      'Per-chat selection is unavailable in per-window mode: it sets the ' +
      'machine-wide account, which would override every pinned window.',
      'Open New Window as Account…', 'Cancel')
    if (choice === 'Open New Window as Account…') return openWindowAs()
    return
  }

  const name = await pickAccount('Start a new Claude chat as...')
  if (!name) return
  if (name !== DEFAULT_NAME && !store.isAuthed(root(), name)) {
    vscode.window.showWarningMessage(
      '"' + name + '" is not signed in yet. Run "Claude Accounts: Re-login Account".')
    return
  }
  await applyToNativeUI(name)
  store.setActive(root(), name)
  refreshAll()
  try {
    await vscode.commands.executeCommand(NEW_CONVERSATION)
  } catch (e) {
    vscode.window.showErrorMessage(
      'Could not open a new Claude conversation. Is the Claude Code extension installed?')
    log('newConversation failed: ' + (e && e.message))
  }
}

async function newTerminalAs() {
  const name = await pickAccount('Open a Claude terminal as...')
  if (!name) return
  launchTerminal('Claude (' + name + ')', accountDirFor(name), [])
}

/**
 * Resolve a launcher for a fresh VS Code window.
 *
 * appRoot is `<install>/resources/app`, so the executable sits two levels up on
 * Windows and Linux. A .app bundle nests it deeper and under a different name,
 * and `process.execPath` inside the bundle is the right answer there anyway.
 */
function vscodeLauncher() {
  const exe = process.platform === 'win32' ? 'Code.exe' : 'code'
  const fromAppRoot = path.join(vscode.env.appRoot, '..', '..', exe)
  if (process.platform !== 'darwin' && fs.existsSync(fromAppRoot)) return fromAppRoot
  return process.execPath
}

/**
 * Open a new window whose extension host inherits CLAUDE_CONFIG_DIR, pinning
 * every chat in that window to one account for the window's whole life.
 */
async function openWindowAs() {
  const name = await pickAccount('Open a new window pinned to...')
  if (!name) return
  if (name !== DEFAULT_NAME && !store.isAuthed(root(), name)) {
    vscode.window.showWarningMessage(
      '"' + name + '" is not signed in yet. Run "Claude Accounts: Add Account" first.')
    return
  }

  // A machine-wide account overrides the launch env, so per-window pinning
  // cannot work while one is set.
  if (envBridge.currentConfigDir(vscode)) {
    const choice = await vscode.window.showWarningMessage(
      'A machine-wide Claude account is set, which overrides per-window accounts. ' +
      'Clear it and switch to per-window mode?',
      { modal: true }, 'Clear and Continue')
    if (choice !== 'Clear and Continue') return
    await envBridge.setConfigDir(vscode, null)
    store.setMode(root(), 'window')
  }

  const folders = vscode.workspace.workspaceFolders || []
  const here = folders.length ? folders[0].uri.fsPath : null
  const picked = await vscode.window.showQuickPick(
    [
      ...(here ? [{ label: '$(folder) This folder', description: here, value: here }] : []),
      { label: '$(folder-opened) Choose a folder...', value: '__pick__' },
      { label: '$(window) Empty window', value: null },
    ],
    { placeHolder: 'Open "' + name + '" in which folder?' })
  if (picked === undefined) return

  let target = picked.value
  if (target === '__pick__') {
    const sel = await vscode.window.showOpenDialog({
      canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Open',
    })
    if (!sel || !sel.length) return
    target = sel[0].fsPath
  }

  const dir = accountDirFor(name)
  const env = { ...process.env }
  if (dir) env.CLAUDE_CONFIG_DIR = dir
  else delete env.CLAUDE_CONFIG_DIR

  const args = ['--new-window'].concat(target ? [target] : [])
  try {
    const child = cp.spawn(vscodeLauncher(), args, {
      env, detached: true, stdio: 'ignore', windowsHide: false,
    })
    child.unref()
    log('opened window for ' + name + ' -> ' + (dir || '(default)'))
    store.setMode(root(), 'window')
    refreshAll()
  } catch (e) {
    vscode.window.showErrorMessage('Could not open a new window: ' + (e && e.message))
  }
}

/** Clear the machine-wide account so each window's launch env takes effect. */
async function usePerWindowAccounts() {
  await envBridge.setConfigDir(vscode, null)
  store.setMode(root(), 'window')
  refreshAll()
  vscode.window.showInformationMessage(
    'Per-window mode. Use "Open New Window as Account…" to pin a window. ' +
    'Windows opened normally use your default ~/.claude login.')
}

/** Go back to one machine-wide account driving every window. */
async function useMachineWideAccount() {
  const name = await pickAccount('Which account should all windows use?')
  if (!name) return
  store.setMode(root(), 'global')
  store.setActive(root(), name)
  await applyToNativeUI(name)
  refreshAll()
  vscode.window.showInformationMessage(
    'Machine-wide mode: new chats in every window use "' + name + '". ' +
    'Already-pinned windows are overridden until reopened.')
}

// ------------------------------------------------- global (single-folder) mode

/**
 * Global mode keeps one config dir (~/.claude) and swaps only the login, so
 * conversations, history and project settings never move. Any CLAUDE_CONFIG_DIR
 * override would defeat that, so it is cleared first.
 */
async function ensureGlobalMode() {
  if (envBridge.currentConfigDir(vscode)) await envBridge.setConfigDir(vscode, null)
  store.setMode(root(), 'login')
  if (windowPinnedDir()) {
    vscode.window.showWarningMessage(
      'This window was opened pinned to a specific account, so it ignores global switching. ' +
      'Use a normally-opened window (Ctrl+Shift+N) for global mode.')
    return false
  }
  return true
}

function globalItems() {
  const active = profilesLib.activeProfile(root())
  return profilesLib.list(root()).map((p) => ({
    label: (p.name === active ? '$(check) ' : '$(blank) ') + p.name,
    description: [p.email, p.org].filter(Boolean).join('  ·  '),
    detail: p.capturedAt ? 'saved ' + new Date(p.capturedAt).toLocaleString() : undefined,
    name: p.name,
  }))
}

/** Snapshot whatever is logged in right now, so it can be switched back to. */
async function saveCurrentLogin(suggested) {
  if (!profilesLib.hasCurrentLogin()) {
    vscode.window.showWarningMessage('No active Claude login found in ~/.claude.')
    return null
  }
  const id = profilesLib.currentIdentity()
  const name = await vscode.window.showInputBox({
    title: 'Save Current Login',
    prompt: 'Name for the account currently signed in' + (id && id.email ? ' (' + id.email + ')' : ''),
    value: suggested || '',
    placeHolder: 'work-team',
    validateInput: (v) => {
      if (!v) return 'Name is required'
      if (!store.validName(v)) return 'Use 1-32 chars: letters, digits, dot, underscore, hyphen'
      return null
    },
  })
  if (!name) return null
  const saved = profilesLib.capture(root(), name)
  refreshAll()
  vscode.window.showInformationMessage(
    'Saved "' + name + '"' + (saved.email ? ' (' + saved.email + ')' : '') + '.')
  return name
}

/**
 * Keep Claude Code's Remote Control setting in step with the account that is
 * active. Only meaningful in global mode, where one login serves everything.
 */
function applyRemotePreference(name) {
  if (store.getMode(root()) !== 'login' || !name) return null
  const off = store.getRemote(root(), name) === 'off'
  const res = remoteLib.setDisabled(off)
  if (res.changed) log('remote control ' + (off ? 'disabled' : 'enabled') + ' for "' + name + '"')
  return res
}

/** The main command: change which account Claude uses, machine-wide. */
async function globalSwitch() {
  if (!(await ensureGlobalMode())) return
  syncStagedLogins()

  const list = profilesLib.list(root())
  if (!list.length) {
    const go = await vscode.window.showInformationMessage(
      'No saved accounts yet. Save the account you are signed in as now, then add others.',
      'Save Current Login', 'Cancel')
    if (go === 'Save Current Login') await saveCurrentLogin()
    return
  }

  const pick = await vscode.window.showQuickPick(globalItems(),
    { placeHolder: 'Switch Claude to which account?', matchOnDescription: true })
  if (!pick) return
  await switchToProfile(pick.name)
}

async function switchToProfile(name) {
  const pick = { name }
  const active = profilesLib.activeProfile(root())
  if (active === pick.name) {
    vscode.window.showInformationMessage('Already signed in as "' + pick.name + '".')
    return
  }

  // Re-capture the live login first: Claude Code rotates tokens in place, so the
  // saved copy can be older than what is on disk right now.
  if (active && profilesLib.hasCurrentLogin()) {
    try { profilesLib.capture(root(), active) } catch (e) { log('pre-switch capture failed: ' + e.message) }
  }

  let applied
  try {
    applied = profilesLib.apply(root(), pick.name)
  } catch (e) {
    vscode.window.showErrorMessage('Switch failed: ' + (e && e.message))
    return
  }

  applyRemotePreference(pick.name)

  const st = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Switching to ' + pick.name + '...' },
    () => Promise.resolve(claude.authStatus(profilesLib.paths().claudeDir)))

  refreshAll()

  if (st.ok && !st.loggedIn) {
    vscode.window.showWarningMessage(
      'Switched to "' + pick.name + '" but it reports signed out. Its refresh token may have ' +
      'expired — run "Re-login Account" to sign in again.')
    return
  }

  const who = (st.ok && st.email) || applied.email || pick.name
  const choice = await vscode.window.showInformationMessage(
    'Now signed in as ' + who + '. Your chats and history are untouched. ' +
    'Open chats keep the previous account until reopened.',
    'Reload Window', 'Not Now')
  if (choice === 'Reload Window') await vscode.commands.executeCommand('workbench.action.reloadWindow')
}

/**
 * Same flow as Add Account, in global mode. It used to log in against ~/.claude
 * directly, which replaced the live login mid-flow; logging in to the
 * account's own folder and importing afterwards never touches it.
 */
async function globalAdd() {
  if (!(await ensureGlobalMode())) return
  return addAccount()
}

/** Reuse a login already captured by the per-window setup, with no re-login. */
async function globalImport() {
  const reg = store.readRegistry(root())
  const candidates = reg.accounts.filter((a) => store.isAuthed(root(), a.name))
  if (!candidates.length) {
    vscode.window.showInformationMessage('No per-window accounts with a saved login to import.')
    return
  }
  const pick = await vscode.window.showQuickPick(
    candidates.map((a) => ({ label: a.name, description: describe(a.name), name: a.name })),
    { placeHolder: 'Import which account into global mode?' })
  if (!pick) return

  try {
    // In global mode the folder copy is moved, not copied, so the account's
    // refresh token only ever lives in one place.
    const saved = profilesLib.importFromDir(root(), pick.name, store.configDir(root(), pick.name),
      { move: store.getMode(root()) === 'login' })
    refreshAll()
    vscode.window.showInformationMessage(
      'Imported "' + pick.name + '"' + (saved.email ? ' (' + saved.email + ')' : '') +
      '. No browser login needed.')
  } catch (e) {
    vscode.window.showErrorMessage('Import failed: ' + (e && e.message))
  }
}

async function globalRemove() {
  const list = profilesLib.list(root())
  if (!list.length) {
    vscode.window.showInformationMessage('No saved accounts.')
    return
  }
  const pick = await vscode.window.showQuickPick(globalItems(),
    { placeHolder: 'Forget which saved account?' })
  if (!pick) return
  const confirm = await vscode.window.showWarningMessage(
    'Forget "' + pick.name + '"? This deletes the saved credentials only. ' +
    'Your chats, and the Claude account itself, are untouched.',
    { modal: true }, 'Forget')
  if (confirm !== 'Forget') return
  profilesLib.remove(root(), pick.name)
  refreshAll()
  vscode.window.showInformationMessage('Forgot "' + pick.name + '".')
}

/**
 * Change an account's display label. The directory keeps its original name on
 * purpose: moving it would strand any window already pinned to the old path.
 */
async function renameAccount() {
  const name = await pickAccount('Rename which account?')
  if (!name) return
  const cur = store.displayOf(root(), name)
  const label = await vscode.window.showInputBox({
    title: 'Rename ' + (name === DEFAULT_NAME ? 'the default account' : '"' + name + '"'),
    prompt: name === DEFAULT_NAME
      ? 'Display name for your original ~/.claude login'
      : 'Display name (the folder stays "' + name + '")',
    value: cur.label,
    validateInput: (v) => (store.validLabel(v) ? null : 'Enter 1-40 characters'),
  })
  if (label === undefined) return
  store.setDisplay(root(), name, { label: label.trim() })
  refreshAll()
  vscode.window.showInformationMessage('Renamed to "' + label.trim() + '".')
}

const ICON_CHOICES = [
  'account', 'person', 'organization', 'home', 'briefcase', 'rocket', 'beaker',
  'star-full', 'heart', 'zap', 'flame', 'globe', 'tools', 'code', 'cloud',
  'shield', 'key', 'mortar-board', 'gift', 'bug', 'telescope', 'squirrel',
]

/** Pick the codicon shown beside the account name. */
async function setAccountIcon() {
  const name = await pickAccount('Set the icon for which account?')
  if (!name) return
  const cur = store.displayOf(root(), name)

  const items = ICON_CHOICES.map((i) => ({
    label: '$(' + i + ') ' + i,
    description: i === cur.icon ? 'current' : undefined,
    value: i,
  }))
  items.push({ label: '$(edit) Custom…', description: 'Any codicon id', value: '__custom__' })

  const pick = await vscode.window.showQuickPick(items,
    { placeHolder: 'Icon for "' + cur.label + '"' })
  if (!pick) return

  let icon = pick.value
  if (icon === '__custom__') {
    icon = await vscode.window.showInputBox({
      title: 'Custom icon',
      prompt: 'Codicon id, without the $() wrapper. See https://microsoft.github.io/vscode-codicons/dist/codicon.html',
      value: cur.icon,
      validateInput: (v) => (store.validIcon(v || '') ? null : 'Letters, digits and hyphens only'),
    })
    if (!icon) return
  }
  store.setDisplay(root(), name, { icon })
  refreshAll()
  vscode.window.showInformationMessage('Icon set to $(' + icon + ') ' + icon + '.')
}

/** Open registry.json so labels, icons and modes can be edited by hand. */
async function openConfigFile() {
  store.ensureRoot(root())
  const p = path.join(root(), 'registry.json')
  if (!fs.existsSync(p)) store.writeRegistry(root(), store.readRegistry(root()))
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p))
  await vscode.window.showTextDocument(doc)
}

/** Turn Remote Control on or off for one account. */
async function remoteControl() {
  if (store.getMode(root()) !== 'login') {
    vscode.window.showWarningMessage(
      'Per-account Remote Control applies in global mode, where one login serves everything.')
    return
  }
  const list = profilesLib.list(root())
  if (!list.length) {
    vscode.window.showInformationMessage('No saved accounts yet.')
    return
  }
  const activeName = profilesLib.activeProfile(root())
  const pick = await vscode.window.showQuickPick(
    list.map((pr) => {
      const off = store.getRemote(root(), pr.name) === 'off'
      return {
        label: (off ? '$(circle-slash) ' : '$(broadcast) ') + store.displayOf(root(), pr.name).label,
        description: (off ? 'Remote Control OFF' : 'Remote Control on') +
          (pr.name === activeName ? '  ·  active' : ''),
        detail: pr.email || undefined,
        name: pr.name,
      }
    }),
    { placeHolder: 'Remote Control for which account?' })
  if (!pick) return

  const currently = store.getRemote(root(), pick.name)
  const choice = await vscode.window.showQuickPick(
    [
      { label: '$(circle-slash) Off', description: 'Never connect this account to claude.ai', value: 'off' },
      { label: '$(broadcast) On', description: 'Leave Claude Code to its own setting', value: 'on' },
    ],
    { placeHolder: 'Remote Control for "' + store.displayOf(root(), pick.name).label + '" (now: ' + currently + ')' })
  if (!choice) return

  store.setRemote(root(), pick.name, choice.value)
  let applied = null
  if (pick.name === activeName) applied = applyRemotePreference(pick.name)
  refreshAll()

  const label = store.displayOf(root(), pick.name).label
  if (choice.value === 'off') {
    vscode.window.showInformationMessage(
      'Remote Control is off for "' + label + '"' +
      (applied ? '. Chats already running keep their current connection until restarted.'
        : '. It will be applied when you switch to that account.'))
  } else {
    vscode.window.showInformationMessage('Remote Control follows Claude Code settings again for "' + label + '".')
  }
}

async function removeAccount() {
  const name = await pickAccount('Remove which account?', { includeDefault: false })
  if (!name) return
  const confirm = await vscode.window.showWarningMessage(
    'Remove "' + name + '"? This deletes its local config dir and stored credentials. ' +
    'Your Claude account itself is untouched.',
    { modal: true }, 'Remove')
  if (confirm !== 'Remove') return
  store.removeAccount(root(), name)
  refreshAll()
  vscode.window.showInformationMessage('Removed "' + name + '".')
}

async function relogin() {
  let name
  if (store.getMode(root()) === 'login') {
    const pick = await vscode.window.showQuickPick(globalItems(),
      { placeHolder: 'Sign in again to which account?' })
    name = pick && pick.name
  } else {
    name = await pickAccount('Re-login which account?', { includeDefault: false })
  }
  if (!name) return

  // Profiles saved from the live login have no folder yet; give them one to log in to.
  if (!store.readRegistry(root()).accounts.some((a) => a.name === name)) store.addAccount(root(), name)
  const dir = store.configDir(root(), name)
  const startedAt = Date.now()
  if (!launchTerminal('Claude login: ' + name, dir, ['auth', 'login'])) return
  trackLogin(name, dir, startedAt, false)
}

async function showStatus() {
  const reg = store.readRegistry(root())
  output.show(true)
  output.appendLine('')
  output.appendLine('=== Claude accounts ===')
  output.appendLine('edition: ' + edition)
  output.appendLine('platform: ' + process.platform + '  ·  credential store: ' + secretsLib.describe())
  output.appendLine('root: ' + root())
  output.appendLine('mode: ' + store.getMode(root()))
  output.appendLine('this window: ' + JSON.stringify(currentWindowAccount()))

  // In global mode the per-account folders are empty by design: the login was
  // moved into the encrypted profile. Probing them would report every account
  // as signed out, so report the profiles and the one live login instead.
  if (store.getMode(root()) === 'login') {
    const active = profilesLib.activeProfile(root())
    const st = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Checking Claude accounts...' },
      () => Promise.resolve(claude.authStatus(profilesLib.paths().claudeDir)))
    output.appendLine('live login: ' + (st.ok
      ? (st.loggedIn ? 'signed in' : 'SIGNED OUT') + '  ' +
        [st.email, st.orgName ? '(' + st.orgName + ')' : null].filter(Boolean).join(' ')
      : 'ERROR: ' + st.error))
    output.appendLine('usage: ' + (usageLib.compactText(usageLib.readBest(root(), null)) || 'n/a'))
    output.appendLine('saved accounts:')
    const saved = profilesLib.list(root())
    if (!saved.length) output.appendLine('   (none saved yet)')
    for (const prof of saved) {
      output.appendLine(' ' + (prof.name === active ? '*' : ' ') + ' ' + prof.name.padEnd(16) +
        ' ' + [prof.email, prof.org].filter(Boolean).join('  ·  ') +
        (prof.capturedAt ? '   saved ' + new Date(prof.capturedAt).toISOString() : '') +
        (store.getRemote(root(), prof.name) === 'off' ? '   remote:off' : ''))
    }
    output.appendLine('(* = active)')
    return
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking Claude accounts...' },
    async () => {
      const names = reg.accounts.map((a) => a.name).concat([DEFAULT_NAME])
      for (const name of names) {
        const dir = accountDirFor(name)
        const st = claude.authStatus(dir || path.join(require('os').homedir(), '.claude'))
        const u = usageLib.readUsage(dir)
        const mark = currentWindowAccount().name === name ? '*' : ' '
        const auth = st.ok
          ? (st.loggedIn ? 'signed in' : 'SIGNED OUT') + '  ' +
            [st.email, st.orgName ? '(' + st.orgName + ')' : null].filter(Boolean).join(' ')
          : 'ERROR: ' + st.error
        output.appendLine(' ' + mark + ' ' + name.padEnd(16) + ' ' + auth +
          '   usage: ' + (usageLib.compactText(u) || 'n/a'))
      }
    })
  output.appendLine('(* = this window)')
}

/** Neutral now that the backend is not always DPAPI; '.dpapi' still restores. */
const BACKUP_EXT = '.enc'

async function backup() {
  const name = await pickAccount('Back up credentials for...', { includeDefault: false })
  if (!name) return
  const src = path.join(store.configDir(root(), name), '.credentials.json')
  if (!fs.existsSync(src)) {
    vscode.window.showWarningMessage('"' + name + '" has no credentials to back up.')
    return
  }
  const blob = secretsLib.protect(fs.readFileSync(src))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = path.join(root(), 'backups', name + '-' + stamp + BACKUP_EXT)
  fs.writeFileSync(dest, blob)
  log('backed up ' + name + ' -> ' + dest + ' (' + blob.length + ' bytes)')
  vscode.window.showInformationMessage(
    'Backed up "' + name + '" (' + secretsLib.describe() + '; readable only by you, on this machine).')
}

async function restore() {
  const dir = path.join(root(), 'backups')
  // .dpapi is what Windows-only builds wrote; still listed so old backups restore.
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(BACKUP_EXT) || f.endsWith('.dpapi'))
    : []
  if (!files.length) {
    vscode.window.showInformationMessage('No backups found.')
    return
  }
  const pick = await vscode.window.showQuickPick(files.sort().reverse(),
    { placeHolder: 'Restore which backup?' })
  if (!pick) return
  const name = pick.replace(/-\d{4}-\d{2}-\d{2}T.*$/, '')
  const target = store.configDir(root(), name)
  if (!fs.existsSync(target)) {
    vscode.window.showErrorMessage('Account "' + name + '" no longer exists.')
    return
  }
  const confirm = await vscode.window.showWarningMessage(
    'Overwrite current credentials for "' + name + '" with ' + pick + '?', { modal: true }, 'Restore')
  if (confirm !== 'Restore') return
  const plain = secretsLib.unprotect(fs.readFileSync(path.join(dir, pick)))
  fs.writeFileSync(path.join(target, '.credentials.json'), plain)
  store.lockdown(target)
  vscode.window.showInformationMessage('Restored "' + name + '".')
  await verifyAccount(name)
}

/**
 * Clicking the meter asks the server, rather than re-reading Claude Code's
 * cache. The bar shows a spinner until the response lands, then updates.
 */
let usageFetchInFlight = false

async function refreshUsage() {
  if (usageFetchInFlight) return
  usageFetchInFlight = true

  const cur = currentWindowAccount()
  const previousText = usageBar.text
  usageBar.text = '$(sync~spin) usage...'
  usageBar.tooltip = 'Fetching live usage from Anthropic...'

  try {
    const res = await liveLib.fetchUsage(cur.dir)
    if (res.ok) {
      usageLib.writeLiveCache(root(), cur.dir, res.utilization)
      updateUsageBar()
      log('live usage fetched for ' + (cur.name || 'default'))
    } else {
      usageBar.text = previousText
      updateUsageBar()
      vscode.window.showWarningMessage(
        'Could not fetch live usage: ' + res.reason + '. Showing the cached figures.')
    }
  } catch (e) {
    usageBar.text = previousText
    updateUsageBar()
    vscode.window.showErrorMessage('Usage refresh failed: ' + (e && e.message))
  } finally {
    usageFetchInFlight = false
  }
}

// ---------------------------------------------------------------- lifecycle

function activate(context) {
  edition = editionLib.from(context)
  output = vscode.window.createOutputChannel('Claude Account Switcher')
  context.subscriptions.push(output)

  store.ensureRoot(root())

  // The team build knows only global mode. A machine that once ran the
  // experimental build can still be left in per-window mode, which this build
  // has no command to undo, so put it back on activation.
  if (edition === editionLib.MAIN && store.getMode(root()) !== 'login') {
    store.setMode(root(), 'login')
    log('main edition: forced global mode')
  }

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  statusBar.command = 'claudeswitcher.switchAccount'
  statusBar.name = 'Claude Account'
  context.subscriptions.push(statusBar)

  usageBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99)
  usageBar.command = 'claudeswitcher.refreshUsage'
  usageBar.name = 'Claude Usage'
  context.subscriptions.push(usageBar)

  const cmds = {
    switchAccount, newChatAs, newTerminalAs, openWindowAs, addAccount,
    removeAccount, relogin, showStatus, backup, restore,
    usePerWindowAccounts, useMachineWideAccount, refreshUsage,
    renameAccount, setAccountIcon, openConfigFile,
    globalSwitch, globalAdd, globalImport, globalRemove, saveCurrentLogin,
    remoteControl,
  }
  for (const id of Object.keys(cmds)) {
    if (!editionLib.includes(edition, id)) continue
    context.subscriptions.push(vscode.commands.registerCommand('claudeswitcher.' + id, () =>
      Promise.resolve(cmds[id]()).catch((e) => {
        log(id + ' failed: ' + (e && e.stack))
        vscode.window.showErrorMessage('Claude Accounts: ' + (e && e.message))
      })))
  }

  // The team build never pins a config dir, so clear any left over by an
  // earlier experimental install; otherwise every chat keeps launching against
  // a folder this build offers no way to unset.
  if (edition === editionLib.MAIN) {
    if (envBridge.currentConfigDir(vscode)) {
      envBridge.setConfigDir(vscode, null)
        .then(() => log('cleared leftover CLAUDE_CONFIG_DIR override'))
        .catch((e) => log('could not clear config dir override: ' + (e && e.message)))
    }
  } else if (store.getMode(root()) === 'window') {
    log('per-window mode; window dir=' + (windowPinnedDir() || '(unset: default login)'))
  } else {
    const active = store.getActive(root())
    if (active && active !== DEFAULT_NAME) {
      if (fs.existsSync(store.configDir(root(), active))) {
        applyToNativeUI(active).catch((e) => log('initial env apply failed: ' + (e && e.message)))
      } else {
        log('active account "' + active + '" has no config dir; leaving env untouched')
        vscode.window.showWarningMessage(
          'Claude account "' + active + '" is missing its local directory. Re-login or remove it.')
      }
    }
  }

  // Recover logins that finished while no one was watching: a missed prompt,
  // a reload mid-login, or an older build that relied on a Verify button.
  if (store.getMode(root()) === 'login') {
    try { applyRemotePreference(profilesLib.activeProfile(root())) } catch (e) { log('remote pref: ' + e.message) }
  }

  const recovered = syncStagedLogins()
  if (recovered.length) {
    vscode.window.showInformationMessage('Added to the account switcher: ' + recovered.join(', ') + '.')
  }

  // registry.json is meant to be hand-editable, so pick up external edits.
  try {
    const watcher = fs.watch(root(), (_ev, file) => {
      if (file === 'registry.json') refreshAll()
    })
    context.subscriptions.push({ dispose: () => watcher.close() })
  } catch (e) { log('registry watch unavailable: ' + (e && e.message)) }

  usageTimer = setInterval(updateUsageBar, 60000)
  context.subscriptions.push({ dispose: () => clearInterval(usageTimer) })
  context.subscriptions.push(vscode.window.onDidChangeWindowState((s) => {
    if (s.focused) updateUsageBar()
  }))
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('claudeCode.environmentVariables')) refreshAll()
  }))

  refreshAll()
  log('activated; edition=' + edition + '; root=' + root() + '; mode=' + store.getMode(root()))
}

function stopLoginWatchers() {
  for (const stop of [...loginWatchers]) stop()
}

function deactivate() {
  if (usageTimer) clearInterval(usageTimer)
  stopLoginWatchers()
}

module.exports = {
  activate,
  deactivate,
  // Test hooks only.
  _test: {
    stopLoginWatchers,
    syncStagedLogins,
    settle: () => Promise.all([...pendingLogins]),
    setLoginPollMs: (ms) => { loginPollMs = ms },
  },
}
