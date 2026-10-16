import { afterEach, describe, expect, it, vi } from "vitest"
import type { BugReportBundle } from "./bug-report.js"

const { default: bugReportDestinationExtension, _internal, deliveryDeps } = await import("./bug-report.js")

function makeBundle(): BugReportBundle {
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
		sessionJsonl:
			'{"role":"user","content":[{"type":"text","text":"my email is jose@example.com","password":"hunter2-plain"}]}\n',
	}
}

describe("bug-report kimchi destination", () => {
	afterEach(() => {
		delete globalThis.__kimchiBugReportScrub
		delete globalThis.__kimchiBugReportDeliver
		vi.restoreAllMocks()
	})

	it("registers the scrub and deliver hooks and the /bug command when loaded", () => {
		const registeredCommands: string[] = []
		const pi = { registerCommand: (name: string) => registeredCommands.push(name) } as never
		bugReportDestinationExtension(pi)
		expect(globalThis.__kimchiBugReportScrub).toBeInstanceOf(Function)
		expect(globalThis.__kimchiBugReportDeliver).toBeInstanceOf(Function)
		expect(registeredCommands).toEqual(["bug"])
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

	it("redacts sensitive JSON keys inside the transcript (key-name rules still apply)", async () => {
		const scrubbed = await _internal.scrubBundle(makeBundle())
		// The plain-looking password value must be caught by the key-name rule,
		// which only works when the JSONL is parsed per line.
		expect(scrubbed.sessionJsonl).not.toContain("hunter2-plain")
		expect(scrubbed.sessionJsonl).toContain("[REDACTED-SECRET_FIELD]")
		expect(scrubbed.sessionJsonl).toContain('"password"')
		expect(scrubbed.sessionJsonl?.endsWith("\n")).toBe(true)
	})

	it("redacts non-JSON transcript lines as plain text", async () => {
		const bundle = makeBundle()
		bundle.sessionJsonl = "not json: jose@example.com\n"
		const scrubbed = await _internal.scrubBundle(bundle)
		expect(scrubbed.sessionJsonl).not.toContain("jose@example.com")
		expect(scrubbed.sessionJsonl).toContain("not json:")
	})

	it("does not mutate the input bundle", async () => {
		const bundle = makeBundle()
		await _internal.scrubBundle(bundle)
		expect(JSON.stringify(bundle)).toContain("jose@example.com")
	})

	it("never creates a gist when the transcript is not included", async () => {
		const createGist = vi.spyOn(deliveryDeps, "createGist")
		const openUrl = vi.spyOn(deliveryDeps, "openUrl").mockResolvedValue(undefined as unknown)
		const bundle = makeBundle()
		bundle.sessionJsonl = undefined
		const delivery = await _internal.deliverToKimchi(bundle)
		expect(createGist).not.toHaveBeenCalled()
		expect(delivery.message).toContain("no session data uploaded")
		const url = openUrl.mock.calls[0][0] as string
		expect(url).not.toContain("gist.github.com")
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
