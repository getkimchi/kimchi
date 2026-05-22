# Kimchi Hooks

Kimchi supports user-owned Bash hooks for commands executed through the `bash` tool and interactive `!` / `!!` shell commands.

Hooks can rewrite a command before it runs, or block it. Use them for local policy, command normalization, formatter wrappers, safety checks, and token-saving rewrites.

## Hook Locations

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

Global hooks are enabled by default. Project hooks are discovered but default to disabled, so a repository cannot silently add shell policy. Enable or disable hooks from:

```text
/resources
/hooks
```

or from the CLI:

```bash
kimchi resources list
kimchi resources enable hooks.bash.project.my-hook-sh
kimchi resources disable hooks.bash.global.my-hook-sh
```

## Runtime Data

Each hook runs with `bash <hook-path>`. It does not need executable mode, but making it executable is still fine.

Kimchi passes the current command in environment variables:

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

`CRUSH_TOOL_INPUT_COMMAND` is provided so simple Crush-style hook examples can be adapted with minimal changes.

## Output Protocol

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

Crush-style JSON is also supported:

```bash
printf '%s\n' '{"decision":"allow","updated_input":"{\"command\":\"git status --short\"}"}'
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

## Notes

- Hooks run synchronously before command execution.
- Hook timeout is 5 seconds.
- Hook output is interpreted as a command rewrite unless it is recognized JSON.
- Use `/resources` to see discovered hook IDs.
- Restart is not required for hook enable/disable changes, but adding or removing hook files is easiest to verify by restarting Kimchi.
