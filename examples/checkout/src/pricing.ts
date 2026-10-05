export interface Product { sku: string; name: string; price_cents: number }
export interface LineItem { sku: string; qty: number }

export function priceCart(products: Product[], items: LineItem[]): { total_cents: number; unknown: string[] } {
  let total = 0;
  const unknown: string[] = [];
  for (const item of items) {
    const product = products.find((p) => p.sku === item.sku);
    if (!product) unknown.push(item.sku);
    else total += product.price_cents * item.qty;
  }
  return { total_cents: total, unknown };
}
