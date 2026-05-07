import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { buildCliArgs, createCliRuntime } from "./cli.js"
import type { RunOpts, SpawnFn } from "./types.js"

function makeStubSpawn(exitCode = 0, resolveAfterMs?: number): SpawnFn {
	return vi.fn((_binary, _args, _opts) => {
		return new Promise<{ exitCode: number }>((resolve) => {
			if (resolveAfterMs != null) {
				setTimeout(() => resolve({ exitCode }), resolveAfterMs)
			} else {
				resolve({ exitCode })
			}
		})
	}) as SpawnFn
}

describe("buildCliArgs", () => {
	it("produces minimal args for image + command only", () => {
		const args = buildCliArgs("docker", { image: "kimchi", command: ["auto"] })
		expect(args).toEqual(["run", "--rm", "kimchi", "auto"])
	})

	it("includes --name when opts.name is set", () => {
		const args = buildCliArgs("docker", { image: "kimchi", command: ["auto"], name: "my-container" })
		expect(args).toContain("--name")
		expect(args).toContain("my-container")
		const nameIdx = args.indexOf("--name")
		expect(args[nameIdx + 1]).toBe("my-container")
	})

	it("includes -w when opts.workdir is set", () => {
		const args = buildCliArgs("docker", { image: "kimchi", command: ["auto"], workdir: "/workspace" })
		expect(args).toContain("-w")
		const wIdx = args.indexOf("-w")
		expect(args[wIdx + 1]).toBe("/workspace")
	})

	it("places --name and -w before mounts and env (correct order)", () => {
		const opts: RunOpts = {
			image: "kimchi",
			command: ["auto"],
			name: "c1",
			workdir: "/workspace",
			mounts: [{ host: "/host", container: "/cont" }],
			env: { FOO: "bar" },
		}
		const args = buildCliArgs("docker", opts)
		const nameIdx = args.indexOf("--name")
		const wIdx = args.indexOf("-w")
		const vIdx = args.indexOf("-v")
		const eIdx = args.indexOf("-e")
		const imageIdx = args.indexOf("kimchi")
		expect(nameIdx).toBeLessThan(vIdx)
		expect(wIdx).toBeLessThan(vIdx)
		expect(vIdx).toBeLessThan(eIdx)
		expect(eIdx).toBeLessThan(imageIdx)
		expect(imageIdx).toBeLessThan(args.indexOf("auto"))
	})

	it("includes -v with correct mount string (no readonly flag)", () => {
		const args = buildCliArgs("docker", {
			image: "kimchi",
			command: ["auto"],
			mounts: [{ host: "/host/path", container: "/container/path" }],
		})
		const vIdx = args.indexOf("-v")
		expect(vIdx).toBeGreaterThan(-1)
		expect(args[vIdx + 1]).toBe("/host/path:/container/path")
	})

	it("appends :ro to readonly mounts", () => {
		const args = buildCliArgs("docker", {
			image: "kimchi",
			command: ["auto"],
			mounts: [{ host: "/host/path", container: "/container/path", readonly: true }],
		})
		const vIdx = args.indexOf("-v")
		expect(args[vIdx + 1]).toBe("/host/path:/container/path:ro")
	})

	it("preserves insertion order for multiple mounts", () => {
		const args = buildCliArgs("docker", {
			image: "kimchi",
			command: ["auto"],
			mounts: [
				{ host: "/host/a", container: "/cont/a" },
				{ host: "/host/b", container: "/cont/b" },
			],
		})
		const vIndices = args.map((v, i) => (v === "-v" ? i : -1)).filter((i) => i !== -1)
		expect(vIndices).toHaveLength(2)
		expect(args[vIndices[0] + 1]).toBe("/host/a:/cont/a")
		expect(args[vIndices[1] + 1]).toBe("/host/b:/cont/b")
	})

	it("includes -e KEY=VAL for each env entry", () => {
		const args = buildCliArgs("docker", {
			image: "kimchi",
			command: ["auto"],
			env: { FOO: "bar", BAZ: "qux" },
		})
		const eIndices = args.map((v, i) => (v === "-e" ? i : -1)).filter((i) => i !== -1)
		expect(eIndices).toHaveLength(2)
		const envPairs = eIndices.map((i) => args[i + 1])
		expect(envPairs).toContain("FOO=bar")
		expect(envPairs).toContain("BAZ=qux")
	})

	it("preserves insertion order for multiple env entries", () => {
		const args = buildCliArgs("docker", {
			image: "kimchi",
			command: ["auto"],
			env: { FIRST: "1", SECOND: "2" },
		})
		const eIndices = args.map((v, i) => (v === "-e" ? i : -1)).filter((i) => i !== -1)
		expect(eIndices).toHaveLength(2)
		expect(args[eIndices[0] + 1]).toBe("FIRST=1")
		expect(args[eIndices[1] + 1]).toBe("SECOND=2")
	})

	it("appends all command fragments after the image", () => {
		const args = buildCliArgs("docker", {
			image: "kimchi",
			command: ["auto", "--task", "/workspace/task.json"],
		})
		const imageIdx = args.indexOf("kimchi")
		expect(args.slice(imageIdx + 1)).toEqual(["auto", "--task", "/workspace/task.json"])
	})

	it("works identically for orbstack binary (same argv shape)", () => {
		const args = buildCliArgs("orbstack", { image: "kimchi", command: ["auto"] })
		expect(args).toEqual(["run", "--rm", "kimchi", "auto"])
	})

	it("works identically for podman binary (same argv shape)", () => {
		const args = buildCliArgs("podman", { image: "kimchi", command: ["auto"] })
		expect(args).toEqual(["run", "--rm", "kimchi", "auto"])
	})

	it("throws when a mount.host contains ':'", () => {
		expect(() =>
			buildCliArgs("docker", {
				image: "kimchi",
				command: ["auto"],
				mounts: [{ host: "/bad:path", container: "/cont" }],
			}),
		).toThrow(/invalid mount path/)
	})

	it("throws when a mount.container contains ','", () => {
		expect(() =>
			buildCliArgs("docker", {
				image: "kimchi",
				command: ["auto"],
				mounts: [{ host: "/host", container: "/bad,path" }],
			}),
		).toThrow(/invalid mount path/)
	})
})

