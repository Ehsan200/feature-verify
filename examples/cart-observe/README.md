# cart-demo — observe-mode example

A tiny shop (products → cart → checkout) looked at in **observe mode**: only what the code does — no spec, nothing judged against expectations.

The project *does* have intent documentation (`docs/SPEC.md` — e.g. "orders over $100 get a 10% discount"), but
`.feature-verify/config.json` sets `{"defaultMode": "observe"}`, so feature-verify ignores it: no intent is gathered,
no intended diagrams are drawn.

## How it is laid out

One **group**, `shop` (`feature.json` → `"group": "shop"`), so the sidebar shows it as one section:

| | what | shows |
|---|---|---|
| `shop-page` | page load; Add and Checkout | links to other features: `%% @drill add-to-cart:` |
| `add-to-cart` | POST /api/cart → `addItem` | a small overview that drills into a deeper flow: `%% @drill add-item` |
| `checkout` | POST /api/checkout | stock subtracted without a floor |
| `_system/shop` | the **system map** | architecture in layers (`cart.js` node → its functions), data model, `cart` and `stock` lifecycles |

Each feature's Architecture / Data / State tab shows the system map with **that feature's parts highlighted** — worked
out from the code refs they share. Two links the code can't show are declared with `%% @feature checkout` in the data model.
Every transition in the lifecycles links (`%% @drill checkout:`) to the feature flow that causes it.

## What reading the code surfaced

The shop **can oversell**: `add-to-cart` checks stock per click, not against what is already in the cart, and
`checkout` subtracts without a floor — the `stock` lifecycle has a `Negative` state. It also keeps one cart for every
visitor and loses all orders on restart.

```
node ../../skills/feature-verify/scripts/dashboard.mjs .feature-verify && open .feature-verify/index.html
```
