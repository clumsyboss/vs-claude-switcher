/**
 * Build the command line we type into a VS Code terminal.
 *
 * VS Code opens the platform's default shell, so the same string cannot serve
 * both. PowerShell parses a quoted path as a *value* and needs the call
 * operator `&` to run it; POSIX shells have no such operator and fail outright
 * on a leading `&` — `zsh: parse error near '&'`, which is exactly what a Mac
 * user hit when this was PowerShell-only.
 */
function invoke(bin, args) {
  const tail = args && args.length ? ' ' + args.join(' ') : ''
  if (process.platform === 'win32') {
    // PowerShell escapes a single quote by doubling it.
    return '& ' + "'" + bin.split("'").join("''") + "'" + tail
  }
  // POSIX: single quotes are literal, so a literal quote means closing the
  // string, emitting an escaped quote, and reopening it.
  return "'" + bin.split("'").join("'\\''") + "'" + tail
}

module.exports = { invoke }
