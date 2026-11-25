import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { hostname } from "node:os"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export interface ReviewOwnerIdentity {
	hostname: string
	startIdentity: string
}

export function currentReviewHost(): string {
	return hostname()
}

/** Linux reports start clock ticks in /proc/<pid>/stat field 22. The comm field
 * may contain spaces, so parse only after its final closing parenthesis. */
async function linuxStartIdentity(pid: number): Promise<string> {
	const stat = await readFile(`/proc/${pid}/stat`, "utf8")
	const closing = stat.lastIndexOf(")")
	if (closing < 0) throw new Error(`Malformed /proc/${pid}/stat process record`)
	const fields = stat.slice(closing + 2).split(/\s+/)
	const start = fields[19]
	if (!start || !/^[0-9]+$/.test(start)) throw new Error(`Cannot determine start time for PID ${pid}`)
	return start
}

async function psStartIdentity(pid: number): Promise<string> {
	const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
		encoding: "utf8",
		timeout: 5_000,
		maxBuffer: 16 * 1024,
	})
	const identity = Date.parse(stdout.trim())
	if (!stdout.trim() || !Number.isFinite(identity)) {
		throw new Error(`Cannot determine process start identity for PID ${pid}`)
	}
	return String(identity)
}

export async function reviewProcessStartIdentity(pid: number): Promise<string> {
	if (process.platform === "linux") return linuxStartIdentity(pid)
	return psStartIdentity(pid)
}

export async function currentReviewOwnerIdentity(): Promise<ReviewOwnerIdentity> {
	return { hostname: currentReviewHost(), startIdentity: await reviewProcessStartIdentity(process.pid) }
}
