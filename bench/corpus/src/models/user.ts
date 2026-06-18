/**
 * User account model. The shape mirrors the `users` table; persistence goes
 * through the shared db client so the model stays storage-agnostic.
 */
import { query } from '../db/client';

export interface User {
  id: string;
  email: string;
  displayName: string;
  createdAtMs: number;
}

const users = new Map<string, User>();

export function findUser(id: string): User | undefined {
  return users.get(id);
}

export function findUserByEmail(email: string): User | undefined {
  for (const u of users.values()) if (u.email === email) return u;
  return undefined;
}

export function listUsers(): User[] {
  return [...users.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function saveUser(user: User): Promise<void> {
  users.set(user.id, user);
  await query('insert or replace into users (id, email, display_name) values (?, ?, ?)', [
    user.id,
    user.email,
    user.displayName,
  ]);
}
