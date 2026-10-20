import { describe, expect, it } from "vitest"
import { reportingSkipReason } from "./automation.js"

describe("PR cost reporting from automated runs", () => {
	it.each(["tui", "rpc"] as const)("lets an interactive %s session report", (mode) => {
		expect(reportingSkipReason(mode, {})).toBeUndefined()
	})
	it.each([
		["print", "non-interactive print mode"],
		["json", "non-interactive JSON mode"],
	] as const)("skips a one-shot %s run", (mode, reason) => {
		expect(reportingSkipReason(mode, {})).toBe(reason)
	})
	it.each([
		"CI",
		"GITHUB_ACTIONS",
		"GITLAB_CI",
		"BUILDKITE",
		"JENKINS_URL",
		"TEAMCITY_VERSION",
		"CIRCLECI",
		"TF_BUILD",
	])("skips a CI job detected through %s", (name) => {
		expect(reportingSkipReason("tui", { [name]: name === "JENKINS_URL" ? "https://jenkins.example/" : "true" })).toBe(
			`CI environment (${name})`,
		)
	})
	it.each(["", " ", "0", "false", "FALSE"])("treats CI=%j as a developer terminal", (value) => {
		expect(reportingSkipReason("tui", { CI: value })).toBeUndefined()
	})
	it.each(["0", "false", "off", "no"])("honors KIMCHI_PR_COST_REPORTING=%s in every mode", (value) => {
		expect(reportingSkipReason("rpc", { KIMCHI_PR_COST_REPORTING: value })).toBe("KIMCHI_PR_COST_REPORTING=0")
	})
	it("offers no way around CI detection", () => {
		expect(reportingSkipReason("tui", { KIMCHI_PR_COST_REPORTING: "1", CI: "true" })).toBe("CI environment (CI)")
	})
	it("skips benchmark runs, the only users of the infrastructure breaker", () => {
		expect(reportingSkipReason("tui", { KIMCHI_INFRA_BREAKER_THRESHOLD: "3" })).toBe(
			"benchmark run (KIMCHI_INFRA_BREAKER_THRESHOLD)",
		)
		expect(reportingSkipReason("tui", { KIMCHI_INFRA_BREAKER_THRESHOLD: "0" })).toBeUndefined()
	})
})
