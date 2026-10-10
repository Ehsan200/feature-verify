#!/usr/bin/env node
// Build .feature-verify/index.html — a single-file dashboard: feature sidebar, tabs per feature
// (Overview · diagram types · Concepts · Intent), pan/zoom diagram canvas, compare view, small flow diagrams
// linked by  %% @drill <flow>  (click a message to open its flow; breadcrumb back), and staleness from basis.json.
// Refuses to build if any diagram fails Mermaid parsing (use --force to build with placeholders).
// Usage: node dashboard.mjs [.feature-verify] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { TYPES, parseDiagram, diagramFlow, stripInline, loadIntent, loadMode, loadGroup, loadGlossary, systemDirs, isFeatureName, parseDrill } from './lib.mjs';
import { check as checkStale } from './stale.mjs';
import { validateFiles, collectMmd, MERMAID_VERSION } from './validate.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const dir = path.resolve(args.find(a => !a.startsWith('--')) || '.feature-verify');
if (!fs.existsSync(dir)) { console.error(`no such dir: ${dir}`); process.exit(2); }
const projectRoot = path.dirname(dir);

// ---- syntax gate
const isIgnored = f => path.basename(f).startsWith('intended.') && loadMode(path.dirname(f)) === 'observe';
const validation = await validateFiles(collectMmd([dir]).filter(f => !isIgnored(f)));
const invalid = new Map(validation.errors.map(e => [path.resolve(e.file), e]));
if (validation.errors.length && !force) {
  console.error(`dashboard not built: ${validation.errors.length} diagram(s) fail Mermaid parsing. Fix them (node validate.mjs ${path.relative(process.cwd(), dir) || '.'}) or pass --force.`);
  for (const e of validation.errors) console.error(`  ${path.relative(process.cwd(), e.file)}:${e.line ?? '?'} ${e.message}${e.sourceLine ? ` → ${e.sourceLine.trim()}` : ''}`);
  process.exit(1);
}
if (validation.unavailable) console.error(`warning: ${validation.unavailable} — diagrams not syntax-checked`);

const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const config = readJson(path.join(dir, 'config.json')) || {};
// "src/a.js:12" → absolute path + line, only if the file exists
const resolveRef = (ref, featureDir) => {
  const m = String(ref || '').match(/^([^\s:]+?)(?::(\d+))?$/);
  if (!m) return null;
  for (const base of [projectRoot, featureDir].filter(Boolean)) { const abs = path.resolve(base, m[1]); if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return { abs, line: Number(m[2] || 1) }; }
  return null;
};

const features = [];
// One feature dir, or a system map dir (<fv>/_system/<group>, shown as the pseudo-feature "@<group>").
function loadFeature(fd, name, sys) {
  const d = { name };
  const mode = sys ? 'observe' : loadMode(fd);
  const names = fs.readdirSync(fd);
  const stale = fs.existsSync(path.join(fd, 'basis.json')) ? checkStale(fd) : null;
  const staleRef = new Map((stale?.refs || []).map(r => [r.from + '|' + r.file + '|' + r.line, { status: r.status, newLine: r.newLine || null }]));
  const diagrams = {};
  for (const t of TYPES) {
    // main diagram (no flow name) first, then flows by name
    const pick = (re, kind) => names.filter(n => re.test(n)).sort((a, b) => (diagramFlow(a) ? 1 : 0) - (diagramFlow(b) ? 1 : 0) || a.localeCompare(b)).map(n => {
      const full = path.join(fd, n);
      const raw = fs.readFileSync(full, 'utf8');
      const err = invalid.get(full);
      const elements = parseDiagram(raw, t).map(e => ({
        text: e.text, srcs: e.srcs, assumed: e.assumed, rel: !!e.isRelationship, mmdLine: e.mmdLine, drill: e.drill || null, features: e.features,
        refs: e.refs.map(r => ({ file: r.file, line: r.line, symbol: r.symbol, abs: path.resolve(projectRoot, r.file), stale: staleRef.get(n + '|' + path.relative(projectRoot, path.resolve(projectRoot, r.file)) + '|' + r.line) || null })),
      }));
      return { name: n, label: kind, flow: diagramFlow(n), src: stripInline(raw), elements, error: err ? { line: err.line, message: err.message, sourceLine: err.sourceLine } : null };
    });
    const entry = {
      intended: mode === 'observe' ? [] : pick(new RegExp(`^intended\\.${t}(\\.[\\w-]+)?\\.mmd$`), 'intended'),
      code: pick(new RegExp(`^code\\.${t}(\\.[\\w-]+)?\\.mmd$`), 'code'),
    };
    if (entry.intended.length || entry.code.length) diagrams[t] = entry;
  }
  const report = readJson(path.join(fd, 'report.json'));
  for (const x of report?.findings || []) { const r = resolveRef(x.ref, fd); if (r) x.refLink = r; }
  for (const x of report?.risks || []) {
    const r = resolveRef(String(x.ref || '').split('#')[0], fd);
    if (r) x.refLink = r; else if (x.ref) { x.refBroken = true; console.error(`warning: ${d.name}: risk ref does not resolve: ${x.ref}`); }
  }
  const checks = report?.mechanical && Object.keys(report.mechanical).length ? report.mechanical : readJson(path.join(fd, 'compare.json'));
  let spec = null; try { spec = fs.readFileSync(path.join(fd, 'spec.md'), 'utf8'); } catch {}
  if (Object.keys(diagrams).length || report || spec) {
    const glossary = (loadGlossary(fd)?.terms || []).filter(t => t.term && t.meaning).map(t => ({ ...t, link: resolveRef(String(t.ref || '').split('#')[0]) }));
    if (stale?.state === 'outdated') console.error(`warning: ${d.name}: code changed since its diagrams were made (${stale.counts.changed} changed, ${stale.counts.gone} gone) — node stale.mjs ${path.relative(process.cwd(), fd)}`);
    if (stale) for (const r of stale.refs) { const l = resolveRef(r.file + ':' + (r.newLine || r.line)); if (l) r.link = l; }
    return { name: d.name, group: sys ? sys.group : loadGroup(fd), system: !!sys, mode, glossary, diagrams, report, checks, stale, spec: mode === 'observe' ? null : spec, intent: mode === 'observe' ? null : loadIntent(fd) };
  }
  return null;
}
for (const d of fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory() && isFeatureName(d.name)).sort((a, b) => a.name.localeCompare(b.name))) {
  const f = loadFeature(path.join(dir, d.name), d.name, null);
  if (f) features.push(f);
}

// ---- system maps: which features use each element
// A feature uses a system element when they point at the same code (architecture: same file; state: a ref within
// ±3 lines, or the transition drills into that feature), when an entity's name appears in the feature's diagrams
// (data), or when the element says so (%% @feature a, b). Module nodes inherit their inner diagram's users.
const norm = p => path.relative(projectRoot, path.resolve(projectRoot, p));
const words = text => {
  const toks = (text.match(/[A-Za-z][A-Za-z0-9_]*/g) || []).map(w => w.toLowerCase().replace(/_/g, ''));
  const set = new Set(toks); toks.forEach((w, i) => { if (toks[i + 1]) set.add(w + toks[i + 1]); });
  for (const w of [...set]) if (w.endsWith('s')) set.add(w.slice(0, -1));
  return set;
};
for (const { group, dir: sd } of systemDirs(dir)) {
  const sys = loadFeature(sd, '@' + group, { group });
  if (!sys) continue;
  const members = features.filter(f => (f.group || 'main') === group);
  const idx = members.map(f => {
    const dgs = Object.values(f.diagrams).flatMap(t => t.code);
    const refs = dgs.flatMap(dg => dg.elements.flatMap(e => e.refs)).concat((f.glossary || []).map(t => String(t.ref || '').match(/^([^\s:]+?):(\d+)/)).filter(Boolean).map(m => ({ file: m[1], line: +m[2] })));
    const files = new Set(refs.map(r => norm(r.file)));
    return { name: f.name, files, refs: refs.map(r => ({ file: norm(r.file), line: r.line })), words: words(dgs.map(dg => dg.src).join('\n') + ' ' + (f.glossary || []).map(t => [t.term, ...(t.aka || [])].join(' ')).join(' ')) };
  });
  const near = (x, r, w) => x.refs.some(q => q.file === norm(r.file) && Math.abs(q.line - r.line) <= w);
  // Architecture: one node per file → the whole file is that node. Several nodes in one file (functions of a module)
  // → a feature line belongs to the node whose ref is the nearest at or above it.
  // Data: the same nearest-above rule within a few lines, no whole-file fallback (entities often share one file).
  const owns = (dg, e, r, x, data) => {
    const file = norm(r.file);
    const marks = dg.elements.flatMap(el => el.refs.filter(q => norm(q.file) === file).map(q => ({ el, line: q.line }))).sort((a, b) => a.line - b.line);
    if (marks.length < 2 && !data) return x.files.has(file);
    return x.refs.some(q => { if (q.file !== file) return false; const m = marks.filter(m => m.line <= q.line).pop() || (data ? null : marks[0]); return m?.el === e && (!data || q.line - m.line <= 10); });
  };
  for (const t of ['architecture', 'data', 'state']) {
    for (const dg of sys.diagrams[t]?.code || []) for (const e of dg.elements) {
      const by = new Set(e.features.filter(n => members.some(m => m.name === n)));
      if (e.drill) { const [ft] = parseDrill(e.drill); if (ft && members.some(m => m.name === ft)) by.add(ft); }
      for (const x of idx) {
        if (t === 'architecture' && e.refs.some(r => owns(dg, e, r, x))) by.add(x.name);
        if (t === 'state' && e.refs.some(r => near(x, r, 3))) by.add(x.name);
        if (t === 'data' && !e.rel) {
          const ent = (e.text.match(/^([A-Za-z_][\w-]*)/) || [])[1];
          if ((ent && x.words.has(ent.toLowerCase().replace(/[_-]/g, ''))) || e.refs.some(r => owns(dg, e, r, x, true))) by.add(x.name);
        }
      }
      e.usedBy = [...by].sort();
    }
  }
  // module nodes (architecture @drill <module>) are used by whoever uses their inner diagram
  const arch = sys.diagrams.architecture?.code || [];
  for (let pass = 0; pass < 5; pass++) for (const dg of arch) for (const e of dg.elements) {
    if (!e.drill || parseDrill(e.drill)[0]) continue;
    const inner = arch.find(x => x.flow === e.drill);
    if (inner) e.usedBy = [...new Set([...e.usedBy, ...inner.elements.flatMap(x => x.usedBy || [])])].sort();
  }
  for (const f of members) f.systemMap = sys.name;
  features.push(sys);
}

const data = JSON.stringify({
  project: path.basename(projectRoot), generatedAt: new Date().toISOString(), features, editor: config.editor || null,
  validation: { parser: validation.parser, errors: validation.errors.length, unavailable: validation.unavailable || null },
}).replace(/</g, '\\u003c');

const html = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feature Verify</title>
<style>
:root {
  --bg:#f6f6f3; --panel:#ffffff; --sunken:#f0efeb; --line:#e4e2dc; --line-strong:#d3d0c8;
  --text:#1c1c1a; --muted:#6c6a64; --faint:#9a978f;
  --accent:#2f5bd3; --accent-soft:#e8eefc; --accent-ink:#ffffff;
  --ok:#17784a; --ok-soft:#e2f3e9; --warn:#93600a; --warn-soft:#fbf0d9; --bad:#b4271b; --bad-soft:#fce8e5; --none-soft:#eeede9;
  --node:#eef2fc; --node-line:#9fb3e3; --store:#eaf5ef; --store-line:#8cc5a5; --ext:#f6efe2; --ext-line:#d6b77c; --ui:#f3eefc; --ui-line:#b6a2e3;
  --shadow:0 1px 2px rgba(20,20,15,.05), 0 4px 16px rgba(20,20,15,.04);
  --radius:12px; --font: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg:#121211; --panel:#1b1b19; --sunken:#151514; --line:#2c2b28; --line-strong:#3a3935;
  --text:#ecebe6; --muted:#a29f97; --faint:#77746d;
  --accent:#7aa0ff; --accent-soft:#1d2945; --accent-ink:#0f1320;
  --ok:#5fcf93; --ok-soft:#14301f; --warn:#e9b955; --warn-soft:#33280e; --bad:#ff8a7c; --bad-soft:#3b1814; --none-soft:#262522;
  --node:#1e2740; --node-line:#4f69a8; --store:#16301f; --store-line:#3f8a60; --ext:#332a17; --ext-line:#9a7a3c; --ui:#2a2240; --ui-line:#7a64b5;
  --shadow:0 1px 2px rgba(0,0,0,.3);
}}
:root[data-theme="dark"] {
  --bg:#121211; --panel:#1b1b19; --sunken:#151514; --line:#2c2b28; --line-strong:#3a3935;
  --text:#ecebe6; --muted:#a29f97; --faint:#77746d;
  --accent:#7aa0ff; --accent-soft:#1d2945; --accent-ink:#0f1320;
  --ok:#5fcf93; --ok-soft:#14301f; --warn:#e9b955; --warn-soft:#33280e; --bad:#ff8a7c; --bad-soft:#3b1814; --none-soft:#262522;
  --node:#1e2740; --node-line:#4f69a8; --store:#16301f; --store-line:#3f8a60; --ext:#332a17; --ext-line:#9a7a3c; --ui:#2a2240; --ui-line:#7a64b5;
  --shadow:0 1px 2px rgba(0,0,0,.3);
}
* { box-sizing:border-box; }
[hidden] { display:none !important; }
html, body { height:100%; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 var(--font); -webkit-font-smoothing:antialiased; }
button { font:inherit; color:inherit; }
a { color:var(--accent); }
code, .mono { font-family:var(--mono); font-size:12px; }

