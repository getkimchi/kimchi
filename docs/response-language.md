# Reply language

By default Kimchi answers in the language the user writes in (the `## Language` section of the system prompt, see `src/extensions/prompt-construction/system-prompt.ts`). That adaptive rule is ambiguous once a conversation mixes languages: after English → French → English, the context is mostly French and a model with weak instruction-following (observed with DeepSeek) keeps answering in French, and a mid-conversation "switch back to English" is often ignored.

Pinning the language removes the ambiguity: the prompt then says "always respond in X, whatever language the user writes in", and a request to switch languages inside the conversation is explicitly *not* an override.

The pin is enforced in two places. The `## Language` section of the system prompt is the static rule. In addition, every LLM request carries a hidden, one-line `<system-reminder>` right after the latest user message ("Reply in X. …", custom type `language_hint`, see `src/extensions/prompt-construction/language-hint.ts`). The system-prompt rule alone sits hundreds of lines above the generation point and was verified (with `--debug-prompts`) to be ignored by DeepSeek once the history is in another language; the reminder adjacent to the latest message is what such models follow. The reminder is injected at the `context` boundary and never written to the session: there is exactly one copy per request, it always states the *current* pin (so `/language fr` or `/language auto` takes effect immediately, with no stale "Reply in ko" lines left in the history), it does not accumulate, and it is not shown in the transcript. Within a turn it sits at the same position in every request, so the in-turn cache prefix holds; across turns the previous reminder disappears, the same trade-off the continuation nudges already make.

In-process subagents get the pinned section too: "append"-mode agents inherit it from the parent prompt, "replace"-mode agents receive it explicitly (`languageBlock` in `src/extensions/agents/prompt/prompts.ts`).

```bash
kimchi config set language ko        # pin — any short name or code works ("Korean", "fr", "zh-Hant")
kimchi config set language auto      # unpin — mirror the user again
kimchi config get language           # show the effective value
```

Inside a session the same thing is `/language ko` and `/language auto`; `/language` alone shows the current value, and typing `/language ` (with a space) lists the current setting first, marked "(current)", ahead of the suggestions. Both surfaces (TUI and ACP) run the command; ACP advertises it in the command palette.

Or edit the config file directly:

```jsonc
// ~/.config/kimchi/config.json — or <project>/.kimchi/config.json (trusted projects win)
{ "language": "ko" }
```

Precedence: project config (trusted) > global config > unset (adaptive). `"auto"` (any case) is the explicit unpin on every surface, including a hand-edited file, so a trusted project can set `"language": "auto"` to get adaptive replies despite a global pin. `/language` and `kimchi config set` write the **global** config (`auto` removes the key); when a project config pins a different value the command says so instead of silently writing a no-op.

Values are trimmed, single-line and at most 40 characters. Anything else is ignored (the prompt falls back to adaptive) so a config file cannot inject arbitrary text into the system prompt. The pin covers everything the user reads — todo items, plan titles, phase and step names, summaries, and commit messages — but not code, file paths or technical terms, exactly the scope of the adaptive rule.

The system prompt re-reads the config on every turn, so changes apply from the next message without a restart. The section is static for the whole session, so the prompt-cache prefix is as stable as before.
