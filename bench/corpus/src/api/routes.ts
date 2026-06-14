/**
 * HTTP route table. Every endpoint the shop exposes is registered here so
 * there is exactly one place to audit the public surface.
 */
import { login, logout } from '../auth/login';
import { findUser, listUsers } from '../models/user';
import { orderTotal, listOrders } from '../models/order';
import { money } from '../util/format';

export interface Route {
  method: 'GET' | 'POST';
  path: string;
  handler: (params: Record<string, string>) => unknown;
}

export function registerRoutes(): Route[] {
  return [
    { method: 'POST', path: '/auth/login', handler: (p) => login(p['email'] ?? '', p['password'] ?? '') },
    { method: 'POST', path: '/auth/logout', handler: (p) => logout(p['token'] ?? '') },
    { method: 'GET', path: '/users', handler: () => listUsers() },
    { method: 'GET', path: '/users/:id', handler: (p) => findUser(p['id'] ?? '') },
    { method: 'GET', path: '/orders', handler: () => listOrders() },
    {
      method: 'GET',
      path: '/orders/:id/total',
      handler: (p) => money(orderTotal(p['id'] ?? '')),
    },
  ];
}