.app { display:grid; grid-template-columns:272px minmax(0,1fr); min-height:100vh; }
aside { border-right:1px solid var(--line); background:var(--panel); position:sticky; top:0; height:100vh; display:flex; flex-direction:column; }
.brand { padding:18px 18px 12px; }
.brand .title { font-weight:650; font-size:15px; letter-spacing:-.01em; }
.brand .sub { color:var(--muted); font-size:12px; }
.search { margin:0 14px 10px; }
.search input { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--sunken); color:var(--text); font:inherit; }
.filters { display:flex; gap:4px; flex-wrap:wrap; padding:0 14px 10px; }
.chip { border:1px solid var(--line); background:transparent; border-radius:999px; padding:2px 9px; font-size:12px; cursor:pointer; color:var(--muted); }
.chip[aria-pressed="true"] { background:var(--text); color:var(--panel); border-color:var(--text); }
.flist { overflow:auto; flex:1; padding:4px 8px 16px; }
.fitem { display:flex; align-items:center; gap:10px; width:100%; text-align:left; background:none; border:0; padding:9px 10px; border-radius:8px; cursor:pointer; }
.fitem:hover { background:var(--sunken); }
.fitem[aria-current="true"] { background:var(--accent-soft); }
.fitem .n { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:550; }
.fitem .n .appr { display:block; font-weight:400; }
.ghead { display:flex; align-items:center; gap:4px; width:100%; background:none; border:0; padding:8px 6px 4px; cursor:pointer; color:var(--muted); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; text-align:left; }
.ghead .appr { font-weight:500; }
.fgroup .fitem.ingroup { padding-left:18px; }
.ftree, .ftree ul { list-style:none; margin:0; padding:0; }
.ftree { margin:2px 0 8px 14px; border-left:1px solid var(--line); }
.trow { display:flex; align-items:center; min-width:0; }
.tw { flex:none; width:18px; height:24px; display:inline-grid; place-items:center; background:none; border:0; padding:0; color:var(--muted); font-size:14px; line-height:1; cursor:pointer; border-radius:4px; }
.tw:hover { background:var(--sunken); }
span.tw { cursor:default; }
.tnode { flex:1; min-width:0; text-align:left; background:none; border:0; padding:3px 6px; border-radius:6px; cursor:pointer; font-size:13px; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.tnode:hover { background:var(--sunken); }
.tnode[aria-current="true"] { background:var(--accent-soft); color:var(--accent); font-weight:600; }
.tnode.cross { color:var(--muted); font-style:italic; }
.ftree .tlabel { font-size:11px; color:var(--faint); padding:8px 8px 2px; text-transform:uppercase; letter-spacing:.04em; }
a.mono, .linkbtn.mono { overflow-wrap:anywhere; }
.dot { width:9px; height:9px; border-radius:50%; flex:none; background:var(--faint); }
.dot.verified { background:var(--ok); } .dot.partial, .dot.incomplete { background:var(--warn); } .dot.mismatch { background:var(--bad); } .dot.observed { background:var(--accent); }
.appr { font-size:11px; color:var(--muted); }
.sidefoot { border-top:1px solid var(--line); padding:10px 14px; display:grid; gap:8px; color:var(--muted); font-size:12px; }
.sidefoot select { font:inherit; font-size:12px; color:var(--text); background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:3px 6px; }
.sidefoot .opts { display:flex; gap:6px; align-items:center; }
.sidefoot .opts select { flex:1; min-width:0; }
.iconbtn { border:1px solid var(--line); background:var(--panel); border-radius:8px; padding:4px 9px; cursor:pointer; font-size:12px; }

main { min-width:0; padding:22px 28px 48px; }
.fhead { display:flex; flex-wrap:wrap; align-items:center; gap:10px 14px; }
.fhead h1 { margin:0; font-size:22px; letter-spacing:-.02em; }
.pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; padding:3px 10px; border-radius:999px; background:var(--none-soft); color:var(--muted); }
.pill.verified { background:var(--ok-soft); color:var(--ok); }
.pill.partial, .pill.incomplete, .pill.assumed { background:var(--warn-soft); color:var(--warn); }
.pill.observed { background:var(--accent-soft); color:var(--accent); }
.pill.mode { background:transparent; border:1px solid var(--line-strong); color:var(--muted); font-weight:500; }
.pill.mismatch { background:var(--bad-soft); color:var(--bad); }
.summary { color:var(--muted); margin:8px 0 0; max-width:900px; }

.tabs { display:flex; gap:2px; margin:20px 0 16px; border-bottom:1px solid var(--line); overflow-x:auto; }
.tab { background:none; border:0; padding:9px 14px; cursor:pointer; color:var(--muted); border-bottom:2px solid transparent; margin-bottom:-1px; white-space:nowrap; display:flex; gap:7px; align-items:center; }
.tab:hover { color:var(--text); }
.tab[aria-selected="true"] { color:var(--text); border-bottom-color:var(--accent); font-weight:600; }
.tab .badge { font-size:11px; padding:0 6px; border-radius:999px; background:var(--bad-soft); color:var(--bad); font-weight:600; }
.tab .badge.warn { background:var(--warn-soft); color:var(--warn); }

.card { background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow); }
.card > h2 { font-size:13px; margin:0; padding:14px 16px 10px; color:var(--muted); font-weight:600; text-transform:uppercase; letter-spacing:.04em; }
.grid2 { display:grid; grid-template-columns:minmax(0,1.1fr) minmax(0,1fr); gap:16px; }
.stack { display:grid; gap:16px; }

.checks { list-style:none; margin:0; padding:0 8px 8px; }
.checks li { display:grid; grid-template-columns:24px 150px minmax(0,1fr); gap:8px; padding:9px 8px; border-top:1px solid var(--line); align-items:start; }
.checks li:first-child { border-top:0; }
.ic { width:20px; height:20px; border-radius:50%; display:grid; place-items:center; font-size:12px; font-weight:700; }
.ic.ok { background:var(--ok-soft); color:var(--ok); } .ic.bad { background:var(--bad-soft); color:var(--bad); } .ic.warn { background:var(--warn-soft); color:var(--warn); } .ic.na { background:var(--none-soft); color:var(--faint); }
.checks .k { font-weight:600; }
.checks .v { color:var(--muted); }
.findings { list-style:none; margin:0; padding:0 8px 8px; }
.risks { list-style:none; margin:0; padding:0 8px 8px; }
.risks li { display:grid; grid-template-columns:76px minmax(0,1fr); gap:10px; padding:11px 8px; border-top:1px solid var(--line); }
.risks li:first-child { border-top:0; }
.impact { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; padding:2px 0; }
.impact.high { color:var(--bad); } .impact.medium { color:var(--warn); } .impact.low { color:var(--muted); }
.risks .rtext { font-weight:500; }
.risks .meta { font-size:12px; color:var(--muted); margin-top:4px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.ev { font-size:11px; font-weight:600; padding:1px 7px; border-radius:6px; }
.riskcard { margin-bottom:16px; }
.cardnote { margin:-6px 16px 6px; font-size:12px; color:var(--muted); }
.findings li { display:grid; grid-template-columns:64px minmax(0,1fr); gap:10px; padding:10px 8px; border-top:1px solid var(--line); }
.findings li:first-child { border-top:0; }
.sev { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; padding-top:2px; }
.sev.high { color:var(--bad); } .sev.medium { color:var(--warn); } .sev.low { color:var(--muted); }
.findings .meta { font-size:12px; color:var(--muted); margin-top:2px; display:flex; gap:8px; flex-wrap:wrap; }
.linkbtn { background:none; border:0; color:var(--accent); cursor:pointer; padding:0; font-size:12px; }
table.matrix { border-collapse:collapse; width:calc(100% - 16px); margin:0 8px 10px; font-size:13px; }
.matrix th, .matrix td { padding:8px 10px; border-top:1px solid var(--line); text-align:left; }
.matrix th { color:var(--muted); font-weight:600; font-size:12px; }
.matrix td button { background:none; border:0; cursor:pointer; padding:0; }
.yes { color:var(--ok); font-weight:700; } .no { color:var(--faint); }

.toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; margin-bottom:10px; }
.seg { display:inline-flex; background:var(--sunken); border:1px solid var(--line); border-radius:9px; padding:2px; }
.seg button { border:0; background:none; padding:5px 12px; border-radius:7px; cursor:pointer; color:var(--muted); font-size:13px; }
.seg button[aria-pressed="true"] { background:var(--panel); color:var(--text); box-shadow:var(--shadow); font-weight:600; }
.seg button:disabled { opacity:.4; cursor:not-allowed; }
.zoom { display:inline-flex; gap:4px; align-items:center; }
.zoom span { min-width:44px; text-align:center; color:var(--muted); font-size:12px; }
.panes { display:grid; gap:12px; }
.panes.n2 { grid-template-columns:repeat(2, minmax(0,1fr)); } .panes.n3 { grid-template-columns:repeat(3, minmax(0,1fr)); }
.pane { display:flex; flex-direction:column; min-width:0; }
.pane-h { display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-bottom:1px solid var(--line); font-size:12px; }
.pane-h b { text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-size:11px; }
.pane-h .mono { color:var(--faint); }
.pane-h select { font:inherit; font-size:12px; font-weight:600; color:var(--text); background:var(--sunken); border:1px solid var(--line); border-radius:7px; padding:3px 6px; }
.el .from { color:var(--muted); font-size:12px; display:block; }
.canvas { position:relative; overflow:hidden; height:clamp(300px, 68vh, 920px); cursor:grab; border-radius:0 0 var(--radius) var(--radius);
  background-color:var(--panel); background-image:radial-gradient(var(--line) 1px, transparent 1px); background-size:18px 18px; }
.canvas.grabbing { cursor:grabbing; }
.stage { position:absolute; left:0; top:0; transform-origin:0 0; }
.stage svg { display:block; max-width:none !important; }
.placeholder { padding:28px; color:var(--muted); }
.placeholder.err { color:var(--bad); }
.placeholder pre { white-space:pre-wrap; background:var(--sunken); padding:10px; border-radius:8px; color:var(--text); font-size:12px; }
.diffbar { display:flex; flex-wrap:wrap; gap:6px; margin:12px 0 0; }
.diffchip { font-size:12px; padding:3px 9px; border-radius:7px; border:1px solid var(--line); background:var(--panel); }
.diffchip.bad { border-color:transparent; background:var(--bad-soft); color:var(--bad); } .diffchip.warn { border-color:transparent; background:var(--warn-soft); color:var(--warn); }
.details { margin-top:16px; }
table.el { width:100%; border-collapse:collapse; font-size:13px; }
.el td, .el th { padding:7px 12px; border-top:1px solid var(--line); text-align:left; vertical-align:top; }
.el th { font-size:12px; color:var(--muted); font-weight:600; }
.el td:first-child { width:46%; }
.tag { display:inline-block; font-size:11px; font-weight:600; padding:1px 7px; border-radius:6px; background:var(--accent-soft); color:var(--accent); margin:0 4px 2px 0; }
.tag.assumed { background:var(--warn-soft); color:var(--warn); }
.tag.missing { background:var(--bad-soft); color:var(--bad); }

