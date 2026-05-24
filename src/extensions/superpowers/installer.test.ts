import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Track tarball paths written via createWriteStream (module-level, populated by mock)
const cwsPaths: string[] = []

// Must mock node:fs before importing installer so createWriteStream is tracked.
// Use importOriginal so all other fs exports (mkdirSync, mkdtempSync, etc.) stay real.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	return {
		...actual,
		createWriteStream: vi.fn((path: string | Buffer | URL) => {
			cwsPaths.push(String(path))
			// Delegate to real createWriteStream so other tests aren't broken
			return actual.createWriteStream("/dev/null")
		}),
	}
})

// Must mock config before importing installer so getSuperpowersVendorDir() resolves to mockHome
vi.mock("./config.js", async (importOriginal) => {
	const mod = await importOriginal<typeof import("./config.js")>()
	return {
		...mod,
		getSuperpowersVendorDir: () => join(process.env.HOME ?? "", ".config", "kimchi", "vendor", "superpowers"),
	}
})

vi.mock("tar", () => ({
	extract: vi.fn().mockResolvedValue(undefined),
}))

import { ensureSuperpowersInstalled } from "./installer.js"

let mockHome: string
let originalHome: string | undefined

beforeEach(() => {
	cwsPaths.length = 0
	originalHome = process.env.HOME
	mockHome = mkdtempSync(join(tmpdir(), "sp-test-"))
	process.env.HOME = mockHome
	// Ensure parent of vendorDir exists so sibling tarball can be written there
	mkdirSync(join(mockHome, ".config", "kimchi", "vendor"), { recursive: true })
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
		const result = await ensureSuperpowersInstalled()
		expect(result).toBe(true)
	})

	it("throws when fetch returns non-ok", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }))
		await expect(ensureSuperpowersInstalled()).rejects.toThrow("404")
	})

	it("downloads tarball to a sibling path outside vendorDir", async () => {
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

		try {
			await ensureSuperpowersInstalled()
		} catch {
			// extract will fail on empty body — only the path matters
		}

		const vendorDir = join(mockHome, ".config", "kimchi", "vendor", "superpowers")
		// Tarball must NOT be inside vendorDir
		const insideVendor = cwsPaths.some((p) => p.startsWith(`${vendorDir}/`) || p.startsWith(`${vendorDir}\\`))
		expect(insideVendor).toBe(false)
		// Tarball must be a sibling ending in .download.tar.gz
		expect(cwsPaths.some((p) => p.endsWith(".download.tar.gz"))).toBe(true)
	})

	it("cleans up tarball on download stream failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: true,
				body: new ReadableStream({
					start(ctrl) {
						ctrl.error(new Error("network dropped"))
					},
				}),
			}),
		)

		await expect(ensureSuperpowersInstalled()).rejects.toThrow()

		const tarballPath = join(mockHome, ".config", "kimchi", "vendor", "superpowers.download.tar.gz")
		expect(existsSync(tarballPath)).toBe(false)
	})
})
