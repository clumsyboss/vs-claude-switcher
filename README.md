# Claude Account Switcher

Switch between your Claude accounts from the VS Code status bar, without going
through the browser login every time.

Everything stays on your machine. No server, no telemetry, no account data
leaves the laptop.

**Windows only.** Credentials are encrypted with Windows DPAPI and the account
store is locked down with `icacls`; neither has a macOS or Linux equivalent here
yet.

---

## Install

Download `claude-account-switcher-main-<version>.vsix` from the
[latest release](https://github.com/clumsyboss/vs-claude-switcher/releases), then:

```powershell
code --install-extension claude-account-switcher-main-1.0.0.vsix
```

Reload VS Code. You should see your Claude account name in the bottom-right
status bar, next to a usage meter.

> If it shows an orange background, your current login has not been saved yet —
> see step 1 below.

## First run

1. **Save the account you already use.** Command Palette (`Ctrl+Shift+P`) →
   **Claude Accounts: Save Current Login…**. Give it a short name. Nothing about
   your login changes; it is just recorded so you can come back to it.
2. **Add your other accounts.** **Claude Accounts: Add Account…** → name it → a
   terminal opens and a browser tab asks you to sign in.
   - Use a **private/incognito window** if your browser is already signed in to
     a different Claude account. Otherwise it will silently reuse that one, and
     the extension will tell you it is a duplicate.
   - Paste the code back into the terminal. The extension notices on its own and
     adds the account — there is no button to click.
3. **Switch.** Click the account name in the status bar and pick one.

## Daily use

| I want to… | Do this |
|---|---|
| See which account is live | Look at the status bar, bottom right |
| Switch account | Click the account name |
| See my limits | Look at the three percentages; hover for detail |
| Force-refresh the limits | Click the percentages |
| Add another account | **Claude Accounts: Add Account…** |
| Sign in again after it expires | **Claude Accounts: Re-login Account…** |
| Something is wrong | **Claude Accounts: Show Status**, then share the output |

### The usage meter

```
📊 36% | 53% | 57%
   │     │     └── weekly, all models
   │     └──────── weekly, model-scoped (e.g. Fable)
   └────────────── session (5 hour)
```

It turns orange at 80% and red at 95%. The figures come from Claude Code's own
cache; clicking makes a live API call and updates as soon as the response lands.

## What switching does and does not touch

This is the part worth understanding, because an earlier design got it wrong.

Claude Code keeps **everything** in one directory — your credentials *and* every
conversation, your project settings, memory and todos. So the switcher keeps
that one directory exactly where it is (`~/.claude`) and swaps only the two
things that identify you: the credentials and the identity block.

**Untouched by a switch:** chat history, the sidebar conversation list, memory,
`CLAUDE.md`, project settings, todos, MCP servers, hooks.

**Changed by a switch:** who you are billed as, and which usage limits apply.

One caveat: **chats that are already open keep the previous account** until you
reopen them. The extension offers a window reload after each switch, which is
the reliable way to move everything across.

## Where your data lives

```
~/.claude/                          Claude Code's own directory — all your chats
~/.claude-switcher/
  registry.json                     account list, display names, active account
  profiles/
    <name>.enc                      DPAPI-encrypted credentials
    <name>.meta.json                email, org, when it was saved
  accounts/<name>/                  scratch space used during a login, then emptied
```

`registry.json` is plain JSON and safe to edit by hand; the extension watches it
and reloads.

### Security

- Credentials are encrypted with Windows **DPAPI at `CurrentUser` scope**. A
  copied `.enc` file is inert on another machine or under another Windows user.
- Account directories have inheritance stripped and are granted to your user
  only.
- A refresh token is never duplicated: a login is *moved* into the encrypted
  profile, and the plaintext copy is deleted only after the encrypted one has
  been read back and verified.
- The extension never logs, prints or transmits token material.

## Troubleshooting

**"Switched … but it reports signed out"** — that account's refresh token
expired (they last a few weeks). Run **Claude Accounts: Re-login Account…**.

**A chat is still using the old account** — it was already open. Reload the
window.

**The account name has an orange background** — the live login is not saved as a
profile. Run **Save Current Login…**, or you will lose it the next time you
switch away.

**`claude` not found** — the extension looks under
`AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\`, then falls
back to `where claude`. Install Claude Code, or put it on `PATH`.

**Anything else** — run **Claude Accounts: Show Status** and send the output
from the "Claude Account Switcher" output channel. It contains no token
material.

---

## For contributors

There are two editions built from this one source tree:

| | Commands | Who it is for |
|---|---|---|
| **main** | 7 | The team. Global switching and nothing else. |
| **experimental** | 22 | Per-window accounts, per-account Remote Control, credential backup/restore. See [docs/experimental.md](docs/experimental.md). |

They share an extension id, so installing one replaces the other — you can never
end up with two status bars fighting over the same account store.

```powershell
npm test              # 207 tests, no network, no touching your real ~/.claude
npm run stage         # build both editions into dist/ without packaging
npm run package       # both .vsix files into dist/
npm run package:main  # just the team build
```

To develop, open this folder in VS Code and press `F5`. Running from source is
always the **experimental** edition.

The split lives in [lib/edition.js](lib/edition.js). A new command is
experimental-only by default; promoting it to the team build means adding its id
to `MAIN_COMMANDS`. `test/edition.test.js` fails if the two builds drift apart.
