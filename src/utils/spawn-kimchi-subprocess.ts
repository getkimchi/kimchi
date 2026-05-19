// Spawn a kimchi subprocess for one-shot agent work. Handles dev (tsx) vs bun-binary vs node-binary invocation.
// Currently the only consumer is curator review (src/extensions/curator/review.ts), but the deleted subagent.ts also had this logic — keep it shared so future consumers don't re-duplicate.

import { type ChildProcess, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { isBunBinary, isRunningUnderBun } from "../env.js"

function readablePath(path: string): boolean {
	try {
		readFileSync(path)
		return true
	} catch {
		return false
	}
}

function resolveTsx(): string | undefined {
	let dir = dirname(process.argv[1])
	while (true) {
		const candidate = resolve(dir, "node_modules/.bin/tsx")
		if (readablePath(candidate)) return candidate
		if (readablePath(resolve(dir, "package.json"))) break
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return undefined
}

export function getAgentInvocation(args: string[]): { command: string; args: string[] } {
	if (isBunBinary) return { command: process.execPath, args }
	if (isRunningUnderBun) return { command: process.execPath, args: [process.argv[1], ...args] }
	if (process.argv[1].endsWith(".ts")) {
		const tsx = resolveTsx()
		if (tsx) return { command: tsx, args: [process.argv[1], ...args] }
		throw new Error("Dev mode requires tsx to spawn kimchi subprocesses, but node_modules/.bin/tsx was not found.")
	}
	return { command: process.execPath, args: [process.argv[1], ...args] }
}

export interface SpawnKimchiOptions {
	args: string[]
	env?: NodeJS.ProcessEnv
	detached?: boolean
	stdout?: "pipe" | "ignore" | number
	stderr?: "pipe" | "ignore" | number
}

export function spawnKimchiSubprocess(opts: SpawnKimchiOptions): ChildProcess {
	const invocation = getAgentInvocation(opts.args)
	return spawn(invocation.command, invocation.args, {
		stdio: ["ignore", opts.stdout ?? "pipe", opts.stderr ?? "pipe"],
		detached: opts.detached ?? false,
		env: { ...process.env, ...opts.env },
	})
}
