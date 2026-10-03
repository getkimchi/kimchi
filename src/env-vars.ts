/**
 * Central registry of every environment variable kimchi recognises.
 *
 * Three audiences:
 *  - ENV_VARS — supported, user-facing configuration. Printed by `kimchi env`.
 *    Each entry needs a description.
 *  - IGNORED_ENV_VARS — internal plumbing (dev/workflow/child-process).
 *    Never printed anywhere; names only, registered so the scan test still
 *    enforces that every variable in the codebase is accounted for.
 *  - TEST_SUITE_ENV_VARS — referenced only by the test suite itself (the
 *    real consumer is a dependency or a manual preview test). Never printed.
 *
 * A unit test (src/env-vars.test.ts) scans src/** for env-var references and
 * fails when a variable is used without being in one of these lists, when a
 * non-test-suite list holds a name no longer referenced in non-test code
 * (i.e. it was removed from business logic), or when a name looks like a
 * mixed-case typo — so these lists cannot silently drift.
 */

export interface EnvVarDef {
	name: string
	description: string
	/** Secret value — `kimchi env` masks it when printing. */
	secret?: boolean
}

/** User-facing, supported configuration surface. Printed by `kimchi env`. */
export const ENV_VARS: EnvVarDef[] = [
	{
		name: "KIMCHI_API_KEY",
		description: "Kimchi API key (overrides config.json apiKey; session-only, never persisted)",
		secret: true,
	},
	{
		name: "KIMCHI_REGION",
		description: "Endpoint region override: us | eu (for headless/CI setups; unknown values are ignored)",
	},
	{
		name: "KIMCHI_PERMISSIONS",
		description: "Initial permissions mode: default | plan | auto | yolo",
	},
	{
		name: "KIMCHI_TELEMETRY_ENABLED",
		description: "Override telemetry (1/true to enable, 0/false to disable). On by default",
	},
	{
		name: "KIMCHI_TAGS",
		description: "Comma-separated `key:value` tags applied to every LLM request",
	},
	{
		name: "KIMCHI_NO_UPDATE_CHECK",
		description: "Disable the background self-update probe",
	},
	{
		name: "KIMCHI_CODING_AGENT_DIR",
		description: "Override the kimchi config/session directory (default: ~/.config/kimchi/harness)",
	},
	{
		name: "KIMCHI_ENABLE_RESOURCES",
		description: "Comma-separated resource ids (hooks/tools/extensions) to enable for this invocation only",
	},
	{
		name: "KIMCHI_REDACTION_ENABLED",
		description: "Enable/disable PII redaction of prompts (1 to enable; 0/false to disable). Off by default",
	},
	{
		name: "KIMCHI_PROXY",
		description: "HTTP(S) proxy URL for outbound traffic; takes precedence over HTTP(S)_PROXY",
	},
	{
		name: "KIMCHI_NO_PROXY",
		description: "Hosts that bypass the proxy (see NO_PROXY semantics)",
	},
	{
		name: "OLLAMA_HOST",
		description: "Ollama endpoint URL (takes precedence over KIMCHI_OLLAMA_HOST; default http://localhost:11434)",
	},
	{
		name: "KIMCHI_OLLAMA_HOST",
		description: "Ollama endpoint URL fallback when OLLAMA_HOST is unset",
	},
	{
		name: "KIMCHI_REMOTE_ENDPOINT",
		description: "Override the platform API URL (defaults to the configured region's endpoint)",
	},
	{
		name: "KIMCHI_BASE_URL",
		description:
			"Override the LLM gateway base URL (chat, router, search; wins over the configured region's endpoints)",
	},
	{
		name: "KIMCHI_WEB_APP_URL",
		description: "Override the web app URL used for login and browser hand-offs",
	},
	{
		name: "KIMCHI_REMOTE_RUN",
		description: "Disable remote-run dispatch with 0/false (enabled by default outside sandbox clusters)",
	},
	{
		name: "KIMCHI_MEMORY_CAPTURE",
		description: "Set to `off` to skip memory capture entirely for the session",
	},
	{
		name: "KIMCHI_MEMORY_DRAIN_CONCURRENCY",
		description: "Concurrency limit for memory-capture drain jobs (default: 6)",
	},
	{
		name: "KIMCHI_FERMENTS_DIR",
		description: "Override the directory where ferment state is stored",
	},
	{
		name: "KIMCHI_AUTO_GIT_INIT",
		description: "Set to 1 to run `git init` without prompting in non-interactive ferment flows",
	},
	{
		name: "KIMCHI_SANDBOX",
		description: "Mark the process as running inside a sandbox cluster (1/true)",
	},
	{
		name: "KIMCHI_PROXY_HELPER",
		description: "Explicit proxy-helper binary override used by the SSH proxy support",
	},
	{
		name: "KIMCHI_DEBUG_PROMPTS",
		description: "Enable debug dumps of assembled prompts (set by kimchi when prompt debugging starts)",
	},
	{
		name: "KIMCHI_WHEEL_SCROLL_LINES",
		description: "Mouse-wheel scroll lines in the TUI (overrides the tui.wheelScrollLines config value)",
	},
]

