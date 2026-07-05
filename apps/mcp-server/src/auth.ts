/**
 * FACTS MCP auth — one-time Google sign-in, so each user's MCP data
 * (learnings, usage) is stored PRIVATELY per-identity in Firebase Firestore.
 *
 * Why this shape: this environment can't install the `firebase` SDK (broken
 * pnpm workspace), so we avoid it entirely. The browser does the Google
 * sign-in on a hosted page (`/mcp-auth.html` on the deployed site, which
 * reuses the project's already-enabled Google provider) and hands the
 * Firebase ID token back to THIS process over a `localhost` loopback. From
 * there we talk to Firestore + the token-refresh endpoint over plain HTTPS.
 *
 * The Firebase Web config (apiKey/projectId) is NOT hardcoded here — it's fetched
 * at runtime from the deployed auth origin (`/mcp-auth-config.json`), so it stays
 * out of this repo. Firebase web keys identify the project, they don't authorize;
 * security is enforced by Firestore rules (each user may read/write only their
 * own `users/{uid}` subtree), not by hiding the key.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/** Hosted page that runs the Google popup + POSTs the ID token to the loopback. */
const AUTH_PAGE = process.env.FACTS_AUTH_URL || 'https://factstack-demo.netlify.app/mcp-auth.html';

/**
 * Fetch the PUBLIC Firebase web config (apiKey + projectId) from the deployed
 * auth origin — the same `/mcp-auth-config.json` the sign-in page reads, built
 * from the owner's local (gitignored) fb.mjs. Kept out of this repo; a fresh
 * clone needs no local config because it reads it from the live site. Cached
 * after the first successful fetch. Null on failure → callers fail closed.
 */
let _fbConfig: { apiKey: string; projectId: string } | null = null;
async function getFbConfig(): Promise<{ apiKey: string; projectId: string } | null> {
  if (_fbConfig) return _fbConfig;
  try {
    const origin = new URL(AUTH_PAGE).origin;
    const res = await fetch(`${origin}/mcp-auth-config.json`);
    if (!res.ok) return null;
    const j = (await res.json()) as { apiKey?: string; projectId?: string };
    if (!j.apiKey || !j.projectId) return null;
    _fbConfig = { apiKey: j.apiKey, projectId: j.projectId };
    return _fbConfig;
  } catch {
    return null;
  }
}

const AUTH_DIR = join(homedir(), '.factstack');
const AUTH_FILE = join(AUTH_DIR, 'auth.json');

export interface Session {
  uid: string;
  email: string | null;
  idToken: string;
  refreshToken: string;
  /** epoch ms when idToken expires. */
  expiresAt: number;
}

export function loadSession(): Session | null {
  try {
    if (!existsSync(AUTH_FILE)) return null;
    return JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as Session;
  } catch {
    return null;
  }
}

