/**
 * Direct executor regressions for bounded cancellation settlement.
 *
 * `createLocalShellOperations().exec` must settle promptly when a detached
 * descendant keeps writing through the inherited stdout/stderr pipes: the
 * timeout path destroys those pipe ends after a 500 ms grace, and — via the
 * shared termination helper added for earendil-works/pi#10929 — the abort
 * path does the same. Without it, `waitForChildProcess`'s idle timer re-arms
 * on every arriving chunk, so an escaped writer keeps a cancelled execution
 * pending indefinitely (until the writer's own exit).
 *
 * The escape uses a Node writer spawned `detached` (its own process group
 * and session, like `setsid`), so these cases run on macOS and Linux
 * without the `setsid` binary; the managed-path reproductions live in
 * bash-control-stress.test.ts (Linux-only). Windows is skipped here: its
 * process model (taskkill trees, no POSIX process groups) is out of
 * validation scope for these semantics.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, expect, it } from "vitest"

/** Bounded settlement after a cancellation action: the 500 ms pipe-destruction grace plus slack. */
const SETTLEMENT_BOUND_MS = 1500

/** Skip on Windows: these cases rely on POSIX process groups and sessions. */
const itPosix = it.skipIf(process.platform === "win32")

let cwd: string

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
		throw error
	}
}

function nodeCommand(file: string): string {
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
	return `${quote(process.execPath)} ${quote(join(cwd, file))}`
}

function treePids(): number[] {
	if (!existsSync(join(cwd, "tree.pids"))) return []
	return readFileSync(join(cwd, "tree.pids"), "utf8").trim().split("\n").map(Number)
}

/**
 * Count pending Timeout handles in this process (vitest runs each test file
 * in its own fork). Sampling with no await between two points brackets a
 * single synchronous action — nothing else can run in between — so the
 * delta is exactly the number of timers that action scheduled.
 */
function pendingTimeouts(): number {
	return process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length
}

/**
 * Write the escaped-writer fixture. The launcher spawns the writer detached
 * (new process group + session — it survives the executor's process-group
 * kill) with only the target inherited pipes open, then exits, so after the
 * root shell is gone the writer is the sole holder of those pipes. The
 * writer records its pid for teardown, writes every 20 ms (continuously
 * re-arming `waitForChildProcess`'s idle timer), survives EPIPE when the
 * executor destroys its pipe ends, and self-exits after 8 s as a safety net.
 */
function writeEscapedWriter(): void {
	writeFileSync(
		join(cwd, "escaped-writer.cjs"),
		`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
if (process.argv[2] === 'writer') {
	const target = process.argv[3];
	const streams =
		target === 'stderr' ? [process.stderr]
		: target === 'both' ? [process.stdout, process.stderr]
		: [process.stdout];
	for (const stream of streams) stream.on('error', () => {});
	fs.appendFileSync('tree.pids', process.pid + '\\n');
	setInterval(() => {
		for (const stream of streams) stream.write('escaped-output\\n');
	}, 20);
	setTimeout(() => process.exit(0), 8000);
	return;
}
const target = process.argv[2] || 'stdout';
const stdio =
	target === 'stderr' ? ['ignore', 'ignore', 'inherit']
	: target === 'both' ? ['ignore', 'inherit', 'inherit']
	: ['ignore', 'inherit', 'ignore'];
spawn(process.execPath, [__filename, 'writer', target], { detached: true, stdio }).unref();
`,
	)
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "kimchi-bash-cancellation-"))
})

afterEach(async () => {
	// Kill escaped writer processes explicitly and wait for them to be reaped:
	// their bounded self-exit is a safety net, not the cleanup path, and the
	// executor's cancellation deliberately does not terminate them.
	for (const pid of treePids()) {
		try {
			process.kill(pid, "SIGKILL")
		} catch {
			// Already dead.
		}
	}
	await expect.poll(() => treePids().filter((pid) => isAlive(pid)).length, { timeout: 3000 }).toBe(0)
	rmSync(cwd, { recursive: true, force: true })
})

itPosix(
	"a timed-out exec rejects promptly while an escaped writer keeps inherited stdout and stderr open",
	async () => {
		writeEscapedWriter()
		const ops = createLocalBashOperations()
		const output: Buffer[] = []
		const started = Date.now()
		await expect(
			ops.exec("node escaped-writer.cjs both", cwd, { onData: (data) => output.push(data), timeout: 1 }),
		).rejects.toThrow("timeout:1")
		// The timeout's 500 ms pipe-destruction grace bounds the rejection.
		expect(Date.now() - started).toBeLessThan(1_000 + SETTLEMENT_BOUND_MS)
		expect(Buffer.concat(output).toString()).toContain("escaped-output")
	},
	10_000,
)

