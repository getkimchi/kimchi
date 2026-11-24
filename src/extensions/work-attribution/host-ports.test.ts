import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type AllowedPermissionModes, fetchOrgPolicy } from "../../api/org-settings.js"
import { resolveGatewayCredentials } from "../../auth/gateway-credentials.js"
import { loadConfig, readGitToken, resolveEndpoints } from "../../config.js"
import { initOrgPolicy, resetOrgPolicyForTests } from "../../org-policy.js"
import { resetProjectScopeTrustForTests, setProjectScopeTrusted } from "../../project-scope-trust.js"
import { isResourceEnabled } from "../../resources/store.js"
import { isTelemetryEnabled } from "../../telemetry-policy.js"
import {
	enforceTelemetryPolicyForTests,
	resetTelemetryPolicyMock,
	telemetryPolicyMock,
} from "../__mocks__/telemetry-policy.js"
import { trackPRCostMetric } from "../telemetry/pr-cost.js"
import { kimchiHostPorts } from "./host-ports.js"
import { COST_PER_PR_RESOURCE_ID } from "./resource.js"

vi.mock("../../api/org-settings.js", () => ({ fetchOrgPolicy: vi.fn() }))
vi.mock("../../telemetry-policy.js", () => telemetryPolicyMock)
vi.mock("../telemetry/pr-cost.js", () => ({ trackPRCostMetric: vi.fn() }))

const mockedFetchOrgPolicy = vi.mocked(fetchOrgPolicy)
const mockedTrackPRCostMetric = vi.mocked(trackPRCostMetric)

/** The global config the isolated home gives every test (see tests/setup/isolated-home.ts). */
function globalConfigPath(): string {
	return join(homedir(), ".config", "kimchi", "config.json")
}

function writeGlobalConfig(value: Record<string, unknown>): void {
	mkdirSync(join(homedir(), ".config", "kimchi"), { recursive: true })
	writeFileSync(globalConfigPath(), JSON.stringify(value))
}

/** A project directory with a .kimchi/config.json the session cwd could resolve. */
function projectWithConfig(value: Record<string, unknown>): string {
	const cwd = mkdtempSync(join(tmpdir(), "kimchi-host-ports-"))
	mkdirSync(join(cwd, ".kimchi"), { recursive: true })
	writeFileSync(join(cwd, ".kimchi", "config.json"), JSON.stringify(value))
	return cwd
}

