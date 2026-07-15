// Shared CLI mode detection — a leaf module with **zero imports**.
//
// This file is loaded very early (entry.ts dynamically imports
// auto-update.ts before cli.js boots, and cli-args.ts is used by the CLI
// dispatch path). It must not pull in pi-coding-agent or any other module
// so it can be safely imported from any context.
//
// Consumers:
//   - src/cli-args.ts re-exports these for the CLI dispatch path.
//   - src/update/auto-update.ts uses them to skip auto-update in non-
//     interactive modes.
//   - src/extensions/onboarding/session-mode.ts uses them to decide whether
//     to show the onboarding wizard.

export type CliMode = "text" | "json" | "rpc" | "acp"

/** Modes where stdout belongs to the caller (protocol channel). */
export const PROTOCOL_MODES = new Set<CliMode>(["json", "rpc", "acp"])

/** Extract the value of `--mode <value>` or `--mode=<value>` from argv. */
export function getCliModeArg(argv: readonly string[]): string | undefined {
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]
		if (arg === "--mode" && i + 1 < argv.length) return argv[i + 1]
		if (arg.startsWith("--mode=")) return arg.slice("--mode=".length)
	}
	return undefined
}

/** True when argv contains `--print` or `-p`. */
export const hasPrintFlag = (argv: readonly string[]): boolean => argv.includes("--print") || argv.includes("-p")

/** True when argv contains `--export` or `--export=<file>`. */
export const hasExportFlag = (argv: readonly string[]): boolean =>
	argv.includes("--export") || argv.some((a) => a.startsWith("--export="))
