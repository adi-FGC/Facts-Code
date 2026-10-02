/**
 * FACTS MCP sign-in page logic.
 *
 * Runs the Google popup via the Firebase Web SDK (loaded from the gstatic CDN,
 * allowed by this page's scoped CSP — see public/_headers `/mcp-auth.html`),
 * then hands the resulting Firebase ID + refresh tokens back to the local MCP
 * `login` process over its 127.0.0.1 loopback. The MCP uses those for its
 * OPTIONAL cloud learnings sync (a Firestore mirror scoped to the user's uid by
 * the rules). Every local MCP tool works without signing in.
 *
 * The Firebase config is the PUBLIC web config, but it is NOT committed to this
 * repo — it's fetched same-origin from `/mcp-auth-config.json`, which the build
 * generates (see scripts/gen-fb-config.mjs: fb.mjs or FACTS_FB_WEB_CONFIG).
 * It only identifies the project; Firestore rules do the actual access control.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

// The sign-in command to run today. The MCP package is not on npm yet (spec's
// MCP_PUBLISHED is false), and `npx -y` on an unclaimed name runs whatever
// claims it, unprompted (MCP-R4). So this is the from-a-clone launch, the same
// as apps/mcp-server/src/auth.ts SIGN_IN_COMMAND. test/mcpAuthPage.test.ts
// fails if this page offers the npx form before publish, or keeps the clone
// form after it.
const SIGN_IN_COMMAND = 'npx tsx apps/mcp-server/src/server.ts login';

const params = new URLSearchParams(location.search);
const port = params.get('port');
// One-time nonce minted by the MCP `login` command and passed in the URL. We echo
// it back on the callback so the local loopback can prove the token came from
// THIS sign-in (not a hostile page blindly POSTing to 127.0.0.1) — see auth.ts.
const state = params.get('state');
const btn = document.getElementById('signin');
const setStatus = (t) => {
  document.getElementById('status').textContent = t;
};

// Load the PUBLIC Firebase web config (served same-origin, generated at build
// time — kept out of the repo), then init Firebase. A deployment built without
// it still answers 200: the SPA fallback serves index.html (text/html) for the
// missing file, so check the type instead of failing inside res.json().
let auth = null;
try {
  const res = await fetch('/mcp-auth-config.json', { cache: 'no-store' });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('json')) {
    throw new Error(
      'this deployment was built without its sign-in config (mcp-auth-config.json is missing). ' +
        'Local MCP tools still work without signing in.',
    );
  }
  auth = getAuth(initializeApp(await res.json()));
} catch (e) {
  setStatus(
    'Could not load the sign-in configuration: ' + (e && e.message ? e.message : String(e)),
  );
  btn.disabled = true;
}

if (!port || !state) {
  setStatus(
    'This page must be opened by the FACTS MCP sign-in in your terminal (from a clone of the FACTS repo: `' +
      SIGN_IN_COMMAND +
      '`). It is missing the one-time link parameters.',
  );
  btn.disabled = true;
}

btn.addEventListener('click', async () => {
  if (!auth) return;
  btn.disabled = true;
  setStatus('Opening Google…');
  try {
    const cred = await signInWithPopup(auth, new GoogleAuthProvider());
    const user = cred.user;
    const idToken = await user.getIdToken();
    setStatus('Linking your terminal…');
    const res = await fetch(`http://127.0.0.1:${port}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        uid: user.uid,
        email: user.email,
        idToken,
        refreshToken: user.refreshToken,
        expiresIn: 3600,
        state,
      }),
    });
    if (res.ok) {
      setStatus(
        '✓ Signed in as ' +
          (user.email || user.uid) +
          '. Return to your terminal — you can close this tab.',
      );
    } else {
      setStatus(
        'Signed in, but couldn’t reach the local FACTS process. Is `' +
          SIGN_IN_COMMAND +
          '` still running?',
      );
      btn.disabled = false;
    }
  } catch (e) {
    setStatus('Sign-in failed: ' + (e && e.message ? e.message : String(e)));
    btn.disabled = false;
  }
});