.md { padding:4px 18px 16px; max-width:820px; }
.md h1, .md h2, .md h3 { margin:14px 0 6px; letter-spacing:-.01em; } .md h1 { font-size:18px; } .md h2 { font-size:15px; } .md h3 { font-size:14px; }
.md p { margin:6px 0; } .md ul { margin:6px 0; padding-left:20px; }
.sources { list-style:none; margin:0; padding:0 8px 8px; }
.sources li { padding:10px 8px; border-top:1px solid var(--line); display:grid; grid-template-columns:44px minmax(0,1fr); gap:10px; }
.sources li:first-child { border-top:0; }
.sid { font-family:var(--mono); font-weight:700; font-size:12px; padding-top:2px; }
blockquote { margin:4px 0; padding:2px 10px; border-left:3px solid var(--line-strong); color:var(--text); }
.kind { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:600; }
pre.block { margin:0 16px 16px; background:var(--sunken); border:1px solid var(--line); border-radius:8px; padding:10px; overflow:auto; font-size:12px; }
.terms { list-style:none; margin:0; padding:0 8px 8px; }
.terms li { padding:10px 8px; border-top:1px solid var(--line); display:grid; grid-template-columns:minmax(110px, 180px) minmax(0,1fr); gap:6px 14px; }
.terms li:first-child { border-top:0; }
.terms .t { font-family:var(--mono); font-weight:700; font-size:13px; word-break:break-word; }
.terms .aka { color:var(--muted); font-size:12px; }
.terms .meta { font-size:12px; color:var(--muted); margin-top:3px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.kindtag { font-size:11px; padding:0 6px; border-radius:5px; background:var(--sunken); border:1px solid var(--line); color:var(--muted); }
.legend { width:100%; border-collapse:collapse; font-size:13px; }
.legend td { padding:7px 14px; border-top:1px solid var(--line); vertical-align:top; }
.legend td:first-child { width:38%; font-family:var(--mono); font-size:12px; white-space:pre; color:var(--text); }
.legend tr:first-child td { border-top:0; }
.cfilter { margin:0 16px 8px; width:calc(100% - 32px); padding:7px 10px; border:1px solid var(--line); border-radius:8px; background:var(--sunken); color:var(--text); font:inherit; }
.termbar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-top:12px; font-size:12px; color:var(--muted); }
.termchip { border:1px dashed var(--line-strong); background:var(--panel); border-radius:7px; padding:2px 8px; cursor:pointer; font-family:var(--mono); font-size:12px; color:var(--text); }
.termchip[aria-expanded="true"] { border-style:solid; border-color:var(--accent); }
.termdef { flex-basis:100%; background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:8px 12px; color:var(--text); font-size:13px; }
abbr.term { text-decoration:underline dotted var(--muted); text-underline-offset:3px; cursor:help; }
.empty { padding:60px 20px; text-align:center; color:var(--muted); }
.flownav { display:grid; gap:8px; margin-bottom:10px; }
.crumbs { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:14px; }
.crumbs .linkbtn { font-size:14px; }
.crumbs .sep { color:var(--faint); }
.flows { display:flex; flex-wrap:wrap; gap:4px; align-items:center; font-size:12px; color:var(--muted); }
.flows > span { margin-right:4px; }
.hint { font-size:12px; color:var(--muted); }
.stage .fv-drill { cursor:pointer; }
.stage text.fv-drill { fill:var(--accent) !important; text-decoration:underline; text-underline-offset:3px; }
.stage line.fv-drill, .stage path.fv-drill { stroke:var(--accent) !important; }
.stage .fv-hit.fv-hit { stroke:transparent !important; stroke-width:16px !important; fill:none !important; pointer-events:stroke; cursor:pointer; }
.tag.stale { background:var(--warn-soft); color:var(--warn); }
.fitem.sysitem .n { font-weight:600; }
.sysicon { flex:none; width:16px; height:16px; border-radius:4px; border:1.5px solid var(--accent); display:grid; place-items:center; font-size:9px; color:var(--accent); }
.hlpick { font-size:13px; color:var(--muted); display:inline-flex; gap:6px; align-items:center; }
.hlpick select { font:inherit; font-size:13px; color:var(--text); background:var(--sunken); border:1px solid var(--line); border-radius:7px; padding:4px 6px; }
.toolleft { display:flex; flex-wrap:wrap; gap:10px; align-items:center; }
.stage g.fv-drill-node { cursor:pointer; }
.stage g.fv-drill-node > rect, .stage g.fv-drill-node > path, .stage g.fv-drill-node > polygon, .stage g.fv-drill-node > circle { stroke:var(--accent) !important; stroke-width:2.5px !important; }
.stage .edgeLabel.fv-drill { cursor:pointer; }
.stage .edgeLabel.fv-drill span, .stage .edgeLabel.fv-drill p { color:var(--accent) !important; text-decoration:underline; }
.stage g.fv-off { opacity:.22; }
.stage g.fv-on > rect, .stage g.fv-on > path { stroke:var(--accent) !important; stroke-width:2.5px !important; }
tr.hlrow td { background:var(--accent-soft); }
.panes.fs { position:fixed; inset:0; z-index:50; background:var(--bg); padding:12px; margin:0; }
.panes.fs .canvas { height:calc(100vh - 66px) !important; }
.panes .fsclose { display:none; }
.panes.fs .fsclose { display:block; position:fixed; bottom:22px; right:24px; z-index:51; box-shadow:var(--shadow); }
body.noscroll { overflow:hidden; }
.usedby { display:flex; flex-wrap:wrap; gap:4px; }
.usedby .chip { font-size:11px; padding:1px 7px; }
.uses { list-style:none; margin:0; padding:0 8px 10px; }
.uses li { display:grid; grid-template-columns:110px minmax(0,1fr); gap:10px; padding:9px 8px; border-top:1px solid var(--line); align-items:start; }
.uses li:first-child { border-top:0; }
.uses .k { font-weight:600; font-size:13px; }
.tag.stale.bad { background:var(--bad-soft); color:var(--bad); }
.pill.stale { cursor:pointer; border:0; }
details.moved > summary { cursor:pointer; padding:4px 16px 12px; font-size:12px; color:var(--muted); }
.stage text.fv-stale { fill:var(--bad) !important; }
.stage line.fv-stale, .stage path.fv-stale { stroke:var(--bad) !important; stroke-dasharray:6 3; }
.chip .sdot { display:inline-block; width:7px; height:7px; border-radius:50%; background:var(--bad); margin-left:5px; vertical-align:middle; }

@media (max-width: 980px) {
  .app { grid-template-columns:1fr; }
  aside { position:static; height:auto; border-right:0; border-bottom:1px solid var(--line); }
  .flist { max-height:220px; }
  main { padding:16px; }
  .grid2, .panes.n2, .panes.n3 { grid-template-columns:1fr; }
  .checks li { grid-template-columns:24px minmax(0,1fr); } .checks .v { grid-column:2; }
}
</style>
</head>
<body>
<div class="app">
  <aside>
    <div class="brand"><div class="title">Feature Verify</div><div class="sub" id="proj"></div></div>
    <div class="search"><input id="q" type="search" placeholder="Filter features and diagrams" aria-label="Filter features and diagrams"></div>
    <div class="filters" id="filters"></div>
    <nav class="flist" id="flist" aria-label="Features"></nav>
    <div class="sidefoot"><span class="opts"><select id="editor" aria-label="Open files in" title="Open code links in"></select><button class="iconbtn" id="theme" title="Theme">Auto</button></span><span id="gen"></span></div>
  </aside>
  <main id="main"></main>
</div>
<script type="application/json" id="data">${data}</script>
<script type="module">
import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs';
const D = JSON.parse(document.getElementById('data').textContent);
const TYPES = ['sequence', 'architecture', 'data', 'state'];
const TYPE_LABEL = { sequence: 'Sequence', architecture: 'Architecture', data: 'Data', state: 'State' };
const h = (t, a = {}, ...kids) => {
  const e = document.createElement(t);
  for (const [k, v] of Object.entries(a)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
  return e;
};
const store = { get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, v); } catch {} } };

