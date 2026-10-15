/**
 * Writes docs/HELP.md from the in-game help data (src/ui/helpContent.ts).
 * Run after editing the help text:   npx tsx scripts/help-md.ts
 * tests/smoke/ui.test.ts fails while docs/HELP.md is out of date.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderHelpMarkdown } from '../src/ui/helpContent';

const out = fileURLToPath(new URL('../docs/HELP.md', import.meta.url));
writeFileSync(out, renderHelpMarkdown(), 'utf8');
console.log(`wrote ${out}`);
