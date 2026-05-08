# Theme Improvements Implementation Plan

Based on OpenCode analysis, here are 8 improvements to implement (excluding #1 user theme directory).

## 2. Hot-Reload Theme Files

**Current:** Settings watcher only watches `settings.json`, not theme files.

**Goal:** Watch themes/*.json and reload when edited.

**Implementation:**
- Extend settings-watcher.ts or create theme-file-watcher.ts
- Watch `themes/*.json` for changes
- On change: re-apply active theme
- Only for bundled themes (no user dir)

**Files:** src/settings-watcher.ts or new src/theme-file-watcher.ts

## 3. Transparent Theme

**Goal:** Add theme where ALL background tokens = "" for terminal blur effects.

**Implementation:**
- Create themes/transparent.json
- Set all 6 bg tokens to "": textBg, border, borderAccent, borderMuted, selectedBg, toolPendingBg
- No oscFg/oscBg (restores terminal colors)

**Example:**
```json
{
  "name": "transparent",
  "colors": {
    "userMessageBg": "",
    "customMessageBg": "",
    "selectedBg": "",
    "toolPendingBg": "",
    "toolSuccessBg": "",
    "toolErrorBg": "",
    "oscFg": "",
    "oscBg": ""
  }
}
```

## 4. Auto-Contrast for Minimal Theme (Generate Text Colors)

**Current:** kimchi-minimal-tints.ts only generates background tints.

**Goal:** Also generate foreground/text colors from terminal bg luminance.

**Implementation:**
- In kimchi-minimal-tints.ts, after computing baseBg from probe
- Calculate luminance: (0.299*R + 0.587*G + 0.114*B) / 255
- If luminance > 0.5 (light bg): use dark text (#333333)
- If luminance <= 0.5 (dark bg): use light text (#CCCCCC)
- Also generate: dim, muted, warning, error based on luminance
- Set theme fgColors Map similar to bgColors approach

**Files:** src/extensions/kimchi-minimal-tints.ts

**Key addition:**
```typescript
const TEXT_COLORS: ReadonlyArray<[token: string, isDark: boolean, hex: string]> = [
  ["text", true, "#333333"], ["text", false, "#CCCCCC"],
  ["dim", true, "#555555"], ["dim", false, "#AAAAAA"],
  // ... etc
]

// After getting baseBg, compute luminance
const luminance = (0.299 * baseBg.r + 0.587 * baseBg.g + 0.114 * baseBg.b) / 255
const isDarkBg = luminance <= 0.5

// Set text colors
for (const [token, forDarkBg, hex] of TEXT_COLORS) {
  if (forDarkBg === isDarkBg) {
    (theme as any).fgColors?.set(token, `\x1b[38;2;${r};${g};${b}m`)
  }
}
```

## 5. Theme Contrast Validation

**Goal:** Warn if theme has poor contrast ratios.

**Implementation:**
- Add contrast check in cli.ts after loading themes
- For each theme, check text vs userMessageBg contrast
- WCAG formula: (L1 + 0.05) / (L2 + 0.05)
- Warn if ratio < 4.5:1 for normal text

**Files:** src/cli.ts or new src/theme-validator.ts

**Example:**
```typescript
function getLuminance(hex: string): number {
  // Convert to RGB, apply gamma correction
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const toLinear = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b)
}

function getContrastRatio(hex1: string, hex2: string): number {
  const l1 = getLuminance(hex1) + 0.05
  const l2 = getLuminance(hex2) + 0.05
  return l1 > l2 ? l1 / l2 : l2 / l1
}
```

## 6. Light/Dark Terminal Detection Warning

**Goal:** Detect terminal bg luminance, warn if theme mismatch.

**Implementation:**
- On startup, probe terminal bg via OSC 11
- Compute luminance (see #4)
- If active theme has oscBg & we can compute luminance:
  - Compare theme luminance vs terminal luminance
  - If difference > threshold, show warning

**Example:**
```typescript
const themeLum = getLuminance(themeBg)  // from theme
const termLum = (0.299*probed.r + 0.587*probed.g + 0.114*probed.b) / 255

if (Math.abs(themeLum - termLum) > 0.4) {
  console.warn(`Theme may have poor contrast with your terminal background`)
  console.warn(`Theme is ${themeLum > 0.5 ? 'light' : 'dark'}, terminal is ${termLum > 0.5 ? 'light' : 'dark'}`)
}
```

## 7. Adaptive Theme Format (Single File Dark+Light)

**Goal:** Support `dark` and `light` sections in one theme file.

**Implementation:**
- Extend theme schema to accept:
```json
{
  "name": "kimchi-adaptive",
  "dark": { "text": "grey-400", "textBg": "grey-900", ... },
  "light": { "text": "grey-700", "textBg": "grey-200", ... }
}
```
- On load, determine which section to use:
  - From terminal bg luminance probe
  - Or from settings.themeMode: "dark" | "light" | "auto"
- Merge chosen section into top-level colors

**Files:** src/theme-loader.ts (new) or modify how themes are loaded

## 8. Full "System" Theme

**Goal:** Runtime-generated palette from terminal probe (like OpenCode's "system" theme).

**Implementation:**
- Create themes/system.json as a marker/template
- On load, if theme === "system":
  - Probe terminal bg
  - Generate full grayscale palette: grey-100 through grey-900
  - Map semantic colors based on bg luminance:
    - If dark bg: success = green, error = red, etc.
    - If light bg: adjust for visibility
  - Create theme in-memory, don't write file

**Key:** This is kimchi-minimal but with auto-generated text colors AND a full semantic palette.

## 9. VS Code Theme Importer

**Goal:** Convert VS Code themes to kimchi format.

**Implementation:**
- New CLI command: `npm run import-theme -- --from vscode --path ./theme.json`
- Parses VS Code color tokens, maps to kimchi tokens:
  - editor.background → textBg
  - editor.foreground → text
  - terminal.ansiGreen → success
  - terminal.ansiRed → error
  - etc.
- Outputs kimchi-compatible theme JSON

**Files:** scripts/import-vscode-theme.js (new)

---

## Priority / Implementation Order

### Phase 1: Quick Wins (this session)
1. Transparent theme (#3)
2. Auto-contrast for minimal (#4)
3. Hot-reload themes (#2)

### Phase 2: Validation & Warnings
4. Contrast validation (#5)
5. Light/dark detection warning (#6)

### Phase 3: Advanced Features
6. Adaptive format (#7)
7. Full system theme (#8)
8. VS Code importer (#9)

