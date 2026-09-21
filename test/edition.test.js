// Guards the main/experimental split. The two editions are derived from one
// manifest and one command table, so the failure this catches is drift: a
// command promoted in lib/edition.js but never added to package.json, a title
// override for a command that is not in the minimal set, or a build that
// quietly ships the whole palette to the team.

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const edition = require('../lib/edition')
const build = require('../build.js')

const base = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
const PREFIX = 'claudeswitcher.'

let passed = 0
let failed = 0
function check(what, ok) {
  if (ok) { passed++; console.log('  ok   ' + what) } else { failed++; console.log('  FAIL ' + what) }
}

console.log('\n-- the minimal set is real and small --')
const allIds = base.contributes.commands.map((c) => c.command.slice(PREFIX.length))
check('every main command exists in package.json',
  edition.MAIN_COMMANDS.every((id) => allIds.includes(id)))
check('no duplicates in the main set',
  new Set(edition.MAIN_COMMANDS).size === edition.MAIN_COMMANDS.length)
check('main is a strict subset of the full palette',
  edition.MAIN_COMMANDS.length < allIds.length)
check('every title override names a main command',
  Object.keys(edition.MAIN_TITLES).every((id) => edition.MAIN_COMMANDS.includes(id)))
check('every main setting exists',
  edition.MAIN_SETTINGS.every((k) => k in base.contributes.configuration.properties))

console.log('\n-- the commands the team build must have --')
for (const id of ['globalSwitch', 'globalAdd', 'globalRemove', 'refreshUsage']) {
  check(id + ' ships in main', edition.includes(edition.MAIN, id))
}

console.log('\n-- and the ones it must not --')
for (const id of ['usePerWindowAccounts', 'openWindowAs', 'newTerminalAs', 'remoteControl',
  'backup', 'restore', 'switchAccount', 'addAccount', 'removeAccount']) {
  check(id + ' is experimental-only', !edition.includes(edition.MAIN, id))
}

console.log('\n-- experimental ships everything --')
check('no command is filtered out',
  allIds.every((id) => edition.includes(edition.EXPERIMENTAL, id)))
check('commandsFor(experimental) means "no filter"',
  edition.commandsFor(edition.EXPERIMENTAL) === null)

console.log('\n-- generated manifests --')
const mainPkg = build.manifestFor(edition.MAIN, base)
const expPkg = build.manifestFor(edition.EXPERIMENTAL, base)

check('main manifest has exactly the main commands',
  mainPkg.contributes.commands.length === edition.MAIN_COMMANDS.length)
check('main manifest declares its edition', mainPkg.claudeswitcher.edition === 'main')
check('experimental manifest declares its edition', expPkg.claudeswitcher.edition === 'experimental')
check('experimental manifest keeps every command',
  expPkg.contributes.commands.length === base.contributes.commands.length)
check('the two share one extension id, so installing one replaces the other',
  mainPkg.name === expPkg.name && mainPkg.name === base.name)
check('display names differ', mainPkg.displayName !== expPkg.displayName)
check('main drops "(Global)" from the switch title',
  mainPkg.contributes.commands.find((c) => c.command === PREFIX + 'globalSwitch').title ===
    'Claude Accounts: Switch Account')
check('main keeps settings it uses',
  Object.keys(mainPkg.contributes.configuration.properties).sort().join(',') ===
    edition.MAIN_SETTINGS.slice().sort().join(','))
check('main drops the per-window-only setting',
  !('claudeswitcher.reloadPrompt' in mainPkg.contributes.configuration.properties))
check('every main command still has a title and category',
  mainPkg.contributes.commands.every((c) => c.title && c.category))
check('building does not mutate the source manifest',
  JSON.stringify(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))) ===
    JSON.stringify(base))

console.log('\n-- a promoted command that package.json forgot is caught --')
const stripped = JSON.parse(JSON.stringify(base))
stripped.contributes.commands = stripped.contributes.commands
  .filter((c) => c.command !== PREFIX + 'globalSwitch')
check('manifestFor throws instead of shipping a broken palette', (() => {
  try { build.manifestFor(edition.MAIN, stripped); return false } catch (e) {
    return /globalSwitch/.test(e.message)
  }
})())

console.log('\n-- edition detection --')
check('unknown edition falls back to experimental',
  edition.from({ extension: { packageJSON: { claudeswitcher: { edition: 'nonsense' } } } }) ===
    edition.EXPERIMENTAL)
check('no host context falls back to experimental', edition.from(undefined) === edition.EXPERIMENTAL)
check('bare context falls back to experimental', edition.from({ subscriptions: [] }) === edition.EXPERIMENTAL)
check('a main manifest is detected',
  edition.from({ extension: { packageJSON: mainPkg } }) === edition.MAIN)

console.log('\n' + passed + ' passed, ' + failed + ' failed')
assert.strictEqual(failed, 0, 'edition tests failed')
