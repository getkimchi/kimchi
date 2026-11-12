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
}

/** User-facing, supported configuration surface. Printed by `kimchi env`. */
export const ENV_VARS: EnvVarDef[] = [
	{
		name: "KIMCHI_API_KEY",
		description: "Kimchi API key (overrides config.json apiKey; session-only, never persisted)",
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
		description:
			"Override telemetry (1/true to enable, 0/false to disable). On by default; an organization policy can enforce the effective state",
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
		name: "KIMCHI_BASE_URL",
		description:
			"Override the LLM gateway base URL (chat, router, search; wins over the configured region's endpoints)",
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
		name: "KIMCHI_PR_COST_REPORTING",
		description: "Set 0/false to opt out of PR cost-report uploads (local attribution still runs)",
	},
	{
		name: "KIMCHI_STREAM_IDLE_TIMEOUT_MS",
		description: "Idle timeout for outbound HTTP in ms (0 disables; wins over the httpIdleTimeoutMs setting)",
	},

	{
		name: "KIMCHI_IDLE_GC",
		description: "Set to `off` to disable adaptive idle garbage collection",
	},

	// documents extension (src/extensions/documents)
	{
		name: "KIMCHI_BROWSER",
		description:
			"Path to the Chromium-based browser binary used for document/PDF rendering (takes precedence over auto-detection)",
	},
	{
		name: "KIMCHI_DOCUMENT_MAX_MB",
		description: "Maximum document size in MB accepted by the documents commands",
	},
	{
		name: "KIMCHI_SOFFICE",
		description: "Path to the LibreOffice `soffice` binary (takes precedence over PATH and OS install locations)",
	},
	{
		name: "KIMCHI_PDF_FONT_DIR",
		description: "Directory of .ttf/.otf fonts for PDF rendering when the OS font dirs have nothing suitable",
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
	// diagnostics: submit-path timing marks (src/extensions/submit-timing.ts)
	"KIMCHI_SUBMIT_TIMING",
	// dev/staging endpoint overrides (same category as the OAuth overrides below)
	"KIMCHI_REMOTE_ENDPOINT",
	"KIMCHI_WEB_APP_URL",
	// sentinel set by the container orchestrator, not by users
	"KIMCHI_SANDBOX",
	// debugging (set by kimchi itself when prompt debugging starts)
	"KIMCHI_DEBUG_PROMPTS",
	// internal binary / install plumbing
	"KIMCHI_PROXY_HELPER",
	"KIMCHI_QUICKJS_WASM_PATH",
	"KIMCHI_BRIDGE_BIN_DIR",
	"KIMCHI_BRIDGE_PREFIX",
	"KIMCHI_LSP_IDLE_EVICT_MS",
	"KIMCHI_MANAGES_MCP_PROJECT_TRUST",
	"PI_PACKAGE_DIR",
	"PI_CODING_AGENT_DIR",
	"PI_SKIP_VERSION_CHECK",
	// curator / ferment workflows
	"KIMCHI_FERMENTS_DIR",
	"KIMCHI_AUTO_GIT_INIT",
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
	"KIMCHI_DISABLE_NUDGE_TODO_CHECKIN",
	"KIMCHI_DISABLE_GUARD_LOOP",
	"KIMCHI_DISABLE_GUARD_BASH_TOOL",
	"KIMCHI_DISABLE_GUARD_EXPLORATION",
	"KIMCHI_DISABLE_GUARD_REVIEW_WRITE",
	// memory pipeline tuning (src/extensions/memory)
	"KIMCHI_MEMORY_DRAIN_CONCURRENCY",
	"KIMCHI_MEMORY_DECISION_GATE",
	"KIMCHI_MEMORY_TRANSIENT_MAX_ATTEMPTS",
	"KIMCHI_MEMORY_TRACE_DRAINS",
	"KIMCHI_MEMORY_TRACE_RECALLS",
	// capture-worker chat-model default when no model is threaded in
	"KIMCHI_MODEL",
	// memory rollout flags (src/extensions/memory/flags.ts)
	"KIMCHI_MEMORY_DIGEST_SELECTION_MIN_CANDIDATES",
	"KIMCHI_MEMORY_EXTRACTION_STRICT_NOISE",
	"KIMCHI_MEMORY_EXTRACTION_RECEIPTS",
	"KIMCHI_MEMORY_TASK_SCOPE",
	"KIMCHI_MEMORY_CAPTURE_TOOL_TURNS",
	"KIMCHI_MEMORY_AUTHORED",
	"KIMCHI_MEMORY_FACT_CLASSES",
	"KIMCHI_MEMORY_GATE_NOISE_CLASSES",
	"KIMCHI_MEMORY_VALUATION_CONTEXT",
	"KIMCHI_MEMORY_STALE_AWARE_DIGEST",
	"KIMCHI_MEMORY_STEP_RECALL_INTERVAL",
	"KIMCHI_MEMORY_STATE_FINGERPRINT_CAP",
	// tool-output residency + adaptive idle-GC tuning (docs/memory-residency.md)
	"KIMCHI_TOOL_OUTPUT_STORE",
	"KIMCHI_TOOL_OUTPUT_EXTERNALIZE_BYTES",
	"KIMCHI_TOOL_OUTPUT_CACHE_BYTES",
	"KIMCHI_IDLE_GC_DELAY_MS",
	"KIMCHI_GC_GROWTH_BYTES",
	"KIMCHI_GC_MIN_INTERVAL_MS",
	// debugging / pi-mono plumbing
	"KIMCHI_DEBUG_TOOL_SURFACE",
	"PI_TELEMETRY",
	// CI/benchmark plumbing: provider retry-storm circuit breaker
	// (src/upstream-retry-patch.ts), read via INFRA_BREAKER_THRESHOLD_ENV
	"KIMCHI_INFRA_BREAKER_THRESHOLD",
	// MCP keyring recovery helper pair (src/extensions/mcp/keyring-recovery.ts),
	// read via named constants; set by kimchi itself or overridden together
	"PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE",
	"PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER",
	// test overrides
	"KIMCHI_TEST_HARNESS",
	"KIMCHI_TUI_E2E_CLIPBOARD_IMAGE",
	"KIMCHI_CLIPBOARD_FORCE",
	"KIMCHI_LSP_BINARIES",
	"KIMCHI_DAP_BINARIES",
	"KIMCHI_IDE_LOCKFILE_DIR",
	"KIMCHI_MCP_E2E_KEYRING_DIR",
	"KIMCHI_E2E_FAKE_BROWSER_OPEN",
	"KIMCHI_E2E_BASH_BLOCKING_TIMEOUT_SECONDS",
	"KIMCHI_E2E_COMPLETION_REMINDER_MS",
	"KIMCHI_E2E_BASH_HANDOFF_SECONDS",
	"KIMCHI_E2E_STATIC_TODO_SPINNER",
	"KIMCHI_E2E_COST_REPORT_REFRESH_MS",
	"KIMCHI_E2E_RECONCILIATION_INTERVAL_MS",
	"KIMCHI_E2E_FIRST_TICK_DELAY_MS",
	// TUI-E2E seams read via readE2eSeam (src/extensions/remote-run, permissions)
	"KIMCHI_E2E_FAKE_SANDBOX_GIT",
	"KIMCHI_E2E_FAKE_REMOTE_COMPLETION",
	"KIMCHI_E2E_FAKE_BROWSER_REVIEW",
	"KIMCHI_E2E_FAKE_PLANNOTATOR_DECISION",
	// hand-registered: read via a named constant the scan cannot see
	// (src/extensions/pii-redaction/redaction-events.ts)
	"KIMCHI_DISABLE_REDACTION_EVENTS",
	// hand-registered: set by kimchi for child processes (update/install, bridge)
	"KIMCHI_BIN",
	// OAuth dev/mock endpoint overrides (src/oauth-config.ts)
	"KIMCHI_OAUTH_CLIENT_ID",
	"KIMCHI_OAUTH_AUTHORIZE_URL",
	"KIMCHI_OAUTH_TOKEN_URL",
	"KIMCHI_OAUTH_AUDIENCE",
	"KIMCHI_ORGANIZATIONS_URL",
	"KIMCHI_OAUTH_USE_ID_TOKEN",
]

/**
 * Variables with NO consumer in kimchi's own source: they are referenced
 * only by test files — either because the real consumer is a dependency
 * (PI_MCP_CONFIG_MODE is read by pi-mcp-adapter) or because they gate a
 * manual preview test (KIMCHI_SHOW_OAUTH_PAGE). For these, test-file
 * references count as "used" in the stale check; for every other list,
 * only non-test code does.
 */
export const TEST_SUITE_ENV_VARS: string[] = [
	"KIMCHI_SHOW_OAUTH_PAGE",
	"PI_MCP_CONFIG_MODE",
	// stubbed only by the login test suite; nothing in non-test src reads it
	"KIMCHI_CONFIG_PATH",
	// literal appears only in tests — oauth-config.ts builds the
	// region-tagged client-id var dynamically via `${KIMCHI_OAUTH_CLIENT_ID_${regionTag}}`
	"KIMCHI_OAUTH_CLIENT_ID_US",
	"KIMCHI_OAUTH_CLIENT_ID_EU",
	// fixture name used by the e2e-seam helper's own unit test
	"KIMCHI_E2E_TEST_SEAM",
	// consumed by dependencies, referenced only from our tests
	"PI_MCP_ADAPTER_TEST_AUTH_STORE",
	"PI_OFFLINE",
	// oauth-rotation e2e unit-suite debug toggles (tests keep the events log /
	// print child store operations), and the adapter store key the suite
	// overrides to scope credential storage per child
	"KIMCHI_KEEP_OAUTH_TMP",
	"KIMCHI_OAUTH_VERBOSE",
	"PI_MCP_ADAPTER_OAUTH_FILE_KEY",
	// rotation-recovery debug toggle in the patched adapter: silent by default,
	// set to 1 to capture recovery diagnostics for a bug report (see
	// docs/mcp-live-testing-setup.md and the adapter patch header)
	"PI_MCP_ADAPTER_DEBUG_AUTH",
]
