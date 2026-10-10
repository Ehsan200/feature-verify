#!/usr/bin/env node
// Build .feature-verify/index.html — a single-file dashboard: feature sidebar, tabs per feature
// (Overview · diagram types · Concepts · Intent), pan/zoom diagram canvas, compare view.
// Refuses to build if any diagram fails Mermaid parsing (use --force to build with placeholders).
// Usage: node dashboard.mjs [.feature-verify] [--force]
import fs from 'node:fs';
import path from 'node:path';
import { TYPES, parseDiagram, diagramType, stripInline, loadIntent, loadMode, loadGlossary } from './lib.mjs';
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
for (const d of fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
  const fd = path.join(dir, d.name);
  const mode = loadMode(fd);
  const names = fs.readdirSync(fd);
  const diagrams = {};
  for (const t of TYPES) {
    const pick = (re, kind) => names.filter(n => re.test(n)).sort().map(n => {
      const full = path.join(fd, n);
      const raw = fs.readFileSync(full, 'utf8');
      const err = invalid.get(full);
      const elements = parseDiagram(raw, t).map(e => ({
        text: e.text, srcs: e.srcs, assumed: e.assumed, rel: !!e.isRelationship,
        refs: e.refs.map(r => ({ file: r.file, line: r.line, symbol: r.symbol, abs: path.resolve(projectRoot, r.file) })),
      }));
      const label = kind;
      return { name: n, label, src: stripInline(raw), elements, error: err ? { line: err.line, message: err.message, sourceLine: err.sourceLine } : null };
    });
    const entry = {
      intended: mode === 'observe' ? [] : pick(new RegExp(`^intended\\.${t}\\.mmd$`), 'intended'),
      code: pick(new RegExp(`^code\\.${t}\\.mmd$`), 'code'),
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
    features.push({ name: d.name, mode, glossary, diagrams, report, checks, spec: mode === 'observe' ? null : spec, intent: mode === 'observe' ? null : loadIntent(fd) });
  }
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
    <div class="search"><input id="q" type="search" placeholder="Filter features" aria-label="Filter features"></div>
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
function fileLink(abs, line, text) {
  const make = EDITORS[editor][1];
  if (!make) return h('button', { class: 'linkbtn mono', title: 'Copy ' + abs + ':' + line, onclick: e => { navigator.clipboard?.writeText(abs + ':' + line); const t = e.target; const o = t.textContent; t.textContent = 'copied'; setTimeout(() => (t.textContent = o), 1000); } }, text);
  const p = abs.startsWith('/') ? abs : '/' + abs.replace(/\\/g, '/'); // editors expect <scheme>://file/<absolute path> (Windows: /C:/…)
  return h('a', { class: 'mono', href: make(encodeURI(p).replace(/#/g, '%23'), line), title: 'Open in ' + EDITORS[editor][0] }, text);
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
  ].map(([n, f, s, dash]) => 'classDef ' + n + ' fill:' + css(f) + ',stroke:' + css(s) + ',color:' + css('--text') + (dash ? ',stroke-dasharray:' + dash : ''));
  if (/^(flowchart|graph)$/.test(head) || /^stateDiagram/.test(head)) return src.replace(/\s*$/, '\n') + defs.map(d => '  ' + d).join('\n') + '\n';
  return src;
}

// ---------- status helpers ----------
const statusOf = f => f.report?.status || (f.mode === 'observe' ? 'incomplete' : 'unverified');
const KINDS = f => f.mode === 'observe' ? ['code'] : ['intended', 'code'];

// ---------- sidebar ----------
document.getElementById('proj').textContent = D.project + ' · ' + D.features.length + ' feature' + (D.features.length === 1 ? '' : 's');
document.getElementById('gen').textContent = 'built ' + new Date(D.generatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
let filter = 'all', query = '';
const STATUSES = ['all', 'mismatch', 'partial', 'incomplete', 'verified', 'observed', 'unverified'];
function renderFilters() {
  const box = document.getElementById('filters'); box.innerHTML = '';
  for (const s of STATUSES) {
    const n = s === 'all' ? D.features.length : D.features.filter(f => statusOf(f) === s).length;
    if (s !== 'all' && !n) continue;
    box.append(h('button', { class: 'chip', 'aria-pressed': String(filter === s), onclick: () => { filter = s; renderFilters(); renderList(); } }, s + ' ' + n));
  }
}
function renderList() {
  const nav = document.getElementById('flist'); nav.innerHTML = '';
  const cur = parseRoute().feature;
  for (const f of D.features) {
    if (filter !== 'all' && statusOf(f) !== filter) continue;
    if (query && !f.name.toLowerCase().includes(query)) continue;
    nav.append(h('button', { class: 'fitem', 'aria-current': String(f.name === cur), onclick: () => go(f.name) },
      h('span', { class: 'dot ' + statusOf(f), title: statusOf(f) }), h('span', { class: 'n' }, f.name, h('span', { class: 'appr' }, (f.mode === 'observe' ? 'observe' : statusOf(f)) + ((f.report?.risks || []).filter(r => r.impact === 'high').length ? ' · ' + f.report.risks.filter(r => r.impact === 'high').length + ' high risk' : '')))));
  }
  if (!nav.children.length) nav.append(h('div', { class: 'appr', style: 'padding:10px' }, 'No matching features.'));
}
document.getElementById('q').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); renderList(); });

// ---------- routing: #/feature/tab/view ----------
function parseRoute() {
  const [feature, tab, view] = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/');
  return { feature: feature || D.features[0]?.name, tab: tab || 'overview', view };
}
const go = (feature, tab = 'overview', view) => { location.hash = '#/' + [feature, tab, view].filter(Boolean).map(encodeURIComponent).join('/'); };
addEventListener('hashchange', route);

function route() {
  renderList();
  const main = document.getElementById('main'); main.innerHTML = '';
  if (!D.features.length) { main.append(h('div', { class: 'empty' }, h('h2', {}, 'No features yet'), h('p', {}, 'Run feature-verify in this project to create one.'))); return; }
  const r = parseRoute();
  const f = D.features.find(x => x.name === r.feature) || D.features[0];
  const st = statusOf(f);
  main.append(h('header', { class: 'fhead' }, h('h1', {}, f.name), h('span', { class: 'pill ' + st }, st),
    f.mode === 'observe' ? h('span', { class: 'pill mode', title: 'Shows what the code does. Nothing is checked against a spec.' }, 'observe mode') : null));
  if (f.report?.summary) main.append(h('p', { class: 'summary' }, f.report.summary));

  const tabs = [['overview', 'Overview']];
  for (const t of TYPES) if (f.diagrams[t]) tabs.push([t, TYPE_LABEL[t]]);
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
  else diagramTab(f, tab, r.view, body);
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
  if (!f.checks) { row('na', 'Mechanical checks', 'not run yet — run compare.mjs'); return rows; }
  if (f.mode === 'observe') {
    row(c.syntax?.ok ? 'ok' : c.syntax?.unavailable ? 'warn' : 'bad', 'Diagram syntax', c.syntax?.ok ? 'all diagrams parse (' + (c.syntax.parser || 'mermaid') + ')' : c.syntax?.unavailable || (c.syntax?.errors?.length + ' diagram(s) fail to parse'));
    const r = c.refs;
    if (r) row(r.ok ? 'ok' : 'bad', 'Code refs', (r.checked - r.failed.length) + ' of ' + r.checked + ' refs resolve' + (r.missing?.length ? ' · ' + r.missing.length + ' element(s) without a ref' : '') + (r.failed.length ? ' · ' + r.failed.length + ' broken' : ''));
    row('na', 'Intent', 'not checked (observe mode)');
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
function overview(f, body) {
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
        d && d[k].length ? h('button', { class: 'yes', title: d[k].map(x => x.name).join(', '), onclick: () => go(f.name, t, k) }, '✓')
        : h('span', { class: 'no', title: skipped || '' }, skipped && k === cols[0] ? 'skipped' : '—')))); }));
  right.append(h('div', { class: 'card' }, h('h2', {}, 'Coverage'), cov,
    f.report?.skipped && Object.keys(f.report.skipped).length ? h('p', { class: 'summary', style: 'padding:0 16px 14px;font-size:12px' }, 'Skipped: ' + Object.entries(f.report.skipped).map(([k, v]) => k + ' (' + v + ')').join(', ')) : null));
  body.append(h('div', { class: 'grid2' }, left, right));
}

