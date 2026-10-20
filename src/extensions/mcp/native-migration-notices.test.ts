import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { notifyMigrationReport } from "./native-migration-notices.js"

function setup() {
	const agentDir = mkdtempSync(join(tmpdir(), "native-migration-notices-"))
	const ctx = createContext()
	const notify = vi.mocked(ctx.ui.notify)
	return { agentDir, ctx, notify }
}

function writeReport(agentDir: string, report: Record<string, unknown>): void {
	writeFileSync(join(agentDir, "mcp-native-migration-report.json"), JSON.stringify(report))
}

describe("notifyMigrationReport", () => {
	it("is silent when no report exists", () => {
		const { agentDir, ctx, notify } = setup()
		notifyMigrationReport(agentDir, ctx)
		expect(notify).not.toHaveBeenCalled()
	})

	it("is silent when the report was already notified", () => {
		const { agentDir, ctx, notify } = setup()
		writeReport(agentDir, { issues: [{ message: "dropped" }], notifiedAt: "2026-10-20T00:00:00Z" })
		notifyMigrationReport(agentDir, ctx)
		expect(notify).not.toHaveBeenCalled()
	})

	it("stamps but stays silent on a clean migration (no issues)", () => {
		const { agentDir, ctx, notify } = setup()
		writeReport(agentDir, { issues: [] })
		notifyMigrationReport(agentDir, ctx)
		expect(notify).not.toHaveBeenCalled()
		expect(JSON.parse(readFileSync(join(agentDir, "mcp-native-migration-report.json"), "utf8")).notifiedAt).toBeTypeOf(
			"string",
		)
	})

	it("notifies once with a one-line info summary pointing at the report", () => {
		const { agentDir, ctx, notify } = setup()
		writeReport(agentDir, {
			issues: [
				{ server: "slack", message: '"oauth" removed; native auto-starts OAuth on 401' },
				{ server: "rovo", message: '"oauth" removed; native auto-starts OAuth on 401' },
				{ server: "rovo", message: 'adapter-only field "debug" dropped' },
			],
		})
		notifyMigrationReport(agentDir, ctx)

		expect(notify).toHaveBeenCalledTimes(1)
		const [message, level] = notify.mock.calls[0] as [string, string]
		expect(level).toBe("info")
		expect(message).toBe(
			`MCP configs migrated to the native engine (report: ${join(agentDir, "mcp-native-migration-report.json")})`,
		)
		// Field-level detail no longer surfaces in the TUI.
		expect(message).not.toContain("oauth")
		expect(message).not.toContain("debug")

		// Marker stamped — a second notification does not fire.
		const report = JSON.parse(readFileSync(join(agentDir, "mcp-native-migration-report.json"), "utf8"))
		expect(report.notifiedAt).toBeTypeOf("string")
		notifyMigrationReport(agentDir, ctx)
		expect(notify).toHaveBeenCalledTimes(1)
	})

})
