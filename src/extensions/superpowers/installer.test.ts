import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Must mock config before importing installer so getSuperpowersVendorDir() resolves to mockHome
vi.mock("./config.js", async (importOriginal) => {
	const mod = await importOriginal<typeof import("./config.js")>()
	return {
		...mod,
		getSuperpowersVendorDir: () => join(process.env.HOME ?? "", ".config", "kimchi", "vendor", "superpowers"),
	}
})

import { ensureSuperpowersInstalled } from "./installer.js"

let mockHome: string
let originalHome: string | undefined

beforeEach(() => {
	originalHome = process.env.HOME
	mockHome = mkdtempSync(join(tmpdir(), "sp-test-"))
	process.env.HOME = mockHome
})

afterEach(() => {
	process.env.HOME = originalHome
	rmSync(mockHome, { recursive: true, force: true })
	vi.restoreAllMocks()
})

describe("ensureSuperpowersInstalled", () => {
	it("downloads and extracts when vendor dir is missing, returns true", async () => {
		const tarball = new Uint8Array(8)
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(ctrl) {
						ctrl.enqueue(tarball)
						ctrl.close()
					},
				}),
			}),
		)

		vi.mock("tar", () => ({
			extract: vi.fn().mockResolvedValue(undefined),
		}))

		const result = await ensureSuperpowersInstalled()
		expect(result).toBe(true)
	})

	it("returns false when already installed at correct version", async () => {
		const vendorDir = join(mockHome, ".config", "kimchi", "vendor", "superpowers")
		const skillsDir = join(vendorDir, "skills")
		mkdirSync(skillsDir, { recursive: true })
		writeFileSync(join(vendorDir, ".version"), "v5.1.0")

		const result = await ensureSuperpowersInstalled()
		expect(result).toBe(false)
	})

	it("re-downloads when .version exists but has stale tag", async () => {
		const vendorDir = join(mockHome, ".config", "kimchi", "vendor", "superpowers")
		const skillsDir = join(vendorDir, "skills")
		mkdirSync(skillsDir, { recursive: true })
		writeFileSync(join(vendorDir, ".version"), "v4.0.0") // stale

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(ctrl) {
						ctrl.close()
					},
				}),
			}),
		)
		vi.mock("tar", () => ({ extract: vi.fn().mockResolvedValue(undefined) }))

		const result = await ensureSuperpowersInstalled()
		expect(result).toBe(true)
	})

	it("throws when fetch returns non-ok", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }))
		await expect(ensureSuperpowersInstalled()).rejects.toThrow("404")
	})
})