// ---------- editor links ----------
const EDITORS = {
  cursor: ['Cursor', (a, l) => 'cursor://file' + a + ':' + l],
  vscode: ['VS Code', (a, l) => 'vscode://file' + a + ':' + l],
  'vscode-insiders': ['VS Code Insiders', (a, l) => 'vscode-insiders://file' + a + ':' + l],
  windsurf: ['Windsurf', (a, l) => 'windsurf://file' + a + ':' + l],
  zed: ['Zed', (a, l) => 'zed://file' + a + ':' + l],
  copy: ['Copy path', null],
};
let editor = store.get('fv-editor', null) || (EDITORS[D.editor] ? D.editor : 'cursor');
if (!EDITORS[editor]) editor = 'cursor';
const edSel = document.getElementById('editor');
for (const [k, [label]] of Object.entries(EDITORS)) edSel.append(h('option', { value: k, selected: k === editor }, 'Open in ' + label));
edSel.addEventListener('change', e => { editor = e.target.value; store.set('fv-editor', editor); route(); });
// A link to file:line in the chosen editor (or a copy-to-clipboard button).
const shortPath = t => { const p = String(t).split('/'); return t.length <= 44 || p.length <= 3 ? t : p[0] + '/…/' + p.slice(-2).join('/'); };
function fileLink(abs, line, full) {
  const text = shortPath(full);
  const make = EDITORS[editor][1];
  if (!make) return h('button', { class: 'linkbtn mono', title: 'Copy ' + abs + ':' + line, onclick: e => { navigator.clipboard?.writeText(abs + ':' + line); const t = e.target; const o = t.textContent; t.textContent = 'copied'; setTimeout(() => (t.textContent = o), 1000); } }, text);
  const p = abs.startsWith('/') ? abs : '/' + abs.replace(/\\/g, '/'); // editors expect <scheme>://file/<absolute path> (Windows: /C:/…)
  return h('a', { class: 'mono', href: make(encodeURI(p).replace(/#/g, '%23'), line), title: (text !== full ? full + ' — ' : '') + 'Open in ' + EDITORS[editor][0] }, text);
}

// ---------- theme ----------
let themePref = store.get('fv-theme', 'auto');
const isDark = () => themePref === 'dark' || (themePref === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
function applyTheme() {
  if (themePref === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.dataset.theme = themePref;
  document.getElementById('theme').textContent = { auto: 'Auto', light: 'Light', dark: 'Dark' }[themePref];
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  mermaid.initialize({
    startOnLoad: false, securityLevel: 'strict', theme: 'base', darkMode: isDark(),
    fontFamily: 'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    themeVariables: {
      fontSize: '14px', background: css('--panel'),
      primaryColor: css('--node'), primaryBorderColor: css('--node-line'), primaryTextColor: css('--text'),
      secondaryColor: css('--sunken'), tertiaryColor: css('--panel'), lineColor: css('--muted'), textColor: css('--text'),
      actorBkg: css('--node'), actorBorder: css('--node-line'), actorTextColor: css('--text'), actorLineColor: css('--line-strong'),
      signalColor: css('--muted'), signalTextColor: css('--text'),
      labelBoxBkgColor: css('--sunken'), labelBoxBorderColor: css('--line-strong'), labelTextColor: css('--text'), loopTextColor: css('--muted'),
      noteBkgColor: css('--warn-soft'), noteBorderColor: css('--warn'), noteTextColor: css('--text'),
      activationBkgColor: css('--accent-soft'), activationBorderColor: css('--accent'), sequenceNumberColor: css('--panel'),
      clusterBkg: css('--sunken'), clusterBorder: css('--line-strong'), edgeLabelBackground: css('--panel'), titleColor: css('--text'),
      nodeBorder: css('--node-line'), mainBkg: css('--node'),
      attributeBackgroundColorOdd: css('--panel'), attributeBackgroundColorEven: css('--sunken'),
    },
    sequence: { useMaxWidth: false, mirrorActors: false, wrap: true, width: 170, actorMargin: 64, messageMargin: 38, boxMargin: 12, noteMargin: 12, boxTextMargin: 6, diagramMarginX: 24, diagramMarginY: 16 },
    flowchart: { useMaxWidth: false, curve: 'basis', padding: 16, nodeSpacing: 46, rankSpacing: 64, diagramPadding: 16 },
    state: { useMaxWidth: false, padding: 10 },
    er: { useMaxWidth: false, layoutDirection: 'LR', entityPadding: 14, diagramPadding: 16 },
  });
}
document.getElementById('theme').addEventListener('click', () => {
  themePref = { auto: 'light', light: 'dark', dark: 'auto' }[themePref]; store.set('fv-theme', themePref);
  applyTheme(); route();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePref === 'auto') { applyTheme(); route(); } });
applyTheme();

// Styling classes diagrams may use: :::ui :::svc :::store :::ext :::assumed :::gap
function decorate(src) {
  const head = src.trimStart().split(/\s/)[0];
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const defs = [
    ['ui', '--ui', '--ui-line'], ['svc', '--node', '--node-line'], ['store', '--store', '--store-line'], ['ext', '--ext', '--ext-line'],
    ['assumed', '--warn-soft', '--warn', '4 3'], ['gap', '--bad-soft', '--bad', '4 3'],
  ].map(([n, f, s, dash]) => 'classDef ' + n + ' fill:' + css(f) + ',stroke:' + css(s) + ',color:' + css('--text') + (dash ? ',stroke-dasharray:' + dash : ''))
    .concat(['classDef fvOn stroke:' + css('--accent') + ',stroke-width:3px', 'classDef fvOff opacity:0.22']);
  if (/^(flowchart|graph)$/.test(head) || /^stateDiagram/.test(head)) return src.replace(/\s*$/, '\n') + defs.map(d => '  ' + d).join('\n') + '\n';
  return src;
}

// ---------- status helpers ----------
const statusOf = f => f.system ? 'system' : f.report?.status || (f.mode === 'observe' ? 'incomplete' : 'unverified');
const FEATS = D.features.filter(f => !f.system);
const sysOf = f => f.system ? f : D.features.find(x => x.name === f.systemMap) || null;
const usedBy = (e, name) => (e.usedBy || []).includes(name);
const KINDS = f => f.mode === 'observe' ? ['code'] : ['intended', 'code'];

// ---------- sidebar ----------
document.getElementById('proj').textContent = D.project + ' · ' + FEATS.length + ' feature' + (FEATS.length === 1 ? '' : 's');
document.getElementById('gen').textContent = 'built ' + new Date(D.generatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
let filter = 'all', query = '';
const STATUSES = ['all', 'mismatch', 'partial', 'incomplete', 'verified', 'observed', 'unverified'];
function renderFilters() {
  const box = document.getElementById('filters'); box.innerHTML = '';
  for (const s of STATUSES) {
    const n = s === 'all' ? FEATS.length : FEATS.filter(f => statusOf(f) === s).length;
    if (s !== 'all' && !n) continue;
    box.append(h('button', { class: 'chip', 'aria-pressed': String(filter === s), onclick: () => { filter = s; renderFilters(); renderList(); } }, s + ' ' + n));
  }
}
// Sidebar: features (grouped by feature.json "group"); the open feature unfolds into its flow tree.
const openState = new Map((() => { try { return JSON.parse(store.get('fv-open', '[]')); } catch { return []; } })());
const toggle = (key, now) => { openState.set(key, !now); store.set('fv-open', JSON.stringify([...openState])); renderList(); };
function featureItem(f, cur, inGroup) {
  const hi = (f.report?.risks || []).filter(r => r.impact === 'high').length;
  return h('button', { class: 'fitem' + (inGroup ? ' ingroup' : ''), 'aria-current': String(f.name === cur), onclick: () => go(f.name) },
    h('span', { class: 'dot ' + statusOf(f), title: statusOf(f) }), h('span', { class: 'n' }, f.name, h('span', { class: 'appr' }, (f.mode === 'observe' ? 'observe' : statusOf(f)) + (f.stale?.state === 'outdated' ? ' · code changed' : '') + (hi ? ' · ' + hi + ' high risk' : ''))));
}
function flowNav(f, r, hits, type = 'sequence') {
  const t = flowTree(f, type);
  if (t.flows.length < 2) return null;
  const onSeq = r.feature === f.name && r.tab === type;
  const curFlow = onSeq ? (t.flows.includes(r.flow) ? r.flow : t.flows[0]) : null;
  const open = fl => go(f.name, type, onSeq ? r.view : undefined, fl);
  const ul = h('ul', { class: 'ftree', role: 'tree', 'aria-label': f.name + ' diagrams' });
  if (query && hits.length) {
    for (const fl of hits) ul.append(h('li', { role: 'treeitem' }, h('div', { class: 'trow' }, h('span', { class: 'tw' }), h('button', { class: 'tnode', 'aria-current': String(fl === curFlow), onclick: () => open(fl) }, flowLabel(fl, true)))));
    return ul;
  }
  const path = new Set();
  for (let x = curFlow; x != null && !path.has(x); x = t.parent.get(x)) path.add(x);
  const node = (fl, depth, seen) => {
    const kids = t.kids.get(fl).filter(k => !seen.has(k)), cross = t.cross.get(fl);
    const key = 'f:' + f.name + ':' + type + ':' + fl, has = kids.length + cross.length > 0;
    const expanded = has && (openState.has(key) ? openState.get(key) : fl === '' || path.has(fl));
    const li = h('li', { role: 'treeitem', 'aria-expanded': has ? String(expanded) : null },
      h('div', { class: 'trow', style: 'padding-left:' + depth * 12 + 'px' },
        has ? h('button', { class: 'tw', 'aria-label': (expanded ? 'Collapse ' : 'Expand ') + flowLabel(fl, true), onclick: () => toggle(key, expanded) }, expanded ? '▾' : '▸') : h('span', { class: 'tw' }),
        h('button', { class: 'tnode', 'aria-current': String(fl === curFlow), title: flowLabel(fl, true), onclick: () => open(fl) }, flowLabel(fl, true),
          t.changed(fl) ? h('span', { class: 'sdot', title: 'Code changed since this diagram was made' }) : null)));
    if (fl === '' && type !== 'sequence') li.querySelector('.tnode').firstChild.textContent = TYPE_LABEL[type];
    if (expanded) {
      const sub = h('ul', { role: 'group' }), next = new Set([...seen, fl]);
      for (const k of kids) sub.append(node(k, depth + 1, next));
      for (const c of cross) sub.append(h('li', { role: 'treeitem' }, h('div', { class: 'trow', style: 'padding-left:' + (depth + 1) * 12 + 'px' }, h('span', { class: 'tw', 'aria-hidden': 'true' }, '↗'),
        h('button', { class: 'tnode cross', title: 'In feature ' + drillTarget(f, c)[0], onclick: () => { const [ft, fl2] = drillTarget(f, c); go(ft, 'sequence', undefined, fl2); } }, drillLabel(f, c)))));
      li.append(sub);
    }
    return li;
  };
  if (t.kids.has('')) ul.append(node('', 0, new Set()));
  const rest = t.unlinked.filter(fl => fl !== '');
  if (rest.length) {
    ul.append(h('li', { class: 'tlabel' }, t.kids.has('') ? 'Not linked from the overview' : 'Diagrams'));
    for (const fl of rest) ul.append(node(fl, 0, new Set()));
  }
  return ul;
}
function renderList() {
  const nav = document.getElementById('flist'); nav.innerHTML = '';
  const r = parseRoute(), cur = r.feature;
  const flowHits = f => query ? flowTree(f).flows.filter(fl => fl && flowLabel(fl, true).toLowerCase().includes(query)) : [];
  const shown = FEATS.filter(f => (filter === 'all' || statusOf(f) === filter) &&
    (!query || f.name.toLowerCase().includes(query) || (f.group || '').toLowerCase().includes(query) || flowHits(f).length));
  const groups = new Map();
  for (const f of shown) { const g = f.group || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(f); }
  for (const x of D.features) if (x.system && !query && x.group !== 'main' && !groups.has(x.group)) groups.set(x.group, []);
  if (D.features.some(x => x.system && x.group === 'main') && !groups.has('') && !query) groups.set('', []);
  const order = [...[...groups.keys()].filter(Boolean).sort(), ...(groups.has('') ? [''] : [])];
  for (const g of order) {
    const box = h('div', { class: 'fgroup' });
    const list = groups.get(g);
    if (g) {
      const key = 'g:' + g, open = query ? true : openState.get(key) ?? true; // filtering opens every group; otherwise the user decides
      box.append(h('button', { class: 'ghead', 'aria-expanded': String(open), onclick: () => toggle(key, open) }, h('span', { 'aria-hidden': 'true' }, open ? '▾' : '▸'), g, h('span', { class: 'appr' }, ' · ' + list.length)));
      if (!open) { nav.append(box); continue; }
    }
    const sys = D.features.find(x => x.system && x.group === (g || 'main'));
    if (sys) {
      box.append(h('button', { class: 'fitem sysitem' + (g ? ' ingroup' : ''), 'aria-current': String(sys.name === cur), onclick: () => go(sys.name) },
        h('span', { class: 'sysicon', 'aria-hidden': 'true' }, '◎'), h('span', { class: 'n' }, 'System map', h('span', { class: 'appr' }, ['architecture', 'data', 'state'].filter(t => sys.diagrams[t]).join(' · ') + (sys.stale?.state === 'outdated' ? ' · code changed' : '')))));
      if (sys.name === cur) { const ty = ['architecture', 'state', 'data'].includes(r.tab) ? r.tab : 'architecture'; const t = flowNav(sys, r, [], ty); if (t) box.append(t); }
    }
    for (const f of list) {
      box.append(featureItem(f, cur, !!g));
      const hits = flowHits(f);
      if (f.name === cur || hits.length) { const t = flowNav(f, r, hits); if (t) box.append(t); }
    }
    nav.append(box);
  }
  if (!nav.children.length) nav.append(h('div', { class: 'appr', style: 'padding:10px' }, 'No matching features.'));
}
document.getElementById('q').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); renderList(); });

// ---------- routing: #/feature/tab/view ----------
function parseRoute() {
  const [feature, tab, view, flow] = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/');
  return { feature: feature || FEATS[0]?.name || D.features[0]?.name, tab: tab || 'overview', view, flow: flow || '' };
}
// #/feature/tab/view/flow — flow is the diagram's flow name ('' = the main diagram)
const go = (feature, tab = 'overview', view, flow) => {
  const segs = [feature, tab, view, flow];
  while (segs.length && !segs[segs.length - 1]) segs.pop();
  location.hash = '#/' + segs.map(x => encodeURIComponent(x || '')).join('/');
};
const flowLabel = (fl, multi) => fl ? fl.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase()) : multi ? 'Overview' : 'Main';
// @drill targets: 'flow' (this feature) | 'feature:flow' | 'feature:' (that feature's overview)
const drillTarget = (f, t) => { const i = t.indexOf(':'); return i < 0 ? [f.name, t] : [t.slice(0, i), t.slice(i + 1)]; };
const drillLabel = (f, t) => { const [ft, fl] = drillTarget(f, t); return (ft !== f.name ? ft + ' › ' : '') + flowLabel(fl, true); };
// The feature's sequence flows as a tree, from its @drill links: overview → flows → deeper flows; cross-feature links as leaves.
const treeCache = new Map();
function flowTree(f, type = 'sequence') {
  const ck = f.name + '|' + type;
  if (treeCache.has(ck)) return treeCache.get(ck);
  const d = f.diagrams[type];
  const all = d ? ['intended', 'code'].flatMap(k => d[k]) : [];
  const flows = [...new Set(all.map(dg => dg.flow))].sort((a, b) => (a ? 1 : 0) - (b ? 1 : 0) || a.localeCompare(b));
  const kids = new Map(flows.map(fl => [fl, []])), cross = new Map(flows.map(fl => [fl, []])), parent = new Map();
  for (const dg of all) for (const e of dg.elements) {
    if (!e.drill) continue;
    const [ft, fl] = drillTarget(f, e.drill);
    if (ft !== f.name) { if (!cross.get(dg.flow).includes(e.drill)) cross.get(dg.flow).push(e.drill); continue; }
    if (fl === dg.flow || !kids.has(fl) || fl === '') continue;
    if (!kids.get(dg.flow).includes(fl)) kids.get(dg.flow).push(fl);
    if (!parent.has(fl)) parent.set(fl, dg.flow);
  }
  const reach = new Set();
  const walk = fl => { if (reach.has(fl)) return; reach.add(fl); kids.get(fl).forEach(walk); };
  if (kids.has('')) walk('');
  const unlinked = flows.filter(fl => !reach.has(fl) && !parent.has(fl));
  unlinked.forEach(walk);
  const t = { flows, kids, cross, parent, unlinked: [...unlinked, ...flows.filter(fl => !reach.has(fl))],
    changed: fl => all.some(dg => dg.flow === fl && f.stale?.outdatedIn?.includes(dg.name)) };
  treeCache.set(ck, t); return t;
}
const STALE = {
  outdated: ['code changed', 'Code the diagrams point at was edited since they were made. Ask the agent to re-run this feature.'],
  shifted: ['code moved', 'Referenced files were edited, but not at the lines the diagrams point at (line numbers may have moved).'],
};
addEventListener('hashchange', route);

function route() {
  renderList();
  const main = document.getElementById('main'); main.innerHTML = '';
  fsToggle = null; document.body.classList.remove('noscroll');
  if (!D.features.length) { main.append(h('div', { class: 'empty' }, h('h2', {}, 'No features yet'), h('p', {}, 'Run feature-verify in this project to create one.'))); return; }
  const r = parseRoute();
  const f = D.features.find(x => x.name === r.feature) || D.features[0];
  const st = statusOf(f);
  main.append(h('header', { class: 'fhead' }, h('h1', {}, f.system ? 'System map' + (f.group !== 'main' ? ' · ' + f.group : '') : f.name), f.system ? h('span', { class: 'pill observed' }, 'whole system') : h('span', { class: 'pill ' + st }, st),
    f.mode === 'observe' && !f.system ? h('span', { class: 'pill mode', title: 'Shows what the code does. Nothing is checked against a spec.' }, 'observe mode') : null,
    STALE[f.stale?.state] ? h('button', { class: 'pill stale ' + (f.stale.state === 'outdated' ? 'mismatch' : 'partial'), title: STALE[f.stale.state][1], onclick: () => go(f.name) }, STALE[f.stale.state][0]) : null));
  if (f.report?.summary) main.append(h('p', { class: 'summary' }, f.report.summary));
  if (f.system && !f.report?.summary) main.append(h('p', { class: 'summary' }, 'How the parts of ' + (f.group === 'main' ? 'the project' : f.group) + ' fit together: components, data and lifecycles. Each feature is a story through this map — pick one to see which parts it uses.'));

  const tabs = [['overview', 'Overview']];
  for (const t of TYPES) if (f.diagrams[t] || (t !== 'sequence' && sysOf(f)?.diagrams[t])) tabs.push([t, TYPE_LABEL[t]]); // no own diagram → the system map, this feature highlighted
  tabs.push(['concepts', 'Concepts']);
  if (f.intent || f.spec) tabs.push(['intent', 'Intent']);
  const tab = tabs.some(t => t[0] === r.tab) ? r.tab : 'overview';
  const badges = tabBadges(f);
  main.append(h('nav', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label]) =>
    h('button', { class: 'tab', role: 'tab', 'aria-selected': String(id === tab), onclick: () => go(f.name, id) }, label,
      badges[id] ? h('span', { class: 'badge' + (badges[id].warn ? ' warn' : '') }, badges[id].n) : null))));

  const body = h('section', { role: 'tabpanel' });
  main.append(body);
  if (tab === 'overview') overview(f, body);
  else if (tab === 'intent') intentTab(f, body);
  else if (tab === 'concepts') conceptsTab(f, body);
  else diagramTab(f, tab, r.view, r.flow, body);
  main.scrollTop = 0;
}

function tabBadges(f) {
  const out = {};
  const hi = (f.report?.risks || []).filter(r => r.impact === 'high').length;
  if (hi) out.overview = { n: hi, warn: false };
  for (const x of f.report?.findings || []) {
    if (!x.type || !f.diagrams[x.type]) continue;
    const b = out[x.type] || (out[x.type] = { n: 0, warn: true });
    b.n++; if (x.severity === 'high' || x.severity === 'medium') b.warn = false;
  }
  const pend = (f.intent?.assumptions || []).length;
  if (pend) out.intent = { n: pend, warn: true };
  return out;
}

