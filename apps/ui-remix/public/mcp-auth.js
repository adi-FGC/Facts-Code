/**
 * FACTS MCP sign-in page logic.
 *
 * Runs the Google popup via the Firebase Web SDK (loaded from the gstatic CDN,
 * allowed by this page's scoped CSP — see public/_headers `/mcp-auth.html`),
 * then hands the resulting Firebase ID + refresh tokens back to the local
 * `factstack-mcp login` process over its 127.0.0.1 loopback. The MCP uses those
 * to write the user's data to Firestore, scoped to their uid by the rules.
 *
 * The Firebase config is the PUBLIC web config, but it is NOT committed to this
 * repo — it's fetched same-origin from `/mcp-auth-config.json`, which the build
 * generates from the owner's local (gitignored) fb.mjs (see scripts/gen-fb-config.mjs).
 * It only identifies the project; Firestore rules do the actual access control.
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const params = new URLSearchParams(location.search);
const port = params.get('port');
// One-time nonce minted by `factstack-mcp login` and passed in the URL. We echo
// it back on the callback so the local loopback can prove the token came from
// THIS sign-in (not a hostile page blindly POSTing to 127.0.0.1) — see auth.ts.
const state = params.get('state');
const btn = document.getElementById('signin');
const setStatus = (t) => {
  document.getElementById('status').textContent = t;
};

// Load the PUBLIC Firebase web config (served same-origin, generated at build
// from the owner's local fb.mjs — kept out of the repo), then init Firebase.
let auth = null;
try {
  const res = await fetch('/mcp-auth-config.json');
  if (!res.ok) throw new Error('config ' + res.status);
  auth = getAuth(initializeApp(await res.json()));
} catch (e) {
  setStatus('Could not load the sign-in configuration: ' + (e && e.message ? e.message : String(e)));
  btn.disabled = true;
}

if (!port || !state) {
  setStatus('This page must be opened by `factstack-mcp login` in your terminal (missing the one-time link parameters).');
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
      setStatus('✓ Signed in as ' + (user.email || user.uid) + '. Return to your terminal — you can close this tab.');
    } else {
      setStatus('Signed in, but couldn’t reach the local FACTS process. Is `factstack-mcp login` still running?');
      btn.disabled = false;
    }
  } catch (e) {
    setStatus('Sign-in failed: ' + (e && e.message ? e.message : String(e)));
    btn.disabled = false;
  }
});
