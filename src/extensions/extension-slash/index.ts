/**
 * extension-slash — register `/extension` slash command in the harness.
 *
 * Mirrors the `kimchi extension` CLI: add/remove/list/enable/disable/update.
 * Reuses runExtension() so behavior stays identical between the two surfaces.
 *
 * Note: changes to the package list take effect on the next kimchi session,
 * since pi resolves package paths at session start.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import type { AutocompleteItem } from "@mariozechner/pi-tui"
import { runExtension } from "../../commands/extension.js"

const HELP_TEXT = `/extension <subcommand> [args]

Subcommands:
  list                  Show configured packages
  add <source>          Install and enable a pi package (npm:, git:, /path)
  remove <source>       Remove and unpersist
  enable <source>       Enable a disabled package
  disable <source>      Disable an enabled package without removing
  update [source]       Update one or all packages

Options:
  -l, --local           Apply to project settings instead of global

Note: changes take effect on the next kimchi session.`

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "list", label: "list", description: "Show configured packages" },
	{ value: "add", label: "add <source>", description: "Install and enable a pi package" },
	{ value: "remove", label: "remove <source>", description: "Remove and unpersist" },
	{ value: "enable", label: "enable <source>", description: "Enable a disabled package" },
	{ value: "disable", label: "disable <source>", description: "Disable without removing" },
	{ value: "update", label: "update [source]", description: "Update one or all packages" },
]

function tokenize(args: string | undefined): string[] {
	if (!args) return []
	return args
		.trim()
		.split(/\s+/)
		.filter((s) => s.length > 0)
}

export default function extensionSlashCommand(pi: ExtensionAPI): void {
	pi.registerCommand("extension", {
		description: "Manage kimchi extensions (add, remove, list, enable, disable, update)",
		getArgumentCompletions: (prefix) => {
			// Only complete the first argument (subcommand). Subsequent args are
			// arbitrary package sources, no useful completions.
			if (prefix.includes(" ")) return null
			const lower = prefix.toLowerCase()
			return SUBCOMMANDS.filter((s) => s.value.startsWith(lower))
		},
		handler: async (args, ctx) => {
			const tokens = tokenize(args)

			if (tokens.length === 0 || tokens[0] === "--help" || tokens[0] === "-h") {
				if (ctx.hasUI) ctx.ui.notify(HELP_TEXT, "info")
				else console.log(HELP_TEXT)
				return
			}

			// Capture stdout/stderr from runExtension so we can route to ctx.ui in interactive mode.
			const captured: string[] = []
			const origLog = console.log
			const origErr = console.error
			console.log = (...a: unknown[]) => {
				captured.push(a.map((v) => (typeof v === "string" ? v : String(v))).join(" "))
			}
			console.error = (...a: unknown[]) => {
				captured.push(a.map((v) => (typeof v === "string" ? v : String(v))).join(" "))
			}

			let exitCode: number
			try {
				exitCode = (await runExtension(tokens)) ?? 0
			} finally {
				console.log = origLog
				console.error = origErr
			}

			const output = captured.join("\n")
			if (ctx.hasUI) {
				const level = exitCode === 0 ? "info" : "error"
				ctx.ui.notify(output || (exitCode === 0 ? "Done." : "Failed."), level)
			} else {
				console.log(output)
			}
		},
	})
}
