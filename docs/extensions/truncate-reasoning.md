# Truncate Reasoning

The `truncate-reasoning` extension strips OpenAI-style reasoning from assistant messages before they're sent to the model API, so reasoning content is never echoed back to the server.

## What it strips

OpenAI-compatible providers (the path served by `minimax-m3`, `deepseek-reasoner`, `gpt-oss`, `llama.cpp`, Moonshot, and others) attach reasoning in three redundant places on the in-memory `AssistantMessage`. The extension strips all three, because the upstream `openai-completions.js` re-builds the outgoing fields from the content blocks on every request.

| Source | Where | Why it must be stripped |
|---|---|---|
| Top-level field | `msg.reasoning_content`, `msg.reasoning`, `msg.reasoning_text`, `msg.reasoning_details` | The user-visible fields the server echoes back |
| `ThinkingContent` block | `msg.content[].type === "thinking"` with `thinkingSignature` matching one of the four field names | The upstream `convertMessages` reads the signature, then writes the thinking text back to `msg.reasoning_content` on the outgoing payload |
| Tool-call `thoughtSignature` | `msg.content[].type === "toolCall".thoughtSignature` | The upstream `convertMessages` parses it as JSON and writes `msg.reasoning_details` on the outgoing payload |

Detection is precise: only `ThinkingContent` blocks whose `thinkingSignature` is one of the four field names are dropped. Anthropic extended-thinking blocks have an opaque encrypted signature that does **not** match any field name, so they pass through untouched — preserving the signature is required for Anthropic tool-use reasoning continuity.

The strip is non-destructive — it happens in the `context` event hook, which receives a `structuredClone` of the messages, so the on-disk session JSONL is untouched. `/tree`, `/compact`, fork, and resume all keep the original reasoning.

## Enabling

The extension is enabled by default. To opt out, add `truncateReasoning: false` to `settings.json` (typically `~/.kimchi/settings.json`):

```json
{
  "truncateReasoning": false
}
```

Anthropic extended thinking + tool use is unaffected: the four OpenAI-style fields do not exist on Anthropic messages, and the extension specifically preserves `ThinkingContent` blocks with opaque encrypted signatures (Anthropic extended-thinking blocks).

## Out of scope

This extension deliberately does **not** touch:

- **Native `ThinkingContent` blocks with an opaque encrypted signature** (Anthropic, Bedrock, Google extended thinking). These carry a signature that must be preserved for tool-use reasoning continuity. The extension only drops thinking blocks whose signature matches one of the four OpenAI-style field names — encrypted signatures are not field names, so they pass through.
- **Text-tag thinking inside text blocks** (e.g. `think` tags, `mm:think` tags, `thinking` tags) — display-side redaction is handled by `hide-thinking.ts` (controlled by the `hideThinkingBlock` setting).
- **The thinking prose** in Anthropic-style `ThinkingContent` blocks — even if a future change wanted to redact this, the signature must stay attached.

If a new OpenAI-compatible provider writes reasoning under a field name not listed above, add the name to `REASONING_FIELDS` in `src/extensions/truncate-reasoning.ts`.

## Verification

The strip is on by default. To confirm it's working, inspect the outgoing LLM payload via the `llm-response-log` extension (or any other request-logging tool). Prior assistant messages should have no `reasoning_content` / `reasoning` / `reasoning_text` / `reasoning_details` keys, and no `ThinkingContent` blocks with one of those signatures. To verify the opt-out path, set `truncateReasoning: false` in `settings.json` and confirm those keys reappear in the captured payload.
