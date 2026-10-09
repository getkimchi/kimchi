import { describe, expect, it } from "vitest"
import { runDoctor } from "./doctor.js"

describe("documents doctor", () => {
	it("passes in this build", async () => {
		const report = await runDoctor()
		expect(
			report.checks.map((c) => `${c.name}:${c.ok}`),
			report.checks
				.filter((c) => !c.ok)
				.map((c) => `${c.name} — ${c.detail ?? ""}`)
				.join("; "),
		).toEqual(report.checks.map((c) => `${c.name}:true`))
		expect(report.ok).toBe(true)
		expect(report.assetSource).toBeDefined()
	})

	it("fails on a deliberately corrupted golden", async () => {
		const report = await runDoctor({ goldens: { pdfPage1: "DEFINITELY NOT IN THE DOCUMENT" } })
		expect(report.ok).toBe(false)
		expect(report.checks.find((c) => c.name === "read-pdf")?.ok).toBe(false)
	})
})
