import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { resetProjectScopeTrustForTests, setProjectScopeTrusted } from "../../project-scope-trust.js"
import { objectiveFilePath, objectiveText, saveObjectiveFile } from "./objective-file.js"

describe("managed objective files", () => {
	let root: string
	let cwd: string
	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-objective-file-")))
		cwd = join(root, 'project "with spaces"')
		mkdirSync(cwd)
		// Objective files live in the project's .kimchi/plans — trust the root
		// so both cwd and the alias path (a sibling) resolve as allowed.
		resetProjectScopeTrustForTests()
		setProjectScopeTrusted(root, true)
	})
	afterEach(() => rmSync(root, { recursive: true, force: true }))

	it("preserves full text in distinct private files and returns an explicit short reference", () => {
		const first = `\n# Full objective\n${"Requirement. ".repeat(700)}\n`
		const reference = saveObjectiveFile(first, cwd)
		const path = objectiveFilePath(reference, cwd)
		if (!path) throw new Error("expected managed path")
		expect(reference).toBe(`Read the Kimchi objective file at ${JSON.stringify(path)} before continuing.`)
		expect(reference.length).toBeLessThan(500)
		expect(readFileSync(path, "utf8")).toBe(first)
		expect(statSync(path).mode & 0o777).toBe(0o600)
		const second = saveObjectiveFile("# Replacement", cwd)
		expect(second).not.toBe(reference)
		expect(objectiveText(second, cwd)).toBe("# Replacement")
		expect(objectiveText(reference, cwd)).toBe(first)
	})

	it("uses the same managed root when cwd is reached through an alias", () => {
		const alias = join(root, "alias")
		symlinkSync(cwd, alias, "dir")
		const reference = saveObjectiveFile("Aliased project", alias)
		expect(objectiveFilePath(reference, alias)).toBe(objectiveFilePath(reference, cwd))
		expect(objectiveText(reference, alias)).toBe("Aliased project")
	})

	it("recognizes a missing generated file and reports a read error instead of a plain objective", () => {
		const path = join(cwd, ".kimchi/plans/12345678-1234-4234-8234-123456789abc-objective.md")
		const reference = `Read the Kimchi objective file at ${JSON.stringify(path)} before continuing.`
		expect(objectiveFilePath(reference, cwd)).toBe(path)
		expect(() => objectiveText(reference, cwd)).toThrow(/Could not read Kimchi objective file/)
	})

	it("rejects a generated filename outside the managed project directory", () => {
		const path = join(root, "12345678-1234-4234-8234-123456789abc-objective.md")
		writeFileSync(path, "unrelated")
		const reference = `Read the Kimchi objective file at ${JSON.stringify(path)} before continuing.`
		expect(() => objectiveFilePath(reference, cwd)).toThrow(/Invalid Kimchi objective file reference/)
	})

	it.each([" \n\t", new Uint8Array([0xff, 0xfe])])("rejects an empty or invalid UTF-8 managed file", (body) => {
		const reference = saveObjectiveFile("initial", cwd)
		const path = objectiveFilePath(reference, cwd)
		if (!path) throw new Error("expected managed path")
		writeFileSync(path, body)
		expect(() => objectiveText(reference, cwd)).toThrow(/Could not read Kimchi objective file/)
	})

	it("does not follow a replaced managed file symlink", () => {
		const reference = saveObjectiveFile("initial", cwd)
		const path = objectiveFilePath(reference, cwd)
		if (!path) throw new Error("expected managed path")
		const other = join(root, "unrelated.txt")
		writeFileSync(other, "unrelated content")
		rmSync(path)
		symlinkSync(other, path)
		expect(() => objectiveText(reference, cwd)).toThrow(/Could not read Kimchi objective file/)
	})

	it("does not write a managed file while the project is untrusted — returns the raw text instead", () => {
		resetProjectScopeTrustForTests()
		const text = "# Untrusted objective\nRuns nowhere."
		const returned = saveObjectiveFile(text, cwd)
		// Raw text is returned as the objective (no file reference), and no
		// .kimchi/plans file is created in the repo the user declined to trust.
		expect(returned).toBe(text)
		expect(objectiveFilePath(returned, cwd)).toBeUndefined()
		expect(existsSync(join(cwd, ".kimchi", "plans"))).toBe(false)
	})

	it.each([
		"Read the Kimchi objective file at not-json before continuing.",
		'Read the Kimchi objective file at "/tmp/arbitrary.md" before continuing.',
		'Read the Kimchi objective file at "relative.md" before continuing.',
		"Read the Kimchi objective file at null before continuing.",
		'Read the Kimchi objective file at "missing suffix"',
	])("rejects malformed managed references without falling back: %s", (reference) => {
		expect(() => objectiveText(reference, cwd)).toThrow(/Invalid Kimchi objective file reference/)
	})

	it("does not resolve ordinary text, including another reference inside a managed file", () => {
		const ordinary = 'Read my objective at "/tmp/arbitrary.md" before continuing.'
		expect(objectiveFilePath(ordinary, cwd)).toBeUndefined()
		expect(objectiveText(ordinary, cwd)).toBe(ordinary)
		const nested = saveObjectiveFile("nested body", cwd)
		expect(objectiveText(saveObjectiveFile(nested, cwd), cwd)).toBe(nested)
	})
})
