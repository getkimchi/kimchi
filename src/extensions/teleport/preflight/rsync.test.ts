import { describe, expect, it } from "vitest"
import { type RsyncPreflightOptions, rsyncInstallHint, whichRsync } from "./rsync.js"

type MockExec = NonNullable<RsyncPreflightOptions["execFile"]>

function mockExec(fn: () => void): MockExec {
	return (() => {
		fn()
		return Buffer.from("")
	}) as unknown as MockExec
}

describe("whichRsync", () => {
	it("returns true when `which` exits 0", () => {
		const exec = mockExec(() => undefined)
		expect(whichRsync({ execFile: exec })).toBe(true)
	})

	it("returns false when `which` throws", () => {
		const exec = mockExec(() => {
			throw new Error("not found")
		})
		expect(whichRsync({ execFile: exec })).toBe(false)
	})
})

describe("rsyncInstallHint", () => {
	it("returns brew hint on darwin", () => {
		expect(rsyncInstallHint({ platform: "darwin" })).toContain("brew install rsync")
	})

	it("returns apt hint on linux", () => {
		expect(rsyncInstallHint({ platform: "linux" })).toContain("apt install rsync")
	})

	it("falls back to a generic hint on other platforms", () => {
		expect(rsyncInstallHint({ platform: "win32" })).toContain("PATH")
	})
})
