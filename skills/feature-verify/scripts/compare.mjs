#!/usr/bin/env node
// Mechanical checks for one feature dir. Prints JSON.
//  - syntax: every .mmd parses with Mermaid
//  - refs: code.*.mmd refs exist (file, line, symbol) and every element has one
//  - intent: every intended element cites a source (@src) or declared assumption (@assumed); quotes verified
//  - endpoints / statuses: HTTP calls and status codes agree between intended and code
//  - glossary: every term has a meaning; its code ref (if any) resolves
//  - drills: every  %% @drill <flow> | <feature>:<flow>  on a sequence message points at an existing diagram
//  - size: number of sequence flows; above 12 the feature is likely several features (split.mjs) — a warning, not a failure
// Observe mode (feature.json {"mode":"observe"}, project default, or --observe): intended diagrams and
// intent are ignored; only the code diagrams are checked.
// Exit 1 if anything fails.
// Usage: node compare.mjs [--observe] .feature-verify/<feature>
import fs from 'node:fs';
import path from 'node:path';
import { extractEndpoints, extractStatuses, diagramType, checkIntent, checkGlossary, checkDrills, sequenceFlows, loadMode, TYPES } from './lib.mjs';
import { checkFiles } from './check-refs.mjs';
import { validateFiles } from './validate.mjs';

const dir = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!dir || !fs.existsSync(dir)) { console.error('usage: compare.mjs [--observe] <feature-dir>'); process.exit(2); }
const mode = process.argv.includes('--observe') ? 'observe' : loadMode(dir);
const observe = mode === 'observe';

const files = { intended: [], code: [] };
for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.mmd')).sort()) {
  const g = f.startsWith('intended.') ? 'intended' : f.startsWith('code.') ? 'code' : null;
  if (g && !(observe && g === 'intended')) files[g].push(path.join(dir, f));
}
const read = f => fs.readFileSync(f, 'utf8');
const collect = fn => Object.fromEntries(Object.entries(files).map(([g, fl]) => [g, new Set(fl.flatMap(f => [...fn(read(f))]))]));
const eps = collect(extractEndpoints);
const sts = collect(extractStatuses);
const sorted = set => [...set].sort((a, b) => (typeof a === 'number' ? a - b : String(a).localeCompare(String(b))));
const minus = (m, a, b) => sorted(new Set([...m[a]].filter(x => !m[b].has(x))));

const syntax = await validateFiles(Object.values(files).flat());
const refs = files.code.length ? checkFiles(files.code) : { checked: 0, failed: [], missing: [], ok: false };
const intent = !observe && files.intended.length ? checkIntent(dir) : null;
const glossary = checkGlossary(dir);
const drills = checkDrills(dir, observe ? ['code'] : ['intended', 'code']);
const flowCount = Math.max(...(observe ? ['code'] : ['intended', 'code']).map(k => sequenceFlows(dir, k).size));
const size = { flows: flowCount, warn: flowCount > 12 ? `${flowCount} sequence flows — probably several features; split with split.mjs` : null };

const result = {
  feature: path.basename(path.resolve(dir)),
  mode,
  coverage: Object.fromEntries(TYPES.map(t => [t, Object.fromEntries(Object.entries(files).map(([g, fl]) => [g, fl.filter(f => diagramType(f) === t).map(f => path.basename(f))]))])),
  syntax: { ok: syntax.ok, parser: syntax.parser, errors: syntax.errors, warnings: syntax.warnings, unavailable: syntax.unavailable || null },
  refs,
  intent,
  glossary,
  drills,
  size,
  endpoints: observe ? null : {
    intended: sorted(eps.intended), code: sorted(eps.code),
    intendedMissingInCode: minus(eps, 'intended', 'code'),
    codeNotInIntended: minus(eps, 'code', 'intended'),
  },
  statuses: observe ? { code: sorted(sts.code) } : {
    intended: sorted(sts.intended), code: sorted(sts.code),
    intendedMissingInCode: minus(sts, 'intended', 'code'),
    codeNotInIntended: minus(sts, 'code', 'intended'),
  },
  checkedAt: new Date().toISOString(),
};
result.ok = syntax.ok && refs.ok && glossary.ok && drills.ok && (observe || (
  (!intent || intent.ok) && !result.endpoints.intendedMissingInCode.length && !result.statuses.intendedMissingInCode.length));
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