function saveSession(s: Session): void {
  mkdirSync(AUTH_DIR, { recursive: true });
  // 0o600: token file readable only by the owner.
  writeFileSync(AUTH_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
}

/**
 * Return a session with a fresh ID token, refreshing via the Secure Token REST
 * endpoint when the current one is near expiry. Null when not signed in / the
 * refresh token is dead (the caller should then prompt `login`).
 */
export async function validSession(): Promise<Session | null> {
  const s = loadSession();
  if (!s) return null;
  if (Date.now() < s.expiresAt - 60_000) return s; // still fresh (60s skew)
  const cfg = await getFbConfig();
  if (!cfg) return null; // can't refresh the token without the web config
  try {
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${cfg.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(s.refreshToken)}`,
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { id_token: string; refresh_token?: string; expires_in: string };
    const next: Session = {
      ...s,
      idToken: j.id_token,
      refreshToken: j.refresh_token || s.refreshToken,
      expiresAt: Date.now() + Number(j.expires_in) * 1000,
    };
    saveSession(next);
    return next;
  } catch {
    return null;
  }
}

/** The MCP tool result returned when the caller isn't signed in. */
export function authRequiredResult(): { isError: true; content: { type: 'text'; text: string }[] } {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text:
          'FACTS MCP needs a one-time Google sign-in so your analysis + learnings are stored ' +
          'privately to your account (no one else can read them).\n\n' +
          'Authenticate (opens your browser):\n\n' +
          '    npx -y @factstack/mcp-server login\n\n' +
          'Then retry. Your data lives per-account in Firebase (Firestore); this is the only ' +
          'thing gated — the public FACTS site + CLI stay open.',
      },
    ],
  };
}

/** Loopback Google sign-in: open the hosted page, receive the Firebase ID token.
 *
 * Threat model for a loopback OAuth receiver: the dangerous caller isn't a LAN
 * host (we bind 127.0.0.1-only) — it's ANOTHER web page open in the same browser,
 * which can POST to http://127.0.0.1:<port>/callback. Without a defence, such a
 * page could inject the ATTACKER's Firebase token, fixating the victim's session
 * onto the attacker's account so the victim's learnings write into the attacker's
 * Firestore subtree. Two layers stop that:
 *   1. a one-time `state` nonce the hosted page must echo back (an attacker page
 *      can't read the legit tab's URL cross-origin, so it can't know the nonce);
 *   2. origin-locked CORS — the preflight only green-lights the hosted page's exact
 *      origin, so the browser blocks a cross-origin POST from any other page. */
export async function login(): Promise<Session> {
  return new Promise<Session>((resolve, reject) => {
    const state = randomBytes(32).toString('hex');
    let allowedOrigin = '';
    try {
      allowedOrigin = new URL(AUTH_PAGE).origin;
    } catch {
      /* malformed FACTS_AUTH_URL — fall back to no origin lock (state nonce still applies) */
    }
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const origin = req.headers.origin;
      // CORS: only the hosted sign-in page's origin may talk to this loopback.
      if (allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        // Private Network Access preflight (public page → loopback): allow it so
        // the legit sign-in page still works on PNA-enforcing browsers.
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === '/callback' && req.method === 'POST') {
        // Reject a cross-origin caller whose Origin isn't the hosted page. (A
        // same-process non-browser caller sends no Origin and still must pass the
        // `state` nonce check below.)
        if (allowedOrigin && origin && origin !== allowedOrigin) {
          res.writeHead(403);
          res.end('bad origin');
          return; // keep the server open for the legit callback
        }
        let body = '';
        let tooBig = false;
        req.on('data', (c) => {
          if (tooBig) return;
          body += c;
          // The legit callback payload is a few KB; cap the accumulator so a
          // local client can't stream an unbounded body and OOM this short-lived
          // process. All validation runs in 'end', so bound the buffer here.
          if (body.length > 64_000) {
            tooBig = true;
            res.writeHead(413);
            res.end('too large');
            req.destroy();
          }
        });
        req.on('end', () => {
          if (tooBig) return;
          let p: {
            uid?: string; email?: string; idToken?: string; refreshToken?: string;
            expiresIn?: number; state?: string;
          };
          try {
            p = JSON.parse(body);
          } catch {
            res.writeHead(400);
            res.end('bad payload');
            return; // don't abort the login on a garbage POST — wait for the real one
          }
          // One-time nonce: only trust a callback that echoes the `state` minted for
          // THIS login and handed to the hosted page via the URL. Blocks blind
          // cross-site token injection (session fixation).
          if (!p.state || p.state !== state) {
            res.writeHead(403);
            res.end('bad state');
            return; // keep the server open for the legit callback
          }
          if (!p.uid || !p.idToken || !p.refreshToken) {
            res.writeHead(400);
            res.end('missing fields');
            return;
          }
          const s: Session = {
            uid: p.uid,
            email: p.email ?? null,
            idToken: p.idToken,
            refreshToken: p.refreshToken,
            expiresAt: Date.now() + (Number(p.expiresIn) || 3600) * 1000,
          };
          saveSession(s);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('FACTS: signed in. You can close this tab and return to your terminal.');
          server.close();
          resolve(s);
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const target = `${AUTH_PAGE}?port=${port}&state=${state}`;
      process.stderr.write(`[factstack-mcp] Sign in with Google (opening browser):\n  ${target}\n`);
      openBrowser(target);
    });
    // Give up after 5 minutes rather than hang forever.
    setTimeout(() => {
      server.close();
      reject(new Error('login timed out (5 min)'));
    }, 300_000).unref();
  });
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* headless / no browser — the URL is printed to stderr for manual open. */
  }
}

/**
 * Upsert a Firestore document under the signed-in user via REST (PATCH =
 * create-or-merge). The ID token authorizes it; rules confirm request.auth.uid
 * matches the `users/{uid}` path. Best-effort: returns false on any failure so
 * a storage hiccup never breaks a tool call.
 */
export async function firestoreSet(
  session: Session,
  docPath: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  const cfg = await getFbConfig();
  if (!cfg) return false;
  const url =
    `https://firestore.googleapis.com/v1/projects/${cfg.projectId}` +
    `/databases/(default)/documents/${docPath}`;
  try {
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${session.idToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: toFirestoreFields(fields) }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ── Minimal JS → Firestore REST value mapping (strings/nums/bools/arrays/maps). ── */
function toFirestoreFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = toValue(v);
  return out;
}

function toValue(v: unknown): unknown {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') {
    return { mapValue: { fields: toFirestoreFields(v as Record<string, unknown>) } };
  }
  return { stringValue: String(v) };
}
