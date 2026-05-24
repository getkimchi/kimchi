# Superpowers Runtime Auto-Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On first session start, download and expose `obra/superpowers` skills so every kimchi user gets the superpowers methodology out of the box.

**Architecture:** A single `superpowers` extension hooks `session_start` to trigger a lazy tarball download/extract into `~/.config/kimchi/vendor/superpowers/`, and hooks `before_agent_start` to prepend `using-superpowers/SKILL.md` plus a Kimchi tool-mapping appendix to the system prompt. The vendor `skills/` directory is registered as a default skill path.

**Tech Stack:** TypeScript, Node `fetch`, `tar` (already in `package.json`), pi ExtensionAPI (`session_start`, `before_agent_start`), vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/extensions/superpowers/config.ts` | Constants: version, GH repo, tarball URL, relative vendor skill path |
| `src/extensions/superpowers/config.test.ts` | Tests for config constants |
| `src/extensions/superpowers/installer.ts` | `ensureSuperpowersInstalled()` — idempotent tarball download + extract + version marker with version comparison |
| `src/extensions/superpowers/installer.test.ts` | Tests for installer (mock fetch, mock fs, mock tar) |
| `src/extensions/superpowers/bootstrap.ts` | `buildSuperpowersBootstrap()` — module-level cached read of `using-superpowers/SKILL.md`, appends Kimchi tool mapping |
| `src/extensions/superpowers/bootstrap.test.ts` | Tests for bootstrap (mock fs with synthetic SKILL.md) |
| `src/extensions/superpowers.ts` | Extension entry point: `session_start` → installer, `before_agent_start` → return `{ systemPrompt }` |
| `src/extensions/superpowers.test.ts` | Integration tests for the extension wiring |
| `src/config.ts` | Add vendor skills relative path to `DEFAULT_SKILL_PATHS` |
| `src/cli.ts` | Import and register the superpowers extension factory |

---

### Task 1: Installer Config

**Files:**
- Create: `src/extensions/superpowers/config.ts`
- Create: `src/extensions/superpowers/config.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/extensions/superpowers/config.test.ts
import { describe, expect, it } from "vitest"
import {
  SUPERPOWERS_VERSION,
  SUPERPOWERS_REPO,
  SUPERPOWERS_SKILL_PATH,
  getSuperpowersTarballUrl,
  getSuperpowersVendorDir,
} from "./config"
import { homedir } from "node:os"
import { join } from "node:path"

