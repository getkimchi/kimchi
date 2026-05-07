// Shared extension factories extracted from cli.ts so that auto.ts can import
// them without triggering cli.ts's top-level side effects (probeTerminalBackground,
// readTelemetryConfig at module load, process.on("exit"), etc.).

import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent"
import type { TelemetryConfig } from "./config.js"
import bashCollapseExtension from "./extensions/bash-collapse.js"
import clipboardImageExtension from "./extensions/clipboard-image.js"
import contextCompactorExtension from "./extensions/context-compactor.js"
import kimchiMinimalTintsExtension from "./extensions/kimchi-minimal-tints.js"
import loginExtension from "./extensions/login/index.js"
import loopGuardExtension from "./extensions/loop-guard.js"
import lspExtension from "./extensions/lsp.js"
import mcpAdapterExtension from "./extensions/mcp-adapter/index.js"
import promptEnrichmentExtension from "./extensions/orchestration/prompt-enrichment.js"
import permissionsExtension from "./extensions/permissions/index.js"
import promptSummaryExtension from "./extensions/prompt-summary.js"
import shutdownMarkerExtension from "./extensions/shutdown-marker.js"
import startupUpdateExtension from "./extensions/startup-update.js"
import subagentExtension from "./extensions/subagent.js"
import tagsExtension from "./extensions/tags.js"
import telemetryExtension from "./extensions/telemetry.js"
import terminalColorsExtension from "./extensions/terminal-colors.js"
import toolRendererExtension from "./extensions/tool-renderer.js"
import uiExtension from "./extensions/ui.js"
import webFetchExtension from "./extensions/web-fetch/index.js"
import webSearchExtension from "./extensions/web-search/index.js"

export interface BaseExtensionDeps {
	telemetryConfig: TelemetryConfig
	skillPaths: string[]
	sessionIdCaptureExtension: (pi: ExtensionAPI) => void
}

export function buildBaseExtensionFactories(deps: BaseExtensionDeps): ExtensionFactory[] {
	return [
		startupUpdateExtension,
		deps.sessionIdCaptureExtension,
		shutdownMarkerExtension,
		terminalColorsExtension,
		kimchiMinimalTintsExtension,
		bashCollapseExtension,
		loopGuardExtension,
		lspExtension,
		mcpAdapterExtension,
		permissionsExtension,
		promptEnrichmentExtension(deps.skillPaths),
		promptSummaryExtension,
		contextCompactorExtension,
		clipboardImageExtension,
		uiExtension,
		subagentExtension,
		tagsExtension,
		telemetryExtension(deps.telemetryConfig),
		toolRendererExtension,
		webFetchExtension,
		webSearchExtension,
		loginExtension,
	]
}

/**
 * Returns a no-op sessionIdCaptureExtension suitable for autonomous runs.
 * Autonomous runs use --no-session so there is no resume hint to print.
 */
export function makeAutonomousSessionIdCapture(): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.on("session_start", () => {
			// no-op: autonomous runs don't need resume hint tracking
		})
	}
}
