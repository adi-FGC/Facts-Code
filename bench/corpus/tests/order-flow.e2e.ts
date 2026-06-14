/**
 * End-to-end order flow exercise. Runner invokes this by glob — nothing in
 * src/ imports it, but a naive path-grep for "order" reads it in full.
 */
import { registerRoutes } from '../src/api/routes';

export async function runOrderFlowE2e(): Promise<string[]> {
  const failures: string[] = [];
  const routes = registerRoutes();

  const listOrders = routes.find((r) => r.path === '/orders');
  if (!listOrders) failures.push('GET /orders route missing from the table');

  const orderTotal = routes.find((r) => r.path === '/orders/:id/total');
  if (!orderTotal) failures.push('GET /orders/:id/total route missing from the table');
  if (orderTotal && orderTotal.method !== 'GET') failures.push('order total must be a GET');

  // An unknown order renders as zero money, never a crash.
  const rendered = orderTotal?.handler({ id: 'nope' });
  if (typeof rendered !== 'string' || !String(rendered).includes('0.00')) {
    failures.push('unknown order should render 0.00 via the shared money formatter');
  }
  return failures;
}