describe("superpowers config", () => {
  it("pins a semver version", () => {
    expect(SUPERPOWERS_VERSION).toMatch(/^v\d+\.\d+\.\d+$/)
  })

  it("SUPERPOWERS_SKILL_PATH is relative to home (no leading slash)", () => {
    expect(SUPERPOWERS_SKILL_PATH).not.toMatch(/^\//)
    expect(SUPERPOWERS_SKILL_PATH).toContain(join(".config", "kimchi", "vendor", "superpowers", "skills"))
  })

  it("getSuperpowersVendorDir returns absolute path under home", () => {
    const dir = getSuperpowersVendorDir()
    expect(dir).toBe(join(homedir(), ".config", "kimchi", "vendor", "superpowers"))
  })

  it("tarball URL contains repo and version", () => {
    const url = getSuperpowersTarballUrl()
    expect(url).toBe(`https://github.com/obra/superpowers/archive/refs/tags/${SUPERPOWERS_VERSION}.tar.gz`)
  })

  it("SUPERPOWERS_REPO is obra/superpowers", () => {
    expect(SUPERPOWERS_REPO).toBe("obra/superpowers")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/extensions/superpowers/config.test.ts
```
Expected: FAIL — cannot find module `./config`

- [ ] **Step 3: Write implementation**

```typescript
// src/extensions/superpowers/config.ts
import { homedir } from "node:os"
import { join } from "node:path"

export const SUPERPOWERS_VERSION = "v5.1.0"
export const SUPERPOWERS_REPO = "obra/superpowers"

/**
 * Relative-to-home skill path, consistent with ALWAYS_SHOWN_SKILL_PATHS in config.ts.
 * Expanded to absolute by expandSkillPaths() at runtime.
 */
export const SUPERPOWERS_SKILL_PATH = join(
  ".config", "kimchi", "vendor", "superpowers", "skills"
)

/** Absolute path to the vendor root (used by the installer for fs operations). */
export function getSuperpowersVendorDir(): string {
  return join(homedir(), ".config", "kimchi", "vendor", "superpowers")
}

export function getSuperpowersTarballUrl(): string {
  return `https://github.com/${SUPERPOWERS_REPO}/archive/refs/tags/${SUPERPOWERS_VERSION}.tar.gz`
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/extensions/superpowers/config.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extensions/superpowers/config.ts src/extensions/superpowers/config.test.ts
git commit -m "feat(superpowers): add installer config constants"
```

---

### Task 2: Tarball Installer

**Files:**
- Create: `src/extensions/superpowers/installer.ts`
- Create: `src/extensions/superpowers/installer.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/extensions/superpowers/installer.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Must mock config before importing installer so homedir() resolves to mockHome
vi.mock("./config", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./config")>()
  return {
    ...mod,
    getSuperpowersVendorDir: () => join(process.env.HOME ?? "", ".config", "kimchi", "vendor", "superpowers"),
  }
})

import { ensureSuperpowersInstalled } from "./installer"

let mockHome: string
let originalHome: string | undefined

beforeEach(() => {
  originalHome = process.env.HOME
  mockHome = mkdtempSync(join(tmpdir(), "sp-test-"))
  process.env.HOME = mockHome
})

afterEach(() => {
  process.env.HOME = originalHome
  rmSync(mockHome, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe("ensureSuperpowersInstalled", () => {
  it("downloads and extracts when vendor dir is missing, returns true", async () => {
    const tarball = new Uint8Array(8) // minimal payload; tar mock handles extraction
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(tarball)
          ctrl.close()
        },
      }),
    }))

    vi.mock("tar", () => ({
      extract: vi.fn().mockResolvedValue(undefined),
    }))

    const result = await ensureSuperpowersInstalled()
    expect(result).toBe(true)
  })

  it("returns false when already installed at correct version", async () => {
    const vendorDir = join(mockHome, ".config", "kimchi", "vendor", "superpowers")
    const skillsDir = join(vendorDir, "skills")
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(vendorDir, ".version"), "v5.1.0")

    const result = await ensureSuperpowersInstalled()
    expect(result).toBe(false)
  })

  it("re-downloads when .version exists but has stale tag", async () => {
    const vendorDir = join(mockHome, ".config", "kimchi", "vendor", "superpowers")
    const skillsDir = join(vendorDir, "skills")
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(vendorDir, ".version"), "v4.0.0") // stale

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({ start(ctrl) { ctrl.close() } }),
    }))
    vi.mock("tar", () => ({ extract: vi.fn().mockResolvedValue(undefined) }))

    const result = await ensureSuperpowersInstalled()
    expect(result).toBe(true)
  })

  it("throws when fetch returns non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" }))
    await expect(ensureSuperpowersInstalled()).rejects.toThrow("404")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/extensions/superpowers/installer.test.ts
```
Expected: FAIL — cannot find module `./installer`

- [ ] **Step 3: Write implementation**

```typescript
// src/extensions/superpowers/installer.ts
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { extract } from "tar"
import { SUPERPOWERS_VERSION, getSuperpowersVendorDir } from "./config"

