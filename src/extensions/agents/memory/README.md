# Agent Memory

Persistent memory for Kimchi subagents, injected as a system-prompt block at spawn. File-based by default; any external memory DB can take over the block through a plugin contract — **with zero provider-specific code in the harness**.

## What it does

Every time the harness spawns a subagent, `resolveMemoryBlock()` builds a `# Agent Memory` section for that agent's system prompt:

```text
agent spawn → resolveMemoryBlock()
                │ try each registered provider (first non-null wins)
                └─► fallback: file-based MEMORY.md block
```

Without any setup, a subagent called `reviewer` gets a block pointing at its own persistent `MEMORY.md`:

```markdown
# Agent Memory

You have a persistent memory directory at: ~/.config/kimchi/harness/agent-memory/reviewer/
Memory scope: user

This memory persists across sessions. Use it to build up knowledge over time.

## Current MEMORY.md
…first 200 lines of the agent's index…

## Memory Instructions
- MEMORY.md is an index file — keep it concise (under 200 lines)…
- Store detailed memories in separate files within the directory…
```

Agents without write tools get a read-only variant that only surfaces existing memories. All paths are validated against traversal and symlinks.

### Memory scopes

| Scope | Location |
|---|---|
| `user` | `<agent-dir>/agent-memory/<name>/` |
| `project` | `<cwd>/.kimchi/agent-memory/<name>/` |
| `local` | `<cwd>/.kimchi/agent-memory-local/<name>/` |

## Plugging in an external memory backend

Any database (OpenViking, mem0, Supermemory, Letta, Zep, your own service) can supply the memory block instead. Implement one interface — use whatever logic you like, return `null` whenever the backend doesn't apply:

```ts
interface AgentMemoryProvider {
	name: string;
	buildBlock(agentName: string, cwd: string): Promise<string | null>;
}
```

### Two ways to register

**Config-driven (no code changes to the harness)** — list the module in `<agent-dir>/memory-providers.json` and it gets dynamic-imported on first use:

```json
[{ "name": "openviking", "module": "/abs/path/to/memory-provider.ts" }]
```

**In-tree** — harness code can call `registerMemoryProvider(provider)` directly.

### A minimal provider looks like this

```ts
const provider = {
	name: "my-memory-db",
	async buildBlock(agentName: string, cwd: string): Promise<string | null> {
		const memories = await recallFromMyApi(agentName);
		if (memories.length === 0) return null; // → harness tries the next provider
		return `# Agent Memory\n\n${memories.map((m) => `- ${m}`).join("\n")}`;
	},
};
export default provider;
```

For plain REST backends you don't even need that module: the `kimchi-openviking` package ships a **generic HTTP adapter** (`extensions/adapters/http-memory.ts`) with presets for mem0/Supermemory/Letta/Zep where a provider is one JSON file in `<agent-dir>/memory-adapters/` — see its README.

## Resolution semantics

1. On the first `resolveMemoryBlock()` call, the manifest is read once and each module imported; entries are shape-validated (`name` + `buildBlock`) before registration. Bad entries are skipped, never fatal.
2. Providers run in registration order; the **first non-null block wins**.
3. A throwing provider is contained and the next is tried.
4. No providers, or all of them returning `null` → the file-based block, exactly as before. An empty registry is byte-identical to the pre-provider behavior.

**Fail-open everywhere:** memory is a prompt-path concern, so no failure mode (missing manifest, unloadable module, dead server) can block agent work — worst case is plain `MEMORY.md` behavior.

## Files

- `memory.ts` — scopes + path safety, file block builders, provider registry, manifest loader.
- `memory.test.ts` — registry ordering, exception containment, manifest edge cases, file fallback (write + read-only).

## Testing

```sh
pnpm run check                              # lint + typecheck
npx vitest run src/extensions/agents        # 506 tests (memory.test.ts included)
```
