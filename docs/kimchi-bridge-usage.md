# Kimchi work reporting for Claude Code and Codex — how to use

Kimchi can record what your Claude Code and Codex sessions cost and show it
per pull request in the Kimchi console (Reporting → PR costs). It ships the
plugins for this in its releases, and a `kimchi bridge` command manages them.
Your inference provider and settings stay the same — unless you opt in to
routing through the Kimchi gateway.

## 1. Install

`curl …install.sh | bash` installs kimchi and asks (when run from a terminal)
whether to add work reporting to each client it finds — Claude Code, Codex, or
both. Answer per client, or set `KIMCHI_BRIDGE_SKIP=1` to skip entirely in
scripts.

Skipped it, or installed a client later? Add it anytime:

```sh
kimchi bridge setup
```

## 2. Sign in — once

Sign into Kimchi the usual way (`kimchi`), or set `KIMCHI_API_KEY`. That one
sign-in is all the plugins need for reporting — there is no separate bridge
login. Sessions that start while signed out stay on your machine and are never
uploaded.

## 3. Routing inference through Kimchi (optional — opt in)

Signing in does **not** change where your model requests go. Only when you
explicitly opt in will Claude Code and Codex send model requests through the
Kimchi gateway:

```sh
kimchi bridge setup   # installs the plugins AND enables gateway routing
```

- API-key sign-ins connect **direct** to the gateway; SSO sign-ins run
  through a small local proxy.
- Turn routing off again:
  ```sh
  kimchi bridge disable   # stop routing and pause recording (records kept)
  ```

## 4. Checking and controlling

| Command | What it does |
| --- | --- |
| `kimchi bridge status` | sign-in, gateway state, queued uploads, recording problems |
| `kimchi bridge setup` | install/update the plugins + enable gateway routing |
| `kimchi bridge disable` | stop gateway routing and pause recording (records kept) |
| `kimchi bridge remove` | uninstall the plugins from Claude Code and Codex (local records kept) |
| `kimchi-bridge flush` | upload anything queued now |
| `kimchi-bridge export jsonl` | print your local records (one JSON object per line) |

After `kimchi bridge remove`, your local records stay in
`~/.local/state/kimchi-bridge` until you delete them. Kimchi updates never
re-add removed plugins.

## 5. What gets recorded and where

Each session records token counts, models, tool calls, commit IDs and pull
request links; `New work:` prompts start a new piece of work. Prompts,
replies, file contents and paths never leave your machine. Records are stored
in SQLite under `~/.local/state/kimchi-bridge` and uploaded with your Kimchi
sign-in, so nothing runs while the clients are closed.

## Troubleshooting

- **Codex can't complete a turn through the gateway** — known upstream issue
  (the gateway `/openai/v1/responses` route); Claude Code works. Follow the
  linked ticket, or use `kimchi bridge disable` to keep using your own
  provider while recording continues.
- **"work reporting did not complete" after an update** — rerun
  `kimchi update`; details are in `~/.local/share/kimchi-bridge/refresh.log`.
- **Recorded nothing?** start a new session after signing in, then check
  `kimchi bridge status`.