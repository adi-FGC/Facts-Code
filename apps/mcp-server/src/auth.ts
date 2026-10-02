/**
 * FACTS MCP auth — an OPTIONAL one-time Google sign-in that turns on the
 * cloud mirror of learnings (a private per-account Firestore subtree).
 *
 * Owner decision 2026-09-24: sign-in is optional. Every local tool and
 * resource works signed out; the session is consulted only by the mirror, so
 * a signed-out, offline or expired user never loses a local tool.
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
import { MCP_NPM_PACKAGE, MCP_NPX, MCP_PUBLISHED } from '@factstack/spec';

/** Hosted page that runs the Google popup + POSTs the ID token to the loopback.
 *  Stays on the Netlify host until the Cloudflare /mcp-auth page and its
 *  config JSON are live (deploy-infra#1, owner call); FACTS_AUTH_URL overrides. */
const DEFAULT_AUTH_PAGE = 'https://factstack-demo.netlify.app/mcp-auth.html';

/** Read per call so an env override set after import (tests) still applies. */
function authPage(): string {
  return process.env.FACTS_AUTH_URL || DEFAULT_AUTH_PAGE;
}

/** Every network call here is bounded: a black-holed network must not hang
 *  the tool call that is waiting on the (optional) cloud mirror. */
const NET_TIMEOUT_MS = 5_000;

/** The one sign-in command, derived from the published npx pair. */
export const LOGIN_COMMAND = `${MCP_NPX} login`;

/** Whether `factstack-mcp` is on npm yet: @factstack/spec's one flag, which
 *  the registry's `mcp.published` reads too (the owner flips it on publish).
 *  Until then no hint offers the npx form as runnable: the name is unclaimed,
 *  and an agent running `npx -y` on it would install whatever claimed it,
 *  unprompted (MCP-R4). */
export { MCP_PUBLISHED };

/** The sign-in to actually run today: the npx one once published, else the
 *  from-a-clone launch (the registry's `mcp.cloneLaunchCommand` + `login`). */
export const SIGN_IN_COMMAND = MCP_PUBLISHED
  ? LOGIN_COMMAND
  : 'npx tsx apps/mcp-server/src/server.ts login';

/** Short, honest hint for the optional cloud sync. */
export function loginHint(): string {
  const what =
    `signs in with Google to mirror learnings to your private account. ` +
    `Every local tool works without it.`;
  return MCP_PUBLISHED
    ? `Optional: \`${SIGN_IN_COMMAND}\` ${what}`
    : `Optional: \`${SIGN_IN_COMMAND}\` (from a clone of the FACTS repo) ${what} ` +
        `${MCP_NPM_PACKAGE} is not on npm yet, so \`${LOGIN_COMMAND}\` won't work until it is published.`;
}

/**
 * Fetch the PUBLIC Firebase web config (apiKey + projectId) from the deployed
 * auth origin — the same `/mcp-auth-config.json` the sign-in page reads, built
 * from the owner's local (gitignored) fb.mjs. Kept out of this repo; a fresh
 * clone needs no local config because it reads it from the live site. Cached
 * after the first successful fetch. Null on failure (including an HTML SPA
 * fallback, which fails the JSON parse) → the mirror pauses.
 */