/**
 * Internal plumbing: dev/test/workflow overrides and variables kimchi sets
 * itself for child processes and hooks. Registered for completeness of the
 * scan test only — never printed by `kimchi env` or `kimchi --help`.
 */
export const IGNORED_ENV_VARS: string[] = [
	// credentials used by the CAST AI backend / telemetry plumbing
	"CASTAI_API_KEY",
	"KIMCHI_TELEMETRY_DEBUG",
	// debugging
	"KIMCHI_DEBUG_SESSION",
	// set by kimchi for child processes, hooks, and pi-mono
	"KIMCHI_ORIGINAL_PI_CODING_AGENT_DIR",
	"KIMCHI_DISABLE_BUILTIN_PROVIDERS",
	"KIMCHI_OAUTH_TEMPLATE_DIR",
	"KIMCHI_PARENT_SESSION_ID",
	"KIMCHI_SUBAGENT",
	"KIMCHI_AGENT_PERSONA",
	"KIMCHI_HOOK_EVENT",
	"KIMCHI_TOOL_NAME",
	"KIMCHI_TOOL_INPUT_COMMAND",
	"PI_PACKAGE_DIR",
	"PI_CODING_AGENT_DIR",
	"PI_SKIP_VERSION_CHECK",
	// curator / ferment workflows
	"KIMCHI_SESSION_REVIEW",
	"KIMCHI_REVIEW_THRESHOLD",
	"KIMCHI_REVIEW_LOG",
	"KIMCHI_ACTIVE_FERMENT",
	"KIMCHI_FERMENT_LOCK_DIR",
	"KIMCHI_FERMENT_LOCK_MAX_AGE_MS",
	"KIMCHI_FERMENT_DISABLE_PARALLEL",
	"KIMCHI_CONTEXT_DATE",
	// per-nudge/per-guard kill switches (src/extensions/steer-events.ts), read ad-hoc
	"KIMCHI_DISABLE_NUDGE_TODO_EARLY",
	"KIMCHI_DISABLE_NUDGE_STALENESS",
	"KIMCHI_DISABLE_NUDGE_BASH_TIMEOUT",
	"KIMCHI_DISABLE_NUDGE_BASH_CONTROL_CHECKIN",
	"KIMCHI_DISABLE_NUDGE_CONTINUATION",
	"KIMCHI_DISABLE_NUDGE_PLANNING_STOP",
	"KIMCHI_DISABLE_GUARD_LOOP",
	"KIMCHI_DISABLE_GUARD_BASH_TOOL",
	"KIMCHI_DISABLE_GUARD_EXPLORATION",
	"KIMCHI_DISABLE_GUARD_REVIEW_WRITE",
	// test overrides
	"KIMCHI_TEST_HARNESS",
	"KIMCHI_TUI_E2E_CLIPBOARD_IMAGE",
	"KIMCHI_CLIPBOARD_FORCE",
	"KIMCHI_LSP_BINARIES",
	"KIMCHI_DAP_BINARIES",
	"KIMCHI_IDE_LOCKFILE_DIR",
	"KIMCHI_MCP_E2E_KEYRING_DIR",
]

/**
 * Variables with NO consumer in kimchi's own source: they are referenced
 * only by test files — either because the real consumer is a dependency
 * (PI_MCP_CONFIG_MODE is read by pi-mcp-adapter) or because they gate a
 * manual preview test (KIMCHI_SHOW_OAUTH_PAGE). For these, test-file
 * references count as "used" in the stale check; for every other list,
 * only non-test code does.
 */
export const TEST_SUITE_ENV_VARS: string[] = ["KIMCHI_SHOW_OAUTH_PAGE", "PI_MCP_CONFIG_MODE"]
