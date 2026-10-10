#!/usr/bin/env node
// Move sequence flows out of a feature that grew too big into a new (or existing) feature, keeping every @drill link
// working: links between the two features become cross-feature links (<feature>:<flow>), and links from any other
// feature are re-pointed. Both kinds (intended / code) move together. With --overview <flow>, that flow becomes the
// new feature's main diagram (<kind>.sequence.mmd). Glossary, report, risks and basis.json are NOT moved — the agent
// re-runs steps 4–6 and stale.mjs record for both features afterwards.
// Usage: node split.mjs .feature-verify/<from> <to> <flow>... [--overview <flow>] [--group <name>] [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { loadMode, loadGroup, parseDrill, diagramFlow, systemDirs, isFeatureName } from './lib.mjs';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const dry = args.includes('--dry-run'); if (dry) args.splice(args.indexOf('--dry-run'), 1);
const overview = opt('--overview'), group = opt('--group');
const [fromArg, to, ...moving] = args;
const usage = () => { console.error('usage: split.mjs .feature-verify/<from> <to> <flow>... [--overview <flow>] [--group <name>] [--dry-run]'); process.exit(2); };
if (!fromArg || !to || !moving.length || !fs.existsSync(fromArg)) usage();
if (!/^[\w-]+$/.test(to)) { console.error(`feature name must be kebab-case: ${to}`); process.exit(2); }
const fromDir = path.resolve(fromArg), from = path.basename(fromDir), root = path.dirname(fromDir), toDir = path.join(root, to);
if (overview && !moving.includes(overview)) { console.error(`--overview ${overview} must be one of the moved flows`); process.exit(2); }

const KINDS = ['intended', 'code'];
const file = (k, fl) => `${k}.sequence${fl ? '.' + fl : ''}.mmd`;
const moved = new Set(moving);
const plan = [];
for (const fl of moving) {
  const found = KINDS.filter(k => fs.existsSync(path.join(fromDir, file(k, fl))));
  if (!found.length) { console.error(`${from} has no sequence flow "${fl}" (${file('code', fl)})`); process.exit(1); }
  for (const k of found) {
    const dest = file(k, fl === overview ? '' : fl);
    if (fs.existsSync(path.join(toDir, dest))) { console.error(`${to}/${dest} already exists`); process.exit(1); }
    plan.push({ k, src: file(k, fl), dest });
  }
}
const newName = fl => (fl === overview ? '' : fl); // name of a moved flow inside the new feature

// Re-point one @drill target, seen from a diagram in feature `owner` (after the move).
function retarget(t, owner, fileMoved) {
  let [feat, fl] = parseDrill(t);
  if (!feat) feat = fileMoved ? from : owner; // same-feature link, resolved where it was written
  if (feat === from && moved.has(fl)) { feat = to; fl = newName(fl); }
  if (feat === owner && fl !== '') return fl;
  return feat + ':' + fl;
}
const rewrite = (text, owner, fileMoved) => text.replace(/(@drill\s+)([\w-]+(?::[\w-]*)?)/g, (m, pre, t) => pre + retarget(t, owner, fileMoved));

const changes = [];
const edit = (dir, name, owner, fileMoved, destName = name) => {
  const src = path.join(dir, name), text = fs.readFileSync(src, 'utf8'), out = rewrite(text, owner, fileMoved);
  changes.push({ src: path.relative(root, src), dest: path.join(owner, destName), links: out !== text });
  if (!dry) {
    if (owner === to) fs.mkdirSync(toDir, { recursive: true });
    fs.writeFileSync(path.join(owner === to ? toDir : dir, destName), out);
    if (fileMoved) fs.rmSync(src);
  }
};
for (const p of plan) edit(fromDir, p.src, to, true, p.dest);
// everything else that may link into the moved flows: the rest of <from>, and every other feature
const dirs = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && isFeatureName(d.name)).map(d => ({ name: d.name, dir: path.join(root, d.name) }))
  .concat(systemDirs(root).map(x => ({ name: '@' + x.group, dir: x.dir }))); // system maps link to feature flows too
for (const d of dirs) {
  const dir = d.dir;
  for (const n of fs.readdirSync(dir).filter(n => /^(intended|code)\.\w+(\.[\w-]+)?\.mmd$/.test(n))) {
    if (d.name === from && plan.some(p => p.src === n)) continue;
    if (d.name === to && plan.some(p => p.dest === n)) continue;
    const text = fs.readFileSync(path.join(dir, n), 'utf8');
    if (rewrite(text, d.name, false) !== text) edit(dir, n, d.name, false);
  }
}

const meta = f => { try { return JSON.parse(fs.readFileSync(path.join(root, f, 'feature.json'), 'utf8')); } catch { return {}; } };
const g = group || loadGroup(fromDir) || from;
if (!dry) {
  fs.mkdirSync(toDir, { recursive: true });
  fs.writeFileSync(path.join(toDir, 'feature.json'), JSON.stringify({ ...meta(to), mode: meta(to).mode || loadMode(fromDir), group: meta(to).group || g }, null, 2) + '\n');
  if (!loadGroup(fromDir)) fs.writeFileSync(path.join(fromDir, 'feature.json'), JSON.stringify({ ...meta(from), group: g }, null, 2) + '\n');
}

console.log(`${dry ? 'would move' : 'moved'} ${moving.length} flow(s) from ${from} to ${to} (group "${g}")${overview ? `; ${overview} is ${to}'s overview` : ''}`);
for (const c of changes) console.log(`  ${c.src === c.dest ? c.src : c.src + ' → ' + c.dest}${c.links ? '  (links re-pointed)' : ''}`);
const left = KINDS.flatMap(k => fs.readdirSync(fromDir).filter(n => n.startsWith(k + ".sequence")).map(diagramFlow)).filter(fl => !dry || !moved.has(fl));
console.log(`${from} keeps ${new Set(left).size} sequence flow(s).`);
console.log(`next: move the glossary terms and risks that concern the moved flows into ${to}, then for both features: compare.mjs → report.json → stale.mjs record; then dashboard.mjs.`);
