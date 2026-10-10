---
name: feature-verify
description: Understand and verify AI-built features visually, in any web project/stack — by reading the code, not by running or testing it. Discovers what exists, asks which mode, then produces per-feature Mermaid diagrams (sequence, architecture, data model, state) — intended (sourced from the user's own prompts, docs, issues or an interview) and code-derived (every element carries a checked file:line ref) — plus a glossary of non-obvious terms and the feature's risks, validates syntax, checks them mechanically, and renders a local HTML dashboard. Use when the user says "verify feature", "diagram this feature", "feature-verify", or wants to check that what was built matches what was intended. Also use in plan-first mode before building a new feature, and in observe mode when the user only wants to see what the code does ("just show me what it does", "no spec", "as-built") — intent is then skipped and ignored.
---

# Feature Verify

Goal: a human understands — and, if they want, verifies — a feature by looking at diagrams, without trusting the AI that wrote the code.
Every element of every diagram must be traceable: intended → a source of intent, code → a line of code.

**This is not a testing tool.** Nothing is run, clicked or recorded. Everything comes from reading the code (and, in verify mode, from the user's intent). The code may behave differently at runtime than it reads; say so plainly when it matters (e.g. config-driven behavior → `UNCERTAIN`), but don't try to execute anything.

## Modes (per feature)

| mode | question it answers | diagrams | compared |
|---|---|---|---|
| `verify` | "Did it build what I wanted?" | intended + code | intended vs code |
| `observe` | "Show me what it does." | code only | — |
| `plan-first` | "Plan it before it's built." | intended first; code after it's built | as verify |

**Observe mode** is for when the user only wants to see what the code does — no spec, no intent, no judgement against expectations:
- Skip steps 1–2 entirely. Do not gather intent, do not run `intent.mjs`, do not interview, do not write `intent.json`, `spec.md` or `intended.*.mmd`.
- Existing intended files and `intent.json` are **ignored** (left on disk untouched; scripts and dashboard skip them).
- Record the mode in `.feature-verify/<feature>/feature.json` → `{"mode": "observe"}`. Every script reads it.
- Findings are notes about what the code does (a counter written but never read, an error path that leaks details). Never phrase them as "should" — there is no intent to compare against.
- Status is `observed` (all diagrams parse, every ref resolves) or `incomplete`.

Never pick the mode yourself: the user chooses it in step 0 (or already chose it — in the request, `feature.json`, or the project default in `.feature-verify/config.json` → `{"defaultMode": "observe"}`). Phrases like "just show me what it does", "what does X actually do", "no spec", "ignore intent", "as-built" count as choosing observe.

## Scripts

They live in the `scripts/` folder next to this SKILL.md — call it `$FV`. Resolve it from this skill's base directory (Claude Code states it when the skill loads; other agents: the directory this file was read from). It differs per install (plugin cache, `~/.claude/skills/feature-verify`, `~/.codex/skills/feature-verify`, a repo checkout); never assume one path. If unsure:
`ls -d ~/.claude/plugins/cache/*/feature-verify/*/skills/feature-verify/scripts ~/.claude/skills/feature-verify/scripts ~/.codex/skills/feature-verify/scripts 2>/dev/null | head -1`

Plain Node ≥ 18, no dependencies. `validate.mjs` installs `mermaid` into `~/.cache/feature-verify/` on first use (one-time network). Run every command from the target project's root.

| script | does |
|---|---|
| `discover.mjs .` | stack, routes/pages/endpoints, schema files, tooling, existing features |
| `intent.mjs . --grep a,b` | the user's past Claude Code + Codex prompts in this project |
| `check-refs.mjs <code.*.mmd>` | every code ref resolves; every element has one |
| `validate.mjs <dir or .mmd>` | real Mermaid parse of every diagram + readability lint |
| `compare.mjs <feature-dir>` | all mechanical checks as JSON |
| `dashboard.mjs .feature-verify` | build the dashboard (refuses if any diagram fails to parse) |
| `stale.mjs record <feature-dir>` | snapshot the code every ref points at → `basis.json` (git; each file in its own repo) |
| `stale.mjs .feature-verify` | has the code changed since? per ref: fresh · moved (new line) · changed · gone |
| `split.mjs .feature-verify/<from> <to> <flow>… [--overview <flow>] [--group g]` | move flows into another feature; re-points every `@drill` |

## Commands

- `feature-verify` — discover, list features, ask the mode, propose, wait.
- `feature-verify <feature>` — full flow for one feature (starts at step 0).
- `feature-verify observe <feature>` — observe mode: code only, intent ignored (steps 0, 3–6).
- `feature-verify <feature> <step>` — `intent | intended | code | glossary | check | verdict | dashboard`.
- `feature-verify dashboard` — rebuild the dashboard only.

## Output layout (target project)

```
.feature-verify/
  config.json                        optional: {"defaultMode": "observe", "editor": "cursor"}
  index.html                         dashboard (generated)
  _system/<group>/                   the system map of a group ("main" for features without one) — see "System map"
    code.architecture.mmd            top level: modules/services/stores/externals (≤ 15 nodes)
    code.architecture.<module>.mmd   inside one module (a top-level node with %% @drill <module> opens it)
    code.data.mmd                    entities + relations (code.data.<area>.mmd if it gets big)
    code.state.<entity>.mmd          lifecycle of one main record (ai-report, booking, payment…)
    basis.json, glossary.json        as for features
  <feature>/
    feature.json                     {"mode": "observe", "group": "neo"} — mode (absent = project default / verify); group = sidebar section
    spec.md                          requirements + acceptance criteria (verify)
    intent.json                      sources of intent + assumptions (verify)
    intended.<type>.mmd              from intent sources only — never from code (verify)
    code.<type>.mmd                  from code; every element has an @ref
    <kind>.sequence.<flow>.mmd       one small flow (e.g. code.sequence.add-to-cart.mmd); the plain file is the overview
    basis.json                       snapshot of the referenced code (stale.mjs record) — what "changed since" compares against
    glossary.json                    plain-language meanings of non-obvious terms
    compare.json                     mechanical check output
    report.json                      verdict, findings, risks
```

`<type>` ∈ `sequence | architecture | data | state`. `<feature>` and `<flow>` are kebab-case. Committing `.feature-verify/` is the user's choice (asked in step 0).

## Provenance comments (all diagram files)

Put provenance on a Mermaid comment line **directly after** the element it belongs to (data diagrams: on the line above the entity). Never inside labels — `:`/`#`/`[` inside labels break several diagram grammars.

```
  API->>Auth: verify(email, password)
  %% @ref src/api/auth.ts:18#verifyCredentials        ← code diagrams: file:line#symbol
  API-->>UI: 423 locked
  %% @src S3                                          ← intended diagrams: source id(s) from intent.json
  API-->>UI: 400 missing fields
  %% @assumed A1                                      ← intended diagrams: declared assumption
```

- `#symbol` must literally appear within ±3 lines of the line (function, route string, table, column, enum value).
- Elements that need provenance: sequence messages, state transitions (except from/to `[*]`), architecture nodes, data entities (relationships are exempt). Structure lines (`participant`, `alt`, `end`, `box`, `subgraph`…) don't.
- **Drill-down** (sequence): put `%% @drill <flow>` on its own comment line after a message (next to its `@ref`) to link it to `<kind>.sequence.<flow>.mmd`. `%% @drill <feature>:<flow>` links to another feature's flow, `%% @drill <feature>:` to its overview — use it for shared steps (payment, login) instead of drawing them twice. In the dashboard that step shows ⤵ and opens on click; the sidebar shows the flows as a tree; a breadcrumb leads back. Every target must exist (`compare.mjs` checks).
- HTTP calls are written `METHOD /path` in labels (`POST /api/login`); reply labels start with the status code (`401 unauthorized`). Both are matched between intended and code.

## Diagram style guide (diagrams must read well, not just parse)

- **Sequence — small diagrams, many of them.** A reader must take one in at a glance: **≤ 10 messages and ≤ 5 participants each** (`validate.mjs` warns above that). Split a feature into:
  - an **overview** (`code.sequence.mmd`): only the user's actions and the requests that leave the client — one message per user action, each with `%% @drill <flow>`;
  - one **flow** per user action / endpoint (`code.sequence.<flow>.mmd`, e.g. `add-to-cart`, `checkout`), from the request to the reply, with its branches. Still too big → move a step's internals into a deeper flow and `@drill` to it (e.g. `cart-add-item`).
  The same split applies to intended diagrams (`intended.sequence.<flow>.mmd`, same flow names, so Compare pairs them). Name flows after what the user does, not after functions.
- **Sequence style**: Group with `box Client … end`, `box Server … end`, `box Data … end`, `box External … end`. Name participants by role (`Login page`, `Auth service`, `Postgres`), alias long names. One action per message, ≤ 50 chars. `alt`/`else` for every branch with the condition in words (`alt account locked (5 failures)`), `opt` for optional steps, `Note over X:` only for notable facts or UNCERTAIN.
- **Architecture**: `flowchart LR`, ≤ 15 nodes, `subgraph` per layer. Shapes carry meaning, and add the class: UI `id(["Login page"]):::ui`, service `id["Auth service"]:::svc`, store `id[("Postgres users")]:::store`, external `id{{"Stripe"}}:::ext`. Label edges with the protocol/endpoint (`-->|POST /api/login|`). Mark doubt `:::assumed`, a missing intended part `:::gap`.
- **Data**: `erDiagram`, only entities/fields the feature reads or writes; mark written fields in the attribute comment (`string status "written"`). Real column names.
- **State**: `stateDiagram-v2`, default top-down direction (no `direction LR` — self-loops render badly). States are nouns (`Locked`), transitions are events (`5th failed attempt`).
- Quote labels containing `( ) [ ] { } : ;` in flowcharts (`id["auth.js (node:http)"]`). Avoid `;` and `#` in sequence labels.
- The dashboard supplies colors and classes; do not add `style`/`classDef` lines.

## What is one feature

**One feature = one user goal** that someone could describe in a sentence: "sign in with phone", "book a session", "buy an AI report", "pay". Not a product area, not the whole app. Guide: **≤ 8 sequence flows** per feature; `compare.mjs` warns above 12 (`size.warn`).
- A request covering several goals ("the neo funnel", "ai report and booking") → propose one feature per goal, all with the same `"group"` in `feature.json` so the sidebar keeps them together (e.g. group `neo`: `phone-login`, `browse-offers`, `booking`, `ai-report`, `payments`).
- Steps several features share (payment, login, notifications) → their own feature; the others link with `@drill payments:verify-transaction`.
- An existing feature that is too big → propose the split, then move flows with `node $FV/split.mjs .feature-verify/<big> <new> <flow>… --overview <flow> --group <g>` (`--dry-run` first). It moves the diagrams and re-points every `@drill`; then move the glossary terms and risks that belong to the new feature and redo steps 5–6 + `stale.mjs record` for both.

## System map (per group)

Features are stories (sequences). To understand the **system** they run through, each group has one system map in `.feature-verify/_system/<group>/` — architecture, data and state drawn **once**, not per feature. The dashboard shows it as "System map" at the top of the group, and every feature's Architecture / Data / State tab shows the system map with **that feature's parts highlighted** and the rest dimmed. A feature draws its own architecture/data/state only when it needs more detail than the map (then both are shown).

- **Architecture, layered**: `code.architecture.mmd` holds the modules (≤ 15 nodes); a module node with `%% @drill <module>` opens `code.architecture.<module>.mmd` with its inner parts. Same style rules as feature architecture.
- **Data**: entities and relations of the whole group; real names.
- **State**: one `code.state.<entity>.mmd` per main record. Put `%% @drill <feature>:<flow>` on a transition to say which feature flow causes it — the label becomes a link, and the lifecycle shows how features connect over time.
- Every element has an `@ref` like any code diagram. Which features use an element is **computed** (same file for architecture; ref within ±3 lines or a drill for state; entity name or nearby ref for data). Add `%% @feature a, b` only where the code can't show it (e.g. a queue consumer).
- Check it like a feature: `compare.mjs .feature-verify/_system/<group>`, `stale.mjs record .feature-verify/_system/<group>`.
- When: draw it when a group has ≥ 2 features or the user wants to understand the system; update it when a feature adds a module, entity or state. An umbrella feature that holds whole-group architecture/data/state (e.g. from before a split) → move those files to `_system/<group>/`.

## Step 0 — Discover, ask the mode, propose (always first)

1. `node $FV/discover.mjs .` and skim the repo structure to fill gaps (monorepos, custom routing, `git.nestedRepos`). Note `featureVerify.defaultMode`, each feature's `mode` and its `stale.state` — `outdated` means code its diagrams point at was edited since they were made (`stale.outdatedIn` lists which diagrams); offer to refresh those first (see Re-runs).
2. Look for intent that exists (don't read it deeply yet): `node $FV/intent.mjs . --limit 50` (count of the user's own prompts), README/docs/specs, issues. Only to tell the user what is available.
3. **Ask the user which mode — always, unless already decided.** It is decided only if (a) the user named it in this request (`observe`, "just show me what it does", "check it against the spec"…), or (b) the feature's `feature.json` or the project's `.feature-verify/config.json` sets it. Otherwise ask, even when intent docs exist — having a spec does not mean the user wants to be judged against it. Use the agent's question tool if it has one (Claude Code: AskUserQuestion), else ask in plain text and wait. Ask it like this, with one concrete example per option drawn from *this* project's feature:

   > How should I look at **<feature>**?
   > - **Observe** — show what the code does, step by step, with its risks. No spec involved.
   >   *Example: "Checkout posts to /api/checkout, subtracts stock and returns 201. Stock is checked per click, not against the cart — it can oversell."* (feature-verify repo: `examples/cart-observe`)
   > - **Verify against intent** — also draw what it *should* do, from <the sources you found: N prompts / docs/SPEC.md / issues / an interview>, and flag every difference.
   >   *Example: "Spec says lock the account after 5 failed logins (your prompt, 14 Sep). The code never returns 423 — mismatch."* (feature-verify repo: `examples/login-demo`)
   > - **Plan first** — the feature isn't built yet; draw the intended design for you to check before building.

   If intent docs exist but the user picks Observe, that is final: do not read them for this feature. Also offer to remember the choice: for this feature (`feature.json`) or as the project default (`.feature-verify/config.json` → `{"defaultMode": "observe"}`).
4. Report briefly, then propose:
   - **What exists**: stack; user-facing features (group endpoints/pages); which already have diagrams, their mode, status, and whether their code changed since.
   - **Plan**: feature(s) — split by user goal (see "What is one feature"), with their group — the chosen mode, diagram types, and the group's system map (`featureVerify.systems` from discover: missing or stale?). Existing features over the size guide: propose a split.
   - **Commit or not**: if `.feature-verify/` is neither ignored nor tracked, ask: `.gitignore`, `.git/info/exclude`, or commit.
5. **Stop. Wait for confirmation.** Write nothing before it (except `feature.json`/`config.json` if the user asked to remember the mode).

## Step 1 — Gather intent (never from the code) — verify / plan-first only

Intent must be independent of the implementation. Reading the code to decide what was intended makes every bug pass. Collect sources in this order and stop when the feature is covered:

1. **The user's prompts** — `node $FV/intent.mjs . --grep <feature words>`. What the user asked an AI to build is the spec. Cite with `kind: "prompt"`, `file` + `line` from the output, and a short verbatim `quote`.
2. **Docs** — README, `docs/`, specs, ADRs, CLAUDE.md/AGENTS.md. `kind: "doc"`, file + line + quote.
3. **Issues / PRs** — `gh issue view`, `gh pr view` when available. `kind: "issue"`, `where: "#12"`, quote.
4. **Tests written by a human** — `kind: "test"`, file + line + quote. Weak if an AI wrote them; say so.
5. **Interview** — for gaps, ask the user a few short, concrete questions (happy path, each error, limits, who may do it, what is stored). Batch them in one message. `kind: "interview"`, `where: "user, <date>"`, quote their answer.

Anything still unknown becomes an **assumption** — never silently filled in. Write `intent.json`:
```json
{
  "sources": [
    {"id": "S1", "kind": "prompt", "tool": "claude", "file": "~/.claude/projects/…/abc.jsonl", "line": 42, "time": "2026-09-14T10:02:00Z", "quote": "lock the account after 5 tries"},
    {"id": "S2", "kind": "doc", "file": "README.md", "line": 31, "quote": "Users sign in with email and password"},
    {"id": "S3", "kind": "interview", "where": "user, 2026-10-10", "quote": "Wrong password shows a generic error"}
  ],
  "assumptions": [
    {"id": "A1", "text": "Missing email or password returns 400."}
  ]
}
```
Quotes are verified mechanically against the cited file/line — copy them exactly. Then write or update `spec.md` from the sources (goal, actors, happy path, errors, acceptance criteria), and show the user the assumptions list. When the user answers one in chat, turn the answer into an `interview` source, re-point the diagram elements from `@assumed A#` to `@src S#`, and drop the assumption.

## Step 2 — Intended diagrams — verify / plan-first only

Write `intended.<type>.mmd` from `intent.json` + `spec.md` only — do not open source code. Every element gets `%% @src S…` or `%% @assumed A…`. Follow the style guide. Run `node $FV/validate.mjs .feature-verify/<feature>` and fix every error.

In plan-first mode, stop here: the user looks at the dashboard (Intent tab + diagrams) and tells you what to change; once they're happy, the diagrams become the build plan.

## Step 3 — Code-derived diagrams

Trace the feature through the actual code: entry (page/route/component) → handlers → services → stores → external APIs → back to UI. Derive from code; don't copy the intended diagrams. Write the sequence as an overview plus small flows linked with `@drill` (style guide).
- Include every branch the code really has: validation, catch blocks, retries, early returns, auth guards. Branches in code but not in intent are exactly what the human must see.
- Unknown from static reading (dynamic dispatch, config-driven) → `Note over X: UNCERTAIN — reason` or a node `id["UNCERTAIN: …"]:::assumed`. Never guess.

```
node $FV/check-refs.mjs .feature-verify/<feature>/code.*.mmd
node $FV/validate.mjs .feature-verify/<feature>
```
Fix every failure before continuing.

## Step 4 — Glossary

People reading the diagrams may not know what the code's words mean (`qty`, `cartView`, `failed++`, `bad-qty`). Write `.feature-verify/<feature>/glossary.json`:
```json
{ "terms": [
  { "term": "qty", "aka": ["quantity"], "kind": "field", "meaning": "How many units are being added. The page always sends 1.", "ref": "src/cart.js:6#qty" }
] }
```
- **Only non-obvious terms.** Include: abbreviations, invented or unclear names (functions, fields, modules, error codes, states), and ordinary words that mean something specific *here* (e.g. `stock` that can go negative, a cart shared by everyone). **Skip** things any developer or product person knows: auth, login, password, token, email, user, session, cart, order, checkout, API, endpoint, server, database, HTTP methods, common status codes (200, 201, 404, 500 — the dashboard explains the uncommon ones itself). When unsure whether a reader would know it, leave it out. Typically 3–12 terms per feature.
- `meaning`: 1–2 plain sentences, no jargon, describing what it is/does **in this codebase** (including surprising behavior). Not a dictionary definition.
- `ref`: where it's defined or decided, `path:line#symbol` (checked like code refs). Omit only for words that don't exist in code (verify mode, from intent).
- `kind`: field | function | module | data | error | state | concept. `aka`: other spellings used in the diagrams.

The dashboard turns these into a Concepts tab, chips under each diagram, and tooltips in the element tables.

## Step 5 — Mechanical check and verdict

```
node $FV/compare.mjs .feature-verify/<feature> > .feature-verify/<feature>/compare.json
```
Checks: syntax (real Mermaid parser), code refs, glossary (every term has a meaning, refs resolve) and — in verify mode — intent provenance (every intended element sourced or assumed, quotes verified; open assumptions listed) and HTTP endpoints / status codes between intended and code. Observe mode skips intent and intended diagrams.

Then compare semantically on top of the mechanical output, per type: call order, branches, auth checks, entities/fields written, states and transitions, components touched. Write `report.json`:

```json
{
  "feature": "login",
  "mode": "verify | observe",
  "status": "verified | partial | mismatch | unverified  (observe: observed | incomplete)",
  "summary": "one or two sentences a busy reader can act on",
  "findings": [
    {"severity": "high|medium|low", "type": "sequence|architecture|data|state", "where": "intended vs code",
     "text": "Spec: lock account after 5 failed attempts. Code has no lockout branch.", "ref": "src/services/auth.ts:40"}
  ],
  "risks": [
    {"impact": "high|medium|low", "category": "security", "type": "sequence",
     "text": "Session token is \"tok-\" + user id, so anyone can forge one.", "ref": "src/services/auth.ts:10#tok-"}
  ],
  "skipped": {"state": "no lifecycle beyond signed-in/out"},
  "mechanical": {},
  "generatedAt": "ISO-8601"
}
```
`findings` vs `risks` — keep them apart:
- **findings** (dashboard: "Differences" in verify, "Notes" in observe): where intended and code disagree; in observe mode, notable facts about what the code does.
- **risks**: what could hurt users or the business, judging from the code — *even if intended and code agree*. One pass over what you already traced. Look for: security (auth bypass, forgeable tokens, injection, missing permission checks, secrets), money / stock (double charge, oversell, wrong totals), data loss or integrity (in-memory state, missing transactions, races, partial writes), privacy (data leaks, enumeration, shared state between users), failure handling (unhandled errors, no retries/timeouts on external calls). Rules: specific to this feature, one concrete sentence on what goes wrong and for whom; `ref` required (`path:line#symbol`); `impact` = harm if it happens. No generic advice ("add tests", "use HTTPS", "consider rate limiting" without a concrete failure). Nothing found → `"risks": []` — don't pad. Don't duplicate a risk as a finding.

When compare passes, snapshot the code the feature points at — this is what later runs compare against to tell the user "code changed since":
```
node $FV/stale.mjs record .feature-verify/<feature>
```
It needs git (each referenced file is stored as a blob in whichever repo holds it — nested repos and submodules are fine). Files outside any repo are tracked by hash only (whole-file change, no line detail); not in git at all → say staleness is limited.

`mechanical` = the compare.json content. `type` must be set (the dashboard links each item to its diagram).
Verify mode: `verified` only if compare passes, no open assumptions, no high/medium findings; open assumptions → `partial`; real differences → `mismatch`. Do not soften findings.
Observe mode: `observed` if compare passes, else `incomplete`. The summary says plainly what the feature does, step by step.

## Step 6 — Dashboard

`node $FV/dashboard.mjs .feature-verify` → `.feature-verify/index.html`. It refuses to build while any diagram fails to parse — fix, don't `--force`. Tell the user the path (`open .feature-verify/index.html` on macOS) and one line per feature: status + top risk + top difference + open assumptions (+ "code changed since" if stale).

## Re-runs

Start with `node $FV/stale.mjs .feature-verify/<feature>`:
- `fresh` — nothing to redo.
- `shifted` — only line numbers moved: update each `moved` ref to its `newLine` (same code), re-run checks, re-record.
- `outdated` — re-read the code behind every `changed`/`gone` ref and redo only the diagrams in `outdatedIn` (plus glossary terms / risks that point there), then steps 5–6 and `stale.mjs record`. Code the feature never referenced isn't tracked; when the change looks larger than the refs, re-trace the whole flow.

Intent changes only with the user (new prompts, docs, or answers).
