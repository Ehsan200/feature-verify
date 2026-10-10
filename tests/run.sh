#!/usr/bin/env bash
# Smoke tests: run every script against the examples and assert the known outcomes.
# login-demo (verify): its spec requires an account lockout the code doesn't have.
# cart-observe (observe): project default mode ignores docs/SPEC.md.
set -u  # no pipefail: several checks pipe a deliberately failing command into a matcher
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FV="$ROOT/skills/feature-verify/scripts"
EX="$ROOT/examples/login-demo"
F=".feature-verify/login"
fail=0
ok()  { echo "ok   - $1"; }
bad() { echo "FAIL - $1"; fail=1; }
q()   { "$@" 2>/dev/null; }
json() { node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8'));process.exit(($1)?0:1)"; }
cd "$EX"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
cp -R .feature-verify "$tmp/fv-backup"
restore() { rm -rf .feature-verify && cp -R "$tmp/fv-backup" .feature-verify; }

# discovery & intent harvest
q node "$FV/discover.mjs" . | json 'r.featureVerify.exists && r.featureVerify.features.length===1' && ok "discover finds the example feature" || bad "discover"
q node "$FV/intent.mjs" . | json 'Array.isArray(r.prompts) && r.sessionsScanned' && ok "intent harvest runs" || bad "intent.mjs"

# code refs
q node "$FV/check-refs.mjs" $F/code.*.mmd >/dev/null && ok "example code refs all resolve" || bad "check-refs on example"
printf 'sequenceDiagram\n  A->>B: call\n  %%%% @ref src/server.js:999#nope\n  A->>B: no ref here\n' > "$tmp/code.sequence.mmd"
out=$(q node "$FV/check-refs.mjs" "$tmp/code.sequence.mmd"); code=$?
[ $code -eq 1 ] && echo "$out" | grep -q "out of range" && echo "$out" | grep -q "MISSING-REF" && ok "check-refs catches broken + missing refs" || bad "check-refs negative case"

# syntax validation (real mermaid parser)
q node "$FV/validate.mjs" .feature-verify >/dev/null && ok "all example diagrams parse" || bad "validate example"
printf 'stateDiagram-v2\n  A --> B : go [src/a.ts:1#x]\n' > "$tmp/code.state.mmd"
q node "$FV/validate.mjs" "$tmp/code.state.mmd" | grep -q "^ERROR" && ok "validate catches a syntax error" || bad "validate negative case"
printf 'flowchart LR\n  a(["UI"]):::ui --> b[("db")]:::store\n' > "$tmp/x.architecture.mmd"
q node "$FV/validate.mjs" "$tmp/x.architecture.mmd" >/dev/null && ok "validate parses flowcharts in Node" || bad "validate flowchart"

# mechanical compare (verify mode)
q node "$FV/compare.mjs" $F > "$tmp/cmp.json"; code=$?
[ $code -eq 1 ] && json 'r.statuses.intendedMissingInCode.includes(423)' < "$tmp/cmp.json" && ok "compare flags missing 423 lockout" || bad "compare should flag 423"
json 'r.intent.assumptions.length===1 && r.intent.unsourced.length===0 && r.intent.badSources.length===0 && r.intent.ok' < "$tmp/cmp.json" && ok "intent: all sourced, quotes verified, A1 listed" || bad "intent check"

# glossary: refs resolve; a fabricated ref is caught
json 'r.glossary.hasGlossary && r.glossary.ok && r.glossary.terms>0' < "$tmp/cmp.json" && ok "glossary refs resolve" || bad "glossary check"
node -e "const f='$F/glossary.json',j=JSON.parse(require('fs').readFileSync(f));j.terms[0].ref='src/server.js:2#doesNotExist';require('fs').writeFileSync(f,JSON.stringify(j))"
q node "$FV/compare.mjs" $F | json '!r.glossary.ok && r.glossary.failed.length===1' && ok "glossary catches a fabricated ref" || bad "glossary negative"
restore

# tampered quote is caught
node -e "const f='$F/intent.json',j=JSON.parse(require('fs').readFileSync(f));j.sources[0].quote='something never written';require('fs').writeFileSync(f,JSON.stringify(j))"
q node "$FV/compare.mjs" $F | json 'r.intent.badSources.some(b=>b.id==="S1")' && ok "intent catches a fabricated quote" || bad "fabricated quote"
restore

# observe mode: intended diagrams + intent ignored, code only
echo '{ "mode": "observe" }' > $F/feature.json
printf 'sequenceDiagram\n  A->>B: broken; on purpose\n' > $F/intended.data.mmd
q node "$FV/compare.mjs" $F > "$tmp/obs.json"; code=$?
[ $code -eq 0 ] && json 'r.mode==="observe" && r.intent===null && r.endpoints===null && r.coverage.sequence.intended.length===0' < "$tmp/obs.json" \
  && ok "observe mode ignores intent and intended diagrams" || bad "observe compare"
q node "$FV/dashboard.mjs" .feature-verify >/dev/null && grep -q '"mode":"observe"' .feature-verify/index.html && ok "observe dashboard builds despite a broken intended diagram" || bad "observe dashboard"
restore

# dashboard
q node "$FV/dashboard.mjs" .feature-verify >/dev/null && grep -q 'mermaid@11' .feature-verify/index.html && ok "dashboard builds" || bad "dashboard"
grep -q '"risks":\[' .feature-verify/index.html && ok "dashboard carries risks" || bad "risks in dashboard"
printf 'sequenceDiagram\n  A->>B: x; y\n' > $F/code.data.mmd
q node "$FV/dashboard.mjs" .feature-verify >/dev/null; [ $? -eq 1 ] && ok "dashboard refuses invalid diagrams" || bad "dashboard syntax gate"
restore

# observe example: project default mode ignores docs/SPEC.md
cd "$ROOT/examples/cart-observe"
q node "$FV/discover.mjs" . | json 'r.featureVerify.defaultMode==="observe" && r.featureVerify.features[0].mode==="observe"' && ok "cart: project default mode is observe" || bad "cart default mode"
q node "$FV/compare.mjs" .feature-verify/checkout > "$tmp/cart.json"; code=$?
[ $code -eq 0 ] && json 'r.mode==="observe" && r.refs.ok && r.glossary.ok' < "$tmp/cart.json" && ok "cart: code diagrams + glossary check out" || bad "cart compare"
q node "$FV/dashboard.mjs" .feature-verify >/dev/null && ok "cart: dashboard builds" || bad "cart dashboard"

exit $fail
