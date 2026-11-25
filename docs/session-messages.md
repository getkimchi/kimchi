# Message subagents and other Kimchi sessions

An interactive Kimchi session (the TUI) can list and message its own subagents and the
other interactive sessions running on the same machine. Print, RPC and ACP runs take no
part, so a program driving Kimchi never sees a turn it did not start.

## Turn it on

Messages between sessions are off until you allow them. The first time the agent is about
to start a subagent while another live session works in the same repository (worktrees of
one repository count), Kimchi asks once:

```text
Ask your other session instead of a subagent?
I see you have a session open in this repository, “Checkout rounding”, that may already
know this work. I can ask it instead of starting a subagent. Turn on session messages?
```

Yes stops that subagent: the agent sends the work to the other session when it is that
session's work, and otherwise starts the subagent again. No lets the subagent start.
Your answer is saved in your profile's `session-messages.json` and applies to every
session; a no is remembered too, so Kimchi does not ask again. Change it any time:

```text
/session-messages enable
/session-messages disable
/session-messages        # show the current choice
```

Sessions that are already running pick up the change after their current turn. Messages
to your own subagents work either way.

## Use it

Ask in plain words, for example:

```text
List the other Kimchi sessions, then ask the web-app session to run its tests and reply to me.
```

The agent uses two tools:

- `list_agents` shows this session's subagents first (ID, type, status, task, start time),
  then each other session as `name [ref]`, idle or busy, with its folder, start time and
  whether it works in the same repository. Work that such a session already owns goes to it
  as a message; other work can still go to a new subagent.
  A session's name is its session name (set with `/name` or picked after the first turn)
  or, before that, the folder name. The ref is the last six characters of the session id.
- `send_message` takes `to` and the text. `to` is a subagent ID, a session name, or
  `name [ref]` when two sessions share a name. A subagent ID wins over a session name.

### Subagents

- A running subagent reads the message when its current step ends, like `steer_subagent`.
- A finished subagent resumes in the background with the message as its next instruction,
  within the default turn limit of a new subagent. Its result arrives as the usual
  completion notification.
- A stopped subagent takes no messages.

### Sessions

The other session sees the text as
`<cross-session-message from="name [ref]">…</cross-session-message>`, followed by a line
telling it to answer with `send_message`, since its own transcript is not seen by the
sender. A busy session reads it when its current step ends; an idle one starts a turn. It
answers with `send_message` to the `from` address. A reply finds the sender by its ref, so it arrives even after the
sender's name has changed.

## Permission modes

When the two sessions run in different permission modes, the receiving session asks its
user before letting the message in:

```text
Message from api-service [e50820]
That session runs in plan mode and this one in auto. Let the message in?
```

No lets nothing in, and the sender is not told. This keeps a Plan-mode session from getting
an Auto-mode one to do what it may not. Both tools are therefore available in Plan mode,
and sending needs no approval on the sending side. Subagents follow their own session's
mode, so messages to them need no approval.

## How it works

Each session listens on a Unix socket, `~/.config/kimchi/live-sessions/<ref>.sock`; the
folder is readable only by you. `list_agents` asks every socket in that folder who it
is, so a session is listed only while it answers. A socket left behind by a session that
crashed is removed the next time anyone lists. Quitting removes the session's socket.

Each connection carries one JSON request and one JSON reply, each at most 65,536
characters. A longer message is refused; send a file path instead.
