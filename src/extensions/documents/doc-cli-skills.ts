/**
 * The bundled document skills that ship a `scripts/<skill>.mjs` CLI — the
 * closed set both the doc-cli launcher (src/extensions/documents/doc-cli-main.ts)
 * and the permission gate (src/extensions/permissions/bundled-skill-cli.ts)
 * consume. Keep this module a leaf (no imports) so the gate's static graph
 * depends on data only.
 */
export const DOC_CLI_SKILLS = ["pdf", "docx", "xlsx", "pptx"] as const
export type DocCliSkill = (typeof DOC_CLI_SKILLS)[number]

/** Read-only subcommands per skill — the ones the permission gate also
 *  accepts in default mode (mutating commands still prompt there, and
 *  everything still skips the classifier in auto mode). Derived from each
 *  CLI's case list: anything that writes a file (create/edit/render/…)
 *  is excluded. */
export const DOC_CLI_READ_ONLY_COMMANDS: Record<DocCliSkill, readonly string[]> = {
	pdf: ["read", "info", "fields", "dump-shapes"],
	docx: ["read", "info"],
	xlsx: ["read", "info"],
	pptx: ["read", "inspect", "check"],
}
