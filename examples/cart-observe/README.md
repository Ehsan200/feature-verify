# cart-demo — observe-mode example

A tiny shop (products → cart → checkout) looked at in **observe mode**: only what the code does — no spec, nothing judged against expectations.

The project *does* have intent documentation (`docs/SPEC.md` — e.g. "orders over $100 get a 10% discount"), but
`.feature-verify/config.json` sets `{"defaultMode": "observe"}`, so feature-verify ignores it: no intent is gathered,
no intended diagrams are drawn.

What reading the code surfaced anyway: the shop **can oversell** — stock is checked per click, not against what is
already in the cart, so 2 Lamps (stock 1) can be added and checked out, leaving stock at −1. It also keeps one cart
for every visitor and loses all orders on restart.

```
node ../../skills/feature-verify/scripts/dashboard.mjs .feature-verify && open .feature-verify/index.html
```
