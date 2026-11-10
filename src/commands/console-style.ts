import { ANSI, fg } from "../ansi.js"

/**
 * Shared styling for console-printing subcommands (help, env, …).
 *
 * Escape codes are only emitted for an interactive TTY without NO_COLOR, so
 * piped output (`kimchi --help | cat`, `kimchi env > out.txt`, CI logs) stays
 * clean. Computed per call: a long-lived process may see NO_COLOR change
 * after import, and tests drive isTTY/NO_COLOR directly.
 */
function colorEnabled(): boolean {
	return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
}

export function bold(text: string): string {
	return colorEnabled() ? `\x1b[1m${text}\x1b[0m` : text
}

export function dim(text: string): string {
	return colorEnabled() ? fg(ANSI.dim, text) : text
}
