import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { LANGUAGE_AUTO, loadConfig, normalizeLanguageSetting, writeLanguage } from "../config.js"

/**
 * `/language` — show or pin the language Kimchi replies in.
 *
 *   /language          show the effective setting
 *   /language ko       pin replies to Korean (any name or code works)
 *   /language auto     unpin: reply in whatever language the user writes in
 *
 * Writes the global `language` config key (same as `kimchi config set
 * language`). The system prompt re-reads the config on every turn, so the
 * change applies from the next message without a restart. A trusted project
 * `.kimchi/config.json` that sets `language` wins over the global value; the
 * command says so when that happens instead of silently writing a no-op.
 */

/** Suggestions for the argument autocomplete — a hint, not an allowlist. */
const SUGGESTED_LANGUAGES = ["auto", "English", "Korean", "Japanese", "Chinese", "French", "German", "Spanish"]

export function describeLanguageSetting(language: string | undefined): string {
	return language === undefined ? "auto (replies in the language you write in)" : language
}

export async function handleLanguageCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const raw = args.trim()
	if (raw.length === 0) {
		const current = loadConfig({ cwd: ctx.cwd }).language
		ctx.ui.notify(
			`Reply language: ${describeLanguageSetting(current)}. Use /language <name|code> or /language auto.`,
			"info",
		)
		return
	}

	const normalized = normalizeLanguageSetting(raw)
	const unpin = normalized === LANGUAGE_AUTO
	const value = unpin ? undefined : normalized
	if (!unpin && value === undefined) {
		ctx.ui.notify(
			`"${raw}" is not a usable language value — give a short name or code such as "ko" or "Korean".`,
			"error",
		)
		return
	}

	writeLanguage(value)

	// The write went to the global config; a trusted project config can still
	// override it. Report the effective value so the user is not misled.
	const effective = loadConfig({ cwd: ctx.cwd }).language
	if (effective !== value) {
		ctx.ui.notify(
			`Saved ${describeLanguageSetting(value)} to the global config, but this project's .kimchi/config.json pins "${effective}" — edit that file to change it here.`,
			"warning",
		)
		return
	}
	ctx.ui.notify(`Reply language: ${describeLanguageSetting(value)}. Applies from your next message.`, "info")
}

/**
 * Argument completions for `/language `. The command description shown in the
 * palette is snapshotted by pi when the autocomplete provider is built, so it
 * cannot carry the live value; the completions are computed on every open, so
 * the current setting is listed first and marked "(current)".
 */
export function languageArgumentCompletions(
	prefix: string,
	current: string | undefined,
): { value: string; label: string; description: string }[] {
	const currentValue = current ?? LANGUAGE_AUTO
	const currentLower = currentValue.toLowerCase()
	const lower = prefix.toLowerCase()
	// Case-insensitive dedupe: a pin of "korean" replaces the "Korean" suggestion.
	const values = [currentValue, ...SUGGESTED_LANGUAGES.filter((l) => l.toLowerCase() !== currentLower)]
	return values
		.filter((l) => l.toLowerCase().startsWith(lower))
		.map((value) => ({
			value,
			label: value === currentValue ? `${value} (current)` : value,
			description:
				value.toLowerCase() === LANGUAGE_AUTO ? "Reply in the language you write in" : `Always reply in ${value}`,
		}))
}

/** How long a config read is reused across the keystrokes of one completion. */
const COMPLETION_CONFIG_TTL_MS = 2_000

export default function languageCommandExtension(pi: ExtensionAPI): void {
	// Completions get no command context, so remember the session cwd (ACP
	// sessions can run with a cwd other than the process cwd) to honour trusted
	// project overrides exactly like the handler does.
	let sessionCwd: string | undefined
	pi.on("session_start", (_event, ctx) => {
		sessionCwd = ctx.cwd
	})

	// loadConfig reads and parses two files (and may warn about permissions);
	// reuse the value across the keystrokes of one `/language …` completion.
	let cached: { at: number; language: string | undefined } | undefined
	const currentLanguage = (): string | undefined => {
		const now = Date.now()
		if (!cached || now - cached.at > COMPLETION_CONFIG_TTL_MS) {
			cached = { at: now, language: loadConfig({ cwd: sessionCwd ?? process.cwd() }).language }
		}
		return cached.language
	}

	pi.registerCommand("language", {
		description: "Show or pin the language Kimchi replies in (e.g. /language ko, /language auto)",
		getArgumentCompletions: (prefix) => languageArgumentCompletions(prefix, currentLanguage()),
		handler: async (args, ctx) => {
			cached = undefined // the handler may have just changed the value
			await handleLanguageCommand(args, ctx)
			cached = undefined
		},
	})
}
