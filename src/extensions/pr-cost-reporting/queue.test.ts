import { execFile } from "node:child_process"
import * as files from "node:fs/promises"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { setOrgPolicyForTests } from "../../org-policy.test-utils.js"
import { backendFor } from "./ledger/records.js"
import { machineFingerprint } from "./machine.js"
import {
	readReportingState,
	recordReportingError,
	reportingProducer,
	setReportingEnabled,
	takeReportingNotice,
	withReportingConsent,
} from "./queue.js"

const account = {
	apiUrl: "https://api.example",
	organizationId: "11111111-1111-4111-8111-111111111111",
	userId: "22222222-2222-4222-8222-222222222222",
}
const requestId = "33333333-3333-4333-8333-333333333333"
let directory: string
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof files>()) }))
vi.mock("./machine.js", () => ({ machineFingerprint: vi.fn() }))
beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "kimchi-reporting-"))
	vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
	vi.mocked(machineFingerprint).mockResolvedValue(undefined)
})
afterEach(async () => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	await rm(directory, { recursive: true, force: true })
})

describe("org usage-reporting policy", () => {
	afterEach(() => {
		resetOrgPolicyForTests()
	})

	it("creates fresh queues disabled under FORCE_OFF", async () => {
		await setOrgPolicyForTests({ usageReporting: "FORCE_OFF" })
		const state = await readReportingState(directory)
		expect(state.enabled).toBe(false)
	})

	it("re-clamps follow-telemetry queues to disabled on load under FORCE_OFF", async () => {
		await setOrgPolicyForTests({ usageReporting: "FORCE_OFF" })
		await files.mkdir(join(directory, "pr-cost-reporting"), { recursive: true })
		await writeFile(
			join(directory, "pr-cost-reporting/state.json"),
			JSON.stringify({
				version: 1,
				enabled: true,
				followsTelemetry: true,
				producerId: "55555555-5555-4555-8555-555555555555",
				entries: {},
			}),
		)
		const state = await readReportingState(directory)
		expect(state.enabled).toBe(false)
	})

	it("re-clamps follow-telemetry queues to enabled on load under FORCE_ON", async () => {
		await setOrgPolicyForTests({ usageReporting: "FORCE_ON" })
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		await files.mkdir(join(directory, "pr-cost-reporting"), { recursive: true })
		await writeFile(
			join(directory, "pr-cost-reporting/state.json"),
			JSON.stringify({
				version: 1,
				enabled: false,
				followsTelemetry: true,
				producerId: "55555555-5555-4555-8555-555555555555",
				entries: {},
			}),
		)
		const state = await readReportingState(directory)
		expect(state.enabled).toBe(true)
	})
})

