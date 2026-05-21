import { readTelemetryConfig } from "../config.js"
import { ensureDeviceId } from "../posthog-device.js"
import { capturePostHogEvent } from "../posthog.js"
import { runWizard } from "../setup-wizard/index.js"

export async function runSetup(_args: string[]): Promise<number> {
	const telemetryConfig = readTelemetryConfig()
	const deviceId = ensureDeviceId()

	const result = await runWizard()

	if (!telemetryConfig.enabled || !deviceId) {
		return result.cancelled ? 130 : 0
	}

	const pending: Promise<void>[] = []

	if (result.cancelled) {
		pending.push(
			capturePostHogEvent({
				event: "setup_aborted",
				distinctId: deviceId,
				properties: { step: result.cancelledStep ?? "unknown" },
			}),
		)
		await Promise.allSettled(pending)
		return 130
	}

	// Track each selected tool individually
	for (const tool of result.selectedTools) {
		pending.push(
			capturePostHogEvent({
				event: "tool_configured",
				distinctId: deviceId,
				properties: { tool_name: tool },
			}),
		)
	}

	pending.push(
		capturePostHogEvent({
			event: "setup_completed",
			distinctId: deviceId,
			properties: {
				tools_count: result.selectedTools.length,
				scope: result.scope ?? "global",
			},
		}),
	)

	await Promise.allSettled(pending)
	return 0
}