// ---------- overview ----------
function checkRows(f) {
  const c = f.checks || {};
  const rows = [];
  const row = (state, k, v) => rows.push(h('li', {}, h('span', { class: 'ic ' + state }, { ok: '✓', bad: '✕', warn: '!', na: '–' }[state]), h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)));
  const st = f.stale;
  const staleRow = () => (f.checks?.size?.warn ? row('warn', 'Size', f.checks.size.warn) : null, !st || st.state === 'unknown' ? row('na', 'Code since diagrams', 'not tracked — run stale.mjs record after the checks pass')
    : row({ fresh: 'ok', shifted: 'warn', outdated: 'bad' }[st.state], 'Code since diagrams', st.state === 'fresh' ? 'unchanged since ' + new Date(st.recordedAt).toLocaleDateString()
      : st.counts.changed + ' ref(s) changed · ' + st.counts.gone + ' gone · ' + st.counts.moved + ' moved, since ' + new Date(st.recordedAt).toLocaleDateString()));
  if (!f.checks) { row('na', 'Mechanical checks', 'not run yet — run compare.mjs'); staleRow(); return rows; }
  if (f.mode === 'observe') {
    row(c.syntax?.ok ? 'ok' : c.syntax?.unavailable ? 'warn' : 'bad', 'Diagram syntax', c.syntax?.ok ? 'all diagrams parse (' + (c.syntax.parser || 'mermaid') + ')' : c.syntax?.unavailable || (c.syntax?.errors?.length + ' diagram(s) fail to parse'));
    const r = c.refs;
    if (r) row(r.ok ? 'ok' : 'bad', 'Code refs', (r.checked - r.failed.length) + ' of ' + r.checked + ' refs resolve' + (r.missing?.length ? ' · ' + r.missing.length + ' element(s) without a ref' : '') + (r.failed.length ? ' · ' + r.failed.length + ' broken' : ''));
    row('na', 'Intent', 'not checked (observe mode)');
    staleRow();
    return rows;
  }
  row(c.syntax?.ok ? 'ok' : c.syntax?.unavailable ? 'warn' : 'bad', 'Diagram syntax', c.syntax?.ok ? 'all diagrams parse (' + (c.syntax.parser || 'mermaid') + ')' : c.syntax?.unavailable || (c.syntax?.errors?.length + ' diagram(s) fail to parse'));
  const r = c.refs;
  if (r) row(r.ok ? 'ok' : 'bad', 'Code refs', (r.checked - r.failed.length) + ' of ' + r.checked + ' refs resolve' + (r.missing?.length ? ' · ' + r.missing.length + ' element(s) without a ref' : '') + (r.failed.length ? ' · ' + r.failed.length + ' broken' : ''));
  const i = c.intent;
  if (i) row(i.ok ? (i.assumptions?.length ? 'warn' : 'ok') : (i.unsourced.length || i.unknownIds.length || i.badSources.length || !i.hasIntentFile) ? 'bad' : 'warn', 'Intent sources',
    !i.hasIntentFile ? 'no intent.json — intended diagrams are unsourced' :
    i.sourced + ' of ' + i.elements + ' elements cite a source' + (i.assumed ? ' · ' + i.assumed + ' assumed' : '') + (i.assumptions?.length ? ' · ' + i.assumptions.length + ' assumption(s) — ask the agent to resolve them with you' : '') + (i.unsourced.length ? ' · ' + i.unsourced.length + ' unsourced' : '') + (i.badSources.length ? ' · ' + i.badSources.length + ' quote(s) not found' : ''));
  else row('na', 'Intent sources', 'no intended diagrams');
  const e = c.endpoints;
  if (e) row(e.intendedMissingInCode.length ? 'bad' : 'ok', 'Endpoints', e.intendedMissingInCode.length ? 'missing in code: ' + e.intendedMissingInCode.join(', ') : (e.intended.length ? e.intended.length + ' intended endpoint(s) present in code' : 'no HTTP calls in intended diagrams'));
  const s = c.statuses;
  if (s?.intendedMissingInCode) row(s.intendedMissingInCode.length ? 'bad' : 'ok', 'Status codes', s.intendedMissingInCode.length ? 'never returned by code: ' + s.intendedMissingInCode.join(', ') : 'every intended status appears in code');
  staleRow();
  return rows;
}

const IMPACT = { high: 0, medium: 1, low: 2 };
function risksCard(f) {
  const rs = (f.report?.risks || []).slice().sort((a, b) => (IMPACT[a.impact] ?? 3) - (IMPACT[b.impact] ?? 3));
  if (!f.report) return null;
  return h('div', { class: 'card riskcard' }, h('h2', {}, 'Risks · ' + rs.length), h('p', { class: 'cardnote' }, 'What could go wrong for users or the business, judging from the code.'),
    rs.length ? h('ul', { class: 'risks' }, rs.map(x => h('li', {}, h('span', { class: 'impact ' + x.impact }, x.impact),
      h('div', {}, h('div', { class: 'rtext' }, termify(f, x.text)),
        h('div', { class: 'meta' },
          x.category ? h('span', { class: 'kindtag' }, x.category) : null,
          x.ref ? (x.refLink ? fileLink(x.refLink.abs, x.refLink.line, x.ref) : h('span', { class: 'tag missing', title: 'This ref does not resolve' }, x.ref + ' · unresolved')) : null,
          x.type && f.diagrams[x.type] ? h('button', { class: 'linkbtn', onclick: () => go(f.name, x.type) }, 'see ' + x.type + ' →') : null)))))
    : h('p', { class: 'summary', style: 'padding:0 16px 14px' }, 'No feature-specific risks found.'));
}
// Where a diagram file lives in the dashboard: code.sequence.add-to-cart.mmd → [sequence, code, add-to-cart]
const diagramPlace = name => { const m = String(name).match(/^(intended|code)\.(\w+)(?:\.([\w-]+))?\.mmd$/); return m ? [m[2], m[1], m[3] || ''] : null; };
function staleCard(f) {
  const st = f.stale;
  if (!st?.refs?.length) return null;
  const item = r => { const at = diagramPlace(r.from); return h('li', {},
      h('span', { class: 'impact ' + (r.status === 'moved' ? 'low' : 'high') }, r.status),
      h('div', {}, h('div', { class: 'meta', style: 'margin-top:0' },
        r.link ? fileLink(r.link.abs, r.link.line, r.file + ':' + (r.newLine || r.line)) : h('span', { class: 'mono' }, r.file + ':' + r.line),
        r.symbol ? h('span', { class: 'mono' }, '#' + r.symbol) : null,
        r.newLine ? h('span', {}, 'was line ' + r.line) : null,
        r.reason ? h('span', {}, r.reason) : null,
        at && f.diagrams[at[0]] ? h('button', { class: 'linkbtn', onclick: () => go(f.name, at[0], at[1], at[2]) }, 'in ' + r.from + ' →') : h('span', { class: 'mono' }, r.from)))); };
  const hard = st.refs.filter(r => r.status !== 'moved'), moved = st.refs.filter(r => r.status === 'moved');
  return h('div', { class: 'card riskcard' }, h('h2', {}, 'Code changed since the diagrams' + (hard.length ? ' · ' + hard.length : '')),
    h('p', { class: 'cardnote' }, (hard.length ? 'These steps may no longer be true. ' : 'The code the diagrams point at is the same; only line numbers moved. ') + 'Ask the agent to re-run this feature to update them.'),
    hard.length ? h('ul', { class: 'risks' }, hard.map(item)) : null,
    moved.length ? h('details', { class: 'moved' }, h('summary', {}, moved.length + ' ref(s) only moved — same code, new line number'), h('ul', { class: 'risks' }, moved.map(item))) : null);
}
// Short name of a system element: node label, entity name, or "From → To".
const elName = e => { const p = prettyEl(e.text); return p.map(x => typeof x === 'string' ? x : x.textContent).filter(Boolean).reverse().find(x => x && x !== '(transition)') || e.text; };
const MAP_TYPES = ['architecture', 'data', 'state'];
function usesCard(f) {
  const sys = sysOf(f);
  if (!sys || f.system) return null;
  const rows = MAP_TYPES.filter(t => sys.diagrams[t]).map(t => {
    const hits = sys.diagrams[t].code.flatMap(dg => dg.elements.filter(e => usedBy(e, f.name)).map(e => [dg, e]));
    const uniq = [...new Map(hits.map(([dg, e]) => [elName(e), [dg, e]])).values()];
    return h('li', {}, h('span', { class: 'k' }, TYPE_LABEL[t]), h('div', { class: 'usedby' }, uniq.length
      ? uniq.slice(0, 16).map(([dg, e]) => h('button', { class: 'chip', onclick: () => go(f.name, t, 'system', dg.flow) }, elName(e))).concat(uniq.length > 16 ? [h('span', { class: 'appr' }, '+' + (uniq.length - 16))] : [])
      : h('span', { class: 'appr' }, 'nothing found')));
  });
  return h('div', { class: 'card riskcard' }, h('h2', {}, 'In the system'), h('p', { class: 'cardnote' }, 'The parts of the ' + (sys.group === 'main' ? '' : sys.group + ' ') + 'system map this feature uses — open one to see it in context.'), h('ul', { class: 'uses' }, rows));
}
function systemOverview(f, body) {
  const sc = staleCard(f); if (sc) body.append(sc);
  const members = FEATS.filter(x => x.systemMap === f.name);
  for (const t of MAP_TYPES) {
    const d = f.diagrams[t]; if (!d) continue;
    const rows = d.code.flatMap(dg => dg.elements.filter(e => !e.rel).map(e => h('tr', {},
      h('td', {}, h('button', { class: 'linkbtn', style: 'font-size:13px;text-align:left', onclick: () => go(f.name, t, '', dg.flow) }, elName(e)), dg.flow ? h('span', { class: 'from' }, flowLabel(dg.flow, true)) : null),
      h('td', {}, e.usedBy?.length ? h('div', { class: 'usedby' }, e.usedBy.map(n => h('button', { class: 'chip', onclick: () => go(f.name, t, n, dg.flow) }, n))) : h('span', { class: 'from' }, 'no feature found')))));
    body.append(h('div', { class: 'card details' }, h('h2', {}, TYPE_LABEL[t] + ' · what uses what'), h('table', { class: 'el' }, h('tr', {}, h('th', {}, 'Part'), h('th', {}, 'Used by (click to highlight)')), rows)));
  }
  body.append(h('div', { class: 'card details' }, h('h2', {}, 'Features in this system · ' + members.length), h('div', { class: 'usedby', style: 'padding:0 16px 14px' }, members.map(x => h('button', { class: 'chip', onclick: () => go(x.name) }, x.name)))));
}
function overview(f, body) {
  if (f.system) return systemOverview(f, body);
  const sc = staleCard(f); if (sc) body.append(sc);
  const uc = usesCard(f); if (uc) body.append(uc);
  const rc = risksCard(f); if (rc) body.append(rc);
  const left = h('div', { class: 'stack' });
  left.append(h('div', { class: 'card' }, h('h2', {}, 'Checks'), h('ul', { class: 'checks' }, checkRows(f))));
  const order = { high: 0, medium: 1, low: 2 };
  const fl = (f.report?.findings || []).slice().sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  left.append(h('div', { class: 'card' }, h('h2', {}, (f.mode === 'observe' ? 'Notes · ' : 'Differences · ') + fl.length), h('p', { class: 'cardnote' }, f.mode === 'observe' ? 'Notable things about what the code does.' : 'Where what was intended and what the code does disagree.'),
    fl.length ? h('ul', { class: 'findings' }, fl.map(x => h('li', {}, h('span', { class: 'sev ' + x.severity }, x.severity),
      h('div', {}, h('div', {}, x.text), h('div', { class: 'meta' }, x.where ? h('span', {}, x.where) : null, x.ref ? (x.refLink ? fileLink(x.refLink.abs, x.refLink.line, x.ref) : h('span', { class: 'mono' }, x.ref)) : null,
        x.type && f.diagrams[x.type] ? h('button', { class: 'linkbtn', onclick: () => go(f.name, x.type, f.mode === 'observe' ? undefined : 'compare') }, (f.mode === 'observe' ? 'see ' : 'compare ') + x.type + ' →') : null)))))
    : h('p', { class: 'summary', style: 'padding:0 16px 14px' }, f.report ? 'None — everything agrees.' : 'No verdict yet.')));

  const right = h('div', { class: 'stack' });
  const cols = KINDS(f);
  const cov = h('table', { class: 'matrix' }, h('tr', {}, h('th', {}, ''), cols.map(k => h('th', {}, k))),
    TYPES.map(t => { const d = f.diagrams[t]; const skipped = f.report?.skipped?.[t];
      return h('tr', {}, h('td', {}, TYPE_LABEL[t]), cols.map(k => h('td', {},
        d && d[k].length ? h('button', { class: 'yes', title: d[k].map(x => x.name).join(', '), onclick: () => go(f.name, t, k) }, '✓' + (d[k].length > 1 ? ' ' + d[k].length : ''))
        : h('span', { class: 'no', title: skipped || '' }, skipped && k === cols[0] ? 'skipped' : '—')))); }));
  right.append(h('div', { class: 'card' }, h('h2', {}, 'Coverage'), cov,
    f.report?.skipped && Object.keys(f.report.skipped).length ? h('p', { class: 'summary', style: 'padding:0 16px 14px;font-size:12px' }, 'Skipped: ' + Object.entries(f.report.skipped).map(([k, v]) => k + ' (' + v + ')').join(', ')) : null));
  body.append(h('div', { class: 'grid2' }, left, right));
}