describe("reporting state", () => {
	it("runs an event step only while reporting is enabled", async () => {
		await setReportingEnabled(directory, true)
		const action = vi.fn()
		expect(await withReportingConsent(directory, action, () => {})).toBe(true)
		expect(action).toHaveBeenCalledOnce()
		await setReportingEnabled(directory, false)
		expect(await withReportingConsent(directory, action, () => {})).toBe(false)
		expect(action).toHaveBeenCalledOnce()
	})

	it("never runs an event step after its lease or credentials changed", async () => {
		await setReportingEnabled(directory, true)
		const action = vi.fn()
		await expect(
			withReportingConsent(directory, action, () => {
				throw new Error("lease lost")
			}),
		).rejects.toThrow("lease lost")
		expect(action).not.toHaveBeenCalled()
	})

	it("stops an event step when the SaaS uploads it follows are turned off", async () => {
		await setReportingEnabled(directory, true)
		const state = await readReportingState(directory)
		await writeFile(
			join(directory, "pr-cost-reporting/state.json"),
			JSON.stringify({ ...state, followsTelemetry: true }),
		)
		const after = vi.fn()
		await expect(
			withReportingConsent(
				directory,
				(consent) => {
					vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
					consent()
					after()
				},
				() => {},
			),
		).rejects.toThrow("PR reporting is disabled")
		expect(after).not.toHaveBeenCalled()
	})

	it("keeps a disabled check read-only while explicit consent still persists", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		expect(await withReportingConsent(directory, vi.fn(), () => {})).toBe(false)
		const path = join(directory, "pr-cost-reporting/state.json")
		await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" })
		await setReportingEnabled(directory, true)
		expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ enabled: true })
	})

	it.each([
		true,
		false,
	])("reads an older version's explicit choice (%s) and keeps its pending snapshots on disk", async (enabled) => {
		const producerId = "55555555-5555-4555-8555-555555555555"
		const legacy = {
			version: 1,
			enabled,
			producerId,
			entries: {
				"older-repository": {
					account,
					repository: { provider: "github", host: "github.com", id: "42" },
					revision: "7",
					pending: { schemaVersion: 1, producerId, revision: "7", requests: [{ requestId }] },
					attempts: 2,
					retryAt: 100,
				},
			},
			skippedRequests: 3,
		}
		await files.mkdir(join(directory, "pr-cost-reporting"), { recursive: true })
		await writeFile(join(directory, "pr-cost-reporting/state.json"), JSON.stringify(legacy))
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", String(!enabled))
		expect(await readReportingState(directory)).toEqual(legacy)
		await setReportingEnabled(directory, !enabled)
		await recordReportingError(directory, "PR cost event upload returned HTTP 503")
		expect(JSON.parse(await readFile(join(directory, "pr-cost-reporting/state.json"), "utf8"))).toEqual({
			...legacy,
			enabled: !enabled,
			...(enabled ? {} : { error: "PR cost event upload returned HTTP 503" }),
		})
	})
	it("claims the default-on notice once across concurrent sessions", async () => {
		expect((await Promise.all([takeReportingNotice(directory), takeReportingNotice(directory)])).sort()).toEqual([
			false,
			true,
		])
		expect(await takeReportingNotice(directory)).toBe(false)
	})
	it("follows SaaS uploads by default after the state is saved and reopened", async () => {
		expect((await readReportingState(directory)).enabled).toBe(true)
		expect(await takeReportingNotice(directory)).toBe(true)
		const original = await readReportingState(directory)
		expect(original).toMatchObject({ followsTelemetry: true, defaultNoticeShown: true })
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		expect((await readReportingState(directory)).enabled).toBe(false)
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		expect(await readReportingState(directory)).toEqual(original)
	})
	it.each([true, false])("preserves an explicit reporting choice (%s) when SaaS uploads change", async (enabled) => {
		await setReportingEnabled(directory, enabled)
		for (const telemetry of ["false", "true"]) {
			vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", telemetry)
			expect((await readReportingState(directory)).enabled).toBe(enabled)
		}
	})
	it("does not rewrite or sync unchanged state", async () => {
		await setReportingEnabled(directory, true)
		const path = join(directory, "pr-cost-reporting", "state.json")
		const before = await files.stat(path)
		await recordReportingError(directory, undefined)
		await setReportingEnabled(directory, true)
		const after = await files.stat(path)
		expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
	})
	it("leaves the last durable state unchanged when fsync fails", async () => {
		await setReportingEnabled(directory, true)
		const before = await readReportingState(directory)
		const originalOpen = files.open
		vi.spyOn(files, "open").mockImplementation(async (...args) => {
			const file = await originalOpen(...args)
			if (String(args[0]).endsWith(".tmp")) vi.spyOn(file, "sync").mockRejectedValue(new Error("disk unavailable"))
			return file
		})
		await expect(recordReportingError(directory, "PR cost event upload returned HTTP 503")).rejects.toThrow(
			"disk unavailable",
		)
		expect(await readReportingState(directory)).toEqual(before)
	})
	it("fails closed on damaged durable state instead of resetting its producer", async () => {
		await setReportingEnabled(directory, true)
		await writeFile(join(directory, "pr-cost-reporting", "state.json"), "{broken")
		await expect(setReportingEnabled(directory, false)).rejects.toThrow("unreadable")
		expect(await readFile(join(directory, "pr-cost-reporting", "state.json"), "utf8")).toBe("{broken")
	})
})

