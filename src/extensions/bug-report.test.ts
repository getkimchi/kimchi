import { afterEach, describe, expect, it, vi } from "vitest"

const { default: bugReportDestinationExtension, _internal, deliveryDeps } = await import("./bug-report.js")

function makeBundle() {
	return {
		metadata: {
			id: "rpt-1",
			hint: "settings apiKey was leaked in the transcript",
			model: { provider: "github-copilot", apiKey: "sk-abc1234567890" },
			custom: { token: "ghp_1234567890abcdef" },
		},
		diagnostics: {
			crashes: [{ message: "boom near jose@example.com" }],
		},
		summary: "User jose@example.com hit an error with sk-abc1234567890 in env.",
		sessionJsonl: '{"role":"user","content":[{"type":"text","text":"my email is jose@example.com"}]}\n',
	}
}

describe("bug-report kimchi destination", () => {
	afterEach(() => {
		delete globalThis.__kimchiBugReportScrub
		delete globalThis.__kimchiBugReportDeliver
		vi.restoreAllMocks()
	})

	it("registers the scrub and deliver hooks when loaded", () => {
		// The pi hook is unused — this extension only installs globals.
		// Cast through to satisfy the ExtensionAPI factory signature without a mock.
		;(bugReportDestinationExtension as unknown as () => void)()
		expect(globalThis.__kimchiBugReportScrub).toBeInstanceOf(Function)
		expect(globalThis.__kimchiBugReportDeliver).toBeInstanceOf(Function)
	})

	it("scrubs PII/secrets across every bundle field", async () => {
		const scrubbed = await _internal.scrubBundle(makeBundle())
		const blob = JSON.stringify(scrubbed)
		expect(blob).not.toContain("jose@example.com")
		expect(blob).not.toContain("sk-abc1234567890")
		expect(blob).not.toContain("ghp_1234567890abcdef")
		expect(blob).toContain("[REDACTED")
		// Structural metadata that isn't secret stays intact.
		expect(scrubbed.metadata.id).toBe("rpt-1")
	})

	it("does not mutate the input bundle", async () => {
		const bundle = makeBundle()
		await _internal.scrubBundle(bundle)
		expect(JSON.stringify(bundle)).toContain("jose@example.com")
	})

	it("delivers by opening the getkimchi issue form and attaches the gist URL", async () => {
		const createGist = vi.spyOn(deliveryDeps, "createGist").mockResolvedValue("https://gist.github.com/abc123")
		const openUrl = vi.spyOn(deliveryDeps, "openUrl").mockResolvedValue(undefined as unknown)
		const delivery = await _internal.deliverToKimchi(makeBundle())
		expect(openUrl).toHaveBeenCalledTimes(1)
		const url = openUrl.mock.calls[0][0] as string
		expect(url).toContain("https://github.com/getkimchi/kimchi/issues/new")
		expect(url).toContain("template=bug_report.yml")
		expect(url).toContain("labels=bug")
		expect(url).toContain(encodeURIComponent("https://gist.github.com/abc123"))
		expect(url).toContain("report-id=rpt-1")
		expect(createGist).toHaveBeenCalledTimes(1)
		expect(delivery.message).toContain("redacted session data")
	})

	it("omits the gist parameter (not the report) when gist creation fails", async () => {
		vi.spyOn(deliveryDeps, "createGist").mockResolvedValue(undefined)
		vi.spyOn(deliveryDeps, "openUrl").mockResolvedValue(undefined as unknown)
		const delivery = await _internal.deliverToKimchi(makeBundle())
		expect(delivery.message).toContain("session export omitted")
	})

	it("surfaces a failure text when the browser cannot be opened", async () => {
		vi.spyOn(deliveryDeps, "createGist").mockResolvedValue(undefined)
		vi.spyOn(deliveryDeps, "openUrl").mockRejectedValue(new Error("no display"))
		const delivery = await _internal.deliverToKimchi(makeBundle())
		expect(delivery.failure).toContain("Failed to open browser")
	})
})
