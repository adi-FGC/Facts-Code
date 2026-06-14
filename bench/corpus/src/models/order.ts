/**
 * Order model + pricing rules. Totals apply quantity discounts before tax;
 * the rendered amount goes through the shared money formatter so every
 * surface shows the same string.
 */
import { findUser } from './user';
import { money } from '../util/format';

export interface OrderLine {
  sku: string;
  unitCents: number;
  quantity: number;
}

export interface Order {
  id: string;
  userId: string;
  lines: OrderLine[];
}

const orders = new Map<string, Order>();

/** Quantity discount: 5% off a line at 10+ units, 10% off at 50+. */
function lineCents(line: OrderLine): number {
  const raw = line.unitCents * line.quantity;
  if (line.quantity >= 50) return Math.round(raw * 0.9);
  if (line.quantity >= 10) return Math.round(raw * 0.95);
  return raw;
}

export function orderTotal(id: string): number {
  const order = orders.get(id);
  if (!order) return 0;
  return order.lines.reduce((sum, l) => sum + lineCents(l), 0);
}

export function listOrders(): Order[] {
  return [...orders.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function describeOrder(id: string): string {
  const order = orders.get(id);
  if (!order) return 'unknown order';
  const owner = findUser(order.userId);
  return `${order.lines.length} lines · ${money(orderTotal(id))} · ${owner?.displayName ?? 'unknown user'}`;
}
