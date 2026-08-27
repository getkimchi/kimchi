/**
 * Shared test harness utilities for smoke tests.
 *
 * Provides isolated temp directories and a helper to spawn the compiled
 * kimchi binary with a sandboxed HOME. The binary computes its agent
 * config dir as HOME/.config/kimchi/harness, so we expose that derived
 * path for tests that need to place settings files there.
 */

import { type SpawnSyncReturns, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { type IPty, spawn as ptySpawn } from "node-pty"
import { afterAll, beforeAll } from "vitest"

const nodeRequire = createRequire(import.meta.url)

export const BINARY_PATH = resolve("dist/bin/kimchi")
export const PACKAGE_DIR = resolve("dist/share/kimchi")

let tempHome: string | undefined

beforeAll(() => {
	tempHome = mkdtempSync(join(tmpdir(), "kimchi-smoke-home-"))
	const configDir = join(tempHome, ".config", "kimchi")
	mkdirSync(configDir, { recursive: true })
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({ skillPaths: [], migrationState: "done" }, null, 2),
		"utf-8",
	)
	// Pre-seed models.json so updateModelsConfig has a cache to fall back to when
	// the dummy KIMCHI_API_KEY gets a 401 from the live metadata endpoint. Without
	// this, interactive smoke tests would fail to boot the binary in CI.
	const agentDir = join(tempHome, ".config", "kimchi", "harness")
	mkdirSync(agentDir, { recursive: true })
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify(
			{
				providers: {
					"kimchi-dev": {
						baseUrl: "https://llm.kimchi.dev/openai/v1",
						apiKey: "$KIMCHI_API_KEY",
						api: "openai-completions",
						authHeader: true,
						models: [
							{
								id: "kimi-k2.5",
								name: "Kimi K2.5",
								reasoning: true,
								input: ["text", "image"],
								contextWindow: 262144,
								maxTokens: 262144,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							},
						],
					},
				},
			},
			null,
			"\t",
		),
		"utf-8",
	)
})

afterAll(() => {
	if (tempHome) {
		rmSync(tempHome, { recursive: true, force: true })
	}
})

function getTempHome(): string {
	if (!tempHome) {
		throw new Error("tempHome not initialized — getAgentDir/ensureAgentDir called outside of a test lifecycle")
	}
	return tempHome
}

/**
 * Returns the agent config dir that the binary will derive from tempHome.
 * Matches the logic in src/cli.ts: resolve(homedir(), ".config", "kimchi", "harness").
 */
export function getAgentDir(): string {
	return join(getTempHome(), ".config", "kimchi", "harness")
}

/**
 * Ensure the agent config dir exists and return its path.
 */
export function ensureAgentDir(): string {
	const dir = getAgentDir()
	mkdirSync(dir, { recursive: true })
	return dir
}

const DEFAULT_TIMEOUT_MS = 30_000

interface RunBinaryOptions {
	args?: string[]
	extraEnv?: Record<string, string>
	timeoutMs?: number
	/** When false, non-zero exit codes and signals don't throw. Useful for testing error paths. Defaults to true. */
	throwOnError?: boolean
}

export function runBinary(opts: RunBinaryOptions = {}): SpawnSyncReturns<string> {
	const { args = [], extraEnv = {}, timeoutMs = DEFAULT_TIMEOUT_MS, throwOnError = true } = opts
	const home = getTempHome()
	const result = spawnSync(BINARY_PATH, args, {
		encoding: "utf-8",
		timeout: timeoutMs,
		env: {
			PATH: process.env.PATH,
			HOME: home,
			PI_PACKAGE_DIR: PACKAGE_DIR,
			...extraEnv,
		},
	})
	if (throwOnError) {
		if (result.status === null) {
			const code = (result.error as NodeJS.ErrnoException | undefined)?.code
			throw new Error(
				`runBinary failed (${code ?? result.signal ?? "unknown"}): ${BINARY_PATH} ${args.join(" ")}\nstdout: ${result.stdout ?? "(empty)"}\nstderr: ${result.stderr ?? "(empty)"}`,
			)
		}
		if (result.status !== 0) {
			throw new Error(
				`runBinary exited with status ${result.status}: ${BINARY_PATH} ${args.join(" ")}\nstdout: ${result.stdout ?? "(empty)"}\nstderr: ${result.stderr ?? "(empty)"}`,
			)
		}
	}
	return result
}

