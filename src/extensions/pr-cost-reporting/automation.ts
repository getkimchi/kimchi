import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { INFRA_BREAKER_THRESHOLD_ENV, resolveInfrastructureBreakerThreshold } from "../../upstream-retry-patch.js"

export const CI_VARIABLES = [
	"CI",
	"GITHUB_ACTIONS",
	"GITLAB_CI",
	"BUILDKITE",
	"JENKINS_URL",
	"TEAMCITY_VERSION",
	"CIRCLECI",
	"TF_BUILD",
]

const disabled = (value: string | undefined) => ["0", "false", "off", "no"].includes(value?.trim().toLowerCase() ?? "")

/**
 * Why this process must not upload PR costs, or undefined when it may. CI, one-shot print or JSON runs
 * and benchmarks (the only callers of the infrastructure breaker) would report noise. Interactive TUI,
 * ACP and RPC sessions still report. Local attribution runs either way.
 */

export function uploadSkipReason(mode: ExtensionContext["mode"], env = process.env): string | undefined {
	if (disabled(env.KIMCHI_PR_COST_REPORTING)) return "KIMCHI_PR_COST_REPORTING=0"
	if (mode === "print") return "non-interactive print mode"
	if (mode === "json") return "non-interactive JSON mode"
	const ci = CI_VARIABLES.find((name) => env[name]?.trim() && !disabled(env[name]))
	if (ci) return `CI environment (${ci})`
	if (resolveInfrastructureBreakerThreshold(env) > 0) return `benchmark run (${INFRA_BREAKER_THRESHOLD_ENV})`
	return undefined
}
