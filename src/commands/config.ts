import { loadConfig, readTelemetryConfig, writeTelemetryEnabled, writeTuiWheelScrollLines } from "../config.js"
import { sendPreSessionEvent } from "../extensions/telemetry/pre-session.js"
import { isRegionId, REGION_ENV, REGIONS, SELF_HOSTED_URL_ENV, selectableRegions } from "../regions.js"
import { isTelemetryPolicyEnforced, readEffectiveTelemetryConfig, usageReportingPolicy } from "../telemetry-policy.js"

const TELEMETRY_ENV = "KIMCHI_TELEMETRY_ENABLED"

/**
 * Allowlist of config keys writable via `kimchi config set` — deliberately
 * not arbitrary dotted paths, so `config set` cannot mutate sensitive or
 * schema-constrained keys (apiKey, region, …). Each entry pairs the CLI
 * surface validation with its config.js writer. New writable keys go here.
 */
interface WritableKeyDef {
	parse: (raw: string) => number | null
	write: (value: number) => void
	describeValue: string
	defaultDisplay: string
}

const WRITABLE_KEYS: Record<string, WritableKeyDef> = {
	"tui.wheelScrollLines": {
		parse: (raw) => {
			const n = Number(raw)
			return Number.isInteger(n) && n >= 1 ? n : null
		},
		write: (lines) => writeTuiWheelScrollLines(lines),
		describeValue: "an integer ≥ 1",
		defaultDisplay: 'unset (default "auto")',
	},
}

/**
 * `kimchi config telemetry [on|off]` — show or set telemetry.enabled in
 * config.json. With no value, prints the effective state (and notes when
 * an env-var override or an org usage-reporting policy is in effect).
 * Policy enforcement never rewrites the persisted preference — it applies
 * per session, so a later USER_CHOICE transition restores the user's choice.
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
		case "region":
			return handleRegion(rest)
		case "set":
			return handleSet(rest)
		case "get":
			return handleGet(rest)
		default:
			console.error(`kimchi config: unknown subcommand "${sub}"`)
			printUsage()
			return 2
	}
}

function handleTelemetry(args: string[]): number {
	const policy = usageReportingPolicy()
	const policyEnforced = isTelemetryPolicyEnforced()

	if (args.length === 0) {
		const cfg = readEffectiveTelemetryConfig()
		const status = cfg.enabled ? "enabled" : "disabled"
		const envVal = process.env[TELEMETRY_ENV]
		if (policyEnforced) {
			const enforcedNote = `enforced ${cfg.enabled ? "on" : "off"} by your organization's policy`
			console.log(
				envVal !== undefined && envVal !== ""
					? `Telemetry: ${status} (${enforcedNote}; from ${TELEMETRY_ENV}=${envVal}, overrides config)`
					: `Telemetry: ${status} (${enforcedNote})`,
			)
			return 0
		}
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
	// Persist the user's choice even when the org policy overrides it: a later
	// USER_CHOICE transition restores their agency, mirroring how the env var
	// already wins over the persisted value.
	writeTelemetryEnabled(enabled)
	console.log(`Telemetry ${enabled ? "enabled" : "disabled"}`)

	if (policy === "FORCE_OFF") {
		// Reporting is org-forbidden: no config_changed signal at all — the
		// force-enable hack below must never fire under FORCE_OFF.
		if (enabled) notePolicyEnforcement("off")
		return 0
	}

	// Emit config_changed telemetry so we can track telemetry opt-in/out.
	// Re-read config to pick up the updated state + auth headers.
	const telemetryConfig = readTelemetryConfig()
	// When turning telemetry OFF, the re-read config has enabled=false, which
	// would cause sendPreSessionEvent to no-op and silently drop the opt-out
	// signal. Temporarily force enabled=true on the config passed to
	// sendPreSessionEvent so the event reaches the backend; the actual new
	// state is carried in the `value` property. Under FORCE_ON this stays —
	// reporting is permitted and the opt-out attempt is the wanted signal.
	if (!enabled) telemetryConfig.enabled = true
	sendPreSessionEvent(telemetryConfig, "config_changed", {
		key: "telemetry.enabled",
		value: enabled,
	})
	if (policy === "FORCE_ON" && !enabled) notePolicyEnforcement("on")
	return 0
}

function notePolicyEnforcement(state: "on" | "off"): void {
	console.log(`Note: your organization's policy enforces telemetry ${state}; effective state unchanged.`)
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

function handleSet(args: string[]): number {
	const [key, raw, ...extra] = args
	if (!key || raw === undefined || extra.length > 0) {
		console.error("Usage: kimchi config set <key> <value>")
		printWritableKeys()
		return 2
	}
	const def = WRITABLE_KEYS[key]
	if (!def) {
		console.error(`kimchi config set: unknown or read-only key "${key}"`)
		printWritableKeys()
		return 2
	}
	const value = def.parse(raw)
	if (value === null) {
		console.error(`kimchi config set ${key}: invalid value "${raw}" (expected ${def.describeValue})`)
		return 2
	}
	def.write(value)
	console.log(`${key} = ${value} (written to global config)`)
	return 0
}

function handleGet(args: string[]): number {
	const [key, ...extra] = args
	if (!key || extra.length > 0) {
		console.error("Usage: kimchi config get <key>")
		printWritableKeys()
		return 2
	}
	const def = WRITABLE_KEYS[key]
	if (!def) {
		console.error(`kimchi config get: unknown or read-only key "${key}"`)
		printWritableKeys()
		return 2
	}
	// Dot-walk the merged config — project config (trusted) wins over global.
	let current: unknown = loadConfig()
	for (const part of key.split(".")) {
		current = current !== null && typeof current === "object" ? (current as Record<string, unknown>)[part] : undefined
	}
	console.log(`${key}: ${current === undefined ? def.defaultDisplay : String(current)} (from config)`)
	return 0
}

function printWritableKeys(): void {
	console.error(`       writable keys: ${Object.keys(WRITABLE_KEYS).join(", ")}`)
}

function printUsage(): void {
	console.error("Usage: kimchi config telemetry [on|off]")
	console.error("       kimchi config telemetry           # show effective status (an org policy may enforce it)")
	console.error("       kimchi config region              # show the endpoint region (chosen at login)")
	console.error("       kimchi config set <key> <value>   # write a config key")
	console.error("       kimchi config get <key>           # show a config key's effective value")
	printWritableKeys()
}

/**
 * `kimchi config region` — show the endpoint region. It is chosen at login and
 * tied to the API key, so there is no set verb (headless setups can set KIMCHI_REGION).
 */
