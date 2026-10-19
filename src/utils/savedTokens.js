import { API_BASE } from '../hooks/useJiraAuth';

/*
 * Saved Personal Access Tokens. The server keeps the token encrypted; this browser keeps
 * the key (see server/credentials.js for why it is split). The key is made once, here,
 * and never leaves except as part of a request that uses it.
 *
 * Clearing the browser's storage loses the key, which makes the saved token unreadable:
 * the next sign-in simply asks for the token again.
 */
const KEY_NAME = 'roadmapVaultKey';
const REMEMBER_PREF = 'rememberTokens'; // { jira: true, confluence: false }

export function vaultKey() {
  try {
    let key = localStorage.getItem(KEY_NAME);
    if (!key) {
      const bytes = window.crypto.getRandomValues(new Uint8Array(32));
      key = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      localStorage.setItem(KEY_NAME, key);
    }
    return key;
  } catch (err) {
    return null; // blocked storage: nothing can be saved, and nothing is pretended to be
  }
}

async function post(path, body) {
  const response = await fetch(`${API_BASE}/api/credentials/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, vaultKey: vaultKey() })
  });
  return response.ok ? response.json() : { saved: false };
}

// { saved, hint, savedAt } — the hint is the token's last four characters, never more
export const savedTokenStatus = (product, url) =>
  url ? post('status', { product, url }).catch(() => ({ saved: false })) : Promise.resolve({ saved: false });

export const forgetSavedToken = (product, url) =>
  post('forget', { product, url }).catch(() => ({ saved: false }));

// Whether the "Remember tokens" box starts ticked: as the user last left it, and ticked
// until they have said otherwise — keeping the token is the point of the setting
export function rememberPreference(product) {
  try {
    const prefs = JSON.parse(localStorage.getItem(REMEMBER_PREF) || '{}');
    return product in prefs ? !!prefs[product] : true;
  } catch (err) {
    return true;
  }
}

export function setRememberPreference(product, value) {
  try {
    const prefs = JSON.parse(localStorage.getItem(REMEMBER_PREF) || '{}');
    prefs[product] = !!value;
    localStorage.setItem(REMEMBER_PREF, JSON.stringify(prefs));
  } catch (err) {
    // Only the checkbox's starting position is lost
  }
}
