import { copyFileSync, existsSync, mkdirSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"
import { readResult as defaultReadResult } from "../autonomous/result.js"
import type { ResultManifest } from "../autonomous/result.js"
import { type SelectRuntimeDeps, selectRuntime as defaultSelectRuntime } from "../autonomous/runtime/select.js"
import type { ContainerRuntime } from "../autonomous/runtime/types.js"
import { selectExtensionFactories } from "../autonomous/select-extensions.js"
import { loadTaskSpec as defaultLoadTaskSpec } from "../autonomous/spec.js"
import type { TaskSpec } from "../autonomous/spec.js"
import { prepareAgentEnvironment } from "../cli-bootstrap.js"
import { maxIterationsExtension } from "../extensions/autonomous/max-iterations.js"
import { type ResultWriterControl, createResultWriter } from "../extensions/autonomous/result-writer.js"
import { timeoutGuardExtension } from "../extensions/autonomous/timeout-guard.js"

export interface AutoDeps {
	loadTaskSpec?: (path: string) => TaskSpec
	runHarness?: (args: string[], options: { extensionFactories: ExtensionFactory[] }) => Promise<void>
	buildBaseFactories?: () => Promise<ExtensionFactory[]>
	prepareEnvironment?: () => Promise<void>
	// Container path:
	selectRuntime?: (name: string, opts?: SelectRuntimeDeps) => ContainerRuntime
	readResult?: (dir: string) => ResultManifest
	fs?: {
		existsSync: (p: string) => boolean
		mkdirSync: (p: string, opts?: { recursive?: boolean }) => void
		copyFileSync: (src: string, dest: string) => void
	}
}

export interface ParsedAutoArgs {
	taskPath?: string
	iterations?: number
	timeoutSeconds?: number
	runtime?: string
	workspace?: string
	image?: string
	passthroughArgs: string[]
	help: boolean
}

async function defaultBuildBaseFactories(): Promise<ExtensionFactory[]> {
	const { readTelemetryConfig, DEFAULT_SKILL_PATHS, loadConfig } = await import("../config.js")
	const { buildBaseExtensionFactories, makeAutonomousSessionIdCapture } = await import("../cli-extensions.js")
	const cfg = loadConfig()
	const skillPaths = cfg.skillPaths ?? DEFAULT_SKILL_PATHS
	return buildBaseExtensionFactories({
		telemetryConfig: readTelemetryConfig(),
		skillPaths,
		sessionIdCaptureExtension: makeAutonomousSessionIdCapture(),
	})
}

/**
 * Parses kimchi auto's own flags from argv, returning passthrough args for pi.
 * In-process flags: --task <path>, --iterations / --max-iterations <N>, --timeout-seconds <N>
 * Container flags: --runtime <name>, --workspace <dir>, --image <ref>
 * Returns { help: true } when --help or -h is present.
 */
export function parseAutoArgs(args: string[]): ParsedAutoArgs {
	if (args.includes("--help") || args.includes("-h")) {
		return { help: true, passthroughArgs: [] }
	}

	let taskPath: string | undefined
	let iterations: number | undefined
	let timeoutSeconds: number | undefined
	let runtime: string | undefined
	let workspace: string | undefined
	let image: string | undefined
	const passthroughArgs: string[] = []

	let i = 0
	while (i < args.length) {
		const arg = args[i]
		if (arg === "--task") {
			const val = args[i + 1]
			if (val === undefined || val.startsWith("-")) {
				throw new Error("missing --task value")
			}
			taskPath = val
			i += 2
		} else if (arg === "--iterations" || arg === "--max-iterations") {
			const val = args[i + 1]
			if (val === undefined || val.startsWith("--")) {
				throw new Error(`missing ${arg} value`)
			}
			const n = Number(val)
			if (!Number.isInteger(n) || n < 1) {
				throw new Error(`${arg} must be a positive integer`)
			}
			iterations = n
			i += 2
		} else if (arg === "--timeout-seconds") {
			const val = args[i + 1]
			if (val === undefined || val.startsWith("--")) {
				throw new Error("missing --timeout-seconds value")
			}
			const n = Number(val)
			if (!Number.isFinite(n) || n <= 0) {
				throw new Error("--timeout-seconds must be a positive number")
			}
			timeoutSeconds = n
			i += 2
		} else if (arg === "--runtime") {
			const val = args[i + 1]
			if (val === undefined || val.startsWith("-")) {
				throw new Error("missing --runtime value")
			}
			runtime = val
			i += 2
		} else if (arg === "--workspace") {
			const val = args[i + 1]
			if (val === undefined || val.startsWith("-")) {
				throw new Error("missing --workspace value")
			}
			workspace = resolve(val)
			i += 2
		} else if (arg === "--image") {
			const val = args[i + 1]
			if (val === undefined || val.startsWith("-")) {
				throw new Error("missing --image value")
			}
			image = val
			i += 2
		} else {
			passthroughArgs.push(arg)
			i++
		}
	}

	return {
		taskPath,
		iterations,
		timeoutSeconds,
		runtime,
		workspace,
		image,
		passthroughArgs,
		help: false,
	}
}

/**
 * Builds the argv array to pass to pi-coding-agent's main().
 * Order: ["--yolo", "--print", "--mode", "json", "--no-session",
 *         (optional --model <model>), (spec.prompt if spec given), ...passthroughArgs]
 */
export function buildAutoArgs(spec: TaskSpec | undefined, parsed: ParsedAutoArgs): string[] {
	const result: string[] = ["--yolo", "--print", "--mode", "json", "--no-session"]
	if (spec?.model) {
		result.push("--model", spec.model)
	}
	if (spec?.prompt) {
		result.push(spec.prompt)
	}
	if (parsed.passthroughArgs.length > 0) {
		result.push(...parsed.passthroughArgs)
	}
	return result
}

/**
 * Builds the full extension factories array for an autonomous run.
 * Always includes resultWriter. Conditionally adds timeoutGuard and maxIterations.
 * Returns both the factories array and the result writer control handle.
 */
export async function buildExtensionFactories(
	options: { timeoutSeconds?: number; iterations?: number },
	baseFactoriesFn: () => Promise<ExtensionFactory[]>,
): Promise<{ factories: ExtensionFactory[]; control: ResultWriterControl }> {
	const writerHandle = createResultWriter({
		resultDir: process.env.KIMCHI_RESULT_DIR ?? `${process.cwd()}/.kimchi`,
		logPath: process.env.KIMCHI_LOG_PATH,
	})

	const base = await baseFactoriesFn()

	const autonomousExtensions = {
		resultWriter: writerHandle.extension,
		...(options.timeoutSeconds !== undefined
			? {
					timeoutGuard: timeoutGuardExtension({
						timeoutMs: options.timeoutSeconds * 1000,
						onTimeout: () => {
							writerHandle.control.markTimeout()
							process.exit(124)
						},
					}),
				}
			: {}),
		...(options.iterations !== undefined
			? {
					maxIterations: maxIterationsExtension({ maxIterations: options.iterations }),
				}
			: {}),
	}

	const factories = selectExtensionFactories(base, {
		autonomous: true,
		autonomousExtensions,
	})

	return { factories, control: writerHandle.control }
}

/**
 * Runs kimchi in autonomous mode.
 *
 * Two modes determined by `--runtime`:
 *   - In-process (no `--runtime`): spawns pi-coding-agent's main() in the current process.
 *   - Containerized (`--runtime <docker|orbstack|podman>`): spins up a container
 *     that runs `kimchi auto --task <spec>` inside, mounting the host workspace.
 *
 * Common flags: --task <spec>, --iterations N, --timeout-seconds N, passthrough for pi.
 * Container-only flags: --workspace <dir> (default cwd), --image <ref> (default "kimchi:latest").
 */
export async function runAuto(args: string[], deps?: AutoDeps): Promise<number | undefined> {
	const resolvedLoadTaskSpec = deps?.loadTaskSpec ?? defaultLoadTaskSpec

	let parsed: ParsedAutoArgs
	try {
		parsed = parseAutoArgs(args)
	} catch (err) {
		console.error((err as Error).message)
		return 1
	}

	if (parsed.help) {
		console.log(
			"Usage: kimchi auto [--task <path>] [--iterations N] [--timeout-seconds N]\n" +
				"                  [--runtime <docker|orbstack|podman> [--workspace <dir>] [--image <ref>]]\n" +
				'                  [@file.md | "prompt"] [extra pi flags...]',
		)
		return 0
	}

	let spec: TaskSpec | undefined
	if (parsed.taskPath) {
		try {
			spec = resolvedLoadTaskSpec(parsed.taskPath)
		} catch (err) {
			console.error((err as Error).message)
			return 1
		}
	}

	if (parsed.runtime !== undefined) {
		return runContainerized(parsed, spec, deps)
	}

	return runInProcess(parsed, spec, deps)
}

/**
 * In-process autonomous run: invokes pi-coding-agent's main() in this process
 * with the autonomous extension factories.
 */
async function runInProcess(
	parsed: ParsedAutoArgs,
	spec: TaskSpec | undefined,
	deps: AutoDeps | undefined,
): Promise<number | undefined> {
	const resolvedRunHarness =
		deps?.runHarness ??
		(async (harnessArgs: string[], options: { extensionFactories: ExtensionFactory[] }) => {
			const { main } = await import("@mariozechner/pi-coding-agent")
			await main(harnessArgs, options)
		})
	const resolvedBuildBaseFactories = deps?.buildBaseFactories ?? defaultBuildBaseFactories
	const resolvedPrepareEnvironment =
		deps?.prepareEnvironment ?? (() => prepareAgentEnvironment({ requireApiKey: true }).then(() => undefined))

	try {
		await resolvedPrepareEnvironment()
	} catch (err) {
		console.error((err as Error).message)
		return 1
	}

	const effectiveIterations = parsed.iterations ?? spec?.iterations
	const effectiveTimeoutSeconds = parsed.timeoutSeconds ?? spec?.timeout_seconds

	let factories: ExtensionFactory[]
	let control: ResultWriterControl
	try {
		;({ factories, control } = await buildExtensionFactories(
			{ timeoutSeconds: effectiveTimeoutSeconds, iterations: effectiveIterations },
			resolvedBuildBaseFactories,
		))
	} catch (err) {
		console.error((err as Error).message)
		return 1
	}

	const autoArgs = buildAutoArgs(spec, parsed)

	// Fallback for synchronous process.exit() calls from pi-mono that skip
	// the session_shutdown event. flushIfUnflushed is a no-op if already flushed.
	const exitFallback = () => {
		control.flushIfUnflushed("error")
	}
	process.on("exit", exitFallback)

	try {
		await resolvedRunHarness(autoArgs, { extensionFactories: factories })
	} catch (err) {
		console.error((err as Error).message)
		control.markError({ message: (err as Error).message, stack: (err as Error).stack })
		process.removeListener("exit", exitFallback)
		return 1
	}

	process.removeListener("exit", exitFallback)
	return 0
}

/**
 * Containerized autonomous run: spins up a container via the selected runtime
 * with the workspace bind-mounted, then reads back the result manifest.
 *
 * Requires --task <path> (or a positional prompt that gets synthesized into
 * a minimal in-memory spec). Mounts <workspace>:/workspace read-write.
 */
async function runContainerized(
	parsed: ParsedAutoArgs,
	spec: TaskSpec | undefined,
	deps: AutoDeps | undefined,
): Promise<number | undefined> {
	const resolvedSelectRuntime = deps?.selectRuntime ?? defaultSelectRuntime
	const resolvedReadResult = deps?.readResult ?? defaultReadResult
	const resolvedFs = deps?.fs ?? { existsSync, mkdirSync, copyFileSync }

	const workspace = parsed.workspace ?? resolve(process.cwd())
	const image = parsed.image ?? "kimchi:latest"

	if (!resolvedFs.existsSync(workspace)) {
		console.error(`workspace not found: ${workspace}`)
		return 1
	}

	if (parsed.taskPath === undefined) {
		console.error("--runtime requires --task <path>")
		return 1
	}

	if (spec === undefined) {
		// parseAutoArgs guarantees taskPath set above; spec only undefined if loadTaskSpec wasn't called
		// (defensive — runAuto loads spec before calling runContainerized when taskPath is set).
		console.error("internal error: spec not loaded")
		return 1
	}

	let runtime: ContainerRuntime
	try {
		runtime = resolvedSelectRuntime(parsed.runtime as string)
	} catch (err) {
		console.error((err as Error).message)
		return 1
	}

	const kimchiDir = join(workspace, ".kimchi")
	resolvedFs.mkdirSync(kimchiDir, { recursive: true })

	const taskDestPath = join(kimchiDir, "task.json")
	resolvedFs.copyFileSync(parsed.taskPath, taskDestPath)

	const env: Record<string, string> = {
		...spec.env,
		...(process.env.KIMCHI_API_KEY ? { KIMCHI_API_KEY: process.env.KIMCHI_API_KEY } : {}),
		KIMCHI_RESULT_DIR: "/workspace/.kimchi",
		KIMCHI_LOG_PATH: "/workspace/.kimchi/run.log",
	}

	const mounts: Array<{ host: string; container: string; readonly?: boolean }> = [
		{ host: workspace, container: "/workspace" },
		...(spec.mounts ?? []),
	]

	for (const mount of mounts) {
		if (mount.host.includes(":") || mount.host.includes(",")) {
			console.error(`invalid mount path: ${mount.host}`)
			return 1
		}
		if (mount.container.includes(":") || mount.container.includes(",")) {
			console.error(`invalid mount path: ${mount.container}`)
			return 1
		}
	}

	const effectiveTimeoutSeconds = parsed.timeoutSeconds ?? spec.timeout_seconds
	const timeoutMs = effectiveTimeoutSeconds * 1000 + 60_000

	const result = await runtime.run({
		image,
		workdir: "/workspace",
		mounts,
		env,
		command: ["auto", "--task", "/workspace/.kimchi/task.json"],
		timeoutMs,
	})

	try {
		const manifest = resolvedReadResult(kimchiDir)
		console.log(`[auto] exit_reason=${manifest.exit_reason} ended_at=${manifest.ended_at}`)
		if (manifest.error) {
			console.error(`[auto] error: ${manifest.error.message}`)
		}
	} catch (err) {
		console.error(`Warning: could not read result manifest: ${(err as Error).message}`)
		if (result.exitCode === 0) return 1
	}

	return result.exitCode
}
