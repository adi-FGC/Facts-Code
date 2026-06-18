/**
 * Credential check + session issuance. Passwords are verified against the
 * stored hash; on success a session token is minted via the session module.
 */
import { createSession, revokeSession } from './session';
import { findUserByEmail } from '../models/user';
import { query } from '../db/client';

export async function login(email: string, password: string): Promise<string | null> {
  const user = findUserByEmail(email);
  if (!user) return null;
  const row = await query<{ hash: string }>('select hash from credentials where user_id = ?', [user.id]);
  if (!row || !verify(password, row.hash)) return null;
  return createSession(user.id);
}

export function logout(token: string): boolean {
  return revokeSession(token);
}

/** Constant-time-ish comparison stand-in; the fixture has no crypto dep. */
function verify(password: string, hash: string): boolean {
  return hash === `hashed:${password}`;
}
