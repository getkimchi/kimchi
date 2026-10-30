/**
 * The bundled document skills that ship a `scripts/<skill>.mjs` CLI — the
 * closed set both the doc-cli launcher (src/extensions/documents/doc-cli-main.ts)
 * and the permission gate (src/extensions/permissions/bundled-skill-cli.ts)
 * consume. Keep this module a leaf (no imports) so the gate's static graph
 * depends on data only.
 */
export const DOC_CLI_SKILLS = ["pdf", "docx", "xlsx", "pptx"] as const
export type DocCliSkill = (typeof DOC_CLI_SKILLS)[number]
