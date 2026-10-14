import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, expect, it } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createBackgroundBashToolDefinition } from "./bash-background-tool.js"
import { createBashControlToolDefinition } from "./bash-control-tool.js"
import { createProcessRegistry, SAFETY_LIMIT_REASON } from "./process-registry.js"
import { createReviewCoordinator } from "./review-coordinator.js"
import type { BashSessionState } from "./session-registry.js"
import { createTerminalDelivery } from "./terminal-delivery.js"

let cwd: string
let state: BashSessionState
const ctx = createContext()

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
		throw error
	}
}

function textOf(result: Awaited<ReturnType<ReturnType<typeof createBashControlToolDefinition>["execute"]>>): string {
	return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
}

function nodeCommand(file: string): string {
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
	return `${quote(process.execPath)} ${quote(join(cwd, file))}`
}

function writeStubbornTree(): void {
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
}

function treePids(): number[] {
	if (!existsSync(join(cwd, "tree.pids"))) return []
	return readFileSync(join(cwd, "tree.pids"), "utf8").trim().split("\n").map(Number)
}

/**
 * setsid-escaped writer: survives the executor's process-group kill, keeps
 * writing inherited stdout every 20 ms (re-arming waitForChildProcess's
 * idle timer), survives EPIPE when the executor destroys its pipe ends, and
 * self-exits after 8 s as a safety net.
 */
function writeEscapedWriter(): void {
	writeFileSync(
		join(cwd, "escaped.cjs"),
		`
const fs = require('node:fs');
fs.appendFileSync('tree.pids', process.pid + '\\n');
process.stdout.on('error', () => {});
setInterval(() => process.stdout.write('escaped-output\\n'), 20);
setTimeout(() => process.exit(0), 8000);
`,
	)
}

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "kimchi-bash-stress-"))
	const registry = createProcessRegistry()
	state = {
		registry,
		coordinator: createReviewCoordinator({ registry }),
		delivery: createTerminalDelivery(),
		limitSeconds: 60,
		cwd,
	}
})

