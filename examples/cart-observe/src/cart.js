import { products, cart, orders } from './store.js';

export function addItem(productId, qty) {
  const product = products.find(p => p.id === productId);
  if (!product) return { status: 404, body: { error: 'no-such-product' } };
  if (!Number.isInteger(qty) || qty < 1) return { status: 400, body: { error: 'bad-qty' } };
  if (product.stock < qty) return { status: 409, body: { error: 'out-of-stock' } };
  const line = cart.items.find(i => i.productId === productId);
  if (line) line.qty += qty; else cart.items.push({ productId, qty });
  return { status: 200, body: cartView() };
}

export function cartView() {
  const lines = cart.items.map(i => ({ ...i, price: products.find(p => p.id === i.productId).price }));
  return { lines, total: lines.reduce((s, l) => s + l.price * l.qty, 0) };
}

export function checkout() {
  if (!cart.items.length) return { status: 409, body: { error: 'empty-cart' } };
  const { total } = cartView();
  for (const i of cart.items) products.find(p => p.id === i.productId).stock -= i.qty;
  const order = { id: orders.length + 1, total, items: cart.items.splice(0) };
  orders.push(order);
  return { status: 201, body: { orderId: order.id, total } };
}
