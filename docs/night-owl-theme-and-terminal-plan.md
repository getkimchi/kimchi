# Night Owl Theme + Full Terminal Wide Theming Plan

## Understanding the Root Problem

When user switches from dark to light theme (or vice versa) in kimchi, only SOME blocks change their background colors. This is because:

1. **Editor blocks** - tinted by kimchi-minimal-tints.ts (works)
2. **Terminal background** - set by OSC 11 via terminal-colors.ts (works)  
3. **But**: The "terminal-wide" content (scrollback, UI chrome) doesn't have explicit background set

## How OpenCode Does Full Terminal Theming

OpenCode uses a TUI framework that sets **background EVERYWHERE**:
- Every UI component has explicit background color
- The TUI renders everything with bg color fills
- No reliance on terminal's default background color

## The Gap in Kimchi

Kimchi uses:
- TUI for some parts (editor, menus) - these get backgrounds
- But terminal escape sequences and scrollback rely on terminal's bg

## Solution: Complete Terminal-Wide Background Application

### Approach 1: OSC 4 (Set 256-color Palette) + OSC 10/11
Replace terminal's entire color palette to match theme:
```
OSC 4 ; 0 ; rgb:RR/GG/BB  ST  → Set color 0 to custom value
OSC 4 ; 15 ; rgb:RR/GG/BB ST → Set color 15 to custom value  
```

But this corrupts the user's terminal permanently until reset.

### Approach 2: Uniform Background for ALL Blocks (Better)
**Set `textBg` and theme OSC bg to the same color**

All "text" areas in kimchi should have:
- `textBg` = explicit theme background color
- `textInput` = same

Everywhere should be rendered with explicit background.

### Approach 3: Clear Screen + Set BG (Best for Terminal)
This is what theme switching SHOULD do:
1. Clear terminal with new bg color
2. Redraw ALL content with explicit bg colors
3. Set OSC 11 to match main theme bg

## Night Owl Theme Mapping

From VS Code Night Owl:
```
Background:     #011627 (dark blue)
Foreground:     #d6deeb (light blue-white)
Cursor/Accent:  #7e57c2 (purple)
Blue:           #82AAFF
Cyan:           #7fdbca / #21c7a8  
Green:          #22da6e / #9CCC65
Yellow:         #c5e478 / #F78C6C
Magenta:        #C792EA
Red:            #EF5350 / #ff5874
Orange:         #F78C6C
Teal:           #80CBC4
Grey-1:         #5f7e97
Grey-2:         #4b6479
Grey-3:         #234d70 (selection)
darker:         #010b14, #0b253a, #0b2942
```

### Kimchi Night Owl Theme Mapping

| Kimchi Token | Night Owl Color | Hex |
|--------------|-----------------|-----|
| text | foreground | #d6deeb |
| textBg | editor.background | #011627 |
| textInput | input.background | #0b253a |
| mute | comment.body | #637777 |
| accent | accent | #C792EA |
| success | terminal.ansiGreen | #22da6e |
| error | terminal.ansiRed | #EF5350 |
| warning | terminal.ansiYellow | #FFEB95 |
| mdHeading | markdown.heading | #82b1ff |
| mdCode | markdown.code | #80CBC4 |
| mdLink | markdown.link | #7fdbca |
| syntaxKeyword | keyword | #c792ea |
| syntaxString | string | #ecc48d |
| syntaxFunction | entity.name.function | #82AAFF |
| syntaxNumber | constant.numeric | #F78C6C |
| userMessageText | variable | #d6deeb |
| userMessageBg | background highlight | #234d70 |
| customMessageBg | input.background | #0b2942 |
| toolPendingBg | list.focus | #234d70 |
| toolSuccessBg | diff.inserted | #99b76d33 |
| toolErrorBg | diff.removed | #ef535033 |
| oscFg | foreground | #d6deeb |
| oscBg | background | #011627 |

## Implementation Plan

1. **Create `themes/night-owl.json`** with the mapped colors

2. **Fix terminal-colors.ts** - use theme oscFg/oscBg when available

3. **Add explicit textBg everywhere** - ensure chat bubbles, editor blocks, etc. ALL have explicit backgrounds

4. **Test:** Switch between kimchi (dark) → night-owl → kimchi-light and verify ALL UI elements change color

