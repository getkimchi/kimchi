import { describe, expect, it } from "vitest"
import { DOC_CLI_COMMANDS, DOC_CLI_SKILLS } from "../../documents/doc-cli-skills.js"
import { DOCUMENT_ERROR_CODES } from "../../documents/model.js"
import { attributeDocumentCliCommand, extractDocumentErrorCode } from "./document-cli.js"

describe("document CLI command attribution", () => {
	for (const documentType of DOC_CLI_SKILLS) {
		describe(documentType, () => {
			for (const operation of DOC_CLI_COMMANDS[documentType]) {
				it(`recognizes primary ${operation}`, () => {
					expect(attributeDocumentCliCommand(`kimchi doc-cli ${documentType} ${operation} input`)).toEqual({
						documentType,
						operation,
					})
				})
			}

			it("recognizes the documented Node fallback", () => {
				expect(
					attributeDocumentCliCommand(
						`KIMCHI_DOCUMENT_MAX_MB=25 node /opt/skills/${documentType}/scripts/${documentType}.mjs read input 2>&1 | tail -20`,
					),
				).toEqual({ documentType, operation: "read" })
			})
		})
	}

	it("recognizes quoted paths containing spaces", () => {
		expect(attributeDocumentCliCommand('node "/tmp/skill root/pdf/scripts/pdf.mjs" read "/tmp/my report.pdf"')).toEqual(
			{ documentType: "pdf", operation: "read" },
		)
	})

	it("recognizes Windows fallback paths", () => {
		expect(attributeDocumentCliCommand(String.raw`node "C:\skills\pdf\scripts\pdf.mjs" info input.pdf`)).toEqual({
			documentType: "pdf",
			operation: "info",
		})
	})

	it("normalizes unknown operations without retaining their text", () => {
		const secret = "/Users/example/private-operation"
		const result = attributeDocumentCliCommand(`kimchi doc-cli pdf ${secret}`)
		expect(result).toEqual({ documentType: "pdf", operation: "unknown" })
		expect(JSON.stringify(result)).not.toContain(secret)
	})

	it.each([
		"ls -la",
		"node other.mjs read",
		"node /tmp/pdf.mjs read",
		"kimchi doc-cli pdf read input && rm -rf /tmp/output",
		"node /opt/skills/pdf/scripts/pdf.mjs read input; node /opt/skills/docx/scripts/docx.mjs read other",
		"node /opt/skills/pdf/scripts/pdf.mjs read input > /tmp/result.txt",
		"node /opt/skills/pdf/scripts/pdf.mjs read input | sh",
	])("rejects ambiguous or non-document command %s", (command) => {
		expect(attributeDocumentCliCommand(command)).toBeUndefined()
	})
})

describe("document error-code extraction", () => {
	for (const code of DOCUMENT_ERROR_CODES) {
		it(`extracts ${code}`, () => {
			expect(
				extractDocumentErrorCode(`output\nerror [${code}]: /private/input.pdf failed\nCommand exited with code 2`),
			).toBe(code)
		})
	}

	it("rejects unknown codes and malformed prefixes", () => {
		expect(extractDocumentErrorCode("error [private-code]: secret\nwarning [corrupt]: no")).toBeUndefined()
	})

	it("does not capture the message or path", () => {
		const output = "error [password-protected]: /private/report.pdf cannot be opened"
		const result = extractDocumentErrorCode(output)
		expect(result).toBe("password-protected")
		expect(JSON.stringify(result)).not.toContain("/private/report.pdf")
	})
})
