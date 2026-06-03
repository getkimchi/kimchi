# Claude Code Hook Adapter Fixture

Use this project-local fixture to test `extensions.claude-code-hook-adapter`.

```bash
mkdir -p .claude
cp examples/claude-code-hook-adapter/settings.json .claude/settings.json
kimchi resources enable extensions.claude-code-hook-adapter
```

Restart Kimchi after enabling the resource.

Try these Bash commands:

```bash
echo KIMCHI_HOOK_REWRITE
echo KIMCHI_HOOK_BLOCK
echo KIMCHI_HOOK_POST_REWRITE
npm install
```

Try these prompt triggers:

```text
KIMCHI_HOOK_PROMPT_REWRITE say hello
KIMCHI_HOOK_PROMPT_BLOCK
```

Hook invocations append JSONL records to `.kimchi/claude-code-hook-adapter.log`.