// ---------- diagram tab ----------
let seq = 0;
function diagramTab(f, type, view, flow, body) {
  const d = f.diagrams[type];
  if (f.system || !d || view === 'system') return mapTab(f, type, view, flow, body);
  const all = ['intended', 'code'].flatMap(k => d[k]);
  const flows = [...new Set(all.map(dg => dg.flow))].sort((a, b) => (a ? 1 : 0) - (b ? 1 : 0) || a.localeCompare(b));
  const multi = flows.length > 1;
  if (!flows.includes(flow)) flow = flows[0];
  const at = k => d[k].find(dg => dg.flow === flow);
  const kinds = ['intended', 'code'].filter(k => at(k));
  const valid = KINDS(f).length > 1 ? [...KINDS(f), 'compare'] : KINDS(f);
  if (!valid.includes(view) || (view !== 'compare' && !at(view)) || (view === 'compare' && kinds.length < 2)) view = kinds.length > 1 ? 'compare' : kinds[0];
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, valid.map(k =>
    h('button', { 'aria-pressed': String(k === view), disabled: k !== 'compare' && !at(k) || (k === 'compare' && kinds.length < 2), onclick: () => go(f.name, type, k, flow) }, k[0].toUpperCase() + k.slice(1))),
    type !== 'sequence' && sysOf(f)?.diagrams[type] ? h('button', { 'aria-pressed': 'false', onclick: () => go(f.name, type, 'system') }, 'In the system') : null);
  const zoomCtl = h('div', { class: 'zoom' });
  body.append(h('div', { class: 'toolbar' }, seg, zoomCtl));

  // Small flow diagrams: breadcrumb back up the @drill chain; the full tree is in the sidebar.
  const onDrill = target => { const [ft, fl] = drillTarget(f, target); go(ft, type, view, fl); };
  if (multi) {
    const t = type === 'sequence' ? flowTree(f) : null;
    const chain = [flow];
    while (t?.parent.has(chain[0]) && !chain.includes(t.parent.get(chain[0]))) chain.unshift(t.parent.get(chain[0]));
    if (t && chain[0] !== '' && t.flows.includes('')) chain.unshift('');
    const next = t ? [...t.kids.get(flow), ...t.cross.get(flow)] : flows.filter(fl => fl !== flow);
    body.append(h('div', { class: 'flownav' },
      h('nav', { class: 'crumbs', 'aria-label': 'Diagram path' }, chain.map((fl, i) => i < chain.length - 1
        ? [h('button', { class: 'linkbtn', onclick: () => onDrill(fl) }, flowLabel(fl, true)), h('span', { class: 'sep', 'aria-hidden': 'true' }, '›')]
        : h('b', { 'aria-current': 'page' }, flowLabel(fl, true))),
        next.length && t ? h('span', { class: 'hint' }, ' · click a ⤵ step to open it') : null),
      next.length ? h('div', { class: 'flows' }, h('span', {}, t ? 'Opens from here:' : 'Other diagrams:'), next.map(x =>
        h('button', { class: 'chip', onclick: () => onDrill(x) }, t ? drillLabel(f, x) : flowLabel(x, true)))) : null));
  }

  const options = ['intended', 'code'].flatMap(k => d[k].map(dg => ({ key: k + ':' + dg.name, kind: k, dg, label: k[0].toUpperCase() + k.slice(1) + (multi ? ' · ' + flowLabel(dg.flow, true) : '') })));
  let picks;
  if (view === 'compare') {
    const saved = (store.get('fv-cmp-' + type + '-' + flow, '') || '').split('|');
    const ok = k => options.some(o => o.key === k);
    const left = ok(saved[0]) ? saved[0] : 'intended:' + at('intended').name;
    const right = ok(saved[1]) && saved[1] !== left ? saved[1] : 'code:' + at('code').name;
    picks = [left, right];
  } else picks = [view + ':' + at(view).name];
  const panes = h('div', { class: 'panes n' + Math.min(picks.length, 2) });
  const canvases = [];
  picks.forEach((key, idx) => {
    const o = options.find(x => x.key === key);
    const c = h('div', { class: 'canvas', tabindex: '0', 'aria-label': o.label + ' ' + type + ' diagram' });
    const title = view === 'compare'
      ? h('select', { 'aria-label': 'Pane ' + (idx + 1), onchange: e => { picks[idx] = e.target.value; store.set('fv-cmp-' + type + '-' + flow, picks.join('|')); route(); } },
          options.map(x => h('option', { value: x.key, selected: x.key === key }, x.label)))
      : h('b', {}, o.label);
    panes.append(h('div', { class: 'card pane' }, h('div', { class: 'pane-h' }, title, h('span', { class: 'mono' }, o.dg.name)), c));
    canvases.push(mountCanvas(c, o.dg, type === 'sequence' ? onDrill : null, x => drillLabel(f, x)));
  });
  body.append(panes);
  // zoom controls drive every visible canvas together
  const zl = h('span', {}, '');
  const zoomAll = fn => () => { canvases.forEach(cv => cv && fn(cv)); zl.textContent = Math.round((canvases[0]?.scale() || 1) * 100) + '%'; };
  zoomCtl.append(h('button', { class: 'iconbtn', title: 'Zoom out (−)', onclick: zoomAll(cv => cv.zoom(1 / 1.2)) }, '−'), zl,
    h('button', { class: 'iconbtn', title: 'Zoom in (+)', onclick: zoomAll(cv => cv.zoom(1.2)) }, '+'),
    h('button', { class: 'iconbtn', title: 'Fit (0)', onclick: zoomAll(cv => cv.fit()) }, 'Fit'),
    h('button', { class: 'iconbtn', title: 'Actual size', onclick: zoomAll(cv => cv.setScale(1)) }, '1:1'), fullscreenCtl(panes, canvases));
  Promise.all(canvases.map(cv => cv?.ready)).then(() => { zl.textContent = Math.round((canvases[0]?.scale() || 1) * 100) + '%'; });
  onkeydown = e => { if (e.target.closest('input')) return; if (e.key === '+' || e.key === '=') zoomAll(cv => cv.zoom(1.2))(); if (e.key === '-') zoomAll(cv => cv.zoom(1 / 1.2))(); if (e.key === '0') zoomAll(cv => cv.fit())(); };

  if (type === 'sequence') body.append(diffBar(f));
  body.append(termBar(f, type, picks.map(k => options.find(x => x.key === k).dg.src).join('\n')));
  // element details for the single view (or the code+intended pair in compare)
  for (const key of picks) { const o = options.find(x => x.key === key); if (o.dg.elements.length) body.append(elementTable(f, o.kind, o.dg, onDrill)); }
}

// A system diagram: on the system page (optionally highlighting one feature), or inside a feature's tab
// (that feature's parts highlighted, the rest dimmed). Route view slot: system page → highlighted feature name.
function mapTab(f, type, view, flow, body) {
  const sys = sysOf(f), d = sys?.diagrams[type];
  if (!d?.code.length) { body.append(h('div', { class: 'empty' }, 'No ' + TYPE_LABEL[type].toLowerCase() + ' diagram' + (sys ? ' in the system map.' : '. Ask the agent to draw the system map for this group.'))); return; }
  const dgs = d.code;
  const hl = f.system ? (FEATS.some(x => x.name === view) ? view : null) : f.name;
  const uses = dg => hl ? dg.elements.filter(e => usedBy(e, hl)).length : 0;
  let dg = dgs.find(x => x.flow === flow) || (hl && !f.system && dgs.find(x => x.flow === '' && uses(x))) || (hl && !f.system && dgs.find(uses)) || dgs[0];
  flow = dg.flow;
  const v = f.system ? (hl || '') : 'system';
  const nav = fl => go(f.name, type, v, fl);
  const name = fl => fl ? flowLabel(fl, true) : TYPE_LABEL[type];
  const left = h('div', { class: 'toolleft' });
  if (!f.system && f.diagrams[type]) left.append(h('div', { class: 'seg', role: 'group' }, KINDS(f).map(k => h('button', { 'aria-pressed': 'false', onclick: () => go(f.name, type, k) }, k[0].toUpperCase() + k.slice(1))), h('button', { 'aria-pressed': 'true' }, 'In the system')));
  if (f.system) left.append(h('label', { class: 'hlpick' }, 'Highlight', h('select', { onchange: e => go(f.name, type, e.target.value, flow) }, h('option', { value: '' }, 'no feature'),
    FEATS.filter(x => x.systemMap === f.name).map(x => h('option', { value: x.name, selected: x.name === hl }, x.name)))));
  else left.append(h('span', { class: 'hint' }, uses(dg) ? 'The ' + (sys.group === 'main' ? '' : sys.group + ' ') + 'system map — what ' + f.name + ' uses is highlighted.' : f.name + ' uses nothing in this diagram.'));
  const zoomCtl = h('div', { class: 'zoom' });
  body.append(h('div', { class: 'toolbar' }, left, zoomCtl));
  if (dgs.length > 1) {
    const t = flowTree(sys, type);
    const chain = [flow];
    while (t.parent.has(chain[0]) && !chain.includes(t.parent.get(chain[0]))) chain.unshift(t.parent.get(chain[0]));
    const kids = t.kids.get(flow) || [];
    const others = dgs.filter(x => x !== dg && !kids.includes(x.flow) && !chain.includes(x.flow));
    const chip = fl => { const x = dgs.find(y => y.flow === fl); return h('button', { class: 'chip', onclick: () => nav(fl) }, name(fl), x && uses(x) ? h('span', { class: 'sdot', style: 'background:var(--accent)', title: 'Used by ' + hl }) : null); };
    body.append(h('div', { class: 'flownav' },
      h('nav', { class: 'crumbs', 'aria-label': 'Diagram path' }, chain.map((fl, i) => i < chain.length - 1
        ? [h('button', { class: 'linkbtn', onclick: () => nav(fl) }, name(fl)), h('span', { class: 'sep', 'aria-hidden': 'true' }, '›')] : h('b', { 'aria-current': 'page' }, name(fl))),
        kids.length ? h('span', { class: 'hint' }, ' · click a blue-bordered part to open it') : null),
      kids.length ? h('div', { class: 'flows' }, h('span', {}, 'Opens from here:'), kids.map(chip)) : null,
      others.length ? h('div', { class: 'flows' }, h('span', {}, 'Other ' + TYPE_LABEL[type].toLowerCase() + ' diagrams:'), others.map(x => chip(x.flow))) : null));
  }
  const onDrill = target => { const [ft, fl] = drillTarget(sys, target); if (ft !== sys.name) go(ft, 'sequence', undefined, fl); else nav(fl); };
  const c = h('div', { class: 'canvas', tabindex: '0', 'aria-label': TYPE_LABEL[type] + ' diagram' });
  const panes = h('div', { class: 'panes n1' }, h('div', { class: 'card pane' }, h('div', { class: 'pane-h' }, h('b', {}, 'System · ' + name(flow) + (hl ? ' · ' + hl + ' highlighted' : '')), h('span', { class: 'mono' }, dg.name)), c));
  body.append(panes);
  const hlSet = hl ? new Set(dg.elements.map((e, i) => usedBy(e, hl) ? i : -1).filter(i => i >= 0)) : null;
  const cv = mountCanvas(c, dg, onDrill, x => drillLabel(sys, x), hlSet);
  const zl = h('span', {}, '');
  const z = fn => () => { cv && fn(cv); zl.textContent = Math.round((cv?.scale() || 1) * 100) + '%'; };
  zoomCtl.append(h('button', { class: 'iconbtn', onclick: z(x => x.zoom(1 / 1.2)) }, '−'), zl, h('button', { class: 'iconbtn', onclick: z(x => x.zoom(1.2)) }, '+'), h('button', { class: 'iconbtn', onclick: z(x => x.fit()) }, 'Fit'), h('button', { class: 'iconbtn', onclick: z(x => x.setScale(1)) }, '1:1'), fullscreenCtl(panes, [cv]));
  cv?.ready.then(() => { zl.textContent = Math.round(cv.scale() * 100) + '%'; });
  onkeydown = e => { if (e.target.closest('input, select')) return; if (e.key === '+' || e.key === '=') z(x => x.zoom(1.2))(); if (e.key === '-') z(x => x.zoom(1 / 1.2))(); if (e.key === '0') z(x => x.fit())(); };
  body.append(termBar(sys, type, dg.src));
  if (dg.elements.length) body.append(elementTable(sys, 'code', dg, onDrill, hl));
}

function diffBar(f) {
  const c = f.checks; const bar = h('div', { class: 'diffbar' });
  if (!c || f.mode === 'observe') return bar;
  for (const s of c.statuses?.intendedMissingInCode || []) bar.append(h('span', { class: 'diffchip bad' }, s + ' · intended, never returned by code'));
  for (const e of c.endpoints?.intendedMissingInCode || []) bar.append(h('span', { class: 'diffchip bad' }, e + ' · missing in code'));
  for (const e of c.endpoints?.codeNotInIntended || []) bar.append(h('span', { class: 'diffchip' }, e + ' · in code, not in intent'));
  return bar;
}

