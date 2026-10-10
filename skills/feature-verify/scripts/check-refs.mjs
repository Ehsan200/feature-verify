#!/usr/bin/env node
// Verify every code ref (%% @ref file:line#symbol) in code-derived diagrams exists, and flag elements missing refs.
// Usage: node check-refs.mjs [--json] <code.*.mmd>...
import fs from 'node:fs';
import { extractRefs, checkRef, missingRefs, diagramType, isMain } from './lib.mjs';

export function checkFiles(files, root = process.cwd()) {
  const result = { checked: 0, failed: [], missing: [] };
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const ref of extractRefs(text)) {
      result.checked++;
      const r = checkRef(ref, root);
      if (!r.ok) result.failed.push({ diagram: f, mmdLine: ref.mmdLine, ref: ref.raw, reason: r.reason });
    }
    const type = diagramType(f);
    if (type) for (const m of missingRefs(text, type)) result.missing.push({ diagram: f, ...m });
  }
  result.ok = result.failed.length === 0 && result.missing.length === 0;
  return result;
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const files = args.filter(a => a !== '--json');
  if (!files.length) { console.error('usage: check-refs.mjs [--json] <code.*.mmd>...'); process.exit(2); }
  const r = checkFiles(files);
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`refs checked: ${r.checked}, failed: ${r.failed.length}, elements missing refs: ${r.missing.length}`);
    for (const f of r.failed) console.log(`FAIL ${f.diagram}:${f.mmdLine} ${f.ref} — ${f.reason}`);
    for (const m of r.missing) console.log(`MISSING-REF ${m.diagram}:${m.mmdLine} ${m.text}`);
  }
  process.exit(r.ok ? 0 : 1);
}