// pnpm drops the executable bit on node-pty's spawn-helper. Without +x, pty.spawn fails with "posix_spawnp failed" the first time the harness tries to start a PTY-backed process. Fix it once at module load.
function ensurePtySpawnHelperExecutable(): void {
	// Derive the prebuilds dir from node-pty's own entry point so we track whatever version is installed rather than hardcoding it.
	const ptyEntry = nodeRequire.resolve("node-pty") // .../node-pty/lib/index.js
	const prebuildsDir = join(dirname(dirname(ptyEntry)), "prebuilds")
	let entries: string[]
	try {
		entries = readdirSync(prebuildsDir)
	} catch {
		return // node-pty installed without prebuilds (e.g. built from source) — nothing to chmod.
	}
	for (const platform of entries) {
		const helper = join(prebuildsDir, platform, "spawn-helper")
		try {
			const mode = statSync(helper).mode
			if ((mode & 0o111) === 0) {
				chmodSync(helper, mode | 0o755)
			}
		} catch {
			// Platform dir exists but has no spawn-helper — ignore.
		}
	}
}
ensurePtySpawnHelperExecutable()

interface RunInteractiveOptions {
	cols?: number
	rows?: number
	extraEnv?: Record<string, string>
}

export interface InteractiveSession {
	/** Escape hatch for raw node-pty operations the helpers don't cover. */
	pty: IPty
	/** Everything kimchi has printed so far, ANSI escapes intact. */
	output(): string
	/** Poll the output; resolve when `predicate(output)` is true, reject on timeout. Use for "wait for prompt", "wait for render". */
	waitFor(predicate: (out: string) => boolean, timeoutMs?: number): Promise<void>
	/** Type `data` into kimchi as if from a keyboard. */
	write(data: string): void
	/** Like `write`, but wrapped in terminal bracketed-paste markers — simulates a real paste. */
	bracketedPaste(text: string): void
	/** Send Ctrl+C twice to clear + exit, then hard-kill as a safety net. Call in `finally`. */
	kill(): Promise<number>
}

/** Spawn kimchi under a real PTY so its interactive TUI boots. Prefer `runBinary` for non-interactive checks — use this only when you need to drive the editor/prompt. */
export function spawnInteractive(opts: RunInteractiveOptions = {}): InteractiveSession {
	const { cols = 120, rows = 40, extraEnv = {} } = opts
	const home = getTempHome()
	const pty = ptySpawn(BINARY_PATH, [], {
		name: "xterm-256color",
		cols,
		rows,
		cwd: home,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: home,
			PI_PACKAGE_DIR: PACKAGE_DIR,
			TERM: "xterm-256color",
			KIMCHI_API_KEY: "smoke-test-dummy",
			...extraEnv,
		},
	})

	let buf = ""
	pty.onData((d) => {
		buf += d
	})

	return {
		pty,
		output: () => buf,
		write: (data) => pty.write(data),
		bracketedPaste: (text) => pty.write(`\x1b[200~${text}\x1b[201~`),
		waitFor: (predicate, timeoutMs = 10_000) =>
			new Promise<void>((resolvePromise, rejectPromise) => {
				if (predicate(buf)) return resolvePromise()
				const start = Date.now()
				const interval = setInterval(() => {
					if (predicate(buf)) {
						clearInterval(interval)
						resolvePromise()
					} else if (Date.now() - start > timeoutMs) {
						clearInterval(interval)
						rejectPromise(new Error(`waitFor timed out after ${timeoutMs}ms. Captured output:\n${buf.slice(-2000)}`))
					}
				}, 50)
			}),
		kill: () =>
			new Promise<number>((resolvePromise) => {
				pty.onExit(({ exitCode }) => resolvePromise(exitCode))
				pty.write("\x03") // Ctrl+C to clear the editor
				pty.write("\x03") // Ctrl+C again to exit
				setTimeout(() => pty.kill(), 500)
			}),
	}
}
