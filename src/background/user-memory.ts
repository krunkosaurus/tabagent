import type { UserFact, UserFactCategory } from "../core/storage";

const CATEGORY_LABELS: Record<UserFactCategory, string> = {
  identity: "Identity",
  preference: "Preferences",
  interest: "Interests",
  work: "Work",
  other: "Notes",
};

/**
 * Render the stored facts as a system-prompt block. Returns "" when there are
 * no facts (no token waste on an empty header). Facts are grouped by category
 * for readability; order is fixed so the block is stable across turns.
 */
export function memoryBlock(facts: UserFact[]): string {
  if (!facts || facts.length === 0) return "";
  const order: UserFactCategory[] = ["identity", "preference", "interest", "work", "other"];
  const lines: string[] = ["\n\nABOUT THE USER (notes they explicitly saved -- use them to personalize your replies; greet by name when natural on the first turn of a session):"];
  for (const cat of order) {
    const items = facts.filter((f) => f.category === cat && f.source === "manual");
    if (items.length === 0) continue;
    lines.push(`\n${CATEGORY_LABELS[cat]}:`);
    for (const f of items) lines.push(`- ${f.text}`);
  }
  return lines.join("\n");
}
