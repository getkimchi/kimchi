export const numberedChoices = (items: string[]): string[] => items.map((c, i) => `${i + 1}. ${c}`)
export const stripChoiceNumber = (choice: string): string => choice.replace(/^\d+\. /, "")