function prettyEl(text) {
  let m = text.match(/^(.+?)\s*(<<-{1,2}>>|-{1,2}>>|-{1,2}>|-{1,2}x|-{1,2}\))[+-]?\s*(.+?)\s*:\s*(.*)$/);
  if (m) return [h('span', { class: 'from' }, m[1].trim() + ' → ' + m[3].trim()), m[4]];
  m = text.match(/^(.+?)\s*-->\s*(.+?)\s*(?::\s*(.*))?$/);
  if (m) return [h('span', { class: 'from' }, m[1].trim() + ' → ' + m[2].trim()), m[3] || '(transition)'];
  m = text.match(/^[\w-]+\s*[\[\(\{>]+\s*"?(.*?)"?\s*[\]\)\}]+(?::::\w+)?\s*$/);
  if (m) return [m[1]];
  m = text.match(/^([A-Za-z_][\w-]*)\s+[|}o][|o]?(?:--|\.\.)[|o]?[|{o]\s+([A-Za-z_][\w-]*)\s*:\s*"?([^"]*)"?/);
  if (m) return [h('span', { class: 'from' }, m[1] + ' → ' + m[2]), m[3]];
  m = text.match(/^([A-Za-z_][\w-]*)\s*\{/);
  if (m) return [h('span', { class: 'from' }, 'entity'), m[1]];
  return [text];
}
function elementTable(f, kind, dg, onDrill, hl) {
  const showUse = dg.elements.some(e => e.usedBy);
  const srcs = new Map((f.intent?.sources || []).map(s => [s.id, s]));
  const asm = new Map((f.intent?.assumptions || []).map(a => [a.id, a]));
  const staleTag = st => !st ? null : h('span', { class: 'tag stale' + (st.status === 'moved' ? '' : ' bad'), title: st.status === 'moved' ? 'Same code, now at line ' + st.newLine : 'This code was edited after the diagram was made' }, st.status === 'moved' ? 'moved → ' + st.newLine : st.status);
  const rows = dg.elements.map(e => h('tr', { class: hl && usedBy(e, hl) ? 'hlrow' : null }, h('td', {}, prettyEl(e.text).map(x => typeof x === 'string' ? termify(f, x) : x),
      e.drill && onDrill ? h('div', {}, h('button', { class: 'linkbtn', onclick: () => onDrill(e.drill) }, '⤵ open ' + drillLabel(f, e.drill))) : null),
    kind === 'code'
      ? h('td', {}, e.rel && !e.refs.length ? h('span', { class: 'from' }, 'relationship (follows from the entities)') : e.refs.length ? e.refs.map(r => h('div', {}, fileLink(r.abs, r.line, r.file + ':' + r.line), r.symbol ? h('span', { class: 'mono', style: 'color:var(--muted)' }, '  #' + r.symbol) : null, ' ', staleTag(r.stale))) : h('span', { class: 'tag missing' }, 'no ref'))
      : h('td', {}, e.srcs.map(id => h('span', { class: 'tag', title: srcs.get(id)?.quote || 'unknown source' }, id)), e.assumed.map(id => h('span', { class: 'tag assumed', title: asm.get(id)?.text || '' }, id + ' · assumed')),
          !e.srcs.length && !e.assumed.length ? h('span', { class: 'tag missing' }, 'unsourced') : null,
          e.srcs.length === 1 && srcs.get(e.srcs[0]) ? h('div', { style: 'color:var(--muted);font-size:12px' }, '“' + srcs.get(e.srcs[0]).quote + '”') : null),
    showUse ? h('td', {}, e.usedBy?.length ? h('div', { class: 'usedby' }, e.usedBy.map(n => h('button', { class: 'chip', 'aria-pressed': String(n === hl), onclick: () => go(n) }, n))) : h('span', { class: 'from' }, e.rel ? '' : 'no feature found')) : null));
  return h('div', { class: 'card details' }, h('h2', {}, kind === 'code' ? 'Code refs · ' + dg.name : 'Intent sources · ' + dg.name),
    h('table', { class: 'el' }, h('tr', {}, h('th', {}, 'Element'), h('th', {}, kind === 'code' ? 'Where in the code' : 'Why it is intended'), showUse ? h('th', {}, 'Used by') : null), rows));
}

// Full screen: the panes fill the window (button, F key, or double-click a diagram); Esc or ✕ leaves.
let fsToggle = null;
function fullscreenCtl(panes, canvases) {
  const toggle = on => { panes.classList.toggle('fs', on); document.body.classList.toggle('noscroll', on); requestAnimationFrame(() => canvases.forEach(cv => cv?.fit())); };
  fsToggle = toggle;
  panes.append(h('button', { class: 'iconbtn fsclose', onclick: () => toggle(false) }, '✕ Exit full screen (Esc)'));
  return h('button', { class: 'iconbtn', title: 'Full screen (F, or double-click the diagram)', onclick: () => toggle(!panes.classList.contains('fs')) }, '⛶ Full screen');
}
addEventListener('keydown', e => {
  if (!fsToggle || e.target.closest?.('input, select, textarea')) return;
  if (e.key === 'Escape') fsToggle(false);
  if (e.key === 'f' || e.key === 'F') fsToggle(!document.querySelector('.panes.fs'));
});

// Pan / zoom canvas around one rendered Mermaid SVG.
// Sequence messages with  %% @drill <flow>  become clickable; messages whose code changed since the diagram was made turn red.
// Mermaid draws, per message in source order, its label text(s) (.messageText, several when wrapped) followed by its
// line (.messageLine0/1), so the n-th line is the n-th element.
function hookMessages(svg, dg, onDrill, label) {
  const msgs = []; let texts = [];
  for (const n of svg.querySelectorAll('.messageText, .messageLine0, .messageLine1')) {
    if (n.classList.contains('messageText')) texts.push(n); else { msgs.push({ line: n, texts }); texts = []; }
  }
  if (msgs.length !== dg.elements.length) return; // unexpected layout — the element table still links every flow
  dg.elements.forEach((e, i) => {
    const { line, texts } = msgs[i];
    const st = e.refs.find(r => r.stale && r.stale.status !== 'moved')?.stale;
    if (st) for (const n of [line, ...texts]) {
      n.classList.add('fv-stale');
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); t.textContent = 'Code ' + st.status + ' since this diagram was made'; n.append(t);
    }
    if (!e.drill || !onDrill) return;
    const hit = line.cloneNode(false);
    hit.removeAttribute('marker-end'); hit.removeAttribute('marker-start'); hit.removeAttribute('style'); hit.setAttribute('class', 'fv-hit');
    line.after(hit);
    hit.setAttribute('data-drill', e.drill);
    for (const n of [line, ...texts]) {
      n.classList.add('fv-drill'); n.setAttribute('data-drill', e.drill);
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'title'); t.textContent = 'Open ' + label(e.drill); n.append(t);
    }
  });
}
// Flowchart / state: highlighted elements get class fvOn, the rest fvOff (dimmed); @drill nodes and transition labels
// become clickable. ER: entities are dimmed / outlined after render (ids are entity-<NAME without _>-<uuid>).
const nodeId = e => (e.text.match(/^([\w-]+)/) || [])[1];
function highlightSrc(src, dg, hl) {
  const head = src.trimStart().split(/\s/)[0];
  const add = (on, off) => src.replace(/\s*$/, '\n') + (on.length ? '  class ' + on.join(',') + ' fvOn\n' : '') + (off.length ? '  class ' + off.join(',') + ' fvOff\n' : '');
  if (/^(flowchart|graph)$/.test(head)) {
    const on = [], off = [];
    dg.elements.forEach((e, i) => { const id = nodeId(e); if (id) (hl.has(i) ? on : off).push(id); });
    return add(on, off);
  }
  if (/^stateDiagram/.test(head)) {
    const on = new Set(), all = new Set();
    dg.elements.forEach((e, i) => { const m = e.text.match(/^(\S+)\s*-->\s*([^\s:]+)/); if (!m) return; for (const x of [m[1], m[2]]) { all.add(x); if (hl.has(i)) on.add(x); } });
    return add([...on], [...all].filter(x => !on.has(x)));
  }
  return src;
}
function hookMap(svg, dg, onDrill, label, hl) {
  const key = x => String(x).replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (hl && svg.querySelector('g[id^="entity-"]')) {
    const on = new Set(dg.elements.filter((e, i) => hl.has(i)).map(e => key((e.text.match(/^([A-Za-z_][\w-]*)/) || [])[1])));
    for (const g of svg.querySelectorAll('g[id^="entity-"]')) g.classList.add(on.has(key(g.id.split('-')[1])) ? 'fv-on' : 'fv-off');
  }
  if (!onDrill) return;
  const title = (n, t) => { const x = document.createElementNS('http://www.w3.org/2000/svg', 'title'); x.textContent = 'Open ' + label(t); n.append(x); };
  for (const e of dg.elements) {
    if (!e.drill) continue;
    const id = nodeId(e);
    const node = id && [...svg.querySelectorAll('g.node')].find(g => new RegExp('^flowchart-' + id.replace(/[-]/g, '\\-') + '-\\d+$').test(g.id));
    if (node && !/-->/.test(e.text)) { node.classList.add('fv-drill-node'); node.setAttribute('data-drill', e.drill); title(node, e.drill); continue; }
    const lbl = (e.text.split(':').slice(1).join(':') || '').trim();
    if (lbl) for (const n of svg.querySelectorAll('.edgeLabel')) if (n.textContent.trim() === lbl) { n.classList.add('fv-drill'); n.setAttribute('data-drill', e.drill); title(n, e.drill); }
  }
}
function mountCanvas(el, dg, onDrill, label = x => x, hl = null) {
  if (dg.error) {
    el.append(h('div', { class: 'placeholder err' }, h('b', {}, 'This diagram has a syntax error and was not rendered.'), h('p', {}, (dg.error.line ? 'Line ' + dg.error.line + ': ' : '') + dg.error.message), dg.error.sourceLine ? h('pre', {}, dg.error.sourceLine) : null));
    el.style.cursor = 'default'; return null;
  }
  const stage = h('div', { class: 'stage' }); el.append(stage);
  let s = 1, x = 0, y = 0, w = 0, ht = 0;
  const apply = () => { stage.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + s + ')'; };
  const api = {
    scale: () => s,
    fit() {
      if (!w) return;
      const W = el.clientWidth, maxH = Math.min(innerHeight * 0.72, 920), full = !!el.closest('.fs');
      s = full ? Math.min((W - 48) / w, (innerHeight - 114) / ht, 2) : Math.min((W - 48) / w, 1.25);
      if (!full) el.style.height = Math.max(240, Math.min(maxH, ht * s + 48)) + 'px';
      const H = el.clientHeight;
      x = (W - w * s) / 2; y = Math.max(24, (H - ht * s) / 2); apply();
    },
    setScale(n, cx = el.clientWidth / 2, cy = el.clientHeight / 2) { n = Math.min(4, Math.max(0.15, n)); x = cx - (cx - x) * n / s; y = cy - (cy - y) * n / s; s = n; apply(); },
    zoom(f, cx, cy) { api.setScale(s * f, cx, cy); },
  };
  api.ready = (async () => {
    try {
      let src = dg.src;
      const drills = onDrill && /^sequenceDiagram/.test(dg.src.trimStart()) ? dg.elements.filter(e => e.drill) : [];
      if (drills.length) { const ls = src.split('\n'); for (const e of drills) ls[e.mmdLine - 1] = ls[e.mmdLine - 1].replace(/\s*$/, ' ⤵'); src = ls.join('\n'); }
      if (hl) src = highlightSrc(src, dg, hl);
      const { svg } = await mermaid.render('fv' + (++seq), decorate(src));
      stage.innerHTML = svg;
      const svgEl = stage.querySelector('svg');
      if (dg.flow != null && /^sequenceDiagram/.test(dg.src.trimStart())) hookMessages(svgEl, dg, onDrill, label);
      else hookMap(svgEl, dg, onDrill, label, hl);
      const vb = svgEl.viewBox?.baseVal;
      w = vb?.width || svgEl.getBBox().width; ht = vb?.height || svgEl.getBBox().height;
      svgEl.setAttribute('width', w); svgEl.setAttribute('height', ht); svgEl.style.maxWidth = 'none';
      api.fit();
    } catch (e) {
      el.innerHTML = ''; el.append(h('div', { class: 'placeholder err' }, h('b', {}, 'Could not render this diagram.'), h('p', {}, String(e.message || e).split('\n')[0])));
    }
  })();
  let drag = null;
  el.addEventListener('pointerdown', e => { drag = { px: e.clientX, py: e.clientY, x, y }; el.setPointerCapture(e.pointerId); el.classList.add('grabbing'); });
  el.addEventListener('pointermove', e => { if (!drag) return; x = drag.x + e.clientX - drag.px; y = drag.y + e.clientY - drag.py; apply(); });
  const end = () => { drag = null; el.classList.remove('grabbing'); };
  // a click (not a drag) on a ⤵ step opens its flow; pointer capture hides the real target, so look it up by position
  el.addEventListener('pointerup', e => {
    const d = drag; end();
    if (!d || !onDrill || Math.hypot(e.clientX - d.px, e.clientY - d.py) > 4) return;
    const t = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-drill]');
    if (t) onDrill(t.getAttribute('data-drill'));
  });
  el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', e => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) api.zoom(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    else { x -= e.deltaX; y -= e.deltaY; apply(); }
  }, { passive: false });
  el.addEventListener('dblclick', e => { if (e.target.closest?.('[data-drill]')) return; fsToggle ? fsToggle(!el.closest('.fs')) : api.fit(); });
  return api;
}