itPosix(
	"aborting an exec whose escaped descendant keeps writing inherited stdout settles promptly",
	async () => {
		writeEscapedWriter()
		const ops = createLocalBashOperations()
		const output: Buffer[] = []
		const abort = new AbortController()
		const running = ops.exec("node escaped-writer.cjs stdout", cwd, {
			onData: (data) => output.push(data),
			signal: abort.signal,
		})
		const rejected = expect(running).rejects.toThrow("aborted")
		await expect.poll(() => treePids().length, { timeout: 1500 }).toBe(1)
		await delay(200) // establish the continuous output flow before cancelling
		const abortedAt = Date.now()
		abort.abort()
		await rejected
		expect(Date.now() - abortedAt).toBeLessThan(SETTLEMENT_BOUND_MS)
		expect(Buffer.concat(output).toString()).toContain("escaped-output")
	},
	15_000,
)

itPosix(
	"aborting an exec whose escaped descendant keeps writing inherited stderr settles promptly",
	async () => {
		writeEscapedWriter()
		const ops = createLocalBashOperations()
		const output: Buffer[] = []
		const abort = new AbortController()
		const running = ops.exec("node escaped-writer.cjs stderr", cwd, {
			onData: (data) => output.push(data),
			signal: abort.signal,
		})
		const rejected = expect(running).rejects.toThrow("aborted")
		await expect.poll(() => treePids().length, { timeout: 1500 }).toBe(1)
		await delay(200)
		const abortedAt = Date.now()
		abort.abort()
		await rejected
		expect(Date.now() - abortedAt).toBeLessThan(SETTLEMENT_BOUND_MS)
		expect(Buffer.concat(output).toString()).toContain("escaped-output")
	},
	15_000,
)

itPosix(
	"an abort followed by a timeout firing inside the cleanup grace schedules at most one cleanup",
	async () => {
		writeEscapedWriter()
		const ops = createLocalBashOperations()
		const abort = new AbortController()
		const running = ops.exec("node escaped-writer.cjs both", cwd, {
			onData: () => {},
			signal: abort.signal,
			// 700 ms: the timeout fires AFTER the abort (~300 ms) but inside its
			// 500 ms cleanup grace (destroy at ~800 ms), so both terminations
			// genuinely overlap before settlement.
			timeout: 0.7,
		})
		const rejected = expect(running).rejects.toThrow("aborted")
		await expect.poll(() => treePids().length, { timeout: 1500 }).toBe(1)
		await delay(200)
		// Synchronous bracket around the abort — no await between the two
		// samples, so nothing else can run: the delta is exactly the number of
		// cleanup timers the abort path scheduled. At most one may appear.
		const timersBeforeAbort = pendingTimeouts()
		const abortedAt = Date.now()
		abort.abort()
		expect(pendingTimeouts()).toBeLessThanOrEqual(timersBeforeAbort + 1)
		await rejected
		// The abort error keeps its precedence even though the timeout also
		// fired before settlement, and the executor settles within the grace
		// of the FIRST termination (the abort's cleanup), not a rescheduled one.
		expect(Date.now() - abortedAt).toBeLessThan(SETTLEMENT_BOUND_MS)
	},
	15_000,
)

itPosix(
	"an abort arriving inside the timeout's cleanup grace adds no second cleanup schedule",
	async () => {
		writeEscapedWriter()
		const ops = createLocalBashOperations()
		const abort = new AbortController()
		const running = ops.exec("node escaped-writer.cjs both", cwd, {
			onData: () => {},
			signal: abort.signal,
			// 300 ms: the timeout fires first and schedules the single cleanup
			// for ~800 ms; the abort at ~500 ms lands inside that grace.
			timeout: 0.3,
		})
		const rejected = expect(running).rejects.toThrow("aborted")
		await delay(500)
		// Synchronous bracket around the abort — with a cleanup already
		// scheduled by the fired timeout, the overlapping abort must add NO
		// further timer: this is the once-only scheduling contract for the
		// shared termination, observed deterministically.
		const timersBeforeAbort = pendingTimeouts()
		const abortedAt = Date.now()
		abort.abort()
		expect(pendingTimeouts()).toBeLessThanOrEqual(timersBeforeAbort)
		await rejected
		// The abort error keeps its precedence over the fired timeout.
		expect(Date.now() - abortedAt).toBeLessThan(SETTLEMENT_BOUND_MS)
	},
	15_000,
)

