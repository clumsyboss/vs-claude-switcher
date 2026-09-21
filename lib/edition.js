/**
 * Editions.
 *
 * One codebase, two builds. `main` is what the team installs: a single global
 * account switcher and nothing else. `experimental` is everything, including
 * per-window accounts, per-account Remote Control and the credential
 * backup/restore tools.
 *
 * The split is declared here and applied in two places that must agree:
 *   - build.js  filters the manifest, so only an edition's commands appear
 *               in the Command Palette;
 *   - extension.js filters command registration, so a command that is not in
 *               an edition cannot be reached at all (a keybinding or another
 *               extension calling it by id gets "command not found").
 *
 * Adding a command therefore defaults to experimental-only. Promoting it to
 * the team build is a one-line edit to MAIN_COMMANDS.
 */

const MAIN = 'main'
const EXPERIMENTAL = 'experimental'
const EDITIONS = [MAIN, EXPERIMENTAL]

/**
 * The minimal set. Each one earns its place:
 *   globalSwitch      the whole point; also what the status bar clicks
 *   globalAdd         sign a new account in
 *   globalRemove      forget a saved account
 *   saveCurrentLogin  first run: the login you already have is not saved yet
 *   relogin           a refresh token expires roughly every few weeks
 *   refreshUsage      what the usage meter clicks
 *   showStatus        the one thing to ask a teammate to run when stuck
 */
const MAIN_COMMANDS = [
  'globalSwitch',
  'globalAdd',
  'globalRemove',
  'saveCurrentLogin',
  'relogin',
  'refreshUsage',
  'showStatus',
]

/** Settings the minimal edition contributes. The rest only matter per-window. */
const MAIN_SETTINGS = ['claudeswitcher.root', 'claudeswitcher.usageIcon']

/**
 * Palette titles for the minimal edition. The full build says "(Global)" to
 * tell global mode apart from per-window mode; with only one mode that
 * qualifier is noise, so the team build drops it.
 */
const MAIN_TITLES = {
  globalSwitch: 'Claude Accounts: Switch Account',
  globalAdd: 'Claude Accounts: Add Account…',
  globalRemove: 'Claude Accounts: Remove Account…',
  saveCurrentLogin: 'Claude Accounts: Save Current Login…',
}

const MAIN_META = {
  displayName: 'Claude Account Switcher',
  description: 'Switch between multiple Claude accounts in VS Code. One login at a time, chats never move.',
}

const EXPERIMENTAL_META = {
  displayName: 'Claude Account Switcher (Experimental)',
  description: 'Claude Account Switcher plus per-window accounts, per-account Remote Control, and credential backup.',
}

function isEdition(v) { return EDITIONS.indexOf(v) !== -1 }

/**
 * Which edition is running. Read from the packaged manifest so there is no
 * second file to keep in sync; anything unrecognised — including running from
 * source with no host — is treated as experimental, because that is the
 * development build.
 */
function from(context) {
  const pkg = context && context.extension && context.extension.packageJSON
  const v = pkg && pkg.claudeswitcher && pkg.claudeswitcher.edition
  return isEdition(v) ? v : EXPERIMENTAL
}

/** Command ids (without the `claudeswitcher.` prefix) an edition ships. */
function commandsFor(edition) {
  return edition === MAIN ? MAIN_COMMANDS.slice() : null   // null = every command
}

function includes(edition, id) {
  const allowed = commandsFor(edition)
  return !allowed || allowed.indexOf(id) !== -1
}

function metaFor(edition) {
  return edition === MAIN ? { ...MAIN_META } : { ...EXPERIMENTAL_META }
}

module.exports = {
  MAIN, EXPERIMENTAL, EDITIONS,
  MAIN_COMMANDS, MAIN_SETTINGS, MAIN_TITLES,
  isEdition, from, commandsFor, includes, metaFor,
}