// ---------- diagram tab ----------
let seq = 0;
function diagramTab(f, type, view, body) {
  const d = f.diagrams[type];
  const kinds = ['intended', 'code'].filter(k => d[k].length);
  const valid = KINDS(f).length > 1 ? [...KINDS(f), 'compare'] : KINDS(f);
  if (!valid.includes(view) || (view !== 'compare' && !d[view]?.length)) view = kinds.length > 1 ? 'compare' : kinds[0];
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, valid.map(k =>
    h('button', { 'aria-pressed': String(k === view), disabled: k !== 'compare' && !d[k].length || (k === 'compare' && kinds.length < 2), onclick: () => go(f.name, type, k) }, k[0].toUpperCase() + k.slice(1))));
  const zoomCtl = h('div', { class: 'zoom' });
  body.append(h('div', { class: 'toolbar' }, seg, zoomCtl));

  const options = kinds.flatMap(k => d[k].map((dg, i) => ({ key: k + ':' + i, kind: k, dg, label: k[0].toUpperCase() + k.slice(1) })));
  let picks;
  if (view === 'compare') {
    const saved = (store.get('fv-cmp-' + type, '') || '').split('|');
    const valid = k => options.some(o => o.key === k);
    const left = valid(saved[0]) ? saved[0] : options[0].key;
    const right = valid(saved[1]) && saved[1] !== left ? saved[1] : (options.find(o => o.kind === 'code' && o.key !== left) || options.find(o => o.key !== left)).key;
    picks = [left, right];
  } else picks = d[view].map((_, i) => view + ':' + i);
  const panes = h('div', { class: 'panes n' + Math.min(picks.length, 2) });
  const canvases = [];
  picks.forEach((key, idx) => {
    const o = options.find(x => x.key === key);
    const c = h('div', { class: 'canvas', tabindex: '0', 'aria-label': o.label + ' ' + type + ' diagram' });
    const title = view === 'compare'
      ? h('select', { 'aria-label': 'Pane ' + (idx + 1), onchange: e => { picks[idx] = e.target.value; store.set('fv-cmp-' + type, picks.join('|')); route(); } },
          options.map(x => h('option', { value: x.key, selected: x.key === key }, x.label)))
      : h('b', {}, o.label);
    panes.append(h('div', { class: 'card pane' }, h('div', { class: 'pane-h' }, title, h('span', { class: 'mono' }, o.dg.name)), c));
    canvases.push(mountCanvas(c, o.dg));
  });
  body.append(panes);
  // zoom controls drive every visible canvas together
  const zl = h('span', {}, '');
  const all = fn => () => { canvases.forEach(cv => cv && fn(cv)); zl.textContent = Math.round((canvases[0]?.scale() || 1) * 100) + '%'; };
  zoomCtl.append(h('button', { class: 'iconbtn', title: 'Zoom out (−)', onclick: all(cv => cv.zoom(1 / 1.2)) }, '−'), zl,
    h('button', { class: 'iconbtn', title: 'Zoom in (+)', onclick: all(cv => cv.zoom(1.2)) }, '+'),
    h('button', { class: 'iconbtn', title: 'Fit (0)', onclick: all(cv => cv.fit()) }, 'Fit'),
    h('button', { class: 'iconbtn', title: 'Actual size', onclick: all(cv => cv.setScale(1)) }, '1:1'));
  Promise.all(canvases.map(cv => cv?.ready)).then(() => { zl.textContent = Math.round((canvases[0]?.scale() || 1) * 100) + '%'; });
  onkeydown = e => { if (e.target.closest('input')) return; if (e.key === '+' || e.key === '=') all(cv => cv.zoom(1.2))(); if (e.key === '-') all(cv => cv.zoom(1 / 1.2))(); if (e.key === '0') all(cv => cv.fit())(); };

  if (type === 'sequence') body.append(diffBar(f));
  body.append(termBar(f, type, picks.map(k => options.find(x => x.key === k).dg.src).join('\n')));
  // element details for the single view (or the code+intended pair in compare)
  for (const key of picks) { const o = options.find(x => x.key === key); if (o.dg.elements.length) body.append(elementTable(f, o.kind, o.dg)); }
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
function elementTable(f, kind, dg) {
  const srcs = new Map((f.intent?.sources || []).map(s => [s.id, s]));
  const asm = new Map((f.intent?.assumptions || []).map(a => [a.id, a]));
  const rows = dg.elements.map(e => h('tr', {}, h('td', {}, prettyEl(e.text).map(x => typeof x === 'string' ? termify(f, x) : x)),
    kind === 'code'
      ? h('td', {}, e.rel && !e.refs.length ? h('span', { class: 'from' }, 'relationship (follows from the entities)') : e.refs.length ? e.refs.map(r => h('div', {}, fileLink(r.abs, r.line, r.file + ':' + r.line), r.symbol ? h('span', { class: 'mono', style: 'color:var(--muted)' }, '  #' + r.symbol) : null)) : h('span', { class: 'tag missing' }, 'no ref'))
      : h('td', {}, e.srcs.map(id => h('span', { class: 'tag', title: srcs.get(id)?.quote || 'unknown source' }, id)), e.assumed.map(id => h('span', { class: 'tag assumed', title: asm.get(id)?.text || '' }, id + ' · assumed')),
          !e.srcs.length && !e.assumed.length ? h('span', { class: 'tag missing' }, 'unsourced') : null,
          e.srcs.length === 1 && srcs.get(e.srcs[0]) ? h('div', { style: 'color:var(--muted);font-size:12px' }, '“' + srcs.get(e.srcs[0]).quote + '”') : null)));
  return h('div', { class: 'card details' }, h('h2', {}, kind === 'code' ? 'Code refs · ' + dg.name : 'Intent sources · ' + dg.name),
    h('table', { class: 'el' }, h('tr', {}, h('th', {}, 'Element'), h('th', {}, kind === 'code' ? 'Where in the code' : 'Why it is intended')), rows));
}

// Pan / zoom canvas around one rendered Mermaid SVG.
function mountCanvas(el, dg) {
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
      const W = el.clientWidth, maxH = Math.min(innerHeight * 0.72, 920);
      s = Math.min((W - 48) / w, 1.25);
      el.style.height = Math.max(240, Math.min(maxH, ht * s + 48)) + 'px';
      const H = el.clientHeight;
      x = (W - w * s) / 2; y = Math.max(24, (H - ht * s) / 2); apply();
    },
    setScale(n, cx = el.clientWidth / 2, cy = el.clientHeight / 2) { n = Math.min(4, Math.max(0.15, n)); x = cx - (cx - x) * n / s; y = cy - (cy - y) * n / s; s = n; apply(); },
    zoom(f, cx, cy) { api.setScale(s * f, cx, cy); },
  };
  api.ready = (async () => {
    try {
      const { svg } = await mermaid.render('fv' + (++seq), decorate(dg.src));
      stage.innerHTML = svg;
      const svgEl = stage.querySelector('svg');
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
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', e => {
    e.preventDefault();
    const r = el.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) api.zoom(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    else { x -= e.deltaX; y -= e.deltaY; apply(); }
  }, { passive: false });
  el.addEventListener('dblclick', () => api.fit());
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