// ---------- intent tab ----------
function md(text) {
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = s => esc(s).replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  let out = '', list = false;
  for (const line of text.split('\n')) {
    const m = line.match(/^(#{1,3})\s+(.*)/), li = line.match(/^\s*[-*]\s+(.*)/);
    if (!li && list) { out += '</ul>'; list = false; }
    if (m) out += '<h' + m[1].length + '>' + inline(m[2]) + '</h' + m[1].length + '>';
    else if (li) { if (!list) { out += '<ul>'; list = true; } out += '<li>' + inline(li[1]) + '</li>'; }
    else if (line.trim()) out += '<p>' + inline(line) + '</p>';
  }
  return out + (list ? '</ul>' : '');
}
const KIND = { prompt: 'Your prompt', doc: 'Document', issue: 'Issue / PR', test: 'Test', interview: 'You said', code: 'Code' };
function intentTab(f, body) {
  const left = h('div', { class: 'stack' }), right = h('div', { class: 'stack' });
  if (f.spec) { const c = h('div', { class: 'card' }, h('h2', {}, 'spec.md')); const m = h('div', { class: 'md' }); m.innerHTML = md(f.spec); c.append(m); left.append(c); }
  const bad = new Map((f.checks?.intent?.badSources || []).map(b => [b.id, b.reason]));
  const src = f.intent?.sources || [];
  left.append(h('div', { class: 'card' }, h('h2', {}, 'Sources · ' + src.length), src.length ? h('ul', { class: 'sources' }, src.map(s => h('li', {}, h('span', { class: 'sid' }, s.id),
    h('div', {}, h('div', { class: 'kind' }, (KIND[s.kind] || s.kind) + (s.tool ? ' · ' + s.tool : '') + (s.time ? ' · ' + new Date(s.time).toLocaleDateString() : '')),
      h('blockquote', {}, s.quote || ''),
      h('div', { class: 'mono', style: 'color:var(--muted)' }, s.file ? s.file + (s.line ? ':' + s.line : '') : s.where || ''),
      bad.has(s.id) ? h('span', { class: 'tag missing' }, 'not verified: ' + bad.get(s.id)) : s.file ? h('span', { class: 'tag' }, 'quote verified') : null))))
    : h('p', { class: 'summary', style: 'padding:0 16px 14px' }, 'No intent.json — intended diagrams cite no sources.')));
  const asm = f.intent?.assumptions || [];
  right.append(h('div', { class: 'card' }, h('h2', {}, 'Assumptions · ' + asm.length),
    asm.length ? [h('p', { class: 'summary', style: 'padding:0 16px;font-size:12px' }, 'Guesses made where no source said. Tell the agent the right answer and it becomes a source.'),
      h('ul', { class: 'sources' }, asm.map(a => h('li', {}, h('span', { class: 'sid' }, a.id), h('div', {}, h('div', {}, a.text), h('div', { style: 'margin-top:6px' }, h('span', { class: 'pill assumed' }, 'assumed'))))))]
    : h('p', { class: 'summary', style: 'padding:0 16px 14px' }, 'None. Every intended element cites a source.')));
  body.append(h('div', { class: 'grid2' }, left, right));
}

// ---------- concepts ----------
const STATUS_TEXT = {
  200: ['OK', 'The request worked.'], 201: ['Created', 'The request worked and something new was created (e.g. an order).'],
  202: ['Accepted', 'Accepted; it will be processed later.'], 204: ['No Content', 'Worked; nothing to send back.'],
  301: ['Moved', 'Permanently moved to another address.'], 302: ['Redirect', 'Go to another address for now (often after login).'], 304: ['Not Modified', 'Nothing changed; the browser reuses its copy.'],
  400: ['Bad Request', 'The request was missing something or was malformed (e.g. an empty field).'],
  401: ['Unauthorized', 'Not signed in, or wrong credentials.'], 403: ['Forbidden', 'Signed in, but not allowed to do this.'],
  404: ['Not Found', 'The thing asked for does not exist.'], 405: ['Method Not Allowed', 'This address does not accept this kind of request.'],
  409: ['Conflict', 'The request clashes with the current state (e.g. out of stock, empty cart, duplicate).'],
  410: ['Gone', 'It existed but was removed.'], 413: ['Too Large', 'The upload or body is too big.'],
  422: ['Unprocessable', 'Understood, but the data is not valid (validation failed).'], 423: ['Locked', 'The resource is locked (e.g. an account after too many failed logins).'],
  429: ['Too Many Requests', 'Rate limit hit; slow down.'],
  500: ['Server Error', 'The server crashed or hit an unexpected error.'], 502: ['Bad Gateway', 'A server in between got a bad answer from another server.'],
  503: ['Unavailable', 'The server is down or overloaded.'], 504: ['Gateway Timeout', 'A server in between waited too long for another server.'],
};
// Codes everyone knows are not explained (they would only add noise).
const COMMON_STATUS = new Set([200, 201, 204, 301, 302, 304, 404, 500]);
const LEGEND = {
  sequence: [
    ['Box at the top', 'A participant: a person, page, server, module or database. Time flows downward.'],
    ['A ──▶ B', 'Solid arrow: A asks B to do something (a call or request).'],
    ['A ◀╌╌ B', 'Dashed arrow: B answers A (a reply, often starting with a status code).'],
    ['A ◀╌╌✕ B', 'Dashed arrow with a cross: the reply is an error.'],
    ['alt [condition]\n else …', 'Alternatives: only one of the sections happens, chosen by the condition in brackets.'],
    ['opt [condition]', 'Optional: happens only if the condition is true.'],
    ['loop [condition]', 'Repeats while the condition holds.'],
    ['Client / Server box', 'Groups participants that run in the same place.'],
    ['Yellow note', 'A remark: a finding, or something the agent could not determine (UNCERTAIN).'],
    ['{email, password}', 'The names of the fields sent or received (values are never shown).'],
  ],
  architecture: [
    ['( rounded )', 'A screen or page the user sees.'],
    ['[ rectangle ]', 'A piece of code that does work: a server, service or module.'],
    ['[( cylinder )]', 'Where data is stored: a database, file, or memory.'],
    ['{{ hexagon }}', 'An outside service (payments, email, maps …).'],
    ['──▶ label', 'One part talks to another; the label says how (e.g. an HTTP call).'],
    ['Group box', 'Parts that belong to the same layer (client, server, data).'],
    ['Dashed amber border', 'Assumed: the agent is not sure this part exists or works this way.'],
    ['Dashed red border', 'Missing: intended, but not found in the code.'],
  ],
  data: [
    ['Box with rows', 'An entity (a kind of record, like a table): its name on top, its fields below as "type  name  note".'],
    ['||', 'Exactly one.'], ['o|', 'Zero or one.'], ['o{', 'Zero or many.'], ['|{', 'One or many.'],
    ['A ||──o{ B : label', 'Read both ends: one A relates to zero-or-many B. The label names the relationship.'],
  ],
  state: [
    ['●', 'Start.'], ['◉', 'End.'],
    ['[ box ]', 'A state the thing can be in (e.g. Locked, SignedIn, Empty).'],
    ['A ──▶ B : event', 'When the event happens, the thing moves from state A to state B.'],
    ['Arrow back to itself', 'The event happens but the state stays the same.'],
  ],
};
const TOOL_WORDS = [
  ['Intended', 'What the feature should do, taken from your prompts, docs, issues or answers — never from the code.'],
  ['Code', 'What the code says it does. Every step links to the exact line.'],
  ['Ref', 'A pointer to a file and line (e.g. src/cart.js:7). Checked automatically: if the line does not exist, the check fails.'],
  ['Assumption', 'A guess the agent had to make because no source said. Tell the agent the real answer to replace it.'],
  ['Observe mode', 'Only shows what the code does. Nothing is judged against a spec.'],
];

const esc = s => s.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
const termIndex = new WeakMap();
function termsOf(f) {
  if (termIndex.has(f)) return termIndex.get(f);
  const list = (f.glossary || []).flatMap(t => [t.term, ...(t.aka || [])].map(w => [w, t])).sort((a, b) => b[0].length - a[0].length);
  const re = list.length ? new RegExp('(?<![\\w-])(' + list.map(([w]) => esc(w)).join('|') + ')(?![\\w-])', 'gi') : null;
  const map = new Map(list.map(([w, t]) => [w.toLowerCase(), t]));
  const v = { re, map }; termIndex.set(f, v); return v;
}
// Wrap known glossary words in a string with <abbr> tooltips.
function termify(f, text) {
  const { re, map } = termsOf(f);
  if (!re) return text;
  const out = []; let last = 0;
  for (const m of text.matchAll(re)) {
    const t = map.get(m[0].toLowerCase()); if (!t) continue;
    out.push(text.slice(last, m.index), h('abbr', { class: 'term', title: t.term + ': ' + t.meaning }, m[0]));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}
// Under a diagram: glossary terms and status codes that appear in what is shown.
function termBar(f, type, src) {
  const bar = h('div', { class: 'termbar' });
  const { re, map } = termsOf(f);
  const found = new Map();
  if (re) for (const m of src.matchAll(re)) { const t = map.get(m[0].toLowerCase()); if (t) found.set(t.term, t); }
  const codes = [...new Set([...src.matchAll(/(?:-->>|--x|-->|--\)|:)\s*⚠?\s*([1-5]\d\d)\b/g)].map(m => Number(m[1])))].filter(c => STATUS_TEXT[c] && !COMMON_STATUS.has(c)).sort();
  if (!found.size && !codes.length) return bar;
  const def = h('div', { class: 'termdef', hidden: true });
  const chip = (label, text) => h('button', { class: 'termchip', 'aria-expanded': 'false', onclick: e => {
    const open = e.currentTarget.getAttribute('aria-expanded') === 'true';
    bar.querySelectorAll('.termchip').forEach(c => c.setAttribute('aria-expanded', 'false'));
    if (open) { def.hidden = true; return; }
    e.currentTarget.setAttribute('aria-expanded', 'true'); def.hidden = false; def.innerHTML = ''; def.append(h('b', { class: 'mono' }, label), ' — ', text);
  } }, label);
  bar.append(h('span', {}, 'Terms in this diagram:'), ...[...found.values()].map(t => chip(t.term, t.meaning)), ...codes.map(c => chip(String(c), STATUS_TEXT[c][0] + '. ' + STATUS_TEXT[c][1])),
    h('button', { class: 'linkbtn', onclick: () => go(f.name, 'concepts') }, 'how to read this diagram →'), def);
  return bar;
}

function conceptsTab(f, body) {
  const left = h('div', { class: 'stack' }), right = h('div', { class: 'stack' });
  const g = f.glossary || [];
  const list = h('ul', { class: 'terms' });
  const draw = q => {
    list.innerHTML = '';
    const items = g.filter(t => !q || (t.term + ' ' + (t.aka || []).join(' ') + ' ' + t.meaning).toLowerCase().includes(q));
    for (const t of items) list.append(h('li', {}, h('div', {}, h('div', { class: 't' }, t.term), t.aka?.length ? h('div', { class: 'aka' }, 'also: ' + t.aka.join(', ')) : null),
      h('div', {}, h('div', {}, t.meaning), h('div', { class: 'meta' }, t.kind ? h('span', { class: 'kindtag' }, t.kind) : null, t.link ? fileLink(t.link.abs, t.link.line, t.ref.split('#')[0]) : t.ref ? h('span', { class: 'mono' }, t.ref) : null))));
    if (!items.length) list.append(h('li', {}, h('div', { class: 'aka' }, q ? 'No match.' : 'No glossary for this feature yet. Ask the agent to write one.')));
  };
  draw('');
  left.append(h('div', { class: 'card' }, h('h2', {}, 'Terms in this feature · ' + g.length),
    g.length > 6 ? h('input', { class: 'cfilter', type: 'search', placeholder: 'Filter terms', oninput: e => draw(e.target.value.trim().toLowerCase()) }) : null, list));
  const c = f.checks || {};
  const codes = [...new Set([...(c.statuses?.intended || []), ...(c.statuses?.code || [])])].filter(x => !COMMON_STATUS.has(x)).sort((a, b) => a - b);
  if (codes.length) left.append(h('div', { class: 'card' }, h('h2', {}, 'Status codes in this feature'), h('table', { class: 'legend' },
    codes.map(code => h('tr', {}, h('td', {}, code + '  ' + (STATUS_TEXT[code]?.[0] || '')), h('td', {}, STATUS_TEXT[code]?.[1] || 'See the code for what it means here.'))))));
  left.append(h('div', { class: 'card' }, h('h2', {}, 'Words this tool uses'), h('table', { class: 'legend' },
    TOOL_WORDS.filter(([w]) => f.mode !== 'observe' || !['Intended', 'Assumption'].includes(w)).map(([w, m]) => h('tr', {}, h('td', {}, w), h('td', {}, m))))));
  for (const t of TYPES) if (f.diagrams[t]) right.append(h('div', { class: 'card' }, h('h2', {}, 'How to read: ' + TYPE_LABEL[t]),
    h('table', { class: 'legend' }, LEGEND[t].map(([sym, m]) => h('tr', {}, h('td', {}, sym), h('td', {}, m))))));
  body.append(h('div', { class: 'grid2' }, left, right));
}


renderFilters();
route();
</script>
</body>
</html>
`;
fs.writeFileSync(path.join(dir, 'index.html'), html);
console.log(`dashboard: ${path.join(dir, 'index.html')} (${features.length} feature(s)${validation.errors.length ? `, ${validation.errors.length} invalid diagram(s) shown as placeholders` : ''})`);
