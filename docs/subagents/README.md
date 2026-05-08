# Subagent examples

Three example personas covering most of the feature surface. Copy any of them
into:

| Scope | Path | Visible to |
|---|---|---|
| Project | `<repo>/.kimchi/agents/<name>.md` | This repo only |
| User | `~/.config/kimchi/harness/agents/<name>.md` | All your projects |

Project files override user files. The filename (without `.md`) is the agent
name the LLM passes as `subagent_type`.

## Examples

| File | Demonstrates |
|---|---|
| [`code-reviewer.md`](code-reviewer.md) | Read-only via `disallowed_tools`, multi-model `models[]`, `strengths: review`, high thinking |
| [`test-writer.md`](test-writer.md) | Edit-capable, project-scoped persistent memory (`memory: project`), focused tools |
| [`research-assistant.md`](research-assistant.md) | Web tools, `skills:` preload, user-scoped memory, citation discipline |

For the full frontmatter reference, see [`../agents.md`](../agents.md).
