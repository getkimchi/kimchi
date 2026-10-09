// Self-contained synthetic document fixtures for TUI e2e tests.
// Kept dependency-local on purpose: the tui-test cache flattens test files,
// so runtime imports into src/… resolve against the wrong base. Unit-level
// extractor coverage lives in src/extensions/documents/** — these fixtures
// only need to survive round-tripping through the extraction pipeline.

import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib"

/** Tiny two-page PDF with extractable text (no pdfjs needed to build). */
export async function makeSimplePdf(): Promise<Uint8Array> {
	const doc = await PDFDocument.create()
	const font = await doc.embedFont(StandardFonts.Helvetica)
	for (const text of ["Hello from page one", "and a second page."]) {
		const page = doc.addPage([200, 200])
		page.drawText(text, { x: 20, y: 160, size: 12, font })
	}
	return doc.save()
}