it("a signal aborted before execution rejects without spawning the command", async () => {
	const ops = createLocalBashOperations()
	const abort = new AbortController()
	abort.abort()
	await expect(
		ops.exec("printf spawned > spawned-marker.txt", cwd, { onData: () => {}, signal: abort.signal }),
	).rejects.toThrow("aborted")
	await delay(300)
	expect(existsSync(join(cwd, "spawned-marker.txt"))).toBe(false)
}, 5_000)

itPosix(
	"normal completion preserves output written by a descendant after the root shell exits",
	async () => {
		writeFileSync(
			join(cwd, "descendant.cjs"),
			`
const beats = setInterval(() => process.stdout.write("DESCENDANT_BEAT\\n"), 20);
setTimeout(() => {
	clearInterval(beats);
	process.stdout.write("LATE_COMPLETION_SENTINEL\\n");
	process.exit(0);
}, 800);
`,
		)
		const ops = createLocalBashOperations()
		const output: Buffer[] = []
		// The root shell exits after 200 ms while the same-group descendant
		// keeps writing inherited stdout beats every 20 ms: the idle-drain grace
		// re-arms on each beat, so the late output must still be collected. No
		// cancellation happened, so no pipe may be destroyed early.
		const result = await ops.exec("node descendant.cjs & sleep 0.2; exit 0", cwd, {
			onData: (data) => output.push(data),
		})
		const outputText = Buffer.concat(output).toString()
		expect(result.exitCode).toBe(0)
		// Beats alone could all predate the shell's exit; the sentinel is
		// emitted ~600 ms AFTER it (after the beats stop), so it is what proves
		// the tail of the descendant's post-exit output survived the drain.
		expect(outputText).toContain("DESCENDANT_BEAT")
		expect(outputText).toContain("LATE_COMPLETION_SENTINEL")
	},
	10_000,
)

itPosix(
	"aborting an exec still terminates ordinary children and grandchildren",
	async () => {
		writeFileSync(
			join(cwd, "tree.cjs"),
			`
const fs = require('node:fs');
const { spawn } = require('node:child_process');
process.on('SIGTERM', () => {});
fs.appendFileSync('tree.pids', process.pid + '\\n');
const depth = Number(process.argv[2] || 0);
if (depth < 2) spawn(process.execPath, [__filename, String(depth + 1)], { stdio: 'inherit' });
setInterval(() => {}, 1000);
`,
		)
		const ops = createLocalBashOperations()
		const abort = new AbortController()
		const running = ops.exec(nodeCommand("tree.cjs"), cwd, { onData: () => {}, signal: abort.signal })
		const rejected = expect(running).rejects.toThrow("aborted")
		await expect.poll(() => treePids().length, { timeout: 1500 }).toBe(3)
		const abortedAt = Date.now()
		abort.abort()
		await rejected
		expect(Date.now() - abortedAt).toBeLessThan(SETTLEMENT_BOUND_MS)
		// The process-group kill still reaches the full ordinary tree.
		await expect.poll(() => treePids().some(isAlive), { timeout: 5000 }).toBe(false)
	},
	10_000,
)

itPosix(
	"an aborted exec that settles before the cleanup grace clears its pipe-cleanup timer",
	async () => {
		const ops = createLocalBashOperations()
		const before = pendingTimeouts()
		const abort = new AbortController()
		const running = ops.exec("sleep 5", cwd, { onData: () => {}, signal: abort.signal })
		const rejected = expect(running).rejects.toThrow("aborted")
		abort.abort()
		await rejected
		// A quiet, non-escaped command settles via pipe EOF well before the
		// 500 ms grace: the pipe-cleanup timer must be cleared in the
		// executor's finally block, not left pending to fire on the already
		// settled streams. Sample briefly to ignore unrelated transient timers.
		let cleared = false
		for (let attempt = 0; attempt < 10 && !cleared; attempt++) {
			cleared = pendingTimeouts() <= before
			if (!cleared) await delay(20)
		}
		expect(cleared).toBe(true)
	},
	10_000,
)
