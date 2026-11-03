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

	const unpin = raw.toLowerCase() === LANGUAGE_AUTO
	const value = unpin ? undefined : normalizeLanguageSetting(raw)
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

export default function languageCommandExtension(pi: ExtensionAPI): void {
	pi.registerCommand("language", {
		description: "Show or pin the language Kimchi replies in (e.g. /language ko, /language auto)",
		getArgumentCompletions: (prefix) => {
			const lower = prefix.toLowerCase()
			return SUGGESTED_LANGUAGES.filter((l) => l.toLowerCase().startsWith(lower)).map((value) => ({
				value,
				label: value,
				description: value === LANGUAGE_AUTO ? "Reply in the language you write in" : `Always reply in ${value}`,
			}))
		},
		handler: handleLanguageCommand,
	})
}
