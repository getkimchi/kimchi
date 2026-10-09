import JSZip from "jszip"
import { describe, expect, it } from "vitest"
import { listZipEntries, openOoxml } from "./package.js"
import { serializeXml } from "./xml.js"

async function makeZip(
	entries: Record<string, string | Uint8Array>,
	options: { unixPermissions?: number } = {},
): Promise<Uint8Array> {
	const zip = new JSZip()
	for (const [name, content] of Object.entries(entries)) {
		zip.file(name, content, options.unixPermissions ? { unixPermissions: options.unixPermissions } : undefined)
	}
	// DEFLATE so the zip-bomb fixture actually falls below the 100:1 cap
	// (jszip defaults to STORE, where compressed === uncompressed). UNIX
	// platform so unixPermissions land in the external attributes.
	return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", platform: "UNIX" })
}

describe("listZipEntries", () => {
	it("lists entries without inflation", async () => {
		const data = await makeZip({ "a/b.xml": "x", "c.xml": "y" })
		expect((await listZipEntries(data)).sort()).toEqual(["a/b.xml", "c.xml"])
	})

	it("rejects path-traversal entries", async () => {
		const data = await makeZip({ "../evil": "x" })
		await expect(listZipEntries(data)).rejects.toMatchObject({ name: "DocumentError", code: "safety-limit" })
	})

	it("rejects absolute-path entries", async () => {
		const data = await makeZip({ "/tmp/evil": "x" })
		await expect(listZipEntries(data)).rejects.toMatchObject({ code: "safety-limit" })
	})

	it("rejects prototype-pollution entry names", async () => {
		// jszip cannot generate a `__proto__` entry (it collides with the
		// plain-object prototype), so byte-patch a normal zip: entry names
		// appear verbatim in both the local header and the central directory
		// and are not covered by the entry CRC.
		const data = await makeZip({ XXPROTOXX: "x" })
		const sentinel = new TextEncoder().encode("XXPROTOXX")
		const proto = new TextEncoder().encode("__proto__")
		const patched = new Uint8Array(data)
		for (let i = 0; i + sentinel.length <= patched.length; i++) {
			if (sentinel.every((b, j) => patched[i + j] === b)) patched.set(proto, i)
		}
		await expect(listZipEntries(patched)).rejects.toMatchObject({ code: "safety-limit" })
	})

	it("rejects symlink entries (unix mode)", async () => {
		// 0o120777: symlink with 0777 perms
		const data = await makeZip({ link: "target-content" }, { unixPermissions: 0o120777 })
		await expect(listZipEntries(data)).rejects.toMatchObject({ code: "safety-limit" })
	})

	it("rejects a zip bomb in under 1s", async () => {
		// 10 MB of zeros → DEFLATE ~10 KB: ~1000:1 ratio, way past the 100:1 cap.
		const bombEntry = new Uint8Array(10 * 1024 * 1024)
		const started = Date.now()
		const data = await makeZip({ "bomb.bin": bombEntry })
		await expect(listZipEntries(data)).rejects.toMatchObject({ code: "safety-limit" })
		expect(Date.now() - started).toBeLessThan(1000)
	})

	it("passes a legitimate small-part XLSX under the grace rule", async () => {
		// Parts under 100 KB uncompressed are exempt from the ratio check —
		// small XML parts legitimately compress far better than 100:1.
		const highlyCompressibleSmall = "x".repeat(99 * 1024)
		const data = await makeZip({ "xl/workbook.xml": highlyCompressibleSmall, "xl/worksheets/sheet1.xml": "<s/>" })
		expect(await listZipEntries(data)).toContain("xl/workbook.xml")
	})

	it("rejects corrupt zips as typed DocumentError", async () => {
		await expect(
			listZipEntries(new TextEncoder().encode("PK\x03\x04 not a real zip padding padding")),
		).rejects.toMatchObject({ name: "DocumentError" })
	})
})

describe("openOoxml", () => {
	it("preserves part contents on open → save with no edits", async () => {
		const data = await makeZip({
			"[Content_Types].xml": "<Types/>",
			"word/document.xml": "<w:document>hello</w:document>",
			"word/media/pic.png": new Uint8Array([1, 2, 3, 4, 5]),
		})
		const pkg = await openOoxml(data)
		expect(pkg.getBytes("word/document.xml")).toEqual(new TextEncoder().encode("<w:document>hello</w:document>"))
		const saved = await pkg.save()
		const reopened = await openOoxml(saved)
		expect(reopened.getBytes("word/document.xml")).toEqual(new TextEncoder().encode("<w:document>hello</w:document>"))
		expect(reopened.getBytes("word/media/pic.png")).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
	})

	it("parses and mutates XML parts", async () => {
		const data = await makeZip({
			"ppt/presentation.xml": '<p:presentation xmlns:p="urn:x"><p:sldIdLst/></p:presentation>',
		})
		const pkg = await openOoxml(data)
		const doc = pkg.getXml("ppt/presentation.xml")
		expect(doc.documentElement?.tagName).toBe("p:presentation")
		pkg.putXml("ppt/presentation.xml", doc)
		const saved = await pkg.save()
		const reopened = await openOoxml(saved)
		expect(serializeXml(reopened.getXml("ppt/presentation.xml"))).toBe(serializeXml(doc))
	})

	it("throws on XML parse failure", async () => {
		const data = await makeZip({ "bad.xml": "<unclosed>" })
		const pkg = await openOoxml(data)
		expect(() => pkg.getXml("bad.xml")).toThrow(/XML parse failed/)
	})
})
