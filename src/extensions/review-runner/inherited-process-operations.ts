import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { constants as osConstants } from "node:os"
import type { BashOperations } from "@earendil-works/pi-coding-agent"
import { waitForChildProcess } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/child-process.js"
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js"
import type { ReviewExecutionMode } from "./execution.js"

/** Headless review commands must inherit Kimchi's process group so the
 * platform watchdog cannot miss them. Other modes retain upstream's detached
 * command-group behavior and cleanup. */
export function reviewInheritedProcessOperations(mode: ReviewExecutionMode): BashOperations | undefined {
	if (mode !== "headless") return undefined
	return {
		async exec(command, cwd, { onData, signal, env }) {
			if (signal?.aborted) throw new Error("aborted")
			const shell = getShellConfig()
			try {
				await access(cwd, constants.F_OK)
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}`)
			}
			const commandFromStdin = shell.commandTransport === "stdin"
			const child = spawn(shell.shell, commandFromStdin ? shell.args : [...shell.args, command], {
				cwd,
				detached: false,
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			})
			if (commandFromStdin) {
				child.stdin?.on("error", () => {})
				child.stdin?.end(command)
			}
			const terminate = () => {
				if (process.platform === "win32" && child.pid) killProcessTree(child.pid)
				else child.kill("SIGTERM")
				setTimeout(() => {
					child.stdout?.destroy()
					child.stderr?.destroy()
				}, 500).unref?.()
			}
			try {
				child.stdout?.on("data", onData)
				child.stderr?.on("data", onData)
				if (signal) {
					if (signal.aborted) terminate()
					else signal.addEventListener("abort", terminate, { once: true })
				}
				const exitCode = await waitForChildProcess(child)
				if (signal?.aborted) throw new Error("aborted")
				const signalCode = child.signalCode
				return { exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) }
			} finally {
				signal?.removeEventListener("abort", terminate)
			}
		},
	}
}
