#!/usr/bin/env node
// Scan a project: stack, frameworks, routes/pages/endpoints, schema files, test & tracing tooling,
// existing .feature-verify features (with staleness: has their code changed since?), nested git repos. Heuristic — the agent fills gaps by reading the repo.
// Usage: node discover.mjs [projectRoot] [--max-routes 300]
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadMode } from './lib.mjs';
import { check as checkStale } from './stale.mjs';

const root = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.');
const mi = process.argv.indexOf('--max-routes');
const MAX_ROUTES = mi >= 0 ? Number(process.argv[mi + 1]) : 300;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.output', '.vercel', '.turbo',
  'coverage', 'venv', '.venv', 'env', '__pycache__', 'vendor', 'target', 'bin', 'obj', '.idea', '.vscode', '.feature-verify', '.cache', 'tmp']);
const SRC_EXT = /\.(m?[jt]sx?|cjs|py|rb|php|go|java|kt|cs|rs|vue|svelte|astro)$/;
const MAX_FILES = 25000;

const files = [];
(function walk(dir) {
  if (files.length >= MAX_FILES) return;
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.name.startsWith('.') && e.name !== '.env.example' && e.isDirectory()) continue;
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else files.push(path.relative(root, p));
  }
})(root);

const read = f => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return ''; } };
const has = (re) => files.filter(f => re.test(f));

// ---- stack / frameworks
const frameworks = new Set(), tooling = new Set(), devScripts = [];
const FW = { next: 'Next.js', react: 'React', vue: 'Vue', nuxt: 'Nuxt', svelte: 'Svelte', '@sveltejs/kit': 'SvelteKit', astro: 'Astro',
  '@remix-run/react': 'Remix', 'react-router': 'React Router', '@angular/core': 'Angular', 'solid-js': 'Solid', express: 'Express',
  fastify: 'Fastify', koa: 'Koa', hono: 'Hono', '@nestjs/core': 'NestJS', 'socket.io': 'Socket.IO', '@trpc/server': 'tRPC',
  graphql: 'GraphQL', prisma: 'Prisma', '@prisma/client': 'Prisma', 'drizzle-orm': 'Drizzle', typeorm: 'TypeORM', sequelize: 'Sequelize',
  mongoose: 'Mongoose', knex: 'Knex', '@supabase/supabase-js': 'Supabase', firebase: 'Firebase', xstate: 'XState', zustand: 'Zustand',
  '@reduxjs/toolkit': 'Redux', stripe: 'Stripe' };
const TOOL = { '@playwright/test': 'Playwright', playwright: 'Playwright', cypress: 'Cypress', vitest: 'Vitest', jest: 'Jest',
  '@opentelemetry/api': 'OpenTelemetry', '@opentelemetry/sdk-node': 'OpenTelemetry', '@vercel/otel': 'OpenTelemetry', '@sentry/node': 'Sentry' };
