/**
 * Documents extension — read PDF/DOCX/PPTX/XLSX (and XLS/ODS/CSV) as
 * Markdown. Gated by the `extensions.documents` experimental resource:
 * registered only when enabled (cli.ts `enabledExtensionFactories`), so a
 * disabled toggle is byte-identical to a kimchi without the extension.
 *
 * Ships: the read_document tool + transparent `read` interception.
 * @file rewriting happens in cli.ts (before extensions load; it checks
 * isResourceEnabled directly). Writes arrive in Phases 2–4 under the
 * separate `extensions.documents-write` toggle.
 */

import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent"
import { installReadInterception } from "./read-intercept.js"
import { createReadDocumentTool, type ReadDocumentDeps } from "./read-tool.js"

export const DOCUMENTS_RESOURCE_ID = "extensions.documents"

export function createDocumentsExtension(deps: ReadDocumentDeps = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerTool(createReadDocumentTool(deps))
		installReadInterception(pi)
	}
}

export default function documentsExtension(pi: ExtensionAPI): void {
	createDocumentsExtension()(pi)
}
