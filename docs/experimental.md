# Experimental edition

Everything in the team build, plus the features that are either unfinished,
risky, or only useful if you know exactly what you are doing.

Build it with `npm run package:experimental`. It shares an extension id with the
team build, so installing it **replaces** the team build (and vice versa).

## What it adds

**Per-window accounts.** Pin a VS Code window to one account by launching it
with `CLAUDE_CONFIG_DIR` set to that account's own directory. Two accounts can
then run side by side in different windows.

> This is the design the team build deliberately abandoned. Because Claude Code
> keeps conversations *inside* the config directory, giving each account its own
> directory splits your chat history across accounts: switch, and the sidebar
> looks empty. It works, but you have to want it.

**Per-account Remote Control.** Set `disableRemoteControl` in
`~/.claude/settings.json` automatically whenever you switch to an account you
have marked "off". Command: **Claude Accounts: Remote Control per Account…**.
The preference is stored in `registry.json` under `remote`.

**Credential backup and restore.** Encrypted snapshots of an account's
credentials into `~/.claude-switcher/backups/`.

**Rename and icons.** Change an account's display label and its status bar
codicon, separately from its folder name.

**Import.** Pull an account captured by the per-window setup into the global
switcher without logging in again.

## Modes

The extension stores a mode in `registry.json`. The team build forces `login`
(global). The experimental build can also use:

- `window` — per-window accounts, set by **Use Per-Window Accounts**
- `global` — one machine-wide `CLAUDE_CONFIG_DIR`, set by **Use One Machine-Wide
  Account**

Switching back to the team build resets the mode to `login` on activation and
clears any leftover `CLAUDE_CONFIG_DIR` override, because that build has no
command to undo them.

---

The rest of this file is the original documentation written while per-window
mode was the main design. Read it with that in mind: where it says "recommended",
it means recommended *for that mode*, not for the team build.

---

## How it works

Claude Code reads its entire auth state from whatever directory `CLAUDE_CONFIG_DIR`
points at. This extension gives each account its own directory:

```
~/.claude-switcher/
  registry.json            which accounts exist, which is active
  accounts/
    work/                  a complete, isolated CLAUDE_CONFIG_DIR
      .credentials.json      <- written by Claude Code at login
      .claude.json           <- identity + that account's project state
    personal/
    side/
  backups/
    work-2026-09-14T...enc     encrypted credential snapshots (older builds wrote .dpapi; both restore)
```

Nothing is swapped in or out of `~/.claude`. Accounts are fully independent, so
two accounts can run **at the same time** in different chats or terminals without
one clobbering the other's refreshed tokens.

Your existing `~/.claude` login is left completely untouched and keeps working as
the default whenever `CLAUDE_CONFIG_DIR` is not set.

## Setup

1. Install (see below), then reload VS Code.
2. Run **Claude Accounts: Add Account** from the Command Palette.
3. Give it a short name (`work`), optionally an email to pre-fill the login page.
4. A terminal opens and runs `claude auth login` against that account's own
   directory. Complete the browser step, then click **Verify**.
5. Repeat for each account.

The browser is needed **once per account**. After that, switching is instant and
entirely offline.

## Daily use

| Command | What it does |
| --- | --- |
| **Open New Window as Account…** | Opens a window permanently pinned to one account. The per-window workhorse. |
| **New Terminal as Account…** | Opens a terminal running `claude` on that account. Exact, per-terminal. |
| **Switch Active Account** | Machine-wide mode only: sets the account new chats use. Status bar click target. |
| **New Chat as Account…** | Machine-wide mode only: opens a new chat on a chosen account. |
| **Use Per-Window Accounts** / **Use One Machine-Wide Account** | Switch between the two modes below. |
| **Rename Account…** / **Set Account Icon…** | Change the display name and icon, including for `(default)`. |
| **Open Config File** | Opens `registry.json` to edit labels, icons and mode by hand. |
| **Add Account…** / **Re-login Account…** | Browser login for a new or expired account. |
| **Show Status** | Live `claude auth status` for every account, in an output channel. |
| **Backup / Restore Credentials** | Encrypted snapshot of one account's tokens, using the platform's credential store. |
| **Remove Account…** | Deletes the local directory. Your actual Claude account is untouched. |

The status bar shows what **this window** is on. A pin icon (`📌 work`) means the
window is pinned and nothing elsewhere can change it.

## Two modes — read this bit

### Per-window mode (recommended)

Each window is pinned to one account for its entire life. **Open New Window as
Account…** launches VS Code with `CLAUDE_CONFIG_DIR` in the new window's
environment, and VS Code passes that through to the window's extension host.

Every chat in that window — new or resumed, sidebar or terminal — uses that
account. Nothing done in another window can change it. Two windows on two
accounts work side by side indefinitely.

Windows you open normally (File → New Window) are not pinned and use your
default `~/.claude` login.

This mode requires the machine-wide setting to be **unset**, because the Claude
extension overlays `claudeCode.environmentVariables` on top of `process.env` at
spawn time — so a machine-wide value wins over the window's. The extension
clears it for you when you enter this mode, and the status bar turns amber if
something re-sets it behind your back.

Per-chat selection is unavailable here, by design: it works by writing that
machine-wide setting, which would override every pinned window at once.

### Machine-wide mode

One account drives new chats in **every** window on the machine.
`claudeCode.environmentVariables` is machine-scoped — VS Code only permits it in
user `settings.json`, never per-workspace — so this genuinely cannot be scoped to
a single window.

Here, **Switch Active Account** and **New Chat as Account…** work, and the switch
takes effect for the *next* chat spawned anywhere.

