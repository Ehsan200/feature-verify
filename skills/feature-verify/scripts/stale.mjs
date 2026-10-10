#!/usr/bin/env node
// Staleness: has the code a feature's diagrams point at changed since they were made?
//  record <feature-dir>   snapshot every file the feature refs (diagrams, glossary, report) → <feature-dir>/basis.json.
//                         Each file's content is stored as a git blob in the file's OWN repo (git hash-object -w), so
//                         nested repos, submodules and a folder of several repos all work. Files outside any repo are
//                         tracked by hash only (whole-file "changed", no line detail).
//  check  <.feature-verify | feature-dir>   compare every ref against the snapshot (git diff of old blob vs file now).
// Ref states:     fresh · moved (same code, line shifted → newLine) · changed (the line or a neighbour edited, or its #symbol is
//                 no longer within ±3 lines) · gone (file removed)
// Feature states: fresh · shifted (only moves / edits away from refs) · outdated (a ref changed or is gone) · unknown (no basis.json)
// Usage: node stale.mjs record .feature-verify/<feature>
//        node stale.mjs [check] [--json] <.feature-verify | .feature-verify/<feature>>    exit 1 if any feature is outdated
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { extractRefs, checkRef, fvRootOf, systemDirs, isMain } from './lib.mjs';

const NEAR = 1; // an edit on the ref line or right next to it changes what the ref points at
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const rootOf = fd => path.dirname(fvRootOf(fd)); // <root>/.feature-verify/<feature> or <root>/.feature-verify/_system/<group>

function git(cwd, args, okCodes = [0]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20 });
  return okCodes.includes(r.status) ? r.stdout : null;
}
// Same id git gives the content, so "unchanged" needs no git at all.
const blobId = buf => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// The repo that holds this file (nearest .git above it), or null.
function repoOf(abs) {
  let d = path.dirname(abs);
  while (!fs.existsSync(d) && d !== path.dirname(d)) d = path.dirname(d);
  return git(d, ['rev-parse', '--show-toplevel'])?.trim() || null;
}