describe("createCliRuntime", () => {
	it("returns a runtime with name matching the binary option", () => {
		const rt = createCliRuntime({ binary: "docker", spawn: makeStubSpawn() })
		expect(rt.name).toBe("docker")
	})

	it("returns name 'orbstack' for orbstack binary", () => {
		const rt = createCliRuntime({ binary: "orbstack", spawn: makeStubSpawn() })
		expect(rt.name).toBe("orbstack")
	})

	it("returns name 'podman' for podman binary", () => {
		const rt = createCliRuntime({ binary: "podman", spawn: makeStubSpawn() })
		expect(rt.name).toBe("podman")
	})

	it("invokes spawn with binary string 'docker' when runtime is orbstack (drop-in)", async () => {
		const stub = makeStubSpawn(0)
		const rt = createCliRuntime({ binary: "orbstack", spawn: stub })
		await rt.run({ image: "kimchi", command: ["auto"] })
		expect(stub).toHaveBeenCalledWith("docker", expect.any(Array), expect.any(Object))
	})

	it("invokes spawn with binary string 'podman' for podman runtime", async () => {
		const stub = makeStubSpawn(0)
		const rt = createCliRuntime({ binary: "podman", spawn: stub })
		await rt.run({ image: "kimchi", command: ["auto"] })
		expect(stub).toHaveBeenCalledWith("podman", expect.any(Array), expect.any(Object))
	})

	it("invokes spawn with binary string 'docker' for docker runtime", async () => {
		const stub = makeStubSpawn(0)
		const rt = createCliRuntime({ binary: "docker", spawn: stub })
		await rt.run({ image: "kimchi", command: ["auto"] })
		expect(stub).toHaveBeenCalledWith("docker", expect.any(Array), expect.any(Object))
	})

	it("run() returns RunResult with exitCode 0 and non-negative durationMs from stub", async () => {
		const stub = makeStubSpawn(0)
		const rt = createCliRuntime({ binary: "docker", spawn: stub })
		const result = await rt.run({ image: "kimchi", command: ["auto"] })
		expect(result.exitCode).toBe(0)
		expect(result.durationMs).toBeGreaterThanOrEqual(0)
	})

	it("run() propagates non-zero exit code from stub spawn", async () => {
		const stub = makeStubSpawn(42)
		const rt = createCliRuntime({ binary: "docker", spawn: stub })
		const result = await rt.run({ image: "kimchi", command: ["auto"] })
		expect(result.exitCode).toBe(42)
	})

	it("run() passes the correct argv to spawn", async () => {
		const stub = makeStubSpawn(0)
		const rt = createCliRuntime({ binary: "docker", spawn: stub })
		await rt.run({
			image: "kimchi",
			command: ["auto", "--task", "/task.json"],
			name: "test-container",
			workdir: "/workspace",
		})
		const [, args] = (stub as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(args).toContain("--name")
		expect(args).toContain("test-container")
		expect(args).toContain("-w")
		expect(args).toContain("/workspace")
		expect(args).toContain("kimchi")
		expect(args).toContain("auto")
	})

	it("run() aborts via AbortSignal when timeoutMs is short and stub never resolves in time", async () => {
		let capturedSignal: AbortSignal | undefined

		const neverResolveSpawn: SpawnFn = vi.fn((_binary, _args, opts) => {
			capturedSignal = opts.signal
			// Never resolves on its own — we rely on the AbortSignal
			return new Promise<{ exitCode: number }>((_resolve, reject) => {
				opts.signal?.addEventListener("abort", () => {
					reject(new Error("aborted"))
				})
			})
		}) as SpawnFn

		const rt = createCliRuntime({ binary: "docker", spawn: neverResolveSpawn })

		await expect(rt.run({ image: "kimchi", command: ["auto"], timeoutMs: 50 })).rejects.toThrow()

		// The signal should have been aborted after the timeout fired
		expect(capturedSignal?.aborted).toBe(true)
	})
})
