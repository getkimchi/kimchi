# Configuring Claude Code and Codex

Run `kimchi setup-tools` to configure installed coding tools to use Kimchi.
Selecting Claude Code or Codex changes the configuration used when you launch
`claude` or `codex` directly, too.

Before applying changes in an interactive terminal, each integration explains
the effect and asks for confirmation. The default is **No**. Declining or
cancelling that confirmation leaves the tool's files unchanged and reports the
tool as **Skipped**. Setup exits successfully if no tool fails. Repeating setup
with unchanged Claude settings or an identical generated Codex config and
catalog skips confirmation and writes, including new backups.

## Claude Code

Setup updates the `env` block in `~/.claude/settings.json`, preserving unrelated
settings. The preview redacts existing and replacement API keys, tokens and
telemetry headers.

The saved `ANTHROPIC_AUTH_TOKEN` takes precedence over a claude.ai login and
disables claude.ai connectors. To use Kimchi for one Claude session without
saving these changes, decline and run `kimchi claude`. The authentication
change still applies within that temporary session.

## Codex

Setup changes the default model and provider in `~/.codex/config.toml` and
replaces `~/.codex/model_catalog.json`. Unrelated TOML settings and other
providers are preserved. Serialization rewrites formatting and removes
comments; the original text is retained in the backup. Invalid TOML is rejected
before either file is changed.

Only files whose generated contents differ are backed up and written. A model
catalog refresh leaves an unchanged `config.toml` untouched, and an API key
change leaves an unchanged catalog untouched.

## Backups and recovery

Before changing an existing file, setup saves its exact original contents
beside it as `<filename>.kimchi-<unique-id>.bak`. Backups use owner-only
permissions and are never overwritten by later runs. Files that did not
previously exist have no backup.

Backups can contain API keys and other credentials. They are retained until
you remove them. Once the new configuration works and you no longer need to
restore an older version, delete its `.kimchi-<unique-id>.bak` file. Do not
share backups or commit them to a repository.

Setup prints each backup's path and a `Restore: cp ...` command. Close the tool,
then run the printed command to restore that version of its configuration.
For Codex, restore both the config and catalog backups if both were created.
Restoring replaces any edits made since the backup, so keep those edits
separately if needed.

All required Codex backups must succeed before either configuration file is
written. A later write failure can leave a partial update; use the printed restore
commands to recover. Backups are also made when the writers run without an
interactive terminal, although confirmation is only shown in a terminal.

These protections apply to Claude Code and Codex. Other integrations have
their own configuration behavior.
