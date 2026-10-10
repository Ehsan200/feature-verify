// Shared helpers for feature-verify scripts. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

export const TYPES = ['sequence', 'architecture', 'data', 'state'];

// Code refs. Preferred: a comment line after the element —  %% @ref src/a.ts:42#symbol
// Also accepted (sequence only, legacy): inline  [src/a.ts:42#symbol]
export const REF_RE = /\[([^\[\]\s]+?):(\d+)(?:#([^\]\s]+))?\]/g;
const AT_REF_RE = /@ref\s+([^\s:]+?):(\d+)(?:#(\S+))?(?=\s|$)/g;
const AT_SRC_RE = /@src\s+([\w,\s-]+)/;
const AT_ASSUMED_RE = /@assumed\s+([\w,\s-]+)/;
const AT_DRILL_RE = /@drill\s+([\w-]+)/;

function refsInLine(line, mmdLine) {
  const out = [];
  for (const re of [AT_REF_RE, REF_RE]) {
    for (const m of line.matchAll(re)) {
      if (!/[\/.]/.test(m[1])) continue; // skip [*] and other non-paths
      out.push({ file: m[1], line: Number(m[2]), symbol: m[3] || null, mmdLine, raw: m[0] });
    }
  }
  return out;
}

export function extractRefs(text) {
  return text.split('\n').flatMap((l, i) => refsInLine(l, i + 1));
}

// Diagram files: <kind>.<type>.mmd (the feature's main/overview diagram) or <kind>.<type>.<flow>.mmd (one small flow).
const FILE_RE = /^(intended|code)\.(sequence|architecture|data|state)(?:\.([\w-]+))?\.mmd$/;
export function diagramType(file) {
  const m = path.basename(file).match(/\.(sequence|architecture|data|state)(?:\.[\w-]+)?\.mmd$/);
  return m ? m[1] : null;
}
// '' for the main diagram, else the flow name (code.sequence.add-to-cart.mmd → 'add-to-cart').
export function diagramFlow(file) {
  const m = path.basename(file).match(FILE_RE);
  return m ? m[3] || '' : null;
}

const STRUCTURAL = /^(sequenceDiagram|flowchart|graph|stateDiagram|erDiagram|autonumber|participant|actor|box|end|alt|else|opt|loop|par|and|critical|break|rect|note|activate|deactivate|subgraph|direction|classDef|class|style|linkStyle|title|accTitle|accDescr|state\s+\S+\s*\{|\}|%%)/i;

// Is this line a diagram element that must carry provenance?
function isElement(t, type) {
  if (!t || STRUCTURAL.test(t)) return false;
  if (type === 'sequence') return /^[^:]+?(-{1,2}>>|-{1,2}>|-{1,2}x|-{1,2}\)|<<-{1,2}>>)[+-]?[^:]+:/.test(t);
  if (type === 'state') return /-->/.test(t) && !t.includes('[*]');
  if (type === 'architecture') return /^[\w-]+\s*(\[|\(|\{|>)/.test(t) && !/(-->|---|-\.->|==>|--\s|~~~)/.test(t);
  if (type === 'data') return /^[A-Za-z_][\w-]*\s*\{\s*$/.test(t) || /^[A-Za-z_][\w-]*\s+[|}o][|o]?(--|\.\.)[|o]?[|{o]\s+[A-Za-z_][\w-]*\s*:/.test(t);
  return false;
}

// Parse a diagram into elements; comment lines (%% @ref / @src / @assumed) directly after an element attach to it.
export function parseDiagram(text, type) {
  const lines = text.split('\n');
  const elements = [];
  let cur = null;
  let pending = []; // data diagrams: provenance comments placed on the line(s) above an entity
  const attach = (el, t, i) => {
    el.refs.push(...refsInLine(t, i + 1));
    const s = t.match(AT_SRC_RE); if (s) el.srcs.push(...s[1].split(/[,\s]+/).filter(Boolean));
    const a = t.match(AT_ASSUMED_RE); if (a) el.assumed.push(...a[1].split(/[,\s]+/).filter(Boolean));
    const d = t.match(AT_DRILL_RE); if (d) el.drill = d[1];
  };
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (t.startsWith('%%')) {
      if (cur) attach(cur, t, i);
      else if (type === 'data') pending.push([t, i]);
      return;
    }
    if (isElement(t, type)) {
      cur = { mmdLine: i + 1, text: stripInline(t), refs: refsInLine(t, i + 1), srcs: [], assumed: [], isRelationship: type === 'data' && !/\{\s*$/.test(t) };
      if (!cur.isRelationship) for (const [pt, pi] of pending) attach(cur, pt, pi);
      pending = [];
      elements.push(cur);
      if (type === 'data' && !cur.isRelationship) cur = null; // attribute lines follow; don't attach later comments
    } else if (t) { cur = null; if (t !== '}') pending = []; }
  });
  return elements;
}

export const stripInline = s => s.replace(/\s*\[[^\[\]\s]+?:\d+(?:#[^\]\s]+)?\]/g, '');

const fileCache = new Map();
function readLines(abs) {
  if (!fileCache.has(abs)) {
    try { fileCache.set(abs, fs.readFileSync(abs, 'utf8').split('\n')); } catch { fileCache.set(abs, null); }
  }
  return fileCache.get(abs);
}

export function checkRef(ref, root = process.cwd()) {
  const abs = path.resolve(root, ref.file);
  const lines = readLines(abs);
  if (!lines) return { ok: false, reason: 'file not found' };
  if (ref.line < 1 || ref.line > lines.length) return { ok: false, reason: `line ${ref.line} out of range (file has ${lines.length})` };
  if (ref.symbol) {
    const win = lines.slice(Math.max(0, ref.line - 4), Math.min(lines.length, ref.line + 3)).join('\n');
    if (!win.includes(ref.symbol)) return { ok: false, reason: `symbol "${ref.symbol}" not within ±3 lines` };
  }
  return { ok: true };
}

// Elements of a code diagram that lack a ref. Data relationships and architecture edges are exempt.
export function missingRefs(text, type) {
  return parseDiagram(text, type).filter(e => !e.refs.length && !e.isRelationship && !/UNCERTAIN/.test(e.text)).map(e => ({ mmdLine: e.mmdLine, text: e.text }));
}

// Drill-down links: a sequence message followed by  %% @drill <flow>  opens <kind>.sequence.<flow>.mmd
// (same kind first, else the other kind). Every target must exist.
export function checkDrills(dir, kinds = ['intended', 'code']) {
  const names = fs.readdirSync(dir).filter(n => FILE_RE.test(n));
  const flows = k => new Set(names.filter(n => n.startsWith(k + '.sequence.')).map(diagramFlow));
  const res = { links: 0, broken: [] };
  for (const n of names.filter(n => diagramType(n) === 'sequence' && kinds.some(k => n.startsWith(k + '.')))) {
    for (const e of parseDiagram(fs.readFileSync(path.join(dir, n), 'utf8'), 'sequence')) {
      if (!e.drill) continue;
      res.links++;
      if (!kinds.some(k => flows(k).has(e.drill))) res.broken.push({ diagram: n, mmdLine: e.mmdLine, drill: e.drill, reason: `no ${n.split('.')[0]}.sequence.${e.drill}.mmd` });
    }
  }
  res.ok = !res.broken.length;
  return res;
}

// ---------- intent ----------
export const expandHome = p => (p && p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);
const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

export function promptText(obj) {
  // Claude Code transcript line
  if (obj?.type === 'user' && obj.message) {
    const c = obj.message.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.filter(x => x.type === 'text').map(x => x.text).join('\n');
  }
  // Codex rollout line
  const p = obj?.payload;
  if (p?.type === 'user_message') return p.message || '';
  if (p?.type === 'item_completed' && p.item?.type === 'UserMessage') return (p.item.content || []).map(x => x.text || '').join('\n');
  if (p?.type === 'message' && p.role === 'user') return (p.content || []).map(x => x.text || '').join('\n');
  return '';
}

// Verify one intent source's quote against where it claims to come from.
export function checkSource(src, root = process.cwd()) {
  if (!src.quote) return src.kind === 'interview' ? { ok: true } : { ok: false, reason: 'no quote' };
  if (src.kind === 'interview') return { ok: true };
  if (!src.file) return { ok: true, unverifiable: true };
  const abs = path.resolve(root, expandHome(src.file));
  const lines = readLines(abs);
  if (!lines) return { ok: false, reason: 'file not found' };
  if (src.kind === 'prompt') {
    const l = lines[(src.line || 0) - 1];
    if (l == null) return { ok: false, reason: `line ${src.line} out of range` };
    let text = ''; try { text = promptText(JSON.parse(l)); } catch { text = l; }
    return norm(text).includes(norm(src.quote)) ? { ok: true } : { ok: false, reason: 'quote not found in that prompt' };
  }
  const lo = src.line ? Math.max(0, src.line - 4) : 0, hi = src.line ? src.line + 3 : lines.length;
  return norm(lines.slice(lo, hi).join(' ')).includes(norm(src.quote)) ? { ok: true } : { ok: false, reason: 'quote not found near that line' };
}

// Feature mode: 'verify' (intended vs code) or 'observe' (code only; intent ignored).
// Per feature: <feature-dir>/feature.json {"mode": "observe"|"verify"}.
// Project default: .feature-verify/config.json {"defaultMode": "observe"} — applies to features without their own mode.
export function loadMode(dir) {
  const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const own = read(path.join(dir, 'feature.json'))?.mode;
  const mode = own || read(path.join(dir, '..', 'config.json'))?.defaultMode;
  return mode === 'observe' ? 'observe' : 'verify';
}

export function loadIntent(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'intent.json'), 'utf8')); } catch { return null; }
}

// Every intended element must cite a source (@src) or a declared assumption (@assumed); ids must exist; quotes must match.
// Assumptions are reported (guesses the user hasn't answered yet) but don't fail the check.
export function checkIntent(dir, root = process.cwd()) {
  const intent = loadIntent(dir) || { sources: [], assumptions: [] };
  const srcIds = new Map((intent.sources || []).map(s => [s.id, s]));
  const asmIds = new Map((intent.assumptions || []).map(a => [a.id, a]));
  const res = { elements: 0, sourced: 0, assumed: 0, unsourced: [], unknownIds: [], badSources: [], assumptions: [] };
  for (const f of fs.readdirSync(dir).filter(n => FILE_RE.test(n) && n.startsWith('intended.'))) {
    const type = diagramType(f);
    for (const e of parseDiagram(fs.readFileSync(path.join(dir, f), 'utf8'), type)) {
      res.elements++;
      if (e.srcs.length) res.sourced++;
      if (e.assumed.length) res.assumed++;
      if (!e.srcs.length && !e.assumed.length) res.unsourced.push({ diagram: f, mmdLine: e.mmdLine, text: e.text });
      for (const id of e.srcs) if (!srcIds.has(id)) res.unknownIds.push({ diagram: f, mmdLine: e.mmdLine, id });
      for (const id of e.assumed) if (!asmIds.has(id)) res.unknownIds.push({ diagram: f, mmdLine: e.mmdLine, id });
    }
  }
  for (const s of intent.sources || []) { const r = checkSource(s, root); if (!r.ok) res.badSources.push({ id: s.id, reason: r.reason }); }
  res.assumptions = (intent.assumptions || []).map(a => ({ id: a.id, text: a.text }));
  res.hasIntentFile = !!loadIntent(dir);
  res.ok = res.hasIntentFile && !res.unsourced.length && !res.unknownIds.length && !res.badSources.length;
  return res;
}

// ---------- glossary ----------
// <feature-dir>/glossary.json: { "terms": [ { "term": "qty", "meaning": "...", "kind": "field", "ref": "src/cart.js:6#qty", "aka": ["quantity"] } ] }
// Plain-language meanings for words a reader may not know. A ref (file:line#symbol) ties each term to the code and is checked.
export function loadGlossary(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'glossary.json'), 'utf8')); } catch { return null; }
}

