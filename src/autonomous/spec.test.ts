import { randomUUID } from "node:crypto"
import { rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { loadTaskSpec } from "./spec.js"

describe("loadTaskSpec", () => {
	const writtenPaths: string[] = []

	function writeTmp(content: string): string {
		const filePath = join(tmpdir(), `spec-test-${randomUUID()}.json`)
		writeFileSync(filePath, content, "utf-8")
		writtenPaths.push(filePath)
		return filePath
	}

	afterEach(() => {
		for (const p of writtenPaths) {
			try {
				rmSync(p)
			} catch {
				// ignore if already removed
			}
		}
		writtenPaths.length = 0
	})

	it("loads a minimal valid spec with only prompt and defaults timeout_seconds to 3600", () => {
		const filePath = writeTmp(JSON.stringify({ prompt: "do the thing" }))
		const spec = loadTaskSpec(filePath)
		expect(spec.prompt).toBe("do the thing")
		expect(spec.timeout_seconds).toBe(3600)
		expect(spec.model).toBeUndefined()
		expect(spec.env).toBeUndefined()
		expect(spec.mounts).toBeUndefined()
		expect(spec.success_criteria).toBeUndefined()
	})

	it("loads a fully-populated valid spec with all fields set", () => {
		const filePath = writeTmp(
			JSON.stringify({
				prompt: "refactor the codebase",
				model: "claude-opus-4-5",
				timeout_seconds: 7200,
				env: { NODE_ENV: "test", DEBUG: "true" },
				mounts: [
					{ host: "/host/repo", container: "/workspace", readonly: false },
					{ host: "/host/data", container: "/data", readonly: true },
				],
				success_criteria: "All tests pass and no lint errors",
			}),
		)
		const spec = loadTaskSpec(filePath)
		expect(spec.prompt).toBe("refactor the codebase")
		expect(spec.model).toBe("claude-opus-4-5")
		expect(spec.timeout_seconds).toBe(7200)
		expect(spec.env).toEqual({ NODE_ENV: "test", DEBUG: "true" })
		expect(spec.mounts).toHaveLength(2)
		if (!spec.mounts) throw new Error("expected spec.mounts to be defined")
		expect(spec.mounts[0]).toEqual({ host: "/host/repo", container: "/workspace", readonly: false })
		expect(spec.mounts[1]).toEqual({ host: "/host/data", container: "/data", readonly: true })
		expect(spec.success_criteria).toBe("All tests pass and no lint errors")
	})

	it("throws when prompt is missing", () => {
		const filePath = writeTmp(JSON.stringify({ model: "gpt-4" }))
		expect(() => loadTaskSpec(filePath)).toThrow(/prompt/)
	})

	it("throws when prompt is empty string", () => {
		const filePath = writeTmp(JSON.stringify({ prompt: "" }))
		expect(() => loadTaskSpec(filePath)).toThrow(/prompt/)
	})

	it("throws when timeout_seconds exceeds 21600 (hard cap)", () => {
		const filePath = writeTmp(JSON.stringify({ prompt: "task", timeout_seconds: 21601 }))
		expect(() => loadTaskSpec(filePath)).toThrow(/timeout_seconds/)
	})

	it("throws when timeout_seconds is 0", () => {
		const filePath = writeTmp(JSON.stringify({ prompt: "task", timeout_seconds: 0 }))
		expect(() => loadTaskSpec(filePath)).toThrow(/timeout_seconds/)
	})

	it("throws when timeout_seconds is negative", () => {
		const filePath = writeTmp(JSON.stringify({ prompt: "task", timeout_seconds: -1 }))
		expect(() => loadTaskSpec(filePath)).toThrow(/timeout_seconds/)
	})

	it("throws when JSON is malformed", () => {
		const filePath = writeTmp("{ prompt: definitely not valid json }")
		expect(() => loadTaskSpec(filePath)).toThrow()
	})

	it("throws when file does not exist", () => {
		const nonExistentPath = join(tmpdir(), `spec-test-${randomUUID()}.json`)
		expect(() => loadTaskSpec(nonExistentPath)).toThrow()
	})

	it("throws when mounts[0].host is missing", () => {
		const filePath = writeTmp(
			JSON.stringify({
				prompt: "task",
				mounts: [{ container: "/workspace" }],
			}),
		)
		expect(() => loadTaskSpec(filePath)).toThrow(/mounts\[0\]\.host/)
	})

	it("throws when mounts[0].host is a non-string", () => {
		const filePath = writeTmp(
			JSON.stringify({
				prompt: "task",
				mounts: [{ host: 42, container: "/workspace" }],
			}),
		)
		expect(() => loadTaskSpec(filePath)).toThrow(/mounts\[0\]\.host/)
	})

	it("throws when env value is non-string", () => {
		const filePath = writeTmp(
			JSON.stringify({
				prompt: "task",
				env: { KEY: 123 },
			}),
		)
		expect(() => loadTaskSpec(filePath)).toThrow(/env/)
	})

	it("includes the field path in the error message for a missing nested field", () => {
		const filePath = writeTmp(
			JSON.stringify({
				prompt: "task",
				mounts: [{ host: "/host", container: "/workspace" }, { container: "/data" }],
			}),
		)
		let error: Error | null = null
		try {
			loadTaskSpec(filePath)
		} catch (err) {
			error = err as Error
		}
		if (!error) throw new Error("expected error to be thrown")
		expect(error.message).toMatch(/mounts\[1\]\.host/)
	})

	it("throws when mount host path is relative (does not start with /)", () => {
		const filePath = writeTmp(
			JSON.stringify({
				prompt: "task",
				mounts: [{ host: "relative/path", container: "/workspace" }],
			}),
		)
		expect(() => loadTaskSpec(filePath)).toThrow()
	})

	it("throws when mount host path contains '..' segment", () => {
		const filePath = writeTmp(
			JSON.stringify({
				prompt: "task",
				mounts: [{ host: "/host/../etc", container: "/workspace" }],
			}),
		)
		expect(() => loadTaskSpec(filePath)).toThrow()
	})

	it("throws when mount container path contains '..' segment", () => {
		const filePath = writeTmp(
			JSON.stringify({
				prompt: "task",
				mounts: [{ host: "/host/path", container: "/workspace/../etc" }],
			}),
		)
		expect(() => loadTaskSpec(filePath)).toThrow()
	})

	it("accepts mount with absolute paths and no '..' segments", () => {
		const filePath = writeTmp(
			JSON.stringify({
				prompt: "task",
				mounts: [{ host: "/host/repo", container: "/workspace" }],
			}),
		)
		const spec = loadTaskSpec(filePath)
		expect(spec.mounts).toHaveLength(1)
		if (!spec.mounts) throw new Error("expected mounts to be defined")
		expect(spec.mounts[0].host).toBe("/host/repo")
		expect(spec.mounts[0].container).toBe("/workspace")
	})

	it("accepts iterations field with a valid positive integer", () => {
		const filePath = writeTmp(JSON.stringify({ prompt: "task", iterations: 5 }))
		const spec = loadTaskSpec(filePath)
		expect(spec.iterations).toBe(5)
	})

	it("iterations is undefined when not provided", () => {
		const filePath = writeTmp(JSON.stringify({ prompt: "task" }))
		const spec = loadTaskSpec(filePath)
		expect(spec.iterations).toBeUndefined()
	})

	it("accepts iterations: 1 (minimum valid)", () => {
		const filePath = writeTmp(JSON.stringify({ prompt: "task", iterations: 1 }))
		const spec = loadTaskSpec(filePath)
		expect(spec.iterations).toBe(1)
	})

	it("accepts iterations: 1000 (maximum valid)", () => {
		const filePath = writeTmp(JSON.stringify({ prompt: "task", iterations: 1000 }))
		const spec = loadTaskSpec(filePath)
		expect(spec.iterations).toBe(1000)
	})

	it("throws when iterations is 0", () => {
		const filePath = writeTmp(JSON.stringify({ prompt: "task", iterations: 0 }))
		expect(() => loadTaskSpec(filePath)).toThrow(/iterations/)
	})

	it("throws when iterations is negative", () => {
		const filePath = writeTmp(JSON.stringify({ prompt: "task", iterations: -1 }))
		expect(() => loadTaskSpec(filePath)).toThrow(/iterations/)
	})

	it("throws when iterations is a non-integer (1.5)", () => {
		const filePath = writeTmp(JSON.stringify({ prompt: "task", iterations: 1.5 }))
		expect(() => loadTaskSpec(filePath)).toThrow(/iterations/)
	})

	it("throws when iterations exceeds 1000", () => {
		const filePath = writeTmp(JSON.stringify({ prompt: "task", iterations: 1001 }))
		expect(() => loadTaskSpec(filePath)).toThrow(/iterations/)
	})
})
