import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readResult, writeResult } from "./result.js"
import type { ResultManifest } from "./result.js"

describe("writeResult / readResult", () => {
	const createdDirs: string[] = []

	function tmpDir(): string {
		const dir = join(tmpdir(), `result-test-${randomUUID()}`)
		createdDirs.push(dir)
		return dir
	}

	afterEach(() => {
		for (const d of createdDirs) {
			try {
				rmSync(d, { recursive: true, force: true })
			} catch {
				// ignore
			}
		}
		createdDirs.length = 0
	})

	const minimalManifest: ResultManifest = {
		exit_reason: "done",
		started_at: "2026-05-06T10:00:00.000Z",
		ended_at: "2026-05-06T10:01:00.000Z",
	}

	const fullManifest: ResultManifest = {
		exit_reason: "error",
		started_at: "2026-05-06T11:00:00.000Z",
		ended_at: "2026-05-06T11:05:00.000Z",
		last_message: "Something went wrong",
		log_path: "/workspace/.kimchi/run.log",
		diff_path: "/workspace/.kimchi/changes.diff",
		error: {
			message: "Command failed with exit code 1",
			stack: "Error: Command failed\n    at run (auto.ts:42:5)",
		},
	}

	it("round-trips a minimal manifest with only required fields", () => {
		const dir = tmpDir()
		mkdirSync(dir, { recursive: true })
		writeResult(dir, minimalManifest)
		const result = readResult(dir)
		expect(result).toEqual(minimalManifest)
	})

	it("round-trips a fully-populated manifest including all optional fields", () => {
		const dir = tmpDir()
		mkdirSync(dir, { recursive: true })
		writeResult(dir, fullManifest)
		const result = readResult(dir)
		expect(result).toEqual(fullManifest)
	})

	it("creates the directory if it does not exist (recursive mkdir)", () => {
		const dir = join(tmpDir(), "nested", "sub", "dir")
		expect(existsSync(dir)).toBe(false)
		writeResult(dir, minimalManifest)
		expect(existsSync(dir)).toBe(true)
		const result = readResult(dir)
		expect(result).toEqual(minimalManifest)
	})

	it("result.json exists and result.json.tmp does NOT exist after a successful write", () => {
		const dir = tmpDir()
		mkdirSync(dir, { recursive: true })
		writeResult(dir, minimalManifest)
		expect(existsSync(join(dir, "result.json"))).toBe(true)
		expect(existsSync(join(dir, "result.json.tmp"))).toBe(false)
	})

	it("overwrites a stale result.json.tmp without throwing (atomic write is idempotent)", () => {
		const dir = tmpDir()
		mkdirSync(dir, { recursive: true })
		// Simulate a stale tmp file left by a previous failed write
		writeFileSync(join(dir, "result.json.tmp"), '{"stale": true}', "utf-8")
		expect(() => writeResult(dir, minimalManifest)).not.toThrow()
		expect(existsSync(join(dir, "result.json.tmp"))).toBe(false)
		const result = readResult(dir)
		expect(result).toEqual(minimalManifest)
	})

	it("writeResult throws when exit_reason is invalid (e.g. 'weird')", () => {
		const dir = tmpDir()
		mkdirSync(dir, { recursive: true })
		const bad = { ...minimalManifest, exit_reason: "weird" } as unknown as ResultManifest
		expect(() => writeResult(dir, bad)).toThrow(/exit_reason/)
	})

	it("readResult throws when result.json does not exist and message mentions the path", () => {
		const dir = tmpDir()
		mkdirSync(dir, { recursive: true })
		const expectedPath = join(dir, "result.json")
		let error: Error | null = null
		try {
			readResult(dir)
		} catch (err) {
			error = err as Error
		}
		if (!error) throw new Error("expected error to be thrown")
		expect(error.message).toContain(expectedPath)
	})

	it("readResult throws when JSON is malformed and message mentions 'parse' or 'JSON'", () => {
		const dir = tmpDir()
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "result.json"), "{ not valid json }", "utf-8")
		let error: Error | null = null
		try {
			readResult(dir)
		} catch (err) {
			error = err as Error
		}
		if (!error) throw new Error("expected error to be thrown")
		expect(error.message).toMatch(/parse|JSON/i)
	})

	it("readResult throws when schema is invalid (exit_reason: 'invalid') with field path in message", () => {
		const dir = tmpDir()
		mkdirSync(dir, { recursive: true })
		writeFileSync(
			join(dir, "result.json"),
			JSON.stringify({ exit_reason: "invalid", started_at: "2026-05-06T10:00:00Z", ended_at: "2026-05-06T10:01:00Z" }),
			"utf-8",
		)
		let error: Error | null = null
		try {
			readResult(dir)
		} catch (err) {
			error = err as Error
		}
		if (!error) throw new Error("expected error to be thrown")
		expect(error.message).toMatch(/exit_reason/)
	})

	it("written JSON is human-readable (pretty-printed with 2-space indent)", () => {
		const dir = tmpDir()
		mkdirSync(dir, { recursive: true })
		writeResult(dir, minimalManifest)
		const raw = readFileSync(join(dir, "result.json"), "utf-8")
		// Pretty-printed JSON starts with "{\n  " (object open + newline + 2-space indent)
		expect(raw).toMatch(/^\{\n {2}/)
	})
})