for (const pj of has(/(^|\/)package\.json$/)) {
  let j; try { j = JSON.parse(read(pj)); } catch { continue; }
  const deps = { ...j.dependencies, ...j.devDependencies };
  for (const d of Object.keys(deps)) {
    if (FW[d]) frameworks.add(FW[d]);
    if (TOOL[d]) tooling.add(TOOL[d]);
    if (d.startsWith('@opentelemetry/')) tooling.add('OpenTelemetry');
  }
  for (const [k, v] of Object.entries(j.scripts || {})) if (/^(dev|start|serve|preview)$/.test(k)) devScripts.push({ package: path.dirname(pj) || '.', script: k, cmd: v });
}
const textHas = (re, fileRe) => has(fileRe).some(f => re.test(read(f)));
const PY = [['django', 'Django'], ['flask', 'Flask'], ['fastapi', 'FastAPI'], ['sqlalchemy', 'SQLAlchemy'], ['starlette', 'Starlette'], ['pydantic', 'Pydantic']];
for (const [k, n] of PY) if (textHas(new RegExp(`^\\s*["']?${k}\\b`, 'mi'), /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile)$/)) frameworks.add(n);
if (textHas(/opentelemetry/i, /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile|Gemfile|go\.mod|pom\.xml|build\.gradle(\.kts)?|composer\.json)$/)) tooling.add('OpenTelemetry');
if (textHas(/pytest/i, /(^|\/)(requirements[^/]*\.txt|pyproject\.toml)$/)) tooling.add('pytest');
if (textHas(/\brails\b/, /(^|\/)Gemfile$/)) frameworks.add('Rails');
if (textHas(/laravel\/framework/, /(^|\/)composer\.json$/)) frameworks.add('Laravel');
if (textHas(/symfony\//, /(^|\/)composer\.json$/)) frameworks.add('Symfony');
for (const [k, n] of [['gin-gonic/gin', 'Gin'], ['labstack/echo', 'Echo'], ['gofiber/fiber', 'Fiber'], ['go-chi/chi', 'Chi']]) if (textHas(new RegExp(k), /(^|\/)go\.mod$/)) frameworks.add(n);
if (has(/(^|\/)go\.mod$/).length) frameworks.add('Go');
if (textHas(/spring-boot/, /(^|\/)(pom\.xml|build\.gradle(\.kts)?)$/)) frameworks.add('Spring Boot');
if (textHas(/Microsoft\.AspNetCore|Sdk="Microsoft\.NET\.Sdk\.Web"/, /\.csproj$/)) frameworks.add('ASP.NET Core');
if (has(/(^|\/)playwright\.config\.[mc]?[jt]s$/).length) tooling.add('Playwright');
if (has(/(^|\/)cypress\.config\.[mc]?[jt]s$/).length) tooling.add('Cypress');
if (has(/(^|\/)(docker-compose|compose)\.ya?ml$/).length) tooling.add('Docker Compose');

// ---- file-based routes
const routes = [];
const add = (kind, method, route, file) => { if (routes.length < MAX_ROUTES * 3) routes.push({ kind, method, route, file }); };
const clean = r => ('/' + r).replace(/\/\([^/)]+\)/g, '').replace(/\/@[^/]+/g, '').replace(/\/index$/, '').replace(/\/+/g, '/').replace(/(.)\/$/, '$1') || '/';
for (const f of files) {
  let m;
  if ((m = f.match(/(?:^|\/)(?:src\/)?app\/(.*?)\/?page\.(?:[jt]sx?|mdx)$/))) add('page', 'GET', clean(m[1]), f);
  else if ((m = f.match(/(?:^|\/)(?:src\/)?app\/(.*?)\/?route\.[jt]s$/))) {
    const methods = [...read(f).matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(x => x[1]);
    for (const mt of methods.length ? methods : ['ANY']) add('api', mt, clean(m[1]), f);
  }
  else if ((m = f.match(/(?:^|\/)(?:src\/)?pages\/(api\/.*)\.[jt]sx?$/))) add('api', 'ANY', clean(m[1]), f);
  else if ((m = f.match(/(?:^|\/)(?:src\/)?pages\/(?!_)(.*)\.(?:[jt]sx?|vue|astro|md|mdx)$/))) add('page', 'GET', clean(m[1]), f);
  else if ((m = f.match(/(?:^|\/)src\/routes\/(.*?)\/?\+page\.svelte$/))) add('page', 'GET', clean(m[1]), f);
  else if ((m = f.match(/(?:^|\/)src\/routes\/(.*?)\/?\+server\.[jt]s$/))) {
    const methods = [...read(f).matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map(x => x[1]);
    for (const mt of methods.length ? methods : ['ANY']) add('api', mt, clean(m[1]), f);
  }
  else if ((m = f.match(/(?:^|\/)server\/(?:api|routes)\/(.*?)(?:\.(get|post|put|patch|delete))?\.[jt]s$/))) add('api', (m[2] || 'ANY').toUpperCase(), clean('api/' + m[1]), f);
  else if ((m = f.match(/(?:^|\/)app\/routes\/(.*)\.[jt]sx?$/)) && frameworks.has('Remix')) add('page', 'GET', clean(m[1].replace(/\./g, '/').replace(/\$/g, ':').replace(/_index$/, '')), f);
}

// ---- code-declared routes
const CODE_ROUTES = [
  [/\b(?:app|router|server|api|r|routes|fastify|hono)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gi, 1, 2],
  [/@(?:\w+)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/gi, 1, 2],                 // FastAPI / Flask 2
  [/@(?:\w+)\.route\(\s*['"]([^'"]+)['"](?:[^)]*methods\s*=\s*\[([^\]]+)\])?/gi, 2, 1],     // Flask
  [/@(Get|Post|Put|Patch|Delete)\(\s*['"]?([^'")]*)['"]?\s*\)/g, 1, 2],                   // NestJS
  [/@(Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']*)["']/g, 1, 2], // Spring
  [/\.(GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]+)"/g, 1, 2],                                  // Gin/Echo/Fiber
  [/\.(?:HandleFunc|Handle)\(\s*"(?:(GET|POST|PUT|PATCH|DELETE)\s+)?([^"]+)"/g, 1, 2],     // net/http
  [/Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]/gi, 1, 2],                 // Laravel
  [/^\s*(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gim, 1, 2],                         // Rails routes.rb
  [/\b(?:re_)?path\(\s*r?['"]([^'"]*)['"]/g, null, 1],                                     // Django
  [/\bMap(Get|Post|Put|Patch|Delete)\(\s*"([^"]+)"/g, 1, 2],                               // ASP.NET minimal
];
for (const f of files) {
  if (!SRC_EXT.test(f) || /(^|\/)(tests?|__tests__|spec|e2e)\//.test(f) || /\.(test|spec)\./.test(f)) continue;
  if (f.endsWith('routes.rb') === false && /\.rb$/.test(f)) continue;
  const txt = read(f);
  if (txt.length > 400000) continue;
  for (const [re, mi_, ri] of CODE_ROUTES) {
    if (re.source.includes('path\\(') && !/urls\.py$/.test(f)) continue;
    for (const m of txt.matchAll(re)) {
      const method = mi_ == null ? 'ANY' : (m[mi_] || 'ANY').replace(/['"\s]/g, '').toUpperCase().replace('REQUEST', 'ANY');
      let r = m[ri] ?? '';
      if (!r.startsWith('/')) r = '/' + r;
      const line = txt.slice(0, m.index).split('\n').length;
      add('api', method, r, `${f}:${line}`);
    }
  }
}
const seen = new Set();
const uniqRoutes = routes.filter(r => { const k = `${r.kind} ${r.method} ${r.route}`; if (seen.has(k)) return false; seen.add(k); return true; });

// ---- data/schema, state machines, tests
const schemaFiles = has(/(schema\.prisma|(^|\/)(drizzle|db)\/schema[^/]*\.[jt]s|(^|\/)models?(\.py|\/[^/]+\.(py|rb|php|[jt]s|go|java|cs))|(^|\/)entities\/|(^|\/)migrations?\/|\.sql$|(^|\/)schema\.(rb|graphql|gql)$)/).slice(0, 80);
const stateFiles = files.filter(f => /\.(m?[jt]sx?)$/.test(f) && /createMachine|setup\(\{|useReducer|createSlice/.test(read(f).slice(0, 200000))).slice(0, 40);
const e2eTests = has(/(^|\/)(e2e|tests?|cypress|playwright)\/.*\.(spec|test|cy)\.[jt]sx?$|\.e2e\.[jt]s$/).slice(0, 60);

// ---- existing feature-verify state
const fvDir = path.join(root, '.feature-verify');
const features = [];
if (fs.existsSync(fvDir)) for (const d of fs.readdirSync(fvDir, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const fd = path.join(fvDir, d.name);
  const diagrams = fs.readdirSync(fd).filter(f => f.endsWith('.mmd'));
  let report = null; try { report = JSON.parse(fs.readFileSync(path.join(fd, 'report.json'), 'utf8')); } catch {}
  const st = checkStale(fd);
  const stale = st.state === 'unknown' ? { state: 'unknown' } : { state: st.state, counts: st.counts, outdatedIn: st.outdatedIn, since: st.recordedAt };
  features.push({ feature: d.name, mode: loadMode(fd), hasSpec: fs.existsSync(path.join(fd, 'spec.md')), diagrams, status: report?.status || 'no report', generatedAt: report?.generatedAt || null, stale });
}

let git = { repo: false };
try {
  execSync('git rev-parse --is-inside-work-tree', { cwd: root, stdio: 'ignore' });
  git.repo = true;
  try { execSync('git check-ignore -q .feature-verify', { cwd: root, stdio: 'ignore' }); git.featureVerifyIgnored = true; } catch { git.featureVerifyIgnored = false; }
  git.featureVerifyTracked = execSync('git ls-files .feature-verify', { cwd: root }).toString().trim().length > 0;
} catch {}
// Repos below the root (a folder of several projects, submodules): staleness works per file, in whichever repo holds it.
git.nestedRepos = [];
(function walk(d, depth) {
  if (depth > 3) return;
  let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  if (d !== root && ents.some(e => e.name === '.git')) git.nestedRepos.push(path.relative(root, d));
  for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== 'vendor') walk(path.join(d, e.name), depth + 1);
})(root, 0);

const result = {
  root, filesScanned: files.length, truncated: files.length >= MAX_FILES,
  languages: Object.entries(files.reduce((acc, f) => { const e = path.extname(f).slice(1); if (SRC_EXT.test(f)) acc[e] = (acc[e] || 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8),
  frameworks: [...frameworks], tooling: [...tooling], devScripts,
  routes: { total: uniqRoutes.length, pages: uniqRoutes.filter(r => r.kind === 'page').slice(0, MAX_ROUTES), api: uniqRoutes.filter(r => r.kind === 'api').slice(0, MAX_ROUTES) },
  schemaFiles, stateFiles, e2eTests,
  featureVerify: { exists: fs.existsSync(fvDir), defaultMode: (() => { try { return JSON.parse(fs.readFileSync(path.join(fvDir, 'config.json'), 'utf8')).defaultMode || 'verify'; } catch { return 'verify'; } })(), features },
  git,
};
console.log(JSON.stringify(result, null, 2));