let _fbConfig: { apiKey: string; projectId: string } | null = null;
async function getFbConfig(): Promise<{ apiKey: string; projectId: string } | null> {
  if (_fbConfig) return _fbConfig;
  try {
    const origin = new URL(authPage()).origin;
    const res = await fetch(`${origin}/mcp-auth-config.json`, {
      signal: AbortSignal.timeout(NET_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { apiKey?: string; projectId?: string };
    if (!j.apiKey || !j.projectId) return null;
    _fbConfig = { apiKey: j.apiKey, projectId: j.projectId };
    return _fbConfig;
  } catch {
    return null;
  }
}

/** `$FACTS_HOME`, else `~/.factstack`. Read per call so tests can isolate it. */
function authDir(): string {
  return process.env.FACTS_HOME || join(homedir(), '.factstack');
}

function authFile(): string {
  return join(authDir(), 'auth.json');
}

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
    const file = authFile();
    if (!existsSync(file)) return null;
    const s = JSON.parse(readFileSync(file, 'utf8')) as Partial<Session> | null;
    // A hand-edited or truncated file is "signed out", not a crash later on.
    if (
      !s ||
      typeof s.uid !== 'string' ||
      typeof s.idToken !== 'string' ||
      typeof s.refreshToken !== 'string'
    ) {
      return null;
    }
    return {
      uid: s.uid,
      email: typeof s.email === 'string' ? s.email : null,
      idToken: s.idToken,
      refreshToken: s.refreshToken,
      expiresAt: Number.isFinite(s.expiresAt) ? (s.expiresAt as number) : 0,
    };
  } catch {
    return null;
  }
}

function saveSession(s: Session): void {
  mkdirSync(authDir(), { recursive: true });
  // 0o600: token file readable only by the owner.
  writeFileSync(authFile(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

/** Where the optional cloud mirror stands. `paused` = signed in, but the token
 *  could not be refreshed right now (offline, auth host unreachable, revoked):
 *  local tools are unaffected and the mirror resumes once refresh works. */
export type CloudSession =
  | { state: 'signed-out' }
  | { state: 'paused'; reason: string }
  | { state: 'ready'; session: Session };

/**
 * Resolve the cloud-mirror session, refreshing the ID token via the Secure
 * Token REST endpoint when it is near expiry. Never throws.
 */
export async function cloudSession(): Promise<CloudSession> {
  const s = loadSession();
  if (!s) return { state: 'signed-out' };
  if (Date.now() < s.expiresAt - 60_000) return { state: 'ready', session: s }; // 60s skew
  const cfg = await getFbConfig();
  if (!cfg) return { state: 'paused', reason: 'sign-in config unreachable (offline?)' };
  try {
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${cfg.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(s.refreshToken)}`,
      signal: AbortSignal.timeout(NET_TIMEOUT_MS),
    });
    if (!res.ok) {
      return {
        state: 'paused',
        reason: `token refresh failed (HTTP ${res.status}); run \`${SIGN_IN_COMMAND}\` again`,
      };
    }
    const j = (await res.json()) as {
      id_token?: string;
      refresh_token?: string;
      expires_in?: string;
    };
    if (!j.id_token) return { state: 'paused', reason: 'token refresh returned no id_token' };
    const next: Session = {
      ...s,
      idToken: j.id_token,
      refreshToken: j.refresh_token || s.refreshToken,
      // A missing/garbled expires_in must not yield NaN (which would force a
      // refresh on every call); Firebase ID tokens live 1 h.
      expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    };
    saveSession(next);
    return { state: 'ready', session: next };
  } catch {
    return { state: 'paused', reason: 'token refresh unreachable (offline?)' };
  }
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
  const page = authPage();
  return new Promise<Session>((resolve, reject) => {
    const state = randomBytes(32).toString('hex');
    let allowedOrigin = '';
    try {
      allowedOrigin = new URL(page).origin;
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
            uid?: string;
            email?: string;
            idToken?: string;
            refreshToken?: string;
            expiresIn?: number;
            state?: string;
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
      const target = `${page}?port=${port}&state=${state}`;
      process.stderr.write(
        `[factstack-mcp] Sign in with Google (opening your browser):\n  ${target}\n` +
          `[factstack-mcp] If the page says the link is missing its parameters, open the FULL URL above (including &state=…) yourself.\n`,
      );
      openBrowser(target);
    });
    // Give up after 5 minutes rather than hang forever.
    setTimeout(() => {
      server.close();
      reject(new Error('login timed out (5 min)'));
    }, 300_000).unref();
  });
}

/**
 * How to open `url` in the default browser, as a program + argv (no shell).
 * Pure so the argv is unit-testable. Windows goes through rundll32's URL
 * handler, NOT `cmd /c start`: cmd.exe parses the (unquoted) URL and cuts it
 * at the first `&`, dropping `&state=…`, so the sign-in page disabled itself.
 */
export function buildOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { command: string; args: string[] } {
  if (platform === 'win32')
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

function openBrowser(url: string): void {
  const { command, args } = buildOpenCommand(process.platform, url);
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).unref();
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
      signal: AbortSignal.timeout(NET_TIMEOUT_MS),
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
