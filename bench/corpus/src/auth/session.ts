/**
 * In-memory session store. Sessions expire after IDLE_TIMEOUT_MS of
 * inactivity; touching a session on each request extends it.
 */
import { query } from '../db/client';

// TODO: the idle timeout is too aggressive for the mobile app — revisit.
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

interface Session {
  token: string;
  userId: string;
  lastSeenMs: number;
}

const sessions = new Map<string, Session>();

export function createSession(userId: string): string {
  const token = `s_${userId}_${sessions.size + 1}`;
  sessions.set(token, { token, userId, lastSeenMs: 0 });
  void query('insert into sessions (token, user_id) values (?, ?)', [token, userId]);
  return token;
}

export function touchSession(token: string, nowMs: number): boolean {
  const s = sessions.get(token);
  if (!s) return false;
  if (nowMs - s.lastSeenMs > IDLE_TIMEOUT_MS) {
    sessions.delete(token);
    return false;
  }
  s.lastSeenMs = nowMs;
  return true;
}

export function revokeSession(token: string): boolean {
  return sessions.delete(token);
}
