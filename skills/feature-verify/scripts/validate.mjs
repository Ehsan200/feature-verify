#!/usr/bin/env node
// Parse every .mmd with the real Mermaid parser (same version the dashboard renders with), plus
// readability lint. First run installs mermaid into a user cache dir (needs network once).
// Usage: node validate.mjs [--json] <dir-or-.mmd>...     exit 1 on any syntax error
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isMain, diagramType, parseDiagram } from './lib.mjs';

export const MERMAID_VERSION = '11.4.1';
const CACHE = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'feature-verify', `mermaid-${MERMAID_VERSION}`);

let mermaidPromise = null;
async function loadMermaid() {
  if (mermaidPromise) return mermaidPromise;
  mermaidPromise = (async () => {
    const req = createRequire(path.join(CACHE, 'package.json'));
    try { req.resolve('mermaid'); } catch {
      fs.mkdirSync(CACHE, { recursive: true });
      if (!fs.existsSync(path.join(CACHE, 'package.json'))) fs.writeFileSync(path.join(CACHE, 'package.json'), '{"private":true}');
      process.stderr.write(`feature-verify: installing mermaid@${MERMAID_VERSION} into ${CACHE} (one time)…\n`);
      execSync(`npm install --no-audit --no-fund --loglevel=error mermaid@${MERMAID_VERSION}`, { cwd: CACHE, stdio: ['ignore', 'ignore', 'inherit'] });
    }
    // Mermaid's sanitizer needs a DOM; parsing does not. Stub it so flowcharts parse in Node.
    // Import through ESM shims in the cache dir so we patch the same module instance mermaid uses.
    const shim = path.join(CACHE, 'fv-shim.mjs');
    if (!fs.existsSync(shim)) fs.writeFileSync(shim, "export { default as purify } from 'dompurify';\nexport { default as mermaid } from 'mermaid';\n");
    const purifyOnly = path.join(CACHE, 'fv-purify.mjs');
    if (!fs.existsSync(purifyOnly)) fs.writeFileSync(purifyOnly, "export { default as purify } from 'dompurify';\n");
    // sequence `box` parsing touches `window?.CSS` and `new Option().style` (color checks); minimal stubs suffice.
    if (typeof globalThis.window === 'undefined') globalThis.window = {};
    if (typeof globalThis.Option === 'undefined') globalThis.Option = class { constructor() { this.style = {}; } };
    const { purify } = await import(pathToFileURL(purifyOnly).href);
    if (typeof purify.addHook !== 'function') Object.assign(purify, { addHook() {}, removeHook() {}, removeHooks() {}, removeAllHooks() {}, sanitize: s => s });
    const { mermaid } = await import(pathToFileURL(shim).href);
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    return mermaid;
  })();
  return mermaidPromise;
}

function lint(src, type) {
  const warnings = [];
  const lines = src.split('\n');
  if (type === 'sequence') {
    const parts = lines.filter(l => /^\s*(participant|actor)\s/.test(l)).length;
    if (parts > 9) warnings.push({ line: 1, message: `${parts} participants — group or split (aim for ≤ 8)` });
  }
  if (type === 'architecture') {
    const nodes = parseDiagram(src, 'architecture').length;
    if (nodes > 16) warnings.push({ line: 1, message: `${nodes} nodes — group with subgraphs or split (aim for ≤ 15)` });
  }
  lines.forEach((l, i) => {
    if (l.trim().startsWith('%%')) return;
    const label = (l.split(':').slice(1).join(':') || '').replace(/\s*\[[^\]]*:\d+[^\]]*\]/g, '').trim();
    if (label.length > 70) warnings.push({ line: i + 1, message: `label is ${label.length} chars — keep under 60` });
  });
  return warnings;
}

export async function validateFiles(files) {
  const result = { checked: 0, errors: [], warnings: [], parser: `mermaid@${MERMAID_VERSION}` };
  let mermaid;
  try { mermaid = await loadMermaid(); } catch (e) {
    result.parser = null;
    result.unavailable = `could not load mermaid: ${String(e.message || e).split('\n')[0]}`;
  }
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    result.checked++;
    for (const w of lint(src, diagramType(f))) result.warnings.push({ file: f, ...w });
    if (!mermaid) continue;
    try { await mermaid.parse(src); } catch (e) {
      const msg = String(e.message || e);
      const line = Number((msg.match(/line (\d+)/) || [])[1]) || null;
      const detail = msg.split('\n').filter(Boolean);
      result.errors.push({ file: f, line, message: detail[0], context: detail.slice(1, 4).join('\n'), sourceLine: line ? src.split('\n')[line - 1] : null });
    }
  }
  result.ok = !result.errors.length && !result.unavailable;
  return result;
}

export function collectMmd(inputs) {
  const out = [];
  for (const p of inputs) {
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) {
      for (const e of fs.readdirSync(p, { withFileTypes: true })) {
        const full = path.join(p, e.name);
        if (e.isDirectory() && e.name !== 'evidence' && e.name !== 'node_modules') out.push(...collectMmd([full]));
        else if (e.name.endsWith('.mmd')) out.push(full);
      }
    } else if (p.endsWith('.mmd')) out.push(p);
  }
  return out.sort();
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const files = collectMmd(args.filter(a => a !== '--json'));
  if (!files.length) { console.error('usage: validate.mjs [--json] <dir-or-.mmd>...'); process.exit(2); }
  const r = await validateFiles(files);
  if (json) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`diagrams: ${r.checked}, syntax errors: ${r.errors.length}, warnings: ${r.warnings.length}${r.parser ? ` (${r.parser})` : ''}`);
    if (r.unavailable) console.log(`UNAVAILABLE ${r.unavailable}`);
    for (const e of r.errors) console.log(`ERROR ${e.file}:${e.line ?? '?'} ${e.message}${e.sourceLine ? `\n      > ${e.sourceLine.trim()}` : ''}${e.context ? '\n      ' + e.context.split('\n').pop() : ''}`);
    for (const w of r.warnings) console.log(`WARN  ${w.file}:${w.line} ${w.message}`);
  }
  process.exit(r.ok ? 0 : 1);
}
