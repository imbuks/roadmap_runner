import { API_BASE } from '../hooks/useJiraAuth';
import { vaultKey } from './savedTokens';

// The Confluence session is its own: a different server, often a different sign-in, and
// signing out of one must not sign you out of the other. Same pattern as the Jira one —
// only the id is kept here; the token stays with the server.
const SESSION_KEY = 'confluenceSessionId';
const CONNECTION_KEY = 'confluenceConnection'; // { baseUrl, authType, user } — no secrets
const TARGET_KEY = 'confluenceSyncTarget';     // { space, parentId }
const JOB_KEY = 'confluenceSyncJob';           // a running sync, to pick up after a reload

const read = (storage, key) => {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
};
const write = (storage, key, value) => {
  try {
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Blocked storage only costs the convenience of being remembered
  }
};

const INVALID_SESSION = /Invalid or missing Confluence session/;

async function request(endpoint, body) {
  const response = await fetch(`${API_BASE}/api/confluence/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { response, data: await response.json().catch(() => ({})) };
}

function failure({ response, data }) {
  const err = new Error(data.error || `Confluence request failed (${response.status})`);
  err.status = response.status;
  err.data = data;
  return err;
}

async function post(endpoint, body) {
  const result = await request(endpoint, body);
  if (!result.response.ok) throw failure(result);
  return result.data;
}

// A request that names the session. When the server no longer knows it, sign in again
// with the saved token and try once more; only with nothing to sign in with is the
// session given up.
async function postWithSession(endpoint, body = {}) {
  const send = sessionId => request(endpoint, { ...body, sessionId });
  let result = await send(confluenceService.getSession());
  if (result.response.status === 400 && INVALID_SESSION.test(result.data.error || '')) {
    const restored = await confluenceService.restoreSession();
    if (!restored) {
      confluenceService.forget();
      throw failure(result);
    }
    result = await send(restored);
  }
  if (!result.response.ok) throw failure(result);
  return result.data;
}

let restoring = null; // one re-sign-in for however many calls found the session gone
let checking = null;

/*
 * Whether Confluence is connected, for every component that cares (the app bar, the
 * connections dialog, the sync page). 'unknown' until `check()` has asked the server —
 * a stored session id is only a hint, and the launch prompt must not open over a session
 * that is about to turn out fine.
 */
let status = { state: 'unknown', user: null, baseUrl: null, authType: null };
const listeners = new Set();

function setStatus(patch) {
  status = { ...status, ...patch };
  listeners.forEach(listener => listener());
}

export const confluenceStatus = {
  get: () => status,
  subscribe: listener => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
};

export const confluenceService = {
  getSession: () => read(localStorage, SESSION_KEY),
  getConnection: () => read(localStorage, CONNECTION_KEY),
  // { space, parentId, parentTitle } — the title only when the page was picked from search
  getTarget: () => ({ space: '', parentId: '', parentTitle: '', ...read(localStorage, TARGET_KEY) }),
  setTarget: target => write(localStorage, TARGET_KEY, target),
  getJob: () => read(sessionStorage, JOB_KEY),
  setJob: jobId => write(sessionStorage, JOB_KEY, jobId),

  forget: () => {
    write(localStorage, SESSION_KEY, null);
    const connection = read(localStorage, CONNECTION_KEY);
    // Keep where you were connecting to; only the session goes
    if (connection) write(localStorage, CONNECTION_KEY, { baseUrl: connection.baseUrl, authType: connection.authType });
    setStatus({ state: 'signed-out', user: null });
  },

  remember: ({ sessionId, user, baseUrl }, authType) => {
    write(localStorage, SESSION_KEY, sessionId);
    write(localStorage, CONNECTION_KEY, { baseUrl, authType, user });
    setStatus({ state: 'connected', user, baseUrl, authType });
  },

  // Settle whether Confluence is connected: ask about the stored session (re-signing in
  // with a saved token if the server has lost it), or failing that, try the saved token
  // outright. Shared by everyone who asks at once.
  check: () => {
    if (!checking) {
      checking = (async () => {
        try {
          if (confluenceService.getSession()) {
            const me = await confluenceService.currentUser();
            setStatus({ state: 'connected', user: me.user, baseUrl: me.baseUrl, authType: me.authType });
          } else if (!(await confluenceService.restoreSession())) {
            setStatus({ state: 'signed-out', user: null });
          }
        } catch (err) {
          // An expired browser sign-in, or a session the saved token could not replace.
          // The proxy being down is different — but either way there is nothing usable.
          setStatus({ state: 'signed-out', user: null });
        }
        return status;
      })().finally(() => { checking = null; });
    }
    return checking;
  },

  // With a PAT, `remember` keeps (true) or forgets (false) the token for next time, and
  // `useSaved` signs in with the kept one instead of a typed one
  signIn: async (baseUrl, { authType, user, token, remember, useSaved }) => {
    try {
      const data = await post('auth', { baseUrl, authType, user, token, remember, useSaved, vaultKey: vaultKey() });
      confluenceService.remember(data, authType);
      return data;
    } catch (err) {
      if (useSaved && !token && err.status === 401) {
        err.message = 'Confluence refused your saved token; it may have expired. Enter a new one.';
      }
      throw err;
    }
  },

  // Blocks until the user is through the identity provider, like the Jira one
  signInWithBrowser: async (baseUrl, token, { remember, useSaved } = {}) => {
    const data = await post('sso-login', { baseUrl, token: token || undefined, remember, useSaved, vaultKey: vaultKey() });
    confluenceService.remember(data, 'sso');
    return data;
  },

  // Sign in again with the saved token. Only a PAT sign-in can be repeated unattended;
  // resolves with the new session id, or null when there is nothing to sign in with.
  restoreSession: () => {
    if (!restoring) {
      restoring = (async () => {
        const connection = confluenceService.getConnection();
        if (!connection || connection.authType !== 'pat' || !connection.baseUrl || connection.signedOut) return null;
        try {
          const data = await confluenceService.signIn(connection.baseUrl, { authType: 'pat', useSaved: true });
          return data.sessionId;
        } catch (err) {
          return null;
        }
      })().finally(() => { restoring = null; });
    }
    return restoring;
  },

  signOut: async () => {
    const sessionId = confluenceService.getSession();
    if (sessionId) await post('logout', { sessionId }).catch(() => {});
    confluenceService.forget();
    // An explicit sign-out must stick: without this the saved token would sign straight
    // back in at the next check
    const connection = read(localStorage, CONNECTION_KEY);
    if (connection) write(localStorage, CONNECTION_KEY, { ...connection, signedOut: true });
  },

  currentUser: () => postWithSession('current-user'),

  checkTarget: (space, parentId) => postWithSession('target', { space, parentId }),

  // [{ id, title, path }] for the Parent page picker
  searchPages: async (space, query) => (await postWithSession('search-pages', { space, query })).pages || [],

  // Send the bundle read by readLocalBundle — only when it is about to be used
  uploadBundle: async entries => {
    const form = new FormData();
    form.append('paths', JSON.stringify(entries.map(f => f.path)));
    entries.forEach(({ file }) => form.append('files', file, file.name));
    const response = await fetch(`${API_BASE}/api/confluence/bundle`, { method: 'POST', body: form });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not send the bundle');
    return data;
  },

  startSync: options => postWithSession('sync', options),
  syncStatus: (jobId, since) => post('sync-status', { jobId, since }),
  stopSync: jobId => post('sync-stop', { jobId })
};

// A page link carries its id as ?pageId=123; a bare number is taken as it is.
export function parsePageId(text) {
  const value = String(text || '').trim();
  const m = /[?&]pageId=(\d+)/.exec(value) || /\/pages\/(\d+)(?:\/|$)/.exec(value);
  return m ? m[1] : value;
}

export default confluenceService;
