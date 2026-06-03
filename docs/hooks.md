# Kimchi Hooks

Kimchi supports Pi-native extension package hooks and user-owned Bash hooks.

## Native Pi Packages

Use Pi packages when a package ships native Pi hooks:

```bash
kimchi install npm:<package-name>
kimchi list
```

Pi package extensions subscribe to native Pi events such as `tool_call`, `tool_result`, `session_start`, `session_before_compact`, `session_compact`, and `session_shutdown`. Kimchi includes a narrow Pi compatibility shim for packages that expect older field names, including `tool_result.output`, `tool_result.params`, and the legacy `before_provider_response` event name.

## Core Bash Hooks

Kimchi core still supports local Bash command hooks for commands executed through the `bash` tool and interactive `!` / `!!` shell commands.

Global hooks:

```bash
~/.config/kimchi/harness/hooks/bash/*.sh
~/.config/kimchi/harness/hooks/bash/*.bash
```

Project hooks:

```bash
.kimchi/hooks/bash/*.sh
.kimchi/hooks/bash/*.bash
```

Global Bash hooks are enabled by default. Project Bash hooks are discovered but disabled by default.

Manage hook resources from:

```text
/resources
/hooks
```

or from the CLI:

```bash
kimchi resources list
kimchi resources disable hooks.bash
kimchi resources enable hooks.bash.project.my-hook-sh
kimchi resources disable hooks.bash.global.my-hook-sh
```

Each Bash hook runs as `bash <hook-path>`. Kimchi passes the current command in environment variables:

```bash
KIMCHI_HOOK_EVENT=tool_call
KIMCHI_TOOL_NAME=bash
KIMCHI_TOOL_INPUT_COMMAND='git status'
CRUSH_TOOL_INPUT_COMMAND='git status'
```

Kimchi also writes JSON to stdin:

```json
{
  "tool_name": "bash",
  "input": {
    "command": "git status"
  },
  "cwd": "/path/to/project"
}
```

No output means "allow unchanged":

```bash
exit 0
```

Plain stdout rewrites the command:

```bash
echo "git status --short"
```

JSON stdout can rewrite the command:

```bash
printf '%s\n' '{"decision":"allow","command":"git status --short"}'
```

Block by returning JSON:

```bash
printf '%s\n' '{"decision":"block","reason":"Use pnpm, not npm"}'
```

or by exiting with status `2` and writing a reason:

```bash
echo "Use pnpm, not npm" >&2
exit 2
```

Any other failure is treated as allow unchanged. This keeps a broken local hook from breaking the agent session.

## Claude Code Adapter

Claude Code hook format is not part of the kimchi core hook contract. Kimchi can run existing Claude Code command hooks through a disabled-by-default compatibility extension.

Enable the adapter:

```bash
kimchi resources enable extensions.claude-code-hook-adapter
```

Restart Kimchi after enabling the adapter. Individual hook commands inside Claude Code config files are not shown separately in `/resources`.

The adapter reads hooks from:

```bash
~/.claude/settings.json
.claude/settings.json
.claude/settings.local.json
```

It honors top-level `disableAllHooks: true`.

Supported events:

- `PreToolUse`
- `PostToolUse`
- `SessionStart`
- `PreCompact`
- `PostCompact`
- `UserPromptSubmit`
- `Stop`
- `SessionEnd`

Example:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "python3 ~/.claude/hooks/pre_tool_use.py"
          }
        ]
      }
    ]
  }
}
```

## Examples

### Rewrite `git status`

Create a global hook:

```bash
mkdir -p ~/.config/kimchi/harness/hooks/bash
cat > ~/.config/kimchi/harness/hooks/bash/git-status-short.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail

if [ "${KIMCHI_TOOL_INPUT_COMMAND:-}" = "git status" ]; then
  echo "git status --short --branch"
fi
SH
```

Start Kimchi and ask it to run `git status`. The displayed Bash command should show the rewritten command.

### Block `npm install`

```bash
mkdir -p ~/.config/kimchi/harness/hooks/bash
cat > ~/.config/kimchi/harness/hooks/bash/pnpm-only.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail

case "${KIMCHI_TOOL_INPUT_COMMAND:-}" in
  npm\ install*|npm\ i*)
    printf '%s\n' '{"decision":"block","reason":"Use pnpm install in this repository."}'
    ;;
esac
SH
```

### Read JSON From Stdin

Use stdin when you need the project cwd or want to avoid shell parsing.

```bash
mkdir -p .kimchi/hooks/bash
cat > .kimchi/hooks/bash/block-rm-root.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail

payload="$(cat)"
command="$(node -e 'const p=JSON.parse(process.argv[1]); console.log(p.input.command)' "$payload")"

if [ "$command" = "rm -rf /" ]; then
  printf '%s\n' '{"decision":"block","reason":"Refusing to remove root."}'
fi
SH
```

Then enable the project hook:

```bash
kimchi resources enable hooks.bash.project.block-rm-root-sh
```

## RTK Hook

Kimchi's built-in RTK integration is exposed as:

```text
hooks.rtk-rewrite
```

It runs before user Bash hooks. User hooks see the RTK-rewritten command when RTK changes it.

Disable it with:

```bash
kimchi resources disable hooks.rtk-rewrite
```

## References

- Pi packages: `https://pi.dev/packages`

## Notes

- Hooks run synchronously before command execution.
- Hook timeout is 5 seconds.
- Hook output is interpreted as a command rewrite unless it is recognized JSON.
- Use `/resources` to see discovered hook IDs.
- Restart is not required for hook enable/disable changes, but adding or removing hook files is easiest to verify by restarting Kimchi.
