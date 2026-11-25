import { type ChildProcess, execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, readdir, readFile } from "node:fs/promises"
import { constants as osConstants } from "node:os"
import { promisify } from "node:util"
import type { BashOperations } from "@earendil-works/pi-coding-agent"
import { waitForChildProcess } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/child-process.js"
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/utils/shell.js"
import { raceWithTimeout } from "../../shared/race-with-timeout.js"
import type { ReviewExecutionMode } from "./execution.js"

const execFileAsync = promisify(execFile)
const PROCESS_TREE_ENV = "KIMCHI_REVIEW_PROCESS_TREE"
const TERM_GRACE_MS = 50
const KILL_SETTLE_MS = 150

type OwnedProcessDiscovery = (owner: string) => Promise<number[]>

async function ownedProcessIds(owner: string): Promise<number[]> {
	const marker = `${PROCESS_TREE_ENV}=${owner}`
	if (process.platform === "darwin") {
		const { stdout } = await execFileAsync("ps", ["-A", "-E", "-o", "pid=,command="], {
			encoding: "utf8",
			maxBuffer: 8 * 1024 * 1024,
		})
		return outputProcessIds(stdout, marker)
	}
	if (process.platform === "linux") return linuxOwnedProcessIds(marker)
	// Other Unix platforms retain their existing ps compatibility path.
	const { stdout } = await execFileAsync("ps", ["eww", "-o", "pid=,command="], {
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
	})
	return outputProcessIds(stdout, marker)
}

function outputProcessIds(output: string, marker: string): number[] {
	return output
		.split("\n")
		.filter((line) => line.includes(marker))
		.map((line) => Number.parseInt(line.trimStart(), 10))
		.filter((pid) => Number.isSafeInteger(pid) && pid > 0)
}

async function linuxOwnedProcessIds(marker: string): Promise<number[]> {
	const entries = await readdir("/proc")
	const owners = await Promise.all(
		entries
			.filter((entry) => /^[1-9][0-9]*$/.test(entry))
			.map(async (entry): Promise<number | undefined> => {
				try {
					const environment = await readFile(`/proc/${entry}/environ`, "utf8")
					if (environment.split("\0").includes(marker)) return Number(entry)
				} catch {
					// A process can vanish, or its environment can be unreadable, between
					// discovery and this read. Those entries are not owned evidence.
					return undefined
				}
				return undefined
			}),
	)
	return owners.filter((pid): pid is number => pid !== undefined)
}

async function parentPid(pid: number): Promise<number | undefined> {
	try {
		if (process.platform === "linux") {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8")
			const parent = Number(
				stat
					.slice(stat.lastIndexOf(")") + 2)
					.trim()
					.split(/\s+/)[1],
			)
			return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined
		}
		const { stdout } = await execFileAsync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" })
		const parent = Number(stdout.trim())
		return Number.isSafeInteger(parent) && parent > 0 ? parent : undefined
	} catch {
		return undefined
	}
}

async function signalOwned(owner: string, signal: NodeJS.Signals, discovery: OwnedProcessDiscovery): Promise<void> {
	const owned = await Promise.all(
		(await discovery(owner)).map(async (pid) => ({ pid, parentPid: await parentPid(pid) })),
	)
	const parents = new Map(owned.map(({ pid, parentPid }) => [pid, parentPid]))
	const depth = (pid: number): number => {
		const visited = new Set<number>()
		let current = pid
		let value = 0
		while (!visited.has(current)) {
			visited.add(current)
			const parent = parents.get(current)
			if (parent === undefined) break
			current = parent
			value += 1
		}
		return value
	}
	const groups = new Map<number, number[]>()
	for (const { pid } of owned) {
		const level = depth(pid)
		groups.set(level, [...(groups.get(level) ?? []), pid])
	}
	const deadline = Date.now() + (signal === "SIGTERM" ? TERM_GRACE_MS : KILL_SETTLE_MS)
	for (const [, pids] of [...groups].sort(([a], [b]) => b - a)) {
		for (const pid of pids) {
			try {
				process.kill(pid, signal)
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
			}
		}
		const survivors = await waitForOwnedExit(owner, deadline, discovery, new Set(pids))
		if (survivors.length === 0) continue
		if (signal === "SIGTERM") {
			for (const pid of survivors) process.kill(pid, "SIGKILL")
			const remaining = await waitForOwnedExit(owner, Date.now() + KILL_SETTLE_MS, discovery, new Set(survivors))
			if (remaining.length > 0)
				throw new Error(`Could not terminate review command processes (${remaining.join(", ")}).`)
			continue
		}
		throw new Error(`Could not terminate review command processes (${survivors.join(", ")}).`)
	}
}

async function waitForOwnedExit(
	owner: string,
	deadline: number,
	discovery: OwnedProcessDiscovery,
	pids?: ReadonlySet<number>,
): Promise<number[]> {
	for (;;) {
		const remaining = (await discovery(owner)).filter((pid) => !pids || pids.has(pid))
		if (remaining.length === 0 || Date.now() >= deadline) return remaining
		await new Promise((resolve) => setTimeout(resolve, Math.min(10, deadline - Date.now())))
	}
}

/** Reap the whole tree and root through actual completion, rather than treating
 * an aborted wait as proof that all descendants have exited. */
async function reapProcessTree(
	owner: string,
	child: ChildProcess,
	completion: Promise<number | null>,
	discovery: OwnedProcessDiscovery,
): Promise<void> {
	const listOwned = async (): Promise<number[]> => {
		try {
			return await discovery(owner)
		} catch (error) {
			// A missing ps or procfs must not escape cancellation. Preserve the old
			// direct-child fallback, but make the reduced guarantee explicit.
			console.warn(
				`[review-runner] cleanup_warning: Process-tree discovery failed: ${error instanceof Error ? error.message : String(error)}. Falling back to direct child termination.`,
			)
			try {
				child.kill("SIGTERM")
			} catch {
				// The immediate child may already have exited.
			}
			return []
		}
	}
	if ((await listOwned()).length === 0) return
	await signalOwned(owner, "SIGTERM", listOwned)
	await raceWithTimeout(
		completion.catch(() => null),
		TERM_GRACE_MS,
		undefined,
	)
	if ((await listOwned()).length === 0) return
	await signalOwned(owner, "SIGKILL", listOwned)
	await raceWithTimeout(waitForOwnedExit(owner, Date.now() + KILL_SETTLE_MS, listOwned), KILL_SETTLE_MS, undefined)
	const remaining = await listOwned()
	if (remaining.length > 0) {
		throw new Error(`Review command did not finish terminating its process tree (${remaining.join(", ")}).`)
	}
}

/** Headless review commands must inherit Kimchi's process group so the
 * platform watchdog cannot miss them. Other modes retain upstream's detached
 * command-group behavior and cleanup. */
export function reviewInheritedProcessOperations(
	mode: ReviewExecutionMode,
	discovery: OwnedProcessDiscovery = ownedProcessIds,
): BashOperations | undefined {
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
				cleanup ??= reapProcessTree(owner, child, completion, discovery)
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