function handleRegion(args: string[]): number {
	if (args.length > 0) {
		console.error(
			`kimchi config region: region is chosen at login and tied to your API key. Run "kimchi login" again to switch regions (headless setups can set ${REGION_ENV}=us|eu|self-hosted).`,
		)
		return 2
	}

	const cfg = loadConfig()
	const current = REGIONS[cfg.region]
	const envVal = process.env[REGION_ENV]
	if (isRegionId(envVal)) {
		console.log(`Region: ${current.id} — ${current.label} (from ${REGION_ENV}=${envVal}, overrides config)`)
	} else {
		if (envVal) console.warn(`Ignoring invalid ${REGION_ENV}=${envVal} (expected us|eu|self-hosted)`)
		console.log(`Region: ${current.id} — ${current.label}`)
	}
	// Self-hosted is only meaningful with its base URL; show what is
	// configured (env override wins over the stored value, like the region).
	if (cfg.region === "self-hosted") {
		const envBase = process.env[SELF_HOSTED_URL_ENV]
		if (cfg.selfHostedUrl && envBase) {
			console.log(`Self-hosted base URL: ${cfg.selfHostedUrl} (from ${SELF_HOSTED_URL_ENV}, overrides config)`)
		} else if (cfg.selfHostedUrl) {
			console.log(`Self-hosted base URL: ${cfg.selfHostedUrl}`)
		} else {
			console.log(
				`Self-hosted base URL: not configured — set ${SELF_HOSTED_URL_ENV} or run "kimchi login" and choose Self-hosted`,
			)
		}
	}
	console.log(
		`Available regions: ${selectableRegions()
			.map((r) => `${r.id} (${r.label})`)
			.join(", ")}`,
	)
	console.log('To switch regions, run "kimchi login" again.')
	return 0
}
