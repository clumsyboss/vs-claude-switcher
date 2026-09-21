#!/usr/bin/env node
/**
 * Build one or both editions.
 *
 *   node build.js                 both editions, staged into dist/
 *   node build.js main            just the team build
 *   node build.js --no-package    stage the folders, skip the .vsix
 *
 * Each edition is staged into its own folder and packaged there, so the
 * working tree is never mutated. That matters: a build that rewrote
 * package.json in place and then crashed would leave the repo holding the
 * wrong manifest, and the next `git commit` would ship it.
 */

const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const edition = require('./lib/edition')

const ROOT = __dirname
const DIST = path.join(ROOT, 'dist')
const PREFIX = 'claudeswitcher.'

/** Everything the extension needs at runtime. Tests and builds stay behind. */
const PAYLOAD = ['extension.js', 'lib', 'README.md', 'LICENSE']

function read(file) { return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')) }

/**
 * Derive an edition's manifest from the full one. Dropping entries rather than
 * listing them per edition means a new command can never be silently missing
 * from the build it was written for — it lands in experimental by default.
 */
function manifestFor(name, base) {
  const meta = edition.metaFor(name)
  const keep = edition.commandsFor(name)
  const has = (id) => !keep || keep.indexOf(id.slice(PREFIX.length)) !== -1

  const commands = base.contributes.commands
    .filter((c) => has(c.command))
    .map((c) => {
      const short = c.command.slice(PREFIX.length)
      const title = name === edition.MAIN && edition.MAIN_TITLES[short]
      return title ? { ...c, title } : { ...c }
    })

  if (keep) {
    const missing = keep.filter((id) => !commands.some((c) => c.command === PREFIX + id))
    if (missing.length) {
      throw new Error('edition "' + name + '" wants commands that package.json does not define: ' +
        missing.join(', '))
    }
  }

  const props = {}
  for (const [key, val] of Object.entries(base.contributes.configuration.properties)) {
    if (name !== edition.MAIN || edition.MAIN_SETTINGS.indexOf(key) !== -1) props[key] = val
  }

  const out = { ...base, ...meta }
  out.claudeswitcher = { edition: name }
  out.contributes = {
    ...base.contributes,
    commands,
    configuration: { ...base.contributes.configuration, properties: props },
  }
  // Both editions share one extension id on purpose: installing either replaces
  // the other, so you can never end up with two status bars fighting over the
  // same registry.
  return out
}

function stage(name, base) {
  const dir = path.join(DIST, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })

  for (const item of PAYLOAD) {
    const src = path.join(ROOT, item)
    if (!fs.existsSync(src)) continue
    fs.cpSync(src, path.join(dir, item), { recursive: true })
  }
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify(manifestFor(name, base), null, 2) + '\n')
  // vsce warns about a missing ignore file and would otherwise sweep in stray files.
  fs.writeFileSync(path.join(dir, '.vscodeignore'), '.vscodeignore\n')
  return dir
}

function pkg(name, dir, version) {
  const out = path.join(DIST, 'claude-account-switcher-' + name + '-' + version + '.vsix')
  const r = cp.spawnSync('npx', ['--yes', '@vscode/vsce@latest', 'package',
    '--no-dependencies', '--allow-missing-repository', '--skip-license', '--out', out],
  { cwd: dir, stdio: 'inherit', shell: true })
  if (r.status !== 0) throw new Error('vsce failed for edition "' + name + '" (exit ' + r.status + ')')
  return out
}

function main(argv) {
  const doPackage = !argv.includes('--no-package')
  const names = argv.filter((a) => !a.startsWith('--'))
  const wanted = names.length ? names : edition.EDITIONS
  for (const n of wanted) {
    if (!edition.isEdition(n)) throw new Error('unknown edition "' + n + '"; expected one of ' +
      edition.EDITIONS.join(', '))
  }

  const base = read('package.json')
  for (const name of wanted) {
    const dir = stage(name, base)
    const count = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      .contributes.commands.length
    console.log(name + ': staged ' + path.relative(ROOT, dir) + ' (' + count + ' commands)')
    if (doPackage) console.log(name + ': ' + path.relative(ROOT, pkg(name, dir, base.version)))
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (e) {
    console.error('build failed: ' + e.message)
    process.exit(1)
  }
}

module.exports = { manifestFor, stage }