const REF_STR = /^([^\s:]+?):(\d+)(?:#(\S+))?$/;
// Every code ref the feature makes: diagram refs (code.*.mmd), glossary refs, report finding/risk refs.
export function collectRefs(fd) {
  const out = [];
  for (const n of fs.readdirSync(fd).filter(n => /^code\..+\.mmd$/.test(n)).sort())
    for (const r of extractRefs(fs.readFileSync(path.join(fd, n), 'utf8'))) out.push({ file: r.file, line: r.line, symbol: r.symbol, from: n });
  const add = (ref, from) => { const m = String(ref || '').match(REF_STR); if (m) out.push({ file: m[1], line: Number(m[2]), symbol: m[3] || null, from }); };
  for (const t of readJson(path.join(fd, 'glossary.json'))?.terms || []) add(t.ref, 'glossary.json');
  const report = readJson(path.join(fd, 'report.json'));
  for (const x of report?.findings || []) add(x.ref, 'report.json');
  for (const x of report?.risks || []) add(x.ref, 'report.json');
  return out;
}

export function record(fd) {
  const root = rootOf(fd);
  const refs = collectRefs(fd).map(r => ({ ...r, file: path.relative(root, path.resolve(root, r.file)) }));
  const files = {};
  for (const file of [...new Set(refs.map(r => r.file))]) {
    const abs = path.resolve(root, file);
    if (!fs.existsSync(abs)) continue; // a broken ref; compare.mjs reports it
    const blob = blobId(fs.readFileSync(abs));
    const repo = repoOf(abs);
    const entry = { blob };
    if (repo && git(repo, ['hash-object', '-w', '--', abs])?.trim() === blob) {
      entry.repo = path.relative(root, repo) || '.';
      const head = git(repo, ['rev-parse', 'HEAD'])?.trim();
      if (head) entry.commit = head;
      if (git(repo, ['status', '--porcelain', '--', abs])?.trim()) entry.uncommitted = true;
    }
    files[file] = entry;
  }
  const basis = { recordedAt: new Date().toISOString(), files, refs };
  fs.writeFileSync(path.join(fd, 'basis.json'), JSON.stringify(basis, null, 2) + '\n');
  return basis;
}

// Hunks of `git diff -U0 old new`: old lines [a, a+b-1] replaced by new lines [c, c+d-1]; b = 0 means an insertion after line a.
function diffHunks(oldText, abs) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-stale-'));
  try {
    const old = path.join(tmp, 'old');
    fs.writeFileSync(old, oldText);
    const out = git(tmp, ['diff', '--no-index', '--no-ext-diff', '--no-color', '-U0', '--', old, abs], [0, 1]);
    if (out == null) return null;
    return [...out.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(m => ({ a: +m[1], b: m[2] == null ? 1 : +m[2], c: +m[3], d: m[4] == null ? 1 : +m[4] }));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

function placeRef(line, hunks) {
  let shift = 0;
  for (const { a, b, d } of hunks) {
    const touches = b > 0 ? a <= line + NEAR && a + b - 1 >= line - NEAR : a >= line - NEAR && a <= line + NEAR - 1; // insertion after line a
    if (touches) return { status: 'changed' };
    if ((b > 0 ? a + b - 1 : a) < line) shift += d - (b > 0 ? b : 0);
  }
  return shift ? { status: 'moved', newLine: line + shift } : { status: 'fresh' };
}

export function check(fd) {
  const feature = path.basename(path.resolve(fd));
  const basis = readJson(path.join(fd, 'basis.json'));
  if (!basis) return { feature, state: 'unknown', reason: 'no basis.json — run: stale.mjs record ' + fd };
  const root = rootOf(fd);
  const files = [];
  const placed = new Map(); // file → line → result
  for (const [file, info] of Object.entries(basis.files || {})) {
    const abs = path.resolve(root, file);
    const lines = new Map();
    placed.set(file, lines);
    const fileRefs = (basis.refs || []).filter(r => r.file === file);
    if (!fs.existsSync(abs)) { files.push({ file, status: 'gone' }); for (const r of fileRefs) lines.set(r.line + '#' + (r.symbol || ''), { status: 'gone', reason: 'file removed or renamed' }); continue; }
    if (blobId(fs.readFileSync(abs)) === info.blob) { files.push({ file, status: 'same' }); continue; }
    const old = info.repo ? git(path.resolve(root, info.repo), ['cat-file', 'blob', info.blob]) : null;
    const hunks = old == null ? null : diffHunks(old, abs);
    if (!hunks) {
      files.push({ file, status: 'edited', detail: false });
      for (const r of fileRefs) lines.set(r.line + '#' + (r.symbol || ''), { status: 'changed', reason: info.repo ? 'old version no longer in git — no line detail' : 'not in a git repo — no line detail' });
      continue;
    }
    files.push({ file, status: 'edited', detail: true, hunks: hunks.length });
    for (const r of fileRefs) {
      const key = r.line + '#' + (r.symbol || '');
      if (lines.has(key)) continue;
      let p = placeRef(r.line, hunks);
      if (p.status !== 'changed' && r.symbol && !checkRef({ file, line: p.newLine || r.line, symbol: r.symbol }, root).ok) p = { status: 'changed', reason: `"${r.symbol}" no longer near this line` };
      lines.set(key, p);
    }
  }
  const refs = (basis.refs || []).map(r => ({ ...r, ...(placed.get(r.file)?.get(r.line + '#' + (r.symbol || '')) || { status: 'fresh' }) }));
  const count = s => refs.filter(r => r.status === s).length;
  const counts = { fresh: count('fresh'), moved: count('moved'), changed: count('changed'), gone: count('gone') };
  const state = counts.changed || counts.gone ? 'outdated' : files.some(f => f.status !== 'same') ? 'shifted' : 'fresh';
  const diagrams = [...new Set(refs.filter(r => r.status === 'changed' || r.status === 'gone').map(r => r.from))];
  return { feature, state, recordedAt: basis.recordedAt, counts, outdatedIn: diagrams, files: files.filter(f => f.status !== 'same'), refs: refs.filter(r => r.status !== 'fresh') };
}

const isFeatureDir = d => fs.readdirSync(d).some(n => n === 'basis.json' || n.endsWith('.mmd') || n === 'report.json');
export function checkAll(dir) {
  if (isFeatureDir(dir)) return [check(dir)];
  const features = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('_')).map(e => path.join(dir, e.name)).filter(isFeatureDir).sort().map(check);
  const systems = systemDirs(dir).filter(s => isFeatureDir(s.dir)).map(s => ({ ...check(s.dir), feature: '_system/' + s.group }));
  return [...features, ...systems];
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const pos = args.filter(a => !a.startsWith('--'));
  const cmd = ['record', 'check'].includes(pos[0]) ? pos.shift() : 'check';
  const target = pos[0];
  if (!target || !fs.existsSync(target)) { console.error('usage: stale.mjs record <feature-dir> | stale.mjs [check] [--json] <.feature-verify | feature-dir>'); process.exit(2); }
  if (cmd === 'record') {
    const b = record(target);
    const all = Object.values(b.files), inGit = all.filter(f => f.repo);
    console.log(`basis: ${b.refs.length} refs in ${all.length} file(s), ${inGit.length} in git (${[...new Set(inGit.map(f => f.repo))].join(', ') || 'none'})${all.length > inGit.length ? `, ${all.length - inGit.length} outside git (whole-file check only)` : ''}`);
    process.exit(0);
  }
  const res = checkAll(target);
  if (json) console.log(JSON.stringify(res, null, 2));
  else for (const r of res) {
    if (r.state === 'unknown') { console.log(`${r.feature}: unknown — ${r.reason}`); continue; }
    const c = r.counts;
    console.log(`${r.feature}: ${r.state} — ${c.changed} changed, ${c.gone} gone, ${c.moved} moved, ${c.fresh} fresh (since ${r.recordedAt})`);
    for (const x of r.refs) console.log(`  ${x.status.padEnd(7)} ${x.file}:${x.line}${x.symbol ? '#' + x.symbol : ''}${x.newLine ? ' → line ' + x.newLine : ''}  (${x.from})${x.reason ? ' — ' + x.reason : ''}`);
  }
  process.exit(res.some(r => r.state === 'outdated') ? 1 : 0);
}