export function checkGlossary(dir, root = process.cwd()) {
  const g = loadGlossary(dir);
  if (!g) return { hasGlossary: false, terms: 0, failed: [], missingMeaning: [], ok: true };
  const res = { hasGlossary: true, terms: (g.terms || []).length, failed: [], missingMeaning: [] };
  for (const t of g.terms || []) {
    if (!t.term || !String(t.meaning || '').trim()) res.missingMeaning.push(t.term || '(unnamed)');
    if (!t.ref) continue;
    const m = String(t.ref).match(/^([^\s:]+?):(\d+)(?:#(\S+))?$/);
    if (!m) { res.failed.push({ term: t.term, ref: t.ref, reason: 'ref must look like path:line#symbol' }); continue; }
    const r = checkRef({ file: m[1], line: Number(m[2]), symbol: m[3] || null }, root);
    if (!r.ok) res.failed.push({ term: t.term, ref: t.ref, reason: r.reason });
  }
  res.ok = !res.failed.length && !res.missingMeaning.length;
  return res;
}

// ---------- HTTP endpoints & statuses ----------
const HTTP_RE = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[^\s\[\]"'`,;)|<>]*)/g;

export function normalizePath(p) {
  p = p.split('?')[0].split('#')[0];
  if (p.length > 1) p = p.replace(/\/+$/, '');
  const segs = p.split('/').map(s => {
    if (!s) return s;
    if (/^(:\w+|\{[^}]+\}|\[\.{0,3}[^\]]+\]|<[^>]+>|\$\{[^}]+\}|\$\w+|\*)$/.test(s)) return ':param';
    if (/^\d+$/.test(s)) return ':param';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return ':param';
    if (/^[0-9a-f]{24}$/i.test(s)) return ':param';
    if (s.length >= 16 && /\d/.test(s) && /^[\w-]+$/.test(s)) return ':param';
    return s;
  });
  return segs.join('/') || '/';
}

const withoutComments = text => text.split('\n').filter(l => !l.trim().startsWith('%%')).join('\n');

export function extractEndpoints(text) {
  const set = new Set();
  for (const m of withoutComments(text).matchAll(HTTP_RE)) set.add(`${m[1]} ${normalizePath(m[2])}`);
  return set;
}

// HTTP status codes on reply arrows (-->> / --x / --) ) of a sequence diagram.
export function extractStatuses(text) {
  const set = new Set();
  for (const line of withoutComments(text).split('\n')) {
    const m = line.match(/--(?:>>|x|\)|>)[+-]?[^:]+:(.*)$/);
    if (!m) continue;
    const label = stripInline(m[1]).replace(/\(\d+ms\)/g, '');
    for (const c of label.matchAll(/\b([1-5]\d\d)\b/g)) set.add(Number(c[1]));
  }
  return set;
}

export function isMain(importMetaUrl) {
  try { return !!process.argv[1] && importMetaUrl === pathToFileURL(fs.realpathSync(process.argv[1])).href; } catch { return false; }
}