describe("kimchiHostPorts", () => {
	let projects: string[]

	beforeEach(() => {
		projects = []
		resetProjectScopeTrustForTests()
		resetTelemetryPolicyMock()
	})

	afterEach(() => {
		for (const project of projects) rmSync(project, { recursive: true, force: true })
		resetProjectScopeTrustForTests()
		resetOrgPolicyForTests()
	})

	describe("credentials", () => {
		it("resolves the global API key when the project is untrusted", () => {
			writeGlobalConfig({ apiKey: "global-key" })
			const cwd = projectWithConfig({ apiKey: "project-key" })
			projects.push(cwd)
			const host = kimchiHostPorts()
			const credentials = host.credentials(cwd)
			// The old credentialOf read loadConfig({ cwd }): an untrusted project's
			// .kimchi/config.json is not read at all, so the global key answers.
			expect(credentials.token).toBe("global-key")
			expect(credentials.token).toBe(resolveGatewayCredentials(loadConfig({ cwd })).token)
			expect(credentials).toEqual({
				token: "global-key",
				organizationId: undefined,
				apiUrl: resolveEndpoints({ cwd }).platformApiUrl.replace(/\/+$/, ""),
			})
		})

		it("lets a trusted project .kimchi/config.json override the key", () => {
			writeGlobalConfig({ apiKey: "global-key" })
			const cwd = projectWithConfig({ apiKey: "project-key" })
			projects.push(cwd)
			setProjectScopeTrusted(cwd, true)
			const credentials = kimchiHostPorts().credentials(cwd)
			// The moved code resolved credentials with loadConfig({ cwd }); with the
			// folder trusted the project tier outranks the global config.
			expect(credentials.token).toBe("project-key")
			expect(credentials.token).toBe(resolveGatewayCredentials(loadConfig({ cwd })).token)
		})

		it("resolves no credential without any key", () => {
			writeGlobalConfig({})
			const host = kimchiHostPorts()
			const credentials = host.credentials(homedir())
			expect(credentials.token).toBe("")
			expect(credentials.organizationId).toBeUndefined()
			expect(credentials.token).toBe(resolveGatewayCredentials(loadConfig({ cwd: homedir() })).token)
		})
	})

	describe("endpoints", () => {
		it("returns the endpoints billing-source compared against", () => {
			const cwd = homedir()
			const endpoints = kimchiHostPorts().endpoints(cwd)
			const expected = resolveEndpoints({ cwd })
			expect(endpoints).toEqual(expected)
		})
	})

	describe("gitToken", () => {
		it("reads the saved gitTokens entry for a host", () => {
			writeGlobalConfig({ gitTokens: { "github.com": "ghp_saved" } })
			const host = kimchiHostPorts()
			// The moved provider-api read readGitToken(repository.host) at the same
			// call site; the port must answer with the same saved token.
			expect(host.gitToken("github.com")).toBe(readGitToken("github.com"))
			expect(host.gitToken("github.com")).toBe("ghp_saved")
			expect(host.gitToken("gitlab.com")).toBeUndefined()
		})
	})

	describe("orgPolicy", () => {
		it("answers resource enablement with isResourceEnabled", async () => {
			const host = kimchiHostPorts()
			expect(host.orgPolicy().resourceEnabled(COST_PER_PR_RESOURCE_ID)).toBe(isResourceEnabled(COST_PER_PR_RESOURCE_ID))

			mockedFetchOrgPolicy.mockResolvedValue({
				kind: "policy",
				orgId: "org-host-ports-test",
				policy: { resources: { [COST_PER_PR_RESOURCE_ID]: "FORCE_OFF" } },
			})
			await initOrgPolicy("key", {
				cachePath: join(mkdtempSync(join(tmpdir(), "org-policy-test-")), "org-policy.json"),
			})
			// The org lock outranks every local choice in both the old call and the port.
			expect(host.orgPolicy().resourceEnabled(COST_PER_PR_RESOURCE_ID)).toBe(false)
			expect(isResourceEnabled(COST_PER_PR_RESOURCE_ID)).toBe(false)
		})
	})

	describe("telemetryConsent", () => {
		it("follows isTelemetryEnabled, including org enforcement", () => {
			const host = kimchiHostPorts()
			expect(host.telemetryConsent()).toBe(isTelemetryEnabled())
			enforceTelemetryPolicyForTests("FORCE_OFF")
			expect(host.telemetryConsent()).toBe(false)
			expect(isTelemetryEnabled()).toBe(false)
		})
	})

	describe("metric", () => {
		it("replays PR-cost metrics into trackPRCostMetric", () => {
			kimchiHostPorts().metric({ kind: "reconciliation" })
			expect(mockedTrackPRCostMetric).toHaveBeenCalledWith({ kind: "reconciliation" })
			kimchiHostPorts().metric({ kind: "delivery", outcome: "success" })
			expect(mockedTrackPRCostMetric).toHaveBeenCalledWith({ kind: "delivery", outcome: "success" })
		})
	})

	describe("host basics", () => {
		it("anchors the agent directory and the e2e seam", () => {
			const host = kimchiHostPorts()
			expect(host.agentDir).toContain("agent")
			// readE2eSeam returns undefined outside the test harness env the seam
			// variables gate on; inside vitest an exported variable is visible.
			process.env.KIMCHI_E2E_PROBE = "visible"
			try {
				expect(host.e2eSeam("KIMCHI_E2E_PROBE")).toBe("visible")
				expect(host.e2eSeam("KIMCHI_E2E_NEVER_SET")).toBeUndefined()
			} finally {
				delete process.env.KIMCHI_E2E_PROBE
			}
			expect(typeof host.now()).toBe("number")
		})
	})
})
