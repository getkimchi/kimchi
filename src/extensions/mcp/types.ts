/**
 * Compatibility type for code that used to import `ServerEntry` from
 * pi-mcp-adapter. Post-migration the adapter is gone; native pi has
 * `McpServerConfig` (narrower). Kimchi's discovery/import/CLI layers accept
 * the looser adapter-shaped JSON and leave dropping unsupported fields to the
 * native loader's own validation and the migration translation.
 */
export interface ServerEntry {
	description?: string
	command?: string
	args?: string[]
	env?: Record<string, string>
	cwd?: string
	url?: string
	headers?: Record<string, string>
	disabled?: boolean
	/** Anything else the adapter accepted and native may or may not keep. */
	[key: string]: unknown
}