export async function ensureSuperpowersInstalled(): Promise<boolean> {
  const vendorDir = getSuperpowersVendorDir()
  const versionFile = join(vendorDir, ".version")
  const skillsDir = join(vendorDir, "skills")

  // Idempotency check: version file must exist AND match pinned version
  if (existsSync(versionFile) && existsSync(skillsDir)) {
    const installed = readFileSync(versionFile, "utf-8").trim()
    if (installed === SUPERPOWERS_VERSION) return false
  }

  mkdirSync(vendorDir, { recursive: true })

  const url = `https://github.com/obra/superpowers/archive/refs/tags/${SUPERPOWERS_VERSION}.tar.gz`
  const tarballPath = join(vendorDir, "download.tar.gz")

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download superpowers: ${response.status} ${response.statusText}`)
  }

  // Stream response body to disk
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(tarballPath)
    stream.on("finish", resolve)
    stream.on("error", reject)
    // biome-ignore lint/style/noNonNullAssertion: fetch guarantees body when ok
    const reader = response.body!.getReader()
    function pump(): void {
      reader.read().then(({ done, value }) => {
        if (done) { stream.end(); return }
        stream.write(value)
        pump()
      }, reject)
    }
    pump()
  })

  // Extract tarball, stripping the top-level "superpowers-5.1.0/" directory
  await extract({ file: tarballPath, cwd: vendorDir, strip: 1 })

  // Write version marker after successful extraction
  writeFileSync(versionFile, SUPERPOWERS_VERSION)

  // Clean up tarball
  await unlink(tarballPath).catch(() => undefined)

  return true
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/extensions/superpowers/installer.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extensions/superpowers/installer.ts src/extensions/superpowers/installer.test.ts
git commit -m "feat(superpowers): add tarball download and extraction"
```

---

### Task 3: Bootstrap Builder

**Files:**
- Create: `src/extensions/superpowers/bootstrap.ts`
- Create: `src/extensions/superpowers/bootstrap.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/extensions/superpowers/bootstrap.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildSuperpowersBootstrap, resetBootstrapCache } from "./bootstrap"

describe("buildSuperpowersBootstrap", () => {
  let mockDir: string

  beforeEach(() => {
    resetBootstrapCache()
    mockDir = mkdtempSync(join(tmpdir(), "sp-bootstrap-"))
    const skillDir = join(mockDir, "skills", "using-superpowers")
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: using-superpowers\n---\n# Using Superpowers\n\nInvoke Skill tool.")
  })

  afterEach(() => {
    rmSync(mockDir, { recursive: true, force: true })
    resetBootstrapCache()
  })

  it("returns using-superpowers body (no frontmatter) + kimchi mapping", () => {
    const result = buildSuperpowersBootstrap(mockDir)
    expect(result).toContain("# Using Superpowers")
    expect(result).not.toContain("name: using-superpowers") // frontmatter stripped
    expect(result).toContain("Kimchi Platform Tool Mapping")
    expect(result).toContain("`Skill` tool")
    expect(result).toContain("`/skill:<name>`")
    expect(result).toContain("`TodoWrite`")
    expect(result).toContain("`Task` tool")
    expect(result).toContain("`Agent` tool")
  })

  it("returns empty string when vendor dir is missing", () => {
    const result = buildSuperpowersBootstrap("/nonexistent/path")
    expect(result).toBe("")
  })

  it("memoizes: second call with same dir does not re-read disk", () => {
    buildSuperpowersBootstrap(mockDir) // prime cache
    // Delete the file after first call
    rmSync(join(mockDir, "skills", "using-superpowers", "SKILL.md"))
    // Should still return the cached result
    const result = buildSuperpowersBootstrap(mockDir)
    expect(result).toContain("# Using Superpowers")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/extensions/superpowers/bootstrap.test.ts
```
Expected: FAIL — cannot find module `./bootstrap`

- [ ] **Step 3: Write implementation**

```typescript
// src/extensions/superpowers/bootstrap.ts
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

const KIMCHI_TOOL_MAPPING = `
## Kimchi Platform Tool Mapping

The following Claude Code tool references in these skills map to native Kimchi equivalents:

| Skill reference | Kimchi action |
|-----------------|---------------|
| \`Skill\` tool | Use \`/skill:<name>\` to load a skill, or \`read\` its SKILL.md path directly |
| \`TodoWrite\` tool | Use \`write\` or \`edit\` on \`TODO.md\` with \`- [ ]\` checklist format |
| \`Task\` tool (subagent) | Use the \`Agent\` tool — default type is \`General-Purpose\`, pass prompt as the \`prompt\` parameter |
| \`Read\` / \`Write\` / \`Edit\` / \`Bash\` | Native tools — same names, same behavior |
`

/** Strip YAML frontmatter (--- block) from skill file content. */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---[\s\S]*?---\n+([\s\S]*)$/)
  return match ? match[1] : content
}

// Module-level cache — SKILL.md never changes during a process lifetime
let _cache: string | null = null

