import { readTelemetryConfig } from "../config.js"
import { drain as drainPreSessionTelemetry, sendPreSessionEvent } from "../extensions/telemetry/pre-session.js"
import { runWizard } from "../setup-wizard/index.js"

export async function runSetup(_args: string[]): Promise<number> {
	const telemetryConfig = readTelemetryConfig()
	const result = await runWizard()

	if (!telemetryConfig.enabled) {
		return result.cancelled ? 130 : 0
	}

	if (result.cancelled) {
		sendPreSessionEvent(telemetryConfig, "setup_aborted", {
			step: result.cancelledStep ?? "unknown",
		})
		await drainPreSessionTelemetry()
		return 130
	}

	// Track each selected tool individually
	for (const tool of result.selectedTools) {
		sendPreSessionEvent(telemetryConfig, "tool_configured", { tool_name: tool })
	}

	sendPreSessionEvent(telemetryConfig, "setup_completed", {
		tools_count: result.selectedTools.length,
		scope: result.scope ?? "global",
	})

	await drainPreSessionTelemetry()
	return 0
}
