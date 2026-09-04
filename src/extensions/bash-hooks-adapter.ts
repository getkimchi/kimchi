/**
 * Re-introduces user bash hook processing that was previously wired by the
 * deleted `rtk-rewrite` extension. This adapter intentionally performs only
 * hook application (block / rewrite) — it does not re-introduce RTK logic.
 *
 * Hooks are discovered from `.kimchi/hooks/bash/` and `~/.config/kimchi/harness/hooks/bash/`
 * by `applyEnabledBashHooks`, which internally checks `isResourceEnabled("hooks.bash")`,
 * so no extra gating is required here.
 */
import { type BashOperations, createLocalBashOperations, type ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { applyEnabledBashHooks } from "../resources/bash-hooks.js"

export default function bashHooksAdapterExtension(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return
		const command = event.input.command
		if (typeof command !== "string") return
		const inputCwd = (event.input as { cwd?: unknown }).cwd
		const cwd = typeof inputCwd === "string" ? inputCwd : process.cwd()
		const hooked = applyEnabledBashHooks(command, cwd)
		if (hooked.block) return { block: true, reason: hooked.reason }
		if (hooked.command !== command) event.input.command = hooked.command
	})

	pi.on("user_bash", (event) => {
		const hooked = applyEnabledBashHooks(event.command, event.cwd)
		if (hooked.block) {
			return {
				result: {
					output: hooked.reason ?? "Bash hook blocked command",
					exitCode: 2,
					cancelled: false,
					truncated: false,
				},
			}
		}
		if (hooked.command === event.command) return
		// Provide custom operations that substitute the rewritten command.
		// Preserve any shellCommandPrefix prepended by the upstream (e.g. alias
		// setup) — the prepared command may be `<prefix>\n<original>`, so we
		// swap only the original portion and leave the prefix intact.
		const local = createLocalBashOperations()
		const operations: BashOperations = {
			exec: (cmd, cwd, options) => {
				const prepared =
					cmd === event.command
						? hooked.command
						: cmd.endsWith(`\n${event.command}`)
							? `${cmd.slice(0, -event.command.length)}${hooked.command}`
							: hooked.command
				return local.exec(prepared, cwd, options)
			},
		}
		return { operations }
	})
}
