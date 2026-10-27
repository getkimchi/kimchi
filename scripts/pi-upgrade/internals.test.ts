import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { HOOKED_METHODS } from "./hooks.ts"
import { compareInternals, extractMember } from "./internals.ts"

const SOURCE = `export class AgentSession {
    constructor() {
        this._retryAttempt = 0;
        this._emit = (event) => { this.listeners.forEach((l) => l(event)); };
    }
    async _prepareRetry(error) {
        if (error.message === "}") {
            return { text: "{ not a block }" };
        }
        return null;
    }
    _isRetryableError(err) { return /overloaded/.test(err.message); }
}
`

describe("extractMember", () => {
	it("returns a method body through its matching brace, ignoring braces in strings and regexes", () => {
		expect(extractMember(SOURCE, "_prepareRetry")).toBe(`async _prepareRetry(error) {
        if (error.message === "}") {
            return { text: "{ not a block }" };
        }
        return null;
    }`)
	})

	it("returns a one-line method", () => {
		expect(extractMember(SOURCE, "_isRetryableError")).toBe(
			"_isRetryableError(err) { return /overloaded/.test(err.message); }",
		)
	})

	it("returns the assignment for a field initialised in the constructor", () => {
		expect(extractMember(SOURCE, "_retryAttempt")).toBe("this._retryAttempt = 0;")
	})

	it("returns null when the member is absent", () => {
		expect(extractMember(SOURCE, "_checkCompaction")).toBeNull()
	})
})

describe("compareInternals", () => {
	it("classifies hooked members and overwritten files as identical, changed or missing", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-upgrade-internals-"))
		onTestFinished(() => rmSync(root, { recursive: true, force: true }))
		const write = (side: string, file: string, text: string) => {
			mkdirSync(join(root, side, "dist"), { recursive: true })
			writeFileSync(join(root, side, file), text)
		}
		write("base", "dist/s.js", SOURCE)
		write(
			"target",
			"dist/s.js",
			SOURCE.replace("overloaded", "overloaded|rate_limit").replace("_prepareRetry", "_prepRetry"),
		)
		write("base", "dist/page.js", "same")
		write("target", "dist/page.js", "same")

		const result = compareInternals({
			methods: [
				{ pkg: "pi-coding-agent", distFile: "dist/s.js", name: "_retryAttempt", hookedBy: "src/a.ts" },
				{ pkg: "pi-coding-agent", distFile: "dist/s.js", name: "_isRetryableError", hookedBy: "src/a.ts" },
				{ pkg: "pi-coding-agent", distFile: "dist/s.js", name: "_prepareRetry", hookedBy: "src/a.ts" },
			],
			overwrites: [{ pkg: "pi-ai", distFile: "dist/page.js", by: "scripts/o.js" }],
			baseDir: () => join(root, "base"),
			targetDir: () => join(root, "target"),
		})

		expect(result.methods.map((m) => [m.name, m.status])).toEqual([
			["_retryAttempt", "identical"],
			["_isRetryableError", "changed"],
			["_prepareRetry", "missing"],
		])
		expect(result.overwrites.map((o) => o.status)).toEqual(["identical"])
	})
})

describe("HOOKED_METHODS manifest", () => {
	it("names only members that their hookedBy file still references", () => {
		for (const m of HOOKED_METHODS) {
			expect(readFileSync(m.hookedBy, "utf8"), `${m.name} in ${m.hookedBy}`).toContain(m.name)
		}
	})
})
