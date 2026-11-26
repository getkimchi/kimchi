# Message subagents and other Kimchi sessions

An interactive Kimchi session (the TUI) can list and message its own subagents and the
other sessions running on the same machine. ACP sessions take part when their client opts
in (see [Studio and other ACP clients](#studio-and-other-acp-clients)). Print and RPC runs
take no part, so a program driving Kimchi never sees a turn it did not start.

## Turn it on

Messages between sessions are off until you allow them. Kimchi asks once: the first time
you tag a session with `@`, or the agent is about to start a subagent while another live
session works in the same repository (worktrees of one repository count):

```text
Ask your other session instead?
“Checkout rounding” is open in this repository and may already know this work.
Yes lets your sessions message each other from now on. /session-messages changes it.
```

A tag asks `Message @shop-shipping?` with the same last line.

For a subagent, yes stops it: the agent sends the work to the other session when it is
that session's work, and otherwise starts the subagent again. No lets the subagent start.
Your answer is saved in your profile's `session-messages.json` and applies to every
session; a no is remembered too, so Kimchi does not ask again. Change it any time:

```text
/session-messages enable
/session-messages disable
/session-messages        # show the current choice
```

Sessions that are already running pick up the change after their current turn. After a
no, `steer_subagent` and `resume_subagent` still reach your subagents.

## Use it

Ask in plain words, for example:

```text
List the other Kimchi sessions, then ask the web-app session to run its tests and reply to me.
```

The agent uses three tools:

- `list_agents` shows this session's subagents first (ID, type, status, task, start time),
  then each other session as `name [ref]`, idle or busy, with its branch, folder, start time and
  whether it works in the same repository. Work that such a session already owns goes to it
  as a message; other work can still go to a new subagent.
  A session's name is its session name (set with `/name` or picked after the first turn)
  or, before that, the folder name. The ref is the last six characters of the session id.
- `message_agent` takes `to` and the text. `to` is a subagent ID, a session name or tag, or
  `name [ref]` when two sessions share a name. A subagent ID wins over a session name.
- `watch_session` takes a session and sends one notice back when that session finishes its
  current work or exits, so "tell me when the shipping session is done" needs no polling.

### Tag sessions with @

Type `@` in the prompt. Live sessions come first, each with its branch, state and folder,
then files; typing narrows the list by name or branch.

```text
@api                    feat/v2-endpoint · busy · ~/code/shop-api
@"Checkout rounding"    fix/rounding · idle · ~/code/shop
src/
```

- **Tags at the start** send the rest of the prompt straight to those sessions, as your own
  words: `@api use the v2 endpoint instead`. A busy session reads it when its current step
  ends, so you can steer a run in progress; an idle one starts. This session starts no
  turn, and the answers come back to it.
- **Tags anywhere else** leave it to the agent: `ask @api and @web to agree on the endpoint
  shape`. It sends each session its part and tells them about each other, so they can work
  it out as a team.

A tag names whom you mean, not everyone: ask for checks on "what the other sessions
built" with one tag, and the agent still finds the untagged ones, in any repository. It
reads their folders but leaves their files alone, and sends each one what it found.
A name with spaces is quoted; two sessions with one name get their ref, as in
`@"shop [e50820]"`. Every session stays yours: typing in it works as before.

### Subagents

- A running subagent reads the message when its current step ends, like `steer_subagent`.
- A finished subagent resumes in the background with the message as its next instruction,
  within the default turn limit of a new subagent. Its result arrives as the usual
  completion notification.
- A stopped subagent takes no messages.

### Sessions

The other session sees the text as
`<cross-session-message from="name [ref]">…</cross-session-message>`, followed by a line
saying it comes from another session's agent, not from its user, so it cannot approve
anything: the agent stays within what its own user asked and asks them before pushing,
publishing or deleting. The line also tells it to answer with `message_agent` when asked
something and to send no thanks or acknowledgements, since every message wakes the other
session. Its user sees
"Message from name [ref]" and the first line; ctrl+o shows the rest. A busy session reads
it when its current step ends; an idle one starts a turn. A reply finds the sender by its
ref, so it arrives even after the sender's name has changed.

Each message counts its hops from the last thing a user wrote. After 8 hops, sending waits
until a user writes again, in that session or straight to it with a tag, so two agents
cannot keep each other busy while a team can still talk things through.
`/session-messages limit 20` changes the number for every session of the profile. One
count per session (not per conversation) keeps a loop among three sessions from slipping
past it. A session also refuses an agent's message that repeats the previous one from
the same sender word for word within 10 seconds; your own words are never refused.

## Permission modes

When the two sessions run in different permission modes, the receiving session asks its
user before letting the message in:

```text
Message from api-service [e50820]
That session runs in plan mode and this one in auto. Let the message in?
```

The question counts down for 5 minutes. When its user says no or does not answer, nothing
gets in, and the sender's conversation gets a notice that the message was declined or
expired. This keeps a Plan-mode session from getting an Auto-mode one to do what it may
not. Both tools are therefore available in Plan mode, and sending needs no approval on the
sending side. Your own words, sent with a leading tag, are not asked about: you could have
typed them there. Subagents follow their own session's mode, so messages to them need no
approval.

## Studio and other ACP clients

An ACP session takes part only when its client opts in at `initialize`. The harness
advertises the same flag under `agentCapabilities._meta["kimchi.dev"]`:

```json
{
  "clientCapabilities": {
    "_meta": {
      "kimchi.dev": {
        "sessionMessages": true,
        "backgroundRuns": true
      }
    }
  }
}
```

Without both flags nothing changes: no inbox, tools, tags or question. With them:

- A received message starts a run no prompt owns, between the
  `_kimchi.dev/background_run_start` and `background_run_end` notifications.
- `_kimchi.dev/live_sessions` with `{ "sessionId": "…" }` returns
  `{ "sessions": [{ "tag", "name", "ref", "branch", "state", "cwd", "sameRepository" }] }`
  for the client's `@` list; put `tag` into the prompt. It returns no sessions after a no.
- Tags work as in the TUI, except that the agent also passes on leading tags, so its reply
  shows in the client.
- A message from another permission mode is refused at once, since Kimchi does not ask the
  client's user between turns.

## How it works

Each session listens on a Unix socket, `~/.config/kimchi/live-sessions/<ref>.sock`; the
folder is readable only by you. `list_agents` asks every socket in that folder who it
is, so a session is listed only while it answers. A socket left behind by a session that
crashed is removed the next time anyone lists. Quitting removes the session's socket.

Each connection carries one JSON request (`info`, `message` or `notice`) and one JSON
reply, each at most 65,536 characters. A message carries its hop count; 0 marks your own
words. A longer message is refused; send a file path
instead. A notice names only the outcome (declined or expired); the sender's side writes
its text.
