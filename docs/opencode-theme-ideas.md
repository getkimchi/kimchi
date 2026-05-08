# OpenCode Theme System Analysis & Ideas for Kimchi

## OpenCode's Approach

### 1. "System" Theme with Runtime Contrast Generation
OpenCode has a sophisticated "system" theme that:
- Probes terminal background via OSC 11
- **Generates a full grayscale palette dynamically** based on terminal luminance
- Uses ANSI 0-15 colors for syntax (respects terminal palette)
- Falls back to `"none"` for transparent/terminal-native colors
- Ensures WCAG-compliant contrast ratios automatically

**Kimchi's approach:** 
- kimchi-minimal-tints computes tints from terminal bg (similar!)
- BUT: doesn't generate a full grayscale palette
- Text colors still come from theme vars, not runtime calculations

**Idea for Kimchi:**
Add a `system` theme that probes terminal bg and generates readable grays automatically:
```typescript
// Probed terminal bg = #FAFAFA (light)
// Generate:
// text: darken(bg, 80%)     → #333333
// dim:   darken(bg, 50%)     → #808080
// muted: darken(bg, 20%)     → #C0C0C0
```

### 2. Hot-Reload (PR #4879)
| Trigger | Use Case |
|---------|----------|
| `/reload-theme` | Manual reload |
| File watchers | Auto on edit |
| SIGUSR1/SIGUSR2 | External scripts |
| Window resize | Re-detect terminal colors |

**Kimchi Gap:**
- Must restart kimchi to see theme changes
- No file watcher on theme files

**Idea:**
Add file watcher on themes/*.json - when edited via external editor, apply changes immediately.

### 3. Single Theme with Dark/Light Variants (lipgloss AdaptiveColor)
OpenCode uses Go's lipgloss `AdaptiveColor` type:
```go
type AdaptiveColor struct {
    Dark  string
    Light string
}
// Renders Dark in dark mode, Light in light mode
```

This means ONE theme file supports both modes based on terminal detection.

**Kimchi Gap:**
- Separate files: kimchi.json and kimchi-light.json
- No way to auto-switch based on terminal/user preference

**Idea:**
Add `dark` and `light` sections to themes:
```json
{
  "name": "kimchi-adaptive",
  "dark": { "text": "grey-400", ... },
  "light": { "text": "grey-700", ... }
}
```

### 4. Transparent Theme (PR #14563)
A built-in theme that sets ALL background tokens to `"none"`:
```json
{
  "background": "none",
  "backgroundPanel": "none",
  "backgroundElement": "none"
}
```

This allows terminal blur/opacity to show through.

**Kimchi Gap:**
- No pure-transparent theme
- Minimal uses tints, not transparent

### 5. ANSI Color Index Support (same issue #4429)
OpenCode CAN use ANSI palette numbers:
```json
{
  "defs": { "red": 1, "green": 2 },
  "colors": { "error": "red" }
}
```

But it causes crashes in some versions (issue #4429).

**Kimchi status:**
- Currently doesn't support ANSI indexes (not a goal)

### 6. Theme Search Path Hierarchy
OpenCode searches in order:
```
1. Built-in themes (embedded)
2. ~/.config/opencode/themes/*.json
3. Project/.opencode/themes/*.json
4. CWD/.opencode/themes/*.json
```

Lower numbers override higher numbers (user config > built-in).

**Kimchi Gap:**
- Only reads from bundled themes
- No user override path

**Idea:**
Add user theme directory: `~/.config/kimchi/harness/themes/`

### 7. Minimum Contrast Ratio (from VS Code)
VS Code terminal has `minimumContrastRatio` feature:
- Automatically adjusts text luminance until 4.5:1 contrast achieved
- Prevents invisible text on mismatched backgrounds

**Idea for Kimchi:**
Detect when terminal fg/bg contrast is poor, warn user or auto-adjust text color.

---

## Summary: Improvement Recommendations

### Easy Wins (low effort, high value)

1. **Fix the "system" theme path** - Read from `~/.config/kimchi/harness/themes/`
2. **Add file watcher** - Hot-reload theme files when edited
3. **Add pure transparent theme** - All bg tokens = empty string

### Medium Effort

4. **Auto-contrast for minimal theme** - Generate text colors from terminal bg probe
5. **Theme validation** - Warn if contrast ratios are poor (text/bg similar luminance)
6. **Smart light/dark detection** - Infer if terminal is light or dark, warn on mismatch

### High Effort (architectural)

7. **Adaptive theme format** - One theme with dark/light variants
8. **System theme** - Runtime-generated palette from terminal probe
9. **VS Code theme importer** - Convert VS Code themes to kimchi format
