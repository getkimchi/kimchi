import { printMergedHelp } from "./help.js"
import { findPackageCommand, runPackageCommand } from "./package-commands.js"
import { findCommand, isKnownCommand } from "./registry.js"

export type DispatchResult = { kind: "handled"; exitCode: number } | { kind: "fallthrough" }

/**
 * Decide whether a top-level kimchi subcommand handles this argv.
 *
 * Returns "handled" with an exit code when the dispatcher took ownership
 * (subcommand or top-level --help). Returns "fallthrough" when the
 * harness/help/ACP paths in cli.ts should run instead.
 *
 * Recognised subcommands live in {@link findCommand} — keep that registry
 * the single source of truth. New top-level commands should be added there
 * and pi-coding-agent's parser should not be involved.
 */
export async function dispatchSubcommand(args: string[]): Promise<DispatchResult> {
	const first = args[0]

	if (isKnownCommand(first)) {
		const cmd = findCommand(first as string)
		// isKnownCommand checked first; the type assertion above is safe.
		if (!cmd) return { kind: "fallthrough" }
		const rest = args.slice(1)
		const code = (await cmd.run(rest)) ?? 0
		return { kind: "handled", exitCode: code }
	}

	// Package-provided subcommands (`kimchi install npm:…`): built-ins and
	// reserved names always win (see package-commands.ts), and flags still
	// fall through to pi untouched.
	if (first !== undefined && !first.startsWith("-")) {
		const packageCommand = findPackageCommand(first)
		if (packageCommand) {
			const exitCode = await runPackageCommand(packageCommand, args.slice(1))
			return { kind: "handled", exitCode }
		}
	}

	// Top-level --help: only when there is NO subcommand context.
	// `kimchi claude --help` is a subcommand call — the handler decides what to do.
	// `kimchi --help` (or `kimchi -h`) falls here and prints the union view.
	if (first === undefined || first.startsWith("-")) {
		if (args.includes("--help") || args.includes("-h")) {
			await printMergedHelp()
			return { kind: "handled", exitCode: 0 }
		}
	}

	return { kind: "fallthrough" }
}
