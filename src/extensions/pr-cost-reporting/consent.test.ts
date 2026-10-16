import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetOrgPolicyForTests } from "../../org-policy.js"
import { setOrgPolicyForTests } from "../../org-policy.test-utils.js"
import { setResourceOverride } from "../../resources/store.js"
import { INFRA_BREAKER_THRESHOLD_ENV } from "../../upstream-retry-patch.js"
import { CI_VARIABLES } from "./automation.js"
import {
	prReportingHeaderValue,
	prReportingStatePath,
	readPRReportingConsent,
	savePRReportingChoice,
	setPRReportingSessionMode,
	takeReportingNotice,
} from "./consent.js"
import { COST_PER_PR_RESOURCE_ID } from "./resource.js"

let agentDir: string

function saveState(state: Record<string, unknown> | string): void {
	const path = prReportingStatePath(agentDir)
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, typeof state === "string" ? state : JSON.stringify(state))
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "kimchi-pr-consent-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir)
	for (const name of [...CI_VARIABLES, "KIMCHI_PR_COST_REPORTING", INFRA_BREAKER_THRESHOLD_ENV]) vi.stubEnv(name, "")
	setPRReportingSessionMode("tui")
})

afterEach(() => {
	setPRReportingSessionMode(undefined)
	resetOrgPolicyForTests()
	vi.unstubAllEnvs()
	rmSync(agentDir, { recursive: true, force: true })
})

describe("PR reporting consent", () => {
	it.each([true, false])("follows the SaaS telemetry setting (%s) until a choice is saved", (telemetry) => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", String(telemetry))
		expect(readPRReportingConsent(agentDir)).toEqual({ enabled: telemetry, source: "default" })
		saveState({ version: 1, enabled: !telemetry, followsTelemetry: true, producerId: "queue", entries: {} })
		expect(readPRReportingConsent(agentDir)).toEqual({ enabled: telemetry, source: "default" })
	})

	it.each([
		{ policy: "FORCE_ON", telemetry: false, enabled: true },
		{ policy: "FORCE_OFF", telemetry: true, enabled: false },
	] as const)("applies the org's $policy usage-reporting policy to the default", async ({
		policy,
		telemetry,
		enabled,
	}) => {
		await setOrgPolicyForTests({ usageReporting: policy })
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", String(telemetry))
		expect(readPRReportingConsent(agentDir)).toEqual({ enabled, source: "default" })
	})

	it.each([true, false])("keeps a saved choice (%s) over the telemetry default and org policy", async (enabled) => {
		await setOrgPolicyForTests({ usageReporting: enabled ? "FORCE_OFF" : "FORCE_ON" })
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", String(!enabled))
		saveState({ version: 1, enabled })
		expect(readPRReportingConsent(agentDir)).toEqual({ enabled, source: "choice" })
	})

	it.each([
		"{",
		JSON.stringify({ version: 2, enabled: true }),
		JSON.stringify({ version: 1, enabled: "yes" }),
		JSON.stringify({ version: 1, enabled: true, followsTelemetry: false }),
	])("treats an unreadable saved state as no consent: %s", (state) => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		saveState(state)
		expect(() => readPRReportingConsent(agentDir)).toThrow()
		expect(prReportingHeaderValue(agentDir)).toBe("off")
	})
})

describe("PR reporting header value", () => {
	it.each([
		{ resource: true, consent: true, value: "proxy" },
		{ resource: true, consent: false, value: "off" },
		{ resource: false, consent: true, value: "off" },
		{ resource: false, consent: false, value: "off" },
	] as const)("is $value with Cost per PR enabled: $resource and consent: $consent", ({ resource, consent, value }) => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		saveState({ version: 1, enabled: consent })
		setResourceOverride(COST_PER_PR_RESOURCE_ID, resource)
		try {
			expect(prReportingHeaderValue(agentDir)).toBe(value)
		} finally {
			setResourceOverride(COST_PER_PR_RESOURCE_ID, undefined)
		}
	})

	it("is off while the organization locks Cost per PR off", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		await setOrgPolicyForTests({ resources: { [COST_PER_PR_RESOURCE_ID]: "FORCE_OFF" } })
		expect(prReportingHeaderValue(agentDir)).toBe("off")
	})

	it.each([
		{ telemetry: true, choice: undefined, value: "proxy" },
		{ telemetry: false, choice: undefined, value: "off" },
		{ telemetry: false, choice: true, value: "proxy" },
		{ telemetry: true, choice: false, value: "off" },
	] as const)("is $value with telemetry $telemetry and saved choice $choice", ({ telemetry, choice, value }) => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", String(telemetry))
		if (choice !== undefined) saveState({ version: 1, enabled: choice })
		expect(prReportingHeaderValue(agentDir)).toBe(value)
	})

	it.each([
		{ name: "KIMCHI_PR_COST_REPORTING", value: "0" },
		{ name: "KIMCHI_PR_COST_REPORTING", value: "off" },
		{ name: "GITHUB_ACTIONS", value: "true" },
		{ name: "CI", value: "1" },
		{ name: INFRA_BREAKER_THRESHOLD_ENV, value: "3" },
	])("is off in a process that never reports ($name=$value), whatever the saved choice", ({ name, value }) => {
		saveState({ version: 1, enabled: true })
		vi.stubEnv(name, value)
		expect(prReportingHeaderValue(agentDir)).toBe("off")
	})

	it.each(["print", "json"] as const)("is off in %s mode and on again in interactive modes", (mode) => {
		saveState({ version: 1, enabled: true })
		setPRReportingSessionMode(mode)
		expect(prReportingHeaderValue(agentDir)).toBe("off")
		setPRReportingSessionMode("rpc")
		expect(prReportingHeaderValue(agentDir)).toBe("proxy")
	})
})

describe("saved PR reporting state", () => {
	it("lets one of several concurrent sessions claim the default-on notice", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		const claims = await Promise.all([1, 2, 3].map(() => takeReportingNotice(agentDir)))
		expect(claims.filter(Boolean)).toHaveLength(1)
		expect(await takeReportingNotice(agentDir)).toBe(false)
		expect(readPRReportingConsent(agentDir)).toEqual({ enabled: true, source: "default" })
	})

	it("keeps an explicit choice over a later change of the SaaS setting", async () => {
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "true")
		await savePRReportingChoice(false, agentDir)
		expect(await takeReportingNotice(agentDir)).toBe(false)
		vi.stubEnv("KIMCHI_TELEMETRY_ENABLED", "false")
		await savePRReportingChoice(true, agentDir)
		expect(readPRReportingConsent(agentDir)).toEqual({ enabled: true, source: "choice" })
		expect(prReportingHeaderValue(agentDir)).toBe("proxy")
	})
})
