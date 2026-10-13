/**
 * Smoke test — the compiled kimchi binary's document capabilities:
 * `kimchi documents doctor --json` runs the embedded fixture corpus through
 * every shipped capability and must pass on every release target (CI), with
 * the PDF.js assets staged next to the binary (share/kimchi/pdfjs).
 */

import { describe, expect, it } from "vitest"
import { runBinary } from "./harness.js"

describe("documents doctor smoke", () => {
	it("documents doctor --json passes on the compiled binary", () => {
		const result = runBinary({ args: ["documents", "doctor", "--json"] })
		expect(result.status).toBe(0)
		const report = JSON.parse(result.stdout) as {
			ok: boolean
			assetSource?: string
			checks: Array<{ name: string; ok: boolean; detail?: string }>
		}
		expect(report.ok).toBe(true)
		for (const name of ["pdfjs-assets", "read-pdf", "read-docx", "read-pptx", "read-xlsx", "safety-zip-bomb"]) {
			expect(report.checks.find((c) => c.name === name)?.ok, name).toBe(true)
		}
		// The compiled binary must resolve packaged assets, not node_modules.
		expect(report.assetSource).toBe("share/kimchi/pdfjs")
	})
})
