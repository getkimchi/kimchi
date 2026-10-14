export const numberedChoices = (items: string[]): string[] => items.map((c, i) => `${i + 1}. ${c}`)
export const stripChoiceNumber = (choice: string): string => choice.replace(/^\d+\. /, "")

/**
 * Match a (possibly decorated) selector choice against its option label.
 * Selectors decorate entries with number prefixes and status markers
 * ("1. ✓  label"), so neither the raw choice nor the stripped one equals the
 * label — match by containment after stripping.
 */
export const choiceMatchesLabel = (choice: string, label: string): boolean => stripChoiceNumber(choice).includes(label)
