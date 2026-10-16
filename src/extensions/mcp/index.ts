/**
 * Kimchi's MCP integration after dropping pi-mcp-adapter: pi 1.3's native
 * built-in MCP extension is the engine.
 *
 * - Interactive (TUI): pi's main() auto-loads `builtin:mcp`; this module only
 *   contributes kimchi-specific notices (`native-migration-notices.ts`). The
 *   `plugins.mcp-apps` org-policy toggle suppresses the built-in via a
 *   `-builtin:mcp` entry seeded into settings (cli.ts).
 * - ACP / headless: pi's built-ins don't auto-load, so
 *   `createKimchiMcpExtension` instantiates the native extension itself and
 *   registers IDE-provided servers via `pi.registerMcpServer()` (converted
 *   from the ACP/adapter server-entry shape with the same translator the
 *   migration uses).
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
	createMcpExtension,
	type ExtensionAPI,
	type ExtensionFactory,
	getAgentDir,
	type McpServerConfig,
} from "@earendil-works/pi-coding-agent"
import { runProjectMcpMigration } from "./config-migration.js"
import { buildGatewayRegistration, getGatewayAddresses, hasGatewayAddress } from "./gateway.js"
import nativeMigrationNoticesExtension from "./native-migration-notices.js"
import type { ServerEntry } from "./types.js"
import mcpWorkObservationExtension from "./work-observation.js"

/** Register the built-in gateway unless a configured server already targets a gateway address. */
function registerGateway(pi: ExtensionAPI, extraServers: Record<string, ServerEntry>): void {
	const gateway = buildGatewayRegistration()
	if (gateway === undefined) return
	try {
		const globalPath = join(getAgentDir(), "mcp.json")
		const configured = existsSync(globalPath)
			? ((JSON.parse(readFileSync(globalPath, "utf8")) as { mcpServers?: Record<string, ServerEntry> }).mcpServers ??
				{})
			: {}
		if (hasGatewayAddress({ ...configured, ...extraServers }, getGatewayAddresses())) return
	} catch {
		// Unreadable config: pi's own config errors will surface; attempt registration anyway.
	}
	pi.registerMcpServer(gateway.name, gateway.config)
}

/** Adapter-shaped server entry accepted from ACP callers (superset of native). */
export type CallerServerEntry = Record<string, unknown>

export interface KimchiMcpExtensionOptions {
	cwd: string
	/** Servers handed in by the ACP client (IDE MCP config), adapter-shaped. */
	callerServers?: Record<string, CallerServerEntry>
}

/** Minimal adapter→native field conversion for programmatic registration. */
function toNativeServerConfig(entry: CallerServerEntry): McpServerConfig {
	const e = { ...entry }
	// Transports.
	if (e.command !== undefined) e.type = "stdio"
	else if (e.url !== undefined) e.type = "http"
	// enabled/disabled.
	if (e.disabled === true) {
		e.disabled = undefined
		e.enabled = false
	} else e.disabled = undefined
	// exposure.
	if (e.directTools === true) {
		e.directTools = undefined
		e.exposure = e.exposure ?? "direct"
	} else e.directTools = undefined
	// Drop adapter-only knobs; native ignores nothing silently here because
	// registerMcpServer validates the same way project/global configs do.
	for (const key of [
		"socket",
		"caFile",
		"requestHeadersCommand",
		"inheritEnv",
		"lifecycle",
		"idleTimeout",
		"protocolVersion",
		"tasks",
		"approveTools",
		"toolPrefix",
		"searchKeywords",
		"exposeResources",
		"pluginDataDir",
		"literalEnv",
		"httpTransport",
		"trace",
		"debug",
		"gateway",
		"oauthCredentialStore",
		"oauthDir",
		"includeTools",
		"excludeTools",
		"bearerToken",
		"bearerTokenEnv",
		"bearerTokenStore",
		"requestTimeoutMs",
	]) {
		delete e[key]
	}
	if (e.auth === "oauth" || e.auth === "bearer" || e.auth === false) e.auth = undefined
	if (e.oauth === true || typeof e.oauth === "string") e.oauth = undefined
	return e as unknown as McpServerConfig
}

/**
 * ACP/headless factory: registers caller-provided servers, then instantiates
 * pi's native MCP extension (which also connects the mcp.json layers).
 */
export function createKimchiMcpExtension(options: KimchiMcpExtensionOptions): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		for (const [name, entry] of Object.entries(options.callerServers ?? {})) {
			try {
				pi.registerMcpServer(name, toNativeServerConfig(entry))
			} catch (error) {
				console.warn(
					`[kimchi-mcp] skipping ACP-provided server "${name}": ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
		registerGateway(pi, options.callerServers ?? {})
		// The launch-time one-shot only migrated the server start cwd's ancestor
		// chain; ACP sessions run in other directories. Translate this session's
		// project file before the native extension reads it.
		try {
			runProjectMcpMigration({ agentDir: getAgentDir(), cwd: options.cwd })
		} catch (error) {
			console.warn(`[kimchi-mcp] project migration failed: ${error instanceof Error ? error.message : String(error)}`)
		}
		mcpWorkObservationExtension(pi)
		createMcpExtension()(pi)
	}
}

/**
 * TUI-side kimchi MCP extension: migration + OAuth re-login notices. The
 * native `builtin:mcp` extension (loaded by pi main()) owns servers, tools,
 * /mcp UI, and auth.
 */
export default function mcpExtension(pi: ExtensionAPI): void {
	// TUI: pi's main() auto-loads the native `builtin:mcp` extension; this only
	// contributes the notes, work observation, and the gateway server registration.
	nativeMigrationNoticesExtension(pi)
	mcpWorkObservationExtension(pi)
	try {
		registerGateway(pi, {})
	} catch {
		// Optionality by design (see buildGatewayRegistration).
	}
}
