# Message other Kimchi sessions

Kimchi sessions running on the same machine can find each other and exchange messages,
like Claude Code's `ListAgents` and `SendMessage`. Nothing to set up: every top-level
session (TUI, print, RPC or ACP) can be reached while it runs. Subagents cannot.

## Use it

Ask in plain words, for example:

```text
List the other Kimchi sessions, then ask the web-app session to run its tests and reply to me.
```

The agent uses two tools:

- `list_sessions` shows each other session as `name [ref]`, with interactive or headless,
  idle or busy, its folder and when it started. The name is the session name (set with
  `/name` or picked after the first turn) or, before that, the folder name. The ref is the
  last six characters of the session id.
- `send_message` takes `to` (a name, or `name [ref]` when two sessions share a name) and
  the text.

The other session sees the text as
`<cross-session-message from="name [ref]">…</cross-session-message>`. A busy session reads
it when its current step ends; an idle one starts a turn. It answers with `send_message`
to the `from` address. A reply finds the sender by its ref, so it arrives even after the
sender's name has changed.

## Permission modes

When the two sessions run in different permission modes, the receiving session asks its
user before letting the message in:

```text
Message from api-service [e50820]
That session runs in plan mode and this one in auto. Let the message in?
```

No lets nothing in, and the sender is not told. A headless session in another mode
refuses the message, and the sender sees why. This keeps a Plan-mode session from getting
an Auto-mode one to do what it may not. Both tools are therefore available in Plan mode,
and sending needs no approval on the sending side.

## How it works

Each session listens on a Unix socket, `~/.config/kimchi/live-sessions/<ref>.sock`; the
folder is readable only by you. `list_sessions` asks every socket in that folder who it
is, so a session is listed only while it answers. A socket left behind by a session that
crashed is removed the next time anyone lists. Quitting removes the session's socket.

Each connection carries one JSON request and one JSON reply, each at most 65,536
characters. A longer message is refused; send a file path instead.
