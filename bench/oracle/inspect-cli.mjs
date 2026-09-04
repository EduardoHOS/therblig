// A first look at what the CLI will feel like: therblig lint, in the product voice.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { inspect } from './inspect.mjs';
import { message } from './invariants.mjs';

const args = process.argv.slice(2);
const targets = args.length ? args : ['bench/corpus'];
const files = [];
for (const t of targets) {
  if (statSync(t).isDirectory()) {
    (function w(d) {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        statSync(p).isDirectory() ? w(p) : e.endsWith('.bpmn') && files.push(p);
      }
    })(t);
  } else files.push(t);
}

let errors = 0, warnings = 0;
for (const f of files.sort()) {
  const d = await inspect(readFileSync(f, 'utf8'));
  if (!d.length) continue;
  console.log(`\n${f.split(sep).join('/')}`);
  for (const x of d) {
    x.severity === 'error' ? errors++ : warnings++;
    console.log(`  ${x.severity === 'error' ? 'error  ' : 'warning'}  ${message(x)}`);
  }
}
// Voice: say what happened, then what to do. Numbers over adjectives, one period.
console.log(
  errors || warnings
    ? `\n${files.length} files. ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.`
    : `\nValid. ${files.length} files, 0 errors, 0 warnings.`);
process.exit(errors ? 1 : 0);