/** For tests only — reset the module-level cache. */
export function resetBootstrapCache(): void {
  _cache = null
}

/**
 * Build the superpowers bootstrap system prompt text.
 * Returns using-superpowers/SKILL.md body + Kimchi tool mapping table.
 * Returns empty string if the vendor dir is not yet installed.
 * Memoized — file is only read once per process.
 */
export function buildSuperpowersBootstrap(vendorDir: string): string {
  if (_cache !== null) return _cache

  const skillPath = join(vendorDir, "skills", "using-superpowers", "SKILL.md")
  if (!existsSync(skillPath)) {
    return ""
  }

  const raw = readFileSync(skillPath, "utf-8")
  const body = stripFrontmatter(raw)
  _cache = `${body}\n${KIMCHI_TOOL_MAPPING}`
  return _cache
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/extensions/superpowers/bootstrap.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extensions/superpowers/bootstrap.ts src/extensions/superpowers/bootstrap.test.ts
git commit -m "feat(superpowers): add bootstrap builder with memoization and kimchi tool mapping"
```

---

### Task 4: Extension Entry Point

**Files:**
- Create: `src/extensions/superpowers.ts`
- Create: `src/extensions/superpowers.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/extensions/superpowers.test.ts
import { describe, expect, it, vi } from "vitest"

vi.mock("./superpowers/installer", () => ({
  ensureSuperpowersInstalled: vi.fn().mockResolvedValue(false),
}))
vi.mock("./superpowers/bootstrap", () => ({
  buildSuperpowersBootstrap: vi.fn().mockReturnValue("bootstrap content"),
}))
vi.mock("./superpowers/config", () => ({
  getSuperpowersVendorDir: vi.fn().mockReturnValue("/mock/vendor"),
  SUPERPOWERS_SKILL_PATH: ".config/kimchi/vendor/superpowers/skills",
  SUPERPOWERS_VERSION: "v5.1.0",
  SUPERPOWERS_REPO: "obra/superpowers",
}))
vi.mock("./agent-worker-context", () => ({
  isAgentWorker: vi.fn().mockReturnValue(false),
}))

import superpowersExtension from "./superpowers"

describe("superpowersExtension", () => {
  it("registers session_start handler", () => {
    const onSpy = vi.fn()
    superpowersExtension({ on: onSpy } as any)
    expect(onSpy).toHaveBeenCalledWith("session_start", expect.any(Function))
  })

  it("registers before_agent_start handler", () => {
    const onSpy = vi.fn()
    superpowersExtension({ on: onSpy } as any)
    expect(onSpy).toHaveBeenCalledWith("before_agent_start", expect.any(Function))
  })

  it("before_agent_start returns systemPrompt with bootstrap prepended", async () => {
    const handlers: Record<string, Function> = {}
    superpowersExtension({ on: (event: string, handler: Function) => { handlers[event] = handler } } as any)

    const event = { systemPrompt: "existing prompt", type: "before_agent_start" }
    const ctx = { hasUI: false }
    const result = await handlers["before_agent_start"](event, ctx)

    expect(result).toEqual({ systemPrompt: "bootstrap content\n\nexisting prompt" })
  })

  it("before_agent_start returns undefined (no-op) when isAgentWorker is true", async () => {
    const { isAgentWorker } = await import("./agent-worker-context")
    vi.mocked(isAgentWorker).mockReturnValue(true)

    const handlers: Record<string, Function> = {}
    superpowersExtension({ on: (event: string, handler: Function) => { handlers[event] = handler } } as any)

    const result = await handlers["before_agent_start"]({ systemPrompt: "x" }, {})
    expect(result).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm vitest run src/extensions/superpowers.test.ts
```
Expected: FAIL — cannot find module `./superpowers`

- [ ] **Step 3: Write implementation**

```typescript
// src/extensions/superpowers.ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "./agent-worker-context.js"
import { buildSuperpowersBootstrap } from "./superpowers/bootstrap.js"
import { getSuperpowersVendorDir } from "./superpowers/config.js"
import { ensureSuperpowersInstalled } from "./superpowers/installer.js"

export default function superpowersExtension(pi: ExtensionAPI) {
  // Lazy install: runs once per session start. No-op if already installed.
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    try {
      const didInstall = await ensureSuperpowersInstalled()
      if (didInstall && ctx.hasUI) {
        ctx.ui.setStatus("superpowers", "✦ Superpowers skills installed")
      }
    } catch {
      // Best-effort — don't block harness launch if offline or GitHub unreachable
      if (ctx.hasUI) {
        ctx.ui.setStatus("superpowers", "Superpowers: could not download skills")
      }
    }
  })

  // Bootstrap injection: prepend using-superpowers + tool mapping to system prompt.
  // Skipped for subagents (they don't need the bootstrap; skills are already loaded).
  pi.on("before_agent_start", async (event, _ctx: ExtensionContext) => {
    if (isAgentWorker()) return

    const bootstrap = buildSuperpowersBootstrap(getSuperpowersVendorDir())
    if (!bootstrap) return

    return { systemPrompt: `${bootstrap}\n\n${event.systemPrompt}` }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm vitest run src/extensions/superpowers.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/extensions/superpowers.ts src/extensions/superpowers.test.ts
git commit -m "feat(superpowers): add extension entry point with session and agent hooks"
```

---

### Task 5: Register Vendor Skill Path

**Files:**
- Modify: `src/config.ts`
- Test: `src/config.test.ts`

- [ ] **Step 1: Read `ALWAYS_SHOWN_SKILL_PATHS` and `buildSkillPathOptions` in `src/config.ts`**

Confirm current shape (lines 11–50). Key facts:
- `ALWAYS_SHOWN_SKILL_PATHS` uses relative-to-home paths like `join(".config", "kimchi", "harness", "skills")`
- `buildSkillPathOptions` adds `ALWAYS_SHOWN` unconditionally, `OPTIONAL` only if they exist, then `discoveredDirs`
- The vendor path must use the same relative convention as `ALWAYS_SHOWN_SKILL_PATHS`

- [ ] **Step 2: Add import and vendor path constant**

In `src/config.ts`, after the existing imports add:

```diff
+ import { SUPERPOWERS_SKILL_PATH } from "./extensions/superpowers/config.js"
```

After `OPTIONAL_SKILL_PATHS`:

```diff
  export const OPTIONAL_SKILL_PATHS = [join(".pi", "agent", "skills"), join(".claude", "skills")]

+ /**
+  * Relative-to-home path for the auto-installed superpowers vendor skills.
+  * Resolved to absolute by expandSkillPaths() at runtime, same as ALWAYS_SHOWN_SKILL_PATHS.
+  */
+ export const VENDOR_SKILL_PATHS = [SUPERPOWERS_SKILL_PATH]

  export const DEFAULT_SKILL_PATHS = [...ALWAYS_SHOWN_SKILL_PATHS, ...OPTIONAL_SKILL_PATHS]
```

- [ ] **Step 3: Update `DEFAULT_SKILL_PATHS` to include vendor path**

```diff
- export const DEFAULT_SKILL_PATHS = [...ALWAYS_SHOWN_SKILL_PATHS, ...OPTIONAL_SKILL_PATHS]
+ export const DEFAULT_SKILL_PATHS = [...ALWAYS_SHOWN_SKILL_PATHS, ...OPTIONAL_SKILL_PATHS, ...VENDOR_SKILL_PATHS]
```

- [ ] **Step 4: Update `buildSkillPathOptions` to handle vendor paths**

The existing function adds `ALWAYS_SHOWN` unconditionally and `OPTIONAL` only if they exist on disk. Add a parallel block for `VENDOR_SKILL_PATHS` (add after the `OPTIONAL_SKILL_PATHS` block, before `discoveredDirs`):

```diff
  for (const p of OPTIONAL_SKILL_PATHS) {
    if (!seen.has(p) && existsSync(join(home, p))) {
      seen.add(p)
      result.push(p)
    }
  }

+ for (const p of VENDOR_SKILL_PATHS) {
+   if (!seen.has(p) && existsSync(join(home, p))) {
+     seen.add(p)
+     result.push(p)
+   }
+ }

  for (const abs of discoveredDirs) {
```

- [ ] **Step 5: Verify existing tests still pass**

```bash
pnpm vitest run src/config.test.ts
```
Expected: PASS (no test asserts exact `DEFAULT_SKILL_PATHS` length — verify manually if one does and update accordingly)

- [ ] **Step 6: Commit**

```bash
git add src/config.ts
git commit -m "feat(superpowers): register vendor skills path in DEFAULT_SKILL_PATHS"
```

---

### Task 6: Register Extension in CLI

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add import alongside other extension imports**

```diff
  import startupUpdateExtension from "./extensions/startup-update.js"
+ import superpowersExtension from "./extensions/superpowers.js"
```

- [ ] **Step 2: Add to `extensionFactories` array**

The `extensionFactories` array starts at around line 462. Add `superpowersExtension` immediately after `startupUpdateExtension` (both are unconditional, always-on extensions):

```diff
  const extensionFactories = [
    startupUpdateExtension,
+   superpowersExtension,
    sessionIdCaptureExtension,
```

- [ ] **Step 3: Run typecheck to confirm no import errors**

```bash
pnpm run typecheck
```
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat(superpowers): register superpowers extension in CLI"
```

---

### Task 7: Full Verification

- [ ] **Step 1: Run full unit test suite**

```bash
pnpm run test
```
Expected: All tests pass, no regressions.

- [ ] **Step 2: Run linter**

```bash
pnpm run lint
```
Expected: No lint errors.

- [ ] **Step 3: Run typecheck**

```bash
pnpm run typecheck
```
Expected: No type errors.

- [ ] **Step 4: Commit if any auto-fixes were applied**

```bash
git add -p
git commit -m "chore(superpowers): lint and typecheck fixes"
```

---

## Self-Review

### Spec coverage

| Requirement | Task | Status |
|-------------|------|--------|
| All 14 skills load by default | Task 5 — vendor `skills/` in `DEFAULT_SKILL_PATHS` | ✅ |
| No npm wrapper dependency | No `package.json` change | ✅ |
| No custom tools | No `registerTool` anywhere | ✅ |
| Bootstrap injection with tool mapping | Task 3, Task 4 | ✅ |
| Works offline after first install | Task 2 — idempotency check, no re-download | ✅ |
| Zero startup latency after first install | Task 4 — `session_start` is async, no-op when installed | ✅ |
| Pinned version | Task 1 — `SUPERPOWERS_VERSION = "v5.1.0"` | ✅ |
| Best-effort on failure | Task 4 — try/catch in `session_start` | ✅ |
| No persona conversion | Nothing in plan creates a persona | ✅ |
| Bootstrap prepended (prompt caching) | Task 4 — `\`${bootstrap}\n\n${event.systemPrompt}\`` | ✅ |
| Version mismatch triggers re-download | Task 2 — reads `.version` and compares to constant | ✅ |

### Placeholder scan

- No "TBD", "TODO", "implement later", "similar to Task N"
- Every step includes exact code, exact commands, expected outputs
- `buildSkillPathOptions` diff shows the full new block (no `// ... existing` omissions)
- `config.ts` diff shows exact insertion points

### Type consistency

| Symbol | Declared | Used |
|--------|----------|------|
| `ensureSuperpowersInstalled()` | `Promise<boolean>` (Task 2) | `await` in Task 4 ✅ |
| `buildSuperpowersBootstrap(vendorDir)` | `(vendorDir: string) => string` (Task 3) | called with `getSuperpowersVendorDir()` in Task 4 ✅ |
| `resetBootstrapCache()` | `() => void` (Task 3) | test only ✅ |
| `SUPERPOWERS_SKILL_PATH` | `string` (Task 1) | imported in Task 5 ✅ |
| `getSuperpowersVendorDir()` | `() => string` (Task 1) | imported in Task 4 ✅ |
| `isAgentWorker()` | `() => boolean` (upstream) | imported in Task 4 ✅ |
| `event.systemPrompt` | `string` on `BeforeAgentStartEvent` (upstream type) | accessed in Task 4 handler ✅ |

---

## Execution Handoff

**Plan saved to `docs/superpowers/plans/2026-05-24-superpowers-auto-installer.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — Fresh subagent per task, two-stage review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
