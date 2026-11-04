// Writes docs/scout_rulebook.md from the rulebook (supabase/functions/scout/rules.ts) and the answer keys that test
// each rule. Run after changing either: node scripts/browser-scout/rulebook.mjs
import { readFile, writeFile } from "node:fs/promises";

const { RULES } = await import(new URL("../../supabase/functions/scout/rules.ts", import.meta.url));
const keys = JSON.parse(await readFile(new URL("./answer-keys.json", import.meta.url), "utf8")).keys;
const testedBy = (id) => [...new Set(keys.filter((k) => (k.rules ?? []).includes(id)).map((k) => k.image ? `${k.name} (screenshot)` : k.name))];
const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

const sections = [
  ["read", "Reading a schedule", "Sent to Claude, word for word, as its reading instructions for every mosque."],
  ["check", "Checks in code", "Enforced by the scout edge function after Claude has read the page, whatever Claude concluded."],
  ["collect", "Finding the times (plain reader)", "How the HTTP Scout finds where a site keeps its times."],
  ["browser", "Reading in a real browser", "How the Browser Scout (GitHub Actions, Chromium) reads sites the plain reader cannot."],
  ["process", "Keeping the rules honest", "How screenshots, answer keys and fixes work."],
];

const out = [
  "# Adrik Scout rulebook",
  "",
  "Every lesson learned from a mosque website, written as a **general rule** that applies to every mosque — including mosques added later.",
  "Generated from `supabase/functions/scout/rules.ts` (the single source of truth) and `scripts/browser-scout/answer-keys.json`; do not edit by hand.",
  "",
  "**Adding a lesson.** When a site is read wrong: (1) write the general rule in `rules.ts` — never hand-enter that mosque's times; (2) add an answer key (or a screenshot fixture) that would have caught it and list the rule id in its `rules`; (3) push. Every push re-runs all answer keys and prints each rule as passing (✓), failing (✗) or untested (·).",
  "",
  `**${RULES.length} rules**: ${sections.map(([k, t]) => `${RULES.filter((r) => r.kind === k).length} ${t.toLowerCase()}`).join(" · ")}.`,
  "",
];
for (const [kind, title, blurb] of sections) {
  out.push(`## ${title}`, "", blurb, "", "| Rule | What it says | Learned from | Tested by |", "|---|---|---|---|");
  for (const r of RULES.filter((x) => x.kind === kind)) {
    const t = testedBy(r.id);
    out.push(`| \`${r.id}\`${r.where ? `<br><sub>${esc(r.where)}</sub>` : ""} | ${esc(r.rule)} | ${esc(r.learned_from)} | ${t.length ? esc(t.join(", ")) : "—"} |`);
  }
  out.push("");
}
await writeFile(new URL("../../docs/scout_rulebook.md", import.meta.url), out.join("\n"));
console.log(`docs/scout_rulebook.md: ${RULES.length} rules, ${RULES.filter((r) => testedBy(r.id).length).length} with answer keys`);
