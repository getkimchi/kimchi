import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
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
import { raceWithTimeout } from "../../shared/race-with-timeout.js"
import type { ReviewExecutionMode } from "./execution.js"

const PROCESS_TREE_ENV = "KIMCHI_REVIEW_PROCESS_TREE"
const TERM_GRACE_MS = 50
const KILL_SETTLE_MS = 150

function ownedProcessIds(owner: string): number[] {
	// macOS uses -A -E to select all processes and expose the environment. The
	// Linux ps compatibility form uses eww.
	const flags = process.platform === "darwin" ? ["-A", "-E"] : ["eww"]
	const output = execFileSync("ps", [...flags, "-o", "pid=,command="], { encoding: "utf8" })
	const marker = `${PROCESS_TREE_ENV}=${owner}`
	return output
		.split("\n")
		.filter((line) => line.includes(marker))
		.map((line) => Number.parseInt(line.trimStart(), 10))
		.filter((pid) => Number.isSafeInteger(pid) && pid > 0)
}

function signalOwned(owner: string, signal: NodeJS.Signals): void {
	for (const pid of ownedProcessIds(owner)) {
		try {
			process.kill(pid, signal)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
		}
	}
}

async function waitForOwnedExit(owner: string, deadline: number): Promise<void> {
	for (;;) {
		const remaining = Date.now()
		if (remaining >= deadline) return
		if (ownedProcessIds(owner).length === 0) return
		await new Promise((resolve) => setTimeout(resolve, Math.min(10, deadline - remaining)))
	}
}

/** Reap the whole tree and root through actual completion, rather than treating
 * an aborted wait as proof that all descendants have exited. */
async function reapProcessTree(owner: string, completion: Promise<number | null>): Promise<void> {
	if (ownedProcessIds(owner).length === 0) return
	signalOwned(owner, "SIGTERM")
	await raceWithTimeout(
		completion.catch(() => null),
		TERM_GRACE_MS,
		undefined,
	)
	if (ownedProcessIds(owner).length === 0) return
	signalOwned(owner, "SIGKILL")
	await raceWithTimeout(waitForOwnedExit(owner, Date.now() + KILL_SETTLE_MS), KILL_SETTLE_MS, undefined)
	const remaining = ownedProcessIds(owner)
	if (remaining.length > 0) {
		throw new Error(`Review command did not finish terminating its process tree (${remaining.join(", ")}).`)
	}
}

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
			const owner = randomUUID()
			const child = spawn(shell.shell, commandFromStdin ? shell.args : [...shell.args, command], {
				cwd,
				detached: false,
				env: { ...(env ?? getShellEnv()), [PROCESS_TREE_ENV]: owner },
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			})
			if (commandFromStdin) {
				child.stdin?.on("error", () => {})
				child.stdin?.end(command)
			}
			const completion = waitForChildProcess(child)
			let cleanup: Promise<void> | undefined
			const terminate = (): Promise<void> => {
				if (process.platform === "win32") {
					if (child.pid) killProcessTree(child.pid)
					return Promise.resolve()
				}
				cleanup ??= reapProcessTree(owner, completion)
				return cleanup
			}
			try {
				child.stdout?.on("data", onData)
				child.stderr?.on("data", onData)
				if (signal) {
					if (signal.aborted) void terminate()
					else signal.addEventListener("abort", terminate, { once: true })
				}
				const exitCode = await completion
				await terminate()
				if (signal?.aborted) throw new Error("aborted")
				const signalCode = child.signalCode
				return { exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) }
			} catch (error) {
				await terminate()
				throw error
			} finally {
				signal?.removeEventListener("abort", terminate)
				child.stdout?.destroy()
				child.stderr?.destroy()
			}
		},
	}
}