describe("producer identity across machines", () => {
	const original = "a".repeat(64)
	const copy = "b".repeat(64)
	async function savedOn(machine: string | undefined) {
		vi.mocked(machineFingerprint).mockResolvedValue(machine)
		const saved = await setReportingEnabled(directory, true)
		expect(saved.machine).toBe(machine)
		return saved
	}

	it("rotates the event producer of a copied home without rewriting its state", async () => {
		const saved = await savedOn(original)
		const path = join(directory, "pr-cost-reporting/state.json")
		const bytes = await readFile(path)
		vi.mocked(machineFingerprint).mockResolvedValue(copy)
		const next = await reportingProducer(directory, () => {})
		expect(next).not.toBe(saved.producerId)
		expect(await reportingProducer(directory, () => {})).toBe(next)
		const copied = await readReportingState(directory)
		expect(copied).toEqual(saved)
		expect(await readFile(path)).toEqual(bytes)
	})

	it("creates one persisted producer for concurrent callers without saved state", async () => {
		const producers = await Promise.all(Array.from({ length: 3 }, () => reportingProducer(directory, () => {})))
		expect(new Set(producers).size).toBe(1)
		expect(await reportingProducer(directory, () => {})).toBe(producers[0])
		expect(JSON.parse(backendFor(directory).getNote("agent", "reporting-producer") ?? "{}")).toEqual({
			version: 1,
			producerId: producers[0],
		})
		expect(backendFor(directory).recordCount()).toBe(0)
	})

	it("keeps saved state and frozen delta bytes across real SQLite producer initialization and process reopen", {
		timeout: 30_000,
	}, async () => {
		const saved = await savedOn(original)
		const path = join(directory, "pr-cost-reporting/state.json")
		const bytes = await readFile(path)
		const driver = fileURLToPath(new URL("../../../tests/e2e/tui/support/ledger-driver.ts", import.meta.url))
		const run = async () =>
			JSON.parse((await promisify(execFile)("bun", [driver, "producer", directory], { timeout: 30_000 })).stdout)
		const [first, concurrent] = await Promise.all([run(), run()])
		expect(concurrent.producerId).toBe(first.producerId)
		for (const result of [first, concurrent, await run()]) {
			expect(result).toMatchObject({
				producerId: first.producerId,
				stateRetained: true,
				batchRetained: true,
				frozenProducer: saved.producerId,
				note: { version: 1, producerId: first.producerId },
			})
			expect(result.producerId !== saved.producerId).toBe(result.machineKnown)
		}
		expect(await readFile(path)).toEqual(bytes)
	})

	it("seeds the same-machine legacy producer once and ignores later old-writer state", async () => {
		const saved = await savedOn(original)
		const path = join(directory, "pr-cost-reporting/state.json")
		const bytes = await readFile(path)
		expect(await reportingProducer(directory, () => {})).toBe(saved.producerId)
		expect(await readFile(path)).toEqual(bytes)
		await writeFile(path, "unreadable old writer state")
		expect(await reportingProducer(directory, () => {})).toBe(saved.producerId)
		expect(await readFile(path, "utf8")).toBe("unreadable old writer state")
	})

	it("fills an initially unknown machine and retains identity while hardware is unavailable", async () => {
		const saved = await savedOn(undefined)
		expect(await reportingProducer(directory, () => {})).toBe(saved.producerId)
		vi.mocked(machineFingerprint).mockResolvedValue(original)
		expect(await reportingProducer(directory, () => {})).toBe(saved.producerId)
		const note = backendFor(directory).getNote("agent", "reporting-producer")
		expect(JSON.parse(note ?? "{}").machine).toBe(original)
		vi.mocked(machineFingerprint).mockResolvedValue(undefined)
		expect(await reportingProducer(directory, () => {})).toBe(saved.producerId)
		expect(backendFor(directory).getNote("agent", "reporting-producer")).toBe(note)
	})

	it("rolls back producer initialization when its lease is lost after the actual note write", async () => {
		const saved = await savedOn(original)
		const path = join(directory, "pr-cost-reporting/state.json")
		const bytes = await readFile(path)
		const backend = backendFor(directory)
		const putNote = backend.putNote.bind(backend)
		let written = false
		const write = vi.spyOn(backend, "putNote").mockImplementation((...args) => {
			putNote(...args)
			written = true
		})
		await expect(
			reportingProducer(directory, () => {
				if (written) throw new Error("lease lost")
			}),
		).rejects.toThrow("lease lost")
		expect(written).toBe(true)
		expect(backend.getNote("agent", "reporting-producer")).toBeUndefined()
		expect(await readFile(path)).toEqual(bytes)
		write.mockRestore()
		expect(await reportingProducer(directory, () => {})).toBe(saved.producerId)
	})

	it.each([
		"not JSON",
		"{}",
		JSON.stringify({ version: 2, producerId: requestId }),
		JSON.stringify({ version: 1, producerId: "invalid" }),
		JSON.stringify({ version: 1, producerId: requestId, machine: false }),
		JSON.stringify({ version: 1, producerId: requestId, machine: "invalid" }),
	])("retains an invalid existing producer note instead of reseeding from legacy state (%s)", async (body) => {
		await savedOn(original)
		const backend = backendFor(directory)
		backend.putNote("agent", "reporting-producer", body)
		await expect(reportingProducer(directory, () => {})).rejects.toThrow()
		expect(backend.getNote("agent", "reporting-producer")).toBe(body)
	})

	it("does not initialize over unreadable legacy state", async () => {
		await savedOn(original)
		const path = join(directory, "pr-cost-reporting/state.json")
		await writeFile(path, "unreadable legacy state")
		await expect(reportingProducer(directory, () => {})).rejects.toThrow("unreadable")
		expect(backendFor(directory).getNote("agent", "reporting-producer")).toBeUndefined()
		expect(await readFile(path, "utf8")).toBe("unreadable legacy state")
	})

	it("keeps the producer on the same machine and records the machine for older state", async () => {
		const legacy = await savedOn(undefined)
		vi.mocked(machineFingerprint).mockResolvedValue(original)
		expect(await readReportingState(directory)).toEqual(legacy)
		const next = await setReportingEnabled(directory, true)
		expect([next.producerId, next.machine]).toEqual([legacy.producerId, original])
	})

	it("keeps the producer when the machine cannot be identified", async () => {
		const saved = await savedOn(original)
		vi.mocked(machineFingerprint).mockResolvedValue(undefined)
		expect(await readReportingState(directory)).toEqual(saved)
	})
})
