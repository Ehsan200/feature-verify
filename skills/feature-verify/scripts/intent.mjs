#!/usr/bin/env node
// Harvest what the user actually asked AI agents to build in this project: user prompts from
// Claude Code transcripts (~/.claude/projects/<encoded-path>/*.jsonl) and Codex rollouts
// (~/.codex/sessions/**/*.jsonl whose cwd is inside the project). Prompts are the best
// independent source of intent when a project has no spec.
// Usage: node intent.mjs [projectRoot] [--grep word,word] [--since YYYY-MM-DD] [--limit 200] [--full]
// Output: JSON { prompts: [{ ref, tool, file, line, time, text }] } — cite file+line+quote in intent.json.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promptText } from './lib.mjs';

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const root = path.resolve(argv[0] && !argv[0].startsWith('--') ? argv[0] : '.');
const words = (opt('grep') || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
const since = opt('since') ? new Date(opt('since')) : null;
const limit = Number(opt('limit') || 200);
const full = argv.includes('--full');
const home = os.homedir();
const tilde = p => (p.startsWith(home) ? '~' + p.slice(home.length) : p);

// Injected context, slash-command plumbing and tool results are not things the user typed.
const NOISE = /^(<command-|<local-command|<system-reminder|<environment_context|<user_instructions|<recommended_plugins|<permissions|<turn_aborted|# AGENTS\.md|Caveat: |\[Request interrupted|\[Image: )/;

const prompts = [];
function consider(tool, file, line, time, text) {
  text = (text || '').trim();
  if (!text || NOISE.test(text)) return;
  if (since && time && new Date(time) < since) return;
  if (words.length && !words.some(w => text.toLowerCase().includes(w))) return;
  prompts.push({ tool, file: tilde(file), line, time: time || null, text: full ? text : text.slice(0, 1500) });
}

function eachLine(file, fn) {
  let data; try { data = fs.readFileSync(file, 'utf8'); } catch { return; }
  data.split('\n').forEach((l, i) => { if (!l) return; let o; try { o = JSON.parse(l); } catch { return; } fn(o, i + 1); });
}

// ---- Claude Code: project dirs are the absolute cwd with / and . replaced by -
const ccRoot = path.join(home, '.claude', 'projects');
const enc = p => p.replace(/[\/.]/g, '-');
const sessionsScanned = { claude: 0, codex: 0 };
if (fs.existsSync(ccRoot)) {
  const prefix = enc(root);
  for (const d of fs.readdirSync(ccRoot)) {
    if (d !== prefix && !d.startsWith(prefix + '-')) continue;
    const dir = path.join(ccRoot, d);
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
      const file = path.join(dir, f);
      sessionsScanned.claude++;
      eachLine(file, (o, n) => {
        if (o.type !== 'user' || o.isMeta || o.isSidechain) return;
        if (o.cwd && !(o.cwd === root || o.cwd.startsWith(root + path.sep))) return;
        consider('claude', file, n, o.timestamp, promptText(o));
      });
    }
  }
}

// ---- Codex: rollouts anywhere under sessions/, filtered by session cwd
const cxRoot = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
function walk(dir, out = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.jsonl')) out.push(p); }
  return out;
}
for (const file of walk(cxRoot)) {
  let cwd = null, typed = false;
  const lines = [];
  eachLine(file, (o, n) => {
    const p = o.payload || {};
    if (o.type === 'session_meta' && p.cwd) cwd = p.cwd;
    if (o.type === 'turn_context' && p.cwd && !cwd) cwd = p.cwd;
    if (p.type === 'user_message' || (p.type === 'item_completed' && p.item?.type === 'UserMessage')) { typed = true; lines.push([o, n]); }
    else if (p.type === 'message' && p.role === 'user') lines.push([o, n, 'fallback']);
  });
  if (!cwd || !(cwd === root || cwd.startsWith(root + path.sep))) continue;
  sessionsScanned.codex++;
  for (const [o, n, kind] of lines) {
    if (typed && kind === 'fallback') continue; // prefer what the user typed over the model-input copy
    consider('codex', file, n, o.timestamp, promptText(o));
  }
}

prompts.sort((a, b) => String(a.time).localeCompare(String(b.time)));
const out = prompts.slice(-limit).map((p, i) => ({ ref: `P${i + 1}`, ...p }));
console.log(JSON.stringify({ root, filters: { grep: words, since: opt('since') || null }, sessionsScanned, total: prompts.length, returned: out.length, prompts: out }, null, 2));
