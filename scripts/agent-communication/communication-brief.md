## Required collaboration during this repair

Use the group board and directed messages for the cross-review below while the
workers are running. These exchanges are part of this task, not optional final
status updates. Keep the existing production ownership and verification rules.

- The implementation owner publishes its proposed connection/fallback and cleanup
  approach with `post_agent_note` before making implementation edits, then asks the boundary and
  lifecycle owners for review through `send_agent_message`.
- The boundary owner checks that proposal against the probe caller's error and
  deadline handling. The lifecycle owner checks it against the OAuth refresh and
  callback flow. Each reads the board entry, inspects the cited source, and replies
  to the actual question ID with a concrete finding or a supported agreement.
- The implementation owner checks those replies, makes any needed correction,
  and posts the resulting decision and test evidence. The reviewing owners read
  that update and check the relevant result before their final handoff.
- Use `list_agent_contacts` for current IDs. Start the exchange early enough for
  peers to answer before they finish; continue independent work while awaiting an
  answer. Send an unresolved dependency to the parent if its owner is no longer
  reachable. Do not invent a disagreement, acknowledge without checking, or poll.

The parent includes these responsibilities in each assignment, reads the resulting
board entries, verifies the combined code, and reports unresolved communication as
well as code failures. A post count alone is not evidence that review happened.