### What never changes in either mode

Open chats keep the account they were spawned with until they respawn. Switching
does not migrate a running chat. Reloading a window respawns **all** its chats
onto the currently-selected account.

**Terminal chats** (`New Terminal as Account…`) are exact in both modes: the
account is baked into that terminal's environment at creation, so ten terminals
can run ten different accounts at once with no interference.

## Your existing account

The login you already had is untouched. It lives in `~/.claude` (credentials)
and `~/.claude.json` (identity, projects, usage), and it is what Claude Code uses
whenever `CLAUDE_CONFIG_DIR` is unset.

It appears in every picker as **`(default)`**, so you can open a window or
terminal on it like any other account. Choosing it launches with the variable
*cleared* rather than pointing at `~/.claude`, so it behaves exactly as it did
before this extension existed — same history, same project state.

It is deliberately excluded from **Remove**, **Re-login**, and **Backup**: it is
Claude Code's own login, and this extension does not manage its lifecycle. Sign
in or out of it with `claude auth` as usual.

Nothing is ever copied out of it. Accounts you add get their own fresh login, so
no refresh token is ever duplicated between two directories.

## Usage meter

The second status bar item shows three percentages for **this window's** account:

```
📊 36% | 53% | 57%
   │     │     └── weekly, all models
   │     └──────── weekly, model-scoped (e.g. Fable)
   └────────────── session (5 hour)
```

Hover for plain text: what each number means, when each limit resets, extra-usage
credits in dollars, and how long ago the figure was cached.

It turns amber above 80% and red above 95%.

**Click the meter to fetch live numbers.** It calls
`GET https://api.anthropic.com/api/oauth/usage` — the same endpoint Claude Code
uses — shows a spinner while the request is in flight, and updates the moment the
response lands. Typically under half a second.

Between clicks the bar reads whichever is newer of two caches: Claude Code's own
`cachedUsageUtilization`, and the result of your last live fetch. The hover says
which one you are looking at and how old it is. It also re-reads every 60 seconds
and when the window regains focus.

Two deliberate limits on the live fetch:

- **It never refreshes your OAuth token.** It uses the existing access token
  read-only. Refreshing rotates the token and rewrites the credential file, and a
  bug there would sign you out. If the token has expired the fetch is skipped and
  the cached figures stay on screen — Claude Code refreshes on its own schedule.
- **It never writes `.claude.json`.** Live results go to
  `~/.claude-switcher/usage/<accountUuid>.json` instead. That file holds your
  project history and settings, and a read-modify-write race with Claude Code
  could lose them.

A failed fetch never blanks the bar: it restores the previous figures and tells
you why.

`Show Status` prints the usage line for every account at once.

## Names and icons

Every account has two separate identities:

- a **folder name** (`work`) — the directory under `accounts/`, and the internal id
- a **display label** (`Work / Acme`) — what the status bar and pickers show

**Rename Account…** changes the label only. The folder deliberately stays put:
moving it would strand any window already pinned to the old path, and would
break a `--new-window` launch already in flight. The tooltip shows the real
folder name whenever it differs from the label.

`(default)` can be renamed and re-iconed like any other account, even though it
has no folder of its own — its display settings live under a `defaults` key.

**Set Account Icon…** offers a list of common icons, or `Custom…` for any
[codicon](https://microsoft.github.io/vscode-codicons/dist/codicon.html) id.
Write the id alone (`briefcase`), not the `$(briefcase)` wrapper.

A pinned window appends a pin after the label, so a custom icon never costs you
the pinned indicator:

```
$(briefcase) Work / Acme $(pin)
```

The usage meter's own icon is the `claudeswitcher.usageIcon` setting.

### Editing by hand

It is all plain JSON in `~/.claude-switcher/registry.json`:

```json
{
  "accounts": [
    { "name": "work", "createdAt": "…", "label": "Work / Acme", "icon": "briefcase" },
    { "name": "personal", "createdAt": "…" }
  ],
  "active": "work",
  "mode": "window",
  "defaults": { "label": "Personal (main)", "icon": "rocket" }
}
```

`label` and `icon` are optional — omit them and an account falls back to its
folder name and the `account` icon. **Open Config File** opens this, and the
extension watches it, so edits appear in the status bar as soon as you save.

Do not rename the `name` key by hand: it must match the directory under
`accounts/`.

## Security

- Each account directory is restricted to your user, since these hold live
  OAuth refresh tokens: `icacls` with inheritance stripped on Windows,
  `chmod 700` elsewhere.
- Backups are encrypted the same way as saved profiles — DPAPI on Windows, an
  AES key held in the Keychain on macOS — so a backup copied to another machine
  or user account is inert.
- The extension never logs, prints, or transmits token material.

## Build and install

```powershell
npm run package:experimental
code --install-extension dist\claude-account-switcher-experimental-1.0.1.vsix
```

Then reload VS Code. To develop instead, open the repo in VS Code and press
`F5` — running from source is always the experimental edition.

## Troubleshooting

- **Status shows SIGNED OUT** — the refresh token expired (roughly 30 days
  unused). Run **Re-login Account…**.
- **A chat used the wrong account** — it was resumed rather than newly created.
  See the scope section above.
- **`claude` not found** — the extension looks for the native binary under
  `AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\`, then falls
  back to `where claude`.

## Tests

```powershell
npm test
```

Runs the extension against a mocked `vscode` API and a throwaway root
directory. Touches neither `~/.claude` nor `~/.claude-switcher`, and never
reaches the network.