afterEach(async () => {
	state.coordinator.dispose()
	await state.registry.shutdown()
	// Kill escaped test processes explicitly and wait for them to be reaped —
	// never rely on their bounded self-exit or on the (deliberately
	// non-terminating) executor cleanup for escaped descendants. Only PIDs
	// recorded by this test are touched.
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

// Real local BashOperations and the production two-second handoff: these
// checks complement the deterministic queue/AgentSession contract tests.
it("repeated real-shell cohorts preserve filtered output and resolve overlapping stops exactly once", async () => {
	const bash = createBackgroundBashToolDefinition(cwd, { state })
	const control = createBashControlToolDefinition(() => state)
	for (let cycle = 0; cycle < 3; cycle++) {
		const results = await Promise.all(
			Array.from({ length: 12 }, (_, i) =>
				bash.execute(
					`spawn-${cycle}-${i}`,
					{
						command: `sleep 3; echo OUTPUT_${cycle}_${i}_END; sleep 600 & child=$!; echo "$child" > child-${cycle}-${i}.pid; wait "$child"`,
					},
					undefined,
					undefined,
					ctx,
				),
			),
		)
		const handles = results.map((result) => {
			expect(result.details?.handoff).toBe(true)
			const handle = result.details?.handle
			if (!handle) throw new Error("Missing real-shell handoff handle")
			return handle
		})
		expect(state.registry.size).toBe(12)
		await expect
			.poll(() => handles.every((_, i) => existsSync(join(cwd, `child-${cycle}-${i}.pid`))), {
				timeout: 5000,
			})
			.toBe(true)
		const selected = await control.execute(
			`inspect-${cycle}`,
			{ handles: [handles[0], "missing"] },
			undefined,
			undefined,
			ctx,
		)
		const selectedText = selected.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
		expect(selected.details.runningHandles).toEqual([handles[0]])
		expect(selectedText).toContain(`\nOUTPUT_${cycle}_0_END\n`)
		expect(selectedText).toContain("Unknown handle")
		for (const handle of handles.slice(1)) expect(state.registry.getEntry(handle)?.deliveredCursor).toBe(0)
		const all = await control.execute(`all-${cycle}`, {}, undefined, undefined, ctx)
		const allText = all.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
		expect(allText).not.toContain(`\nOUTPUT_${cycle}_0_END\n`)
		for (let i = 1; i < handles.length; i++) expect(allText).toContain(`\nOUTPUT_${cycle}_${i}_END\n`)
		const stops = await Promise.all([
			control.execute(`stop-a-${cycle}`, { stop_handles: handles }, undefined, undefined, ctx),
			control.execute(`stop-b-${cycle}`, { stop_handles: [...handles].reverse() }, undefined, undefined, ctx),
		])
		const delivered = stops.flatMap((result) => result.details.exitedHandles ?? [])
		expect(delivered.sort()).toEqual([...handles].sort())
		expect(state.registry.size).toBe(0)
		expect(state.coordinator.size).toBe(0)
		// An empty registry alone would miss orphaned shell children.
		for (let i = 0; i < handles.length; i++) {
			const pid = Number(readFileSync(join(cwd, `child-${cycle}-${i}.pid`), "utf8").trim())
			expect(pid).toBeGreaterThan(0)
			await expect
				.poll(
					() => {
						try {
							process.kill(pid, 0)
							return true
						} catch (error) {
							if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
							throw error
						}
					},
					{ timeout: 5000 },
				)
				.toBe(false)
		}
		state.delivery.acknowledgeControl(delivered)
		const empty = await control.execute(`empty-${cycle}`, { wait: true }, undefined, undefined, ctx)
		expect(empty.details.event).toBe("empty")
		expect(state.delivery.size).toBe(0)
	}
}, 30_000)

it("cancelling a real cohort wait preserves survivors and a failed sibling result", async () => {
	const bash = createBackgroundBashToolDefinition(cwd, { state })
	const control = createBashControlToolDefinition(() => state)
	const spawned = await Promise.all([
		bash.execute("failure", { command: "sleep 3; echo FAILED_OUTPUT; exit 7" }, undefined, undefined, ctx),
		bash.execute("survivor", { command: "sleep 600" }, undefined, undefined, ctx),
	])
	const survivor = spawned[1].details?.handle
	if (!survivor) throw new Error("Missing survivor handle")
	const abort = new AbortController()
	const waiting = control.execute("cancel", { wait: true }, abort.signal, undefined, ctx)
	abort.abort()
	expect((await waiting).details.aborted).toBe(true)
	expect(state.registry.getEntry(survivor)?.state).toBe("running")
	const exited = await control.execute("observe-failure", { wait: true, waitSeconds: 10 }, undefined, undefined, ctx)
	const exitedText = exited.content.map((block) => (block.type === "text" ? block.text : "")).join("\n")
	expect(exited.details.event).toBe("exit")
	expect(exitedText).toContain("FAILED_OUTPUT")
	expect(exitedText).toContain("exit code 7")
	expect(exited.details.runningHandles).toEqual([survivor])
	state.delivery.acknowledgeControl(exited.details.exitedHandles ?? [])
	const stopped = await control.execute("stop", { stop_handles: [survivor] }, undefined, undefined, ctx)
	expect(stopped.details.exitedHandles).toEqual([survivor])
	expect(stopped.details.runningHandles).toEqual([])
	expect(state.registry.size).toBe(0)
}, 15_000)

it("cancellation before the real handoff kills a stubborn three-generation process tree", async () => {
	writeStubbornTree()
	const bash = createBackgroundBashToolDefinition(cwd, { state })
	const abort = new AbortController()
	const running = bash.execute("early-abort", { command: nodeCommand("tree.cjs") }, abort.signal, undefined, ctx)
	const rejected = expect(running).rejects.toThrow("Command aborted")
	await expect.poll(() => treePids().length, { timeout: 1500 }).toBe(3)
	abort.abort()
	await rejected
	await expect.poll(() => treePids().some(isAlive), { timeout: 5000 }).toBe(false)
	expect(state.registry.size).toBe(0)
	expect(state.coordinator.size).toBe(0)
	expect(state.delivery.size).toBe(0)
}, 10_000)

// Prompt settlement under continuous inherited output: every managed
// cancellation path must settle within 1.5 s of the cancellation action even
// while a setsid child keeps writing through the inherited stdout pipe —
// waitForChildProcess re-arms its idle timer on every chunk, so the executor
// only settles once the patched abort/timeout termination destroys the pipes
// (earendil-works/pi#10929). These measure settlement ONLY; the escaped
// descendant's survival is pinned separately by the .fails cases below.
it.skipIf(process.platform !== "linux").each(["stop", "safety-limit", "abort", "shutdown"] as const)(
	"managed %s settles promptly despite a setsid child that keeps writing inherited stdout",
	async (mode) => {
		writeEscapedWriter()
		state.limitSeconds = mode === "safety-limit" ? 3 : 60
		const bash = createBackgroundBashToolDefinition(cwd, { state })
		const control = createBashControlToolDefinition(() => state)
		const abort = new AbortController()
		const running = bash.execute(
			"escaped",
			{ command: `setsid ${nodeCommand("escaped.cjs")} & wait` },
			abort.signal,
			undefined,
			ctx,
		)
		if (mode === "abort") {
			const rejected = expect(running).rejects.toThrow("Command aborted")
			await expect.poll(() => treePids().length, { timeout: 1500 }).toBe(1)
			const abortedAt = Date.now()
			abort.abort()
			await rejected
			expect(Date.now() - abortedAt).toBeLessThan(1500)
		} else {
			const spawned = await running
			const handle = spawned.details?.handle
			if (!handle) throw new Error("Missing escaped process handle")
			if (mode === "shutdown") {
				const started = Date.now()
				state.coordinator.dispose()
				await state.registry.shutdown()
				expect(Date.now() - started).toBeLessThan(1500)
			} else if (mode === "safety-limit") {
				// The deadline is armed at SPAWN and the initial handoff takes ~2 s
				// of the 3 s budget, so measuring from handoff completion would
				// count lead-in before the cancellation even begins. Start the
				// clock at the observed kill/abort transition on the entry's real
				// cancellation signal instead, and verify the safety-limit reason
				// separately.
				let killedAt: number | undefined
				state.registry.getEntry(handle)?.controller.signal.addEventListener(
					"abort",
					() => {
						killedAt = Date.now()
					},
					{ once: true },
				)
				await state.registry.whenExited(handle)
				expect(state.registry.getEntry(handle)?.reason).toBe(SAFETY_LIMIT_REASON)
				if (killedAt === undefined) throw new Error("Safety-limit cancellation signal was never observed")
				expect(Date.now() - killedAt).toBeLessThan(1500)
			} else {
				const started = Date.now()
				await control.execute("stop-escaped", { stop_handles: [handle] }, undefined, undefined, ctx)
				expect(Date.now() - started).toBeLessThan(1500)
			}
		}
	},
	15_000,
)

// Known limitation, deliberately pinned with .fails: managed cancellation
// settles the executor by closing the inherited pipes (see the settlement
// regressions above) but does NOT terminate a descendant that escaped the
// command group via setsid — it survives until its own bounded self-exit.
// Remove .fails ONLY when managed cancellation actually terminates escaped
// descendants; prompt settlement is covered by the ordinary passing tests
// above and must keep passing. Settlement is intentionally NOT awaited
// before the assertion: pre-fix it pends until the writer's self-exit
// (leaving the child dead and this assertion trivially green), so aliveness
// is checked inside a bounded window of the cancellation instead.
it.skipIf(process.platform !== "linux").fails.each(["stop", "safety-limit", "abort", "shutdown"] as const)(
	"managed %s terminates a setsid descendant that keeps writing inherited stdout",
	async (mode) => {
		writeEscapedWriter()
		state.limitSeconds = mode === "safety-limit" ? 3 : 60
		const bash = createBackgroundBashToolDefinition(cwd, { state })
		const control = createBashControlToolDefinition(() => state)
		const abort = new AbortController()
		const running = bash.execute(
			"escaped",
			{ command: `setsid ${nodeCommand("escaped.cjs")} & wait` },
			abort.signal,
			undefined,
			ctx,
		)
		if (mode === "abort") {
			await expect.poll(() => treePids().length, { timeout: 1500 }).toBe(1)
			abort.abort()
			void running.catch(() => {})
			await delay(1500)
		} else {
			const spawned = await running
			const handle = spawned.details?.handle
			if (!handle) throw new Error("Missing escaped process handle")
			if (mode === "shutdown") {
				state.coordinator.dispose()
				void state.registry.shutdown()
			} else if (mode === "safety-limit") {
				// The deadline fires on its own at spawn + 3 s; wait past it and
				// the settle window before checking the descendant.
				await delay(4000)
			} else {
				void control.execute("stop-escaped", { stop_handles: [handle] }, undefined, undefined, ctx).catch(() => {})
				await delay(1500)
			}
		}
		expect(treePids().some(isAlive)).toBe(false)
	},
	20_000,
)

it("stop kills children and grandchildren ignoring SIGTERM after handoff", async () => {
	writeStubbornTree()
	const bash = createBackgroundBashToolDefinition(cwd, { state })
	const control = createBashControlToolDefinition(() => state)
	const result = await bash.execute("stubborn", { command: nodeCommand("tree.cjs") }, undefined, undefined, ctx)
	const handle = result.details?.handle
	if (!handle) throw new Error("Missing stubborn process handle")
	expect(result.details?.handoff).toBe(true)
	expect(treePids()).toHaveLength(3)
	const stopped = await control.execute("stop-tree", { stop_handles: [handle] }, undefined, undefined, ctx)
	expect(stopped.details.exitedHandles).toEqual([handle])
	expect(textOf(stopped)).toContain("stopped on request")
	await expect.poll(() => treePids().some(isAlive), { timeout: 5000 }).toBe(false)
	expect(state.registry.size).toBe(0)
}, 10_000)

it("parallel megabyte Unicode output retains complete spill files and filtered cursors", async () => {
	const bash = createBackgroundBashToolDefinition(cwd, { state })
	const control = createBashControlToolDefinition(() => state)
	const payload = "🙂한글".repeat(150_000)
	for (let i = 0; i < 4; i++) {
		writeFileSync(
			join(cwd, `flood-${i}.cjs`),
			`
const bytes = Buffer.from('🙂한글'.repeat(150000) + 'TAIL_${i}');
process.stdout.write(bytes.subarray(0, 3));
setTimeout(() => process.stdout.write(bytes.subarray(3)), 30);
`,
		)
	}
	const results = await Promise.all(
		Array.from({ length: 4 }, (_, i) =>
			bash.execute(
				`flood-${i}`,
				{ command: `while [ ! -f flood-now ]; do sleep 0.01; done; ${nodeCommand(`flood-${i}.cjs`)}` },
				undefined,
				undefined,
				ctx,
			),
		),
	)
	const handles = results.map((result) => {
		const handle = result.details?.handle
		if (!handle) throw new Error("Missing flood handle")
		return handle
	})
	writeFileSync(join(cwd, "flood-now"), "")
	await Promise.all(handles.map((handle) => state.registry.whenExited(handle)))
	const selected = await control.execute("flood-selected", { handles: [handles[0]] }, undefined, undefined, ctx)
	expect(selected.details.exitedHandles).toEqual([handles[0]])
	for (const handle of handles.slice(1)) expect(state.registry.getEntry(handle)?.deliveredCursor).toBe(0)
	const remaining = await control.execute("flood-rest", {}, undefined, undefined, ctx)
	expect(remaining.details.exitedHandles).toEqual(handles.slice(1))
	const paths: string[] = []
	for (let i = 0; i < handles.length; i++) {
		const completed = state.registry.completedSnapshot(handles[i])
		const path = completed?.final.fullOutputPath
		if (!path) throw new Error("Missing full flood output spill")
		paths.push(path)
		expect(completed?.final.truncation?.truncated).toBe(true)
		expect(completed?.final.content).not.toContain("�")
		expect(completed?.final.content).toContain(`TAIL_${i}`)
		expect(readFileSync(path, "utf8")).toBe(`${payload}TAIL_${i}`)
	}
	state.delivery.acknowledgeControl(handles)
	await state.registry.shutdown()
	for (const path of paths) expect(existsSync(path)).toBe(false)
}, 15_000)

it("natural exits racing overlapping stops preserve one terminal result per real process", async () => {
	const ops = createLocalBashOperations()
	const control = createBashControlToolDefinition(() => state)
	for (let i = 0; i < 24; i++) {
		const handle = state.registry.spawn(
			ops,
			`echo RACE_${i}; while [ ! -f gate-${i} ]; do sleep 0.01; done; exit 7`,
			cwd,
			undefined,
			{ limitSeconds: 60 },
		)
		state.coordinator.handleSpawned(handle)
		await expect.poll(() => state.registry.getEntry(handle)?.lastOutputAtMs).toBeDefined()
		writeFileSync(join(cwd, `gate-${i}`), "")
		if (i % 3 === 0) await state.registry.whenExited(handle)
		else if (i % 3 === 1) await delay(5)
		const results = await Promise.all([
			control.execute(`race-a-${i}`, { stop_handles: [handle] }, undefined, undefined, ctx),
			control.execute(`race-b-${i}`, { stop_handles: [handle] }, undefined, undefined, ctx),
		])
		expect(results.flatMap((result) => result.details.exitedHandles ?? [])).toEqual([handle])
		expect(results.map(textOf).join("\n").split(`\nRACE_${i}\n`)).toHaveLength(2)
		if (i % 3 === 0) expect(results.map(textOf).join("\n")).toContain("exit code 7")
		state.delivery.acknowledgeControl([handle])
		expect(state.registry.size).toBe(0)
		expect(state.coordinator.size).toBe(0)
	}
}, 20_000)

it("the real safety deadline yields a wait and retains its reason across a racing stop", async () => {
	const ops = createLocalBashOperations()
	const control = createBashControlToolDefinition(() => state)
	const victim = state.registry.spawn(ops, "echo deadline-victim; sleep 600", cwd, undefined, { limitSeconds: 1 })
	const survivor = state.registry.spawn(ops, "sleep 600", cwd, undefined, { limitSeconds: 60 })
	state.coordinator.handleSpawned(victim)
	state.coordinator.handleSpawned(survivor)
	const waiting = control.execute("deadline-wait", { wait: true, waitSeconds: 300 }, undefined, undefined, ctx)
	await state.registry.whenExited(victim)
	expect(state.registry.getEntry(victim)?.reason).toBe(SAFETY_LIMIT_REASON)
	const stopping = control.execute("deadline-stop", { stop_handles: [victim] }, undefined, undefined, ctx)
	const results = await Promise.all([waiting, stopping])
	expect(results.flatMap((result) => result.details.exitedHandles ?? [])).toEqual([victim])
	expect(results.map(textOf).join("\n")).toContain("safety limit")
	expect(state.registry.getEntry(survivor)?.state).toBe("running")
	state.delivery.acknowledgeControl([victim])
	await control.execute("stop-survivor", { stop_handles: [survivor] }, undefined, undefined, ctx)
}, 10_000)

it("shutdown settles an active wait and kills the real process tree", async () => {
	writeStubbornTree()
	const bash = createBackgroundBashToolDefinition(cwd, { state })
	const control = createBashControlToolDefinition(() => state)
	await bash.execute("shutdown-tree", { command: nodeCommand("tree.cjs") }, undefined, undefined, ctx)
	const waiting = control.execute("shutdown-wait", { wait: true }, undefined, undefined, ctx)
	state.coordinator.dispose()
	await state.registry.shutdown()
	expect((await waiting).details.aborted).toBe(true)
	await expect.poll(() => treePids().some(isAlive), { timeout: 5000 }).toBe(false)
	expect(state.registry.size).toBe(0)
	expect(state.coordinator.size).toBe(0)
}, 10_000)
