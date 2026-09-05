import { isDeepStrictEqual } from "node:util"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
	type DefaultProjectTrust,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
	SettingsManager,
} from "@earendil-works/pi-coding-agent"
import type { McpConfig } from "pi-mcp-adapter/types"

const TRUST = "Trust"
const TRUST_ONCE = "Trust (this session only)"
const DO_NOT_TRUST = "Do not trust"

export const MCP_PROJECT_TRUST_WARNING =
	"Project MCP configuration is not trusted. Kimchi did not start project-defined MCP servers; user-level MCP configuration remains available. Use /trust and restart Kimchi to change this decision."

interface McpProjectTrustOptions {
	projectConfig: McpConfig
	userConfig: McpConfig
	explicitTrust?: boolean
	agentDir?: string
	defaultProjectTrust?: DefaultProjectTrust
}

function readDefaultProjectTrust(cwd: string, agentDir: string): DefaultProjectTrust | undefined {
	try {
		return SettingsManager.create(cwd, agentDir, { projectTrusted: false }).getDefaultProjectTrust()
	} catch {
		return undefined
	}
}

/**
 * Resolve whether MCP may consume project-derived configuration.
 *
 * Pi's project-trust detector does not currently include standard `.mcp.json`
 * files, so a repository containing only MCP configuration is otherwise marked
 * trivially trusted. Reuse Pi's persisted trust store and defaults, and ask only
 * for this missing case. Existing Pi trust decisions remain authoritative.
 */
export async function resolveMcpProjectTrust(
	ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "mode" | "isProjectTrusted" | "ui">,
	options: McpProjectTrustOptions,
): Promise<boolean> {
	if (isDeepStrictEqual(options.projectConfig, options.userConfig)) return true
	if (options.explicitTrust !== undefined) return options.explicitTrust
	if (!ctx.isProjectTrusted()) return false
	if (hasTrustRequiringProjectResources(ctx.cwd)) return true

	const agentDir = options.agentDir ?? getAgentDir()
	try {
		const trustStore = new ProjectTrustStore(agentDir)
		const storedDecision = trustStore.get(ctx.cwd)
		if (storedDecision !== null) return storedDecision

		const defaultProjectTrust = options.defaultProjectTrust ?? readDefaultProjectTrust(ctx.cwd, agentDir)
		if (defaultProjectTrust === "always") return true
		if (defaultProjectTrust === "never" || !ctx.hasUI || ctx.mode !== "tui") return false

		const selected = await ctx.ui.select(
			`Trust project MCP configuration?\n${ctx.cwd}\n\nThis allows Kimchi to start MCP servers defined by this project.`,
			[TRUST, TRUST_ONCE, DO_NOT_TRUST],
		)
		if (selected === TRUST) {
			trustStore.set(ctx.cwd, true)
			return true
		}
		if (selected === TRUST_ONCE) return true
		if (selected === DO_NOT_TRUST) trustStore.set(ctx.cwd, false)
		return false
	} catch {
		// Trust resolution is a security boundary: unexpected failures fail closed.
		return false
	}
}
