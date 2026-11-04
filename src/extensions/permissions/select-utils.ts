// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
export const numberedChoices = (items: string[]): string[] => items.map((c, i) => `${i + 1}. ${c}`)
export const stripChoiceNumber = (choice: string): string => choice.replace(/^\d+\. /, "")

/**
 * Match a (possibly decorated) selector choice against its option label.
 * Selectors decorate entries with number prefixes and status markers
 * ("1. ✓  label"), so neither the raw choice nor the stripped one equals the
 * label — match by containment after stripping.
 */
export const choiceMatchesLabel = (choice: string, label: string): boolean => stripChoiceNumber(choice).includes(label)
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
