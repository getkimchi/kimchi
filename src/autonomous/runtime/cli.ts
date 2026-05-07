import { spawn as nodeSpawn } from "node:child_process"
import type { ContainerRuntime, RunOpts, RunResult, SpawnFn } from "./types.js"

export type CliRuntimeBinary = "docker" | "orbstack" | "podman"

export function buildCliArgs(binary: CliRuntimeBinary, opts: RunOpts): string[] {
	const args: string[] = ["run", "--rm"]

	if (opts.name) {
		args.push("--name", opts.name)
	}

	if (opts.workdir) {
		args.push("-w", opts.workdir)
	}

	for (const mount of opts.mounts ?? []) {
		if (mount.host.includes(":") || mount.host.includes(",")) {
			throw new Error(`invalid mount path: ${mount.host}`)
		}
		if (mount.container.includes(":") || mount.container.includes(",")) {
			throw new Error(`invalid mount path: ${mount.container}`)
		}
		const mountStr = mount.readonly ? `${mount.host}:${mount.container}:ro` : `${mount.host}:${mount.container}`
		args.push("-v", mountStr)
	}

	for (const [key, val] of Object.entries(opts.env ?? {})) {
		args.push("-e", `${key}=${val}`)
	}

	args.push(opts.image)
	args.push(...opts.command)

	return args
}

function resolveSpawnBinary(binary: CliRuntimeBinary): string {
	// orbstack is a docker drop-in on macOS — it uses the same `docker` CLI binary
	if (binary === "orbstack") return "docker"
	return binary
}

export function defaultSpawn(): SpawnFn {
	return (spawnBinary, args, opts) => {
		return new Promise((resolve, reject) => {
			const child = nodeSpawn(spawnBinary, args, {
				stdio: ["ignore", "pipe", "pipe"],
				signal: opts.signal,
			})

			child.stdout?.on("data", (chunk: Buffer) => {
				opts.onStdout?.(chunk.toString())
			})

			child.stderr?.on("data", (chunk: Buffer) => {
				opts.onStderr?.(chunk.toString())
			})

			let settled = false
			child.once("error", (err) => {
				if (!settled) {
					settled = true
					reject(err)
				}
			})
			child.once("close", (code) => {
				if (!settled) {
					settled = true
					resolve({ exitCode: code ?? 1 })
				}
			})
		})
	}
}

export interface CliRuntimeOptions {
	binary: CliRuntimeBinary
	spawn?: SpawnFn
}

export function createCliRuntime(options: CliRuntimeOptions): ContainerRuntime {
	const { binary } = options
	const spawnFn = options.spawn ?? defaultSpawn()
	const spawnBinary = resolveSpawnBinary(binary)

	return {
		name: binary,

		async run(opts: RunOpts): Promise<RunResult> {
			const args = buildCliArgs(binary, opts)
			const start = Date.now()

			let controller: AbortController | undefined
			let timeoutId: ReturnType<typeof setTimeout> | undefined

			if (opts.timeoutMs != null && opts.timeoutMs > 0) {
				const ctrl = new AbortController()
				controller = ctrl
				timeoutId = setTimeout(() => {
					ctrl.abort()
				}, opts.timeoutMs)
			}

			try {
				const result = await spawnFn(spawnBinary, args, {
					signal: controller?.signal,
				})
				return { exitCode: result.exitCode, durationMs: Date.now() - start }
			} finally {
				if (timeoutId != null) {
					clearTimeout(timeoutId)
				}
			}
		},
	}
}
