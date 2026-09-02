import { readTelemetryConfig, writeTelemetryEnabled } from "../config.js"
import { sendPreSessionEvent } from "../extensions/telemetry/pre-session.js"

const TELEMETRY_ENV = "KIMCHI_TELEMETRY_ENABLED"

/**
 * `kimchi config telemetry [on|off]` — show or set telemetry.enabled in
 * config.json. With no value, prints the current state (and notes when
 * an env-var override is in effect).
 *
 * Anything else under `kimchi config <subcommand>` is unrecognised; we
 * print a usage line and return 2 (POSIX "incorrect invocation").
 */
export async function runConfig(args: string[]): Promise<number> {
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
		printUsage()
		return args.length === 0 ? 1 : 0
	}

	const sub = args[0]
	const rest = args.slice(1)

	switch (sub) {
		case "telemetry":
			return handleTelemetry(rest)
		default:
			console.error(`kimchi config: unknown subcommand "${sub}"`)
			printUsage()
			return 2
	}
}

function handleTelemetry(args: string[]): number {
	if (args.length === 0) {
		const cfg = readTelemetryConfig()
		const status = cfg.enabled ? "enabled" : "disabled"
		const envVal = process.env[TELEMETRY_ENV]
		if (envVal !== undefined && envVal !== "") {
			console.log(`Telemetry: ${status} (from ${TELEMETRY_ENV}=${envVal}, overrides config)`)
		} else {
			console.log(`Telemetry: ${status} (from config)`)
		}
		return 0
	}

	const value = args[0].toLowerCase()
	const enabled = parseSwitch(value)
	if (enabled === null) {
		console.error(`kimchi config telemetry: expected "on" or "off", got "${args[0]}"`)
		return 2
	}
	writeTelemetryEnabled(enabled)
	// Emit config_changed telemetry so we can track telemetry opt-in/out.
	// Re-read config to pick up the updated state + auth headers.
	const telemetryConfig = readTelemetryConfig()
	// When turning telemetry OFF, the re-read config has enabled=false, which
	// would cause sendPreSessionEvent to no-op and silently drop the opt-out
	// signal. Temporarily force enabled=true on the config passed to
	// sendPreSessionEvent so the event reaches the backend; the actual new
	// state is carried in the `value` property.
	if (!enabled) telemetryConfig.enabled = true
	sendPreSessionEvent(telemetryConfig, "config_changed", {
		key: "telemetry.enabled",
		value: enabled,
	})
	console.log(`Telemetry ${enabled ? "enabled" : "disabled"}`)
	return 0
}

/**
 * Accept the common on/off, true/false, yes/no, 1/0 spellings so users
 * don't have to remember which CLI takes which.
 */
function parseSwitch(s: string): boolean | null {
	switch (s) {
		case "on":
		case "true":
		case "yes":
		case "1":
		case "enable":
		case "enabled":
			return true
		case "off":
		case "false":
		case "no":
		case "0":
		case "disable":
		case "disabled":
			return false
		default:
			return null
	}
}

function printUsage(): void {
	console.error("Usage: kimchi config telemetry [on|off]")
	console.error("       kimchi config telemetry           # show current status")
}
