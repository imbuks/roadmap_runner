process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const fetch = require('node-fetch');
const fetchCookie = require('fetch-cookie');
const tough = require('tough-cookie');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loginWithBrowser } = require('./browser-login');

const app = express();
const PORT = process.env.PORT || 4000;

// Attachments are held in memory only long enough to forward them to Jira
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// Session store: { [sessionId]: { jar, jiraUrl, auth, createdAt } }
const jiraSessions = {};

// Sessions are mirrored to disk so restarting the server does not force everyone to
// re-enter their token. The file holds Jira credentials, so it lives in the user's home
// directory (never the repo, where it could be committed), is readable only by them,
// and entries expire so an abandoned token does not linger forever.
const SESSION_DIR = path.join(os.homedir(), '.roadmap-runner');
const SESSION_FILE = path.join(SESSION_DIR, 'sessions.json');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function saveSessions() {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
    const data = {};
    Object.entries(jiraSessions).forEach(([id, session]) => {
      data[id] = {
        jiraUrl: session.jiraUrl,
        auth: session.auth,
        createdAt: session.createdAt,
        lastUsedAt: session.lastUsedAt,
        // Keep the whole jar, gateway session cookies included: for an SSO session they
        // *are* the credential, and re-earning one costs the user a browser sign-in. A
        // cookie that has since lapsed is no longer a hazard — classifyInterception spots
        // the gateway's reply and the session is re-established automatically.
        cookies: session.jar && typeof session.jar.toJSON === 'function' ? session.jar.toJSON() : null
      };
    });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data), { mode: 0o600 });
    // writeFileSync/mkdirSync only apply their mode when creating, so tighten explicitly
    // in case the file or directory already existed with looser permissions
    fs.chmodSync(SESSION_FILE, 0o600);
    fs.chmodSync(SESSION_DIR, 0o700);
  } catch (err) {
    // Losing persistence is not fatal; the session still works until the next restart
    console.warn('Could not persist Jira sessions:', err.message);
  }
}

function loadSessions() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const now = Date.now();
    let expired = 0;
    Object.entries(data).forEach(([id, session]) => {
      if (!session || !session.auth || !session.jiraUrl) return;
      if (session.createdAt && now - session.createdAt > SESSION_TTL_MS) {
        expired++;
        return;
      }
      let jar;
      try {
        jar = session.cookies ? tough.CookieJar.fromJSON(session.cookies) : new tough.CookieJar();
      } catch (err) {
        jar = new tough.CookieJar(); // a corrupt jar just means re-negotiating cookies
      }
      jiraSessions[id] = {
        jar,
        jiraUrl: session.jiraUrl,
        auth: session.auth,
        createdAt: session.createdAt || now,
        lastUsedAt: session.lastUsedAt || session.createdAt || now
      };
    });
    const restored = Object.keys(jiraSessions).length;
    console.log(`Restored ${restored} Jira session(s) from ${SESSION_FILE}${expired ? ` (${expired} expired)` : ''}`);
    if (expired) saveSessions();
  } catch (err) {
    console.warn('Could not read stored Jira sessions:', err.message);
  }
}

/**
 * Build the correct Authorization header for a session's stored credentials.
 * - 'pat'   : Jira Data Center/Server Personal Access Token -> Bearer auth (no username)
 * - 'basic' : username + password/token -> Basic auth (default, legacy behaviour)
 * - 'sso'   : signed in through the browser. The gateway is satisfied by the captured
 *             cookies; Jira is satisfied by a token if one was supplied, and otherwise by
 *             its own session cookie. Returns null in that second case, and jiraFetch
 *             drops headers with no value.
 */
function buildAuthHeader(auth) {
  if (!auth) return null;
  if (auth.authType === 'sso') {
    return auth.jiraToken ? 'Bearer ' + auth.jiraToken : null;
  }
  if (auth.authType === 'pat') {
    return 'Bearer ' + auth.jiraToken;
  }
  return 'Basic ' + Buffer.from(`${auth.jiraUser}:${auth.jiraToken}`).toString('base64');
}

/*
 * --- Talking to a Jira that sits behind an F5 BIG-IP APM gateway --------------------
 *
 * When the gateway's own session lapses it does not pass the request through to Jira and
 * it does not return a clean HTTP error. It answers the request itself with an HTML
 * portal page under whatever status it likes (404 is common), so an untreated response
 * reaches the UI as a baffling "Jira API error 404" full of markup.
 *
 * Two things make that happen here:
 *   - the gateway's cookies are short-lived, but we persist the whole jar for 30 days,
 *     so a server restart replays a long-dead gateway session;
 *   - several requests are usually in flight at once, and each one that arrives without
 *     a valid gateway session starts its own access policy evaluation. The gateway only
 *     tolerates one, and answers the rest with "Access policy evaluation is already in
 *     progress for your current session."
 *
 * So: recognise the gateway's pages, and re-establish its session exactly once no matter
 * how many requests hit the wall together. Where the policy demands interactive SSO, the
 * only thing that can satisfy it is a browser — see server/browser-login.js.
 */

// The gateway hands back an interactive single sign-on flow: an auto-posting SAML form,
// an OIDC bounce, or its own logon page. No Authorization header can satisfy any of them.
const SSO_MARKERS = [
  /SAMLRequest/,
  /login\.microsoftonline\.com/i,
  /\/my\.policy/i,
  /name=["']?(username|password)["']?/i,
  /openid-configuration|oauth2\/authorize/i
];

const APM_BUSY_MARKER = /Access policy evaluation is already in progress/i;
const APM_MARKERS = [/BIG-IP/i, /F5 Networks/i, /Access policy evaluation/i, /\/vdesk\//i];

const SSO_MESSAGE =
  'Jira is behind an F5 BIG-IP gateway that requires interactive single sign-on (SAML via ' +
  'Microsoft Entra ID). It rejected the request before Jira ever saw it, and a Jira API token ' +
  'cannot satisfy it. Use "Sign in with browser", or connect to the corporate network/VPN ' +
  'where the gateway lets API traffic through.';

const APM_MESSAGE =
  'Jira is unreachable: the network gateway (F5 BIG-IP) answered instead of Jira. ' +
  'This usually means the VPN/SSO session has expired — reconnect to the VPN, then sign in to Jira again.';

/**
 * Classify a response that came back from the gateway rather than from Jira.
 *
 * The rule is deliberately broad: every call here asks a /rest/ endpoint for JSON, and
 * Jira's REST API never answers those with HTML. So any HTML body means something in the
 * path intercepted the request — regardless of the status code, which the gateway sets to
 * whatever it likes (a 404 on its error page, and a cheerful 200 on its SSO redirect).
 *
 * Returns null when the response really is Jira's, otherwise:
 *   'sso'  - an interactive login flow. Unrecoverable from a server; fail fast.
 *   'apm'  - a gateway session problem. Worth re-establishing and retrying.
 */
function classifyInterception(response, body) {
  const contentType = response.headers.get('content-type') || '';
  const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
  if (!isHtml) return null;
  if (APM_BUSY_MARKER.test(body)) return 'apm';
  if (SSO_MARKERS.some(marker => marker.test(body))) return 'sso';
  if (APM_MARKERS.some(marker => marker.test(body))) return 'apm';
  // HTML where JSON was promised, from something that did not identify itself. Treat it
  // as a recoverable gateway hiccup; if it persists the retry limit reports it anyway.
  return 'apm';
}

/*
 * Per-session gateway state, keyed by that session's cookie jar:
 *   recovery   - the re-handshake currently in flight, if any
 *   generation - bumped each time one completes, so a request that was already in the
 *                air when the session was re-established knows to simply retry instead
 *                of tearing down the freshly minted session and starting over.
 */
const gatewayState = new WeakMap();

function gatewayStateFor(jar) {
  let state = gatewayState.get(jar);
  if (!state) {
    state = { recovery: null, generation: 0 };
    gatewayState.set(jar, state);
  }
  return state;
}

// Drop the stale gateway cookies, then send one cheap request on its own so the gateway
// can run its access policy through to completion without competition. Its own request
// can lose a race too, so give it a few tries before leaving it to the caller's retry.
async function primeGatewaySession(jar, fetchWithCookies, jiraUrl, auth) {
  await new Promise(resolve => jar.removeAllCookies(() => resolve()));
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchWithCookies(`${jiraUrl}/rest/api/2/myself`, {
        headers: { 'Authorization': buildAuthHeader(auth), 'Accept': 'application/json' },
        redirect: 'follow'
      });
      const kind = classifyInterception(response, await response.text());
      // Anything that is not an interception means the gateway let us through, so the
      // session is established — even a genuine Jira error, which the caller will see.
      if (!kind) return;
      // No number of retries produces a browser session, so stop rather than hammer it.
      if (kind === 'sso') return 'sso';
    } catch (err) {
      // Transport failure: fall through and wait before trying again.
    }
    await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1)));
  }
}

// Re-establish the gateway session, unless another request got there first while this
// one was failing. `work` returns the recovery strategy to run; going through the shared
// slot means a burst of failing requests produces one recovery, not one each — which for
// a browser sign-in is the difference between one window and a dozen.
async function recoverGatewaySession(state, generation, work) {
  if (state.generation > generation) return null;
  if (!state.recovery) {
    state.recovery = work()
      .catch(err => ({ error: err }))
      .then(result => {
        state.generation++;
        state.recovery = null;
        return result;
      });
  }
  return state.recovery;
}

// An SSO session is re-earned by signing in again, which only a browser can do. Sessions
// created that way carry authType 'sso', so the server knows re-opening a window is what
// the user signed up for rather than a surprise.
async function reloginWithBrowser(jar, jiraUrl, auth) {
  const summary = await loginWithBrowser(jiraUrl, jar, {
    authHeader: buildAuthHeader(auth),
    onProgress: where => console.log(`  browser sign-in is at: ${where}`)
  });
  saveSessions(); // the refreshed cookies are the credential; keep them across restarts
  console.log(`Re-established the Jira browser session for ${summary.user}`);
  return summary;
}

const MAX_GATEWAY_ATTEMPTS = 3;

/**
 * A cookie-aware fetch for one Jira session that transparently recovers from the gateway
 * in front of it. Call sites read `ok`, `status` and `text()`, and the body has to be
 * buffered here to inspect it, so it hands back that shape rather than a spent Response.
 */
function makeJiraFetch(jar, jiraUrl, auth) {
  const fetchWithCookies = fetchCookie(fetch, jar);
  const buffered = (response, body) => ({
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    text: async () => body
  });

  const state = gatewayStateFor(jar);
  // A streamed body (a file upload) cannot be replayed, so such a request is recovered
  // but not retried here — resending it would send an empty form.
  const replayable = body => !body || typeof body === 'string' || Buffer.isBuffer(body);
  // An 'sso' session sends no Authorization header at all, so drop empty ones rather
  // than letting "Authorization: null" go out on the wire.
  const withoutEmptyHeaders = headers =>
    Object.fromEntries(Object.entries(headers || {}).filter(([, value]) => value != null));

  return async function jiraFetch(url, options = {}) {
    const request = { ...options, headers: withoutEmptyHeaders(options.headers) };

    for (let attempt = 0; ; attempt++) {
      // If the gateway session is already being re-established, wait for it rather than
      // racing it — competing evaluations are exactly what the gateway rejects.
      if (state.recovery) await state.recovery;
      const generation = state.generation;

      const response = await fetchWithCookies(url, request);
      const body = await response.text();
      const kind = classifyInterception(response, body);
      if (!kind) return buffered(response, body);

      // Only a browser can complete an SSO flow. A session that was established that way
      // can re-open one; anything else has nothing left to try, so report it now rather
      // than spending three rounds of retries arriving at the same wall.
      const canReopenBrowser = auth && auth.authType === 'sso';
      if (kind === 'sso' && !canReopenBrowser) throw new Error(SSO_MESSAGE);
      if (attempt >= MAX_GATEWAY_ATTEMPTS) throw new Error(kind === 'sso' ? SSO_MESSAGE : APM_MESSAGE);

      const recovered = await recoverGatewaySession(state, generation, () =>
        kind === 'sso'
          ? reloginWithBrowser(jar, jiraUrl, auth)
          : primeGatewaySession(jar, fetchWithCookies, jiraUrl, auth));

      if (recovered === 'sso') throw new Error(SSO_MESSAGE);
      // A browser sign-in that failed outright (cancelled, timed out) is the user's
      // answer, so surface it instead of silently retrying.
      if (recovered && recovered.error) throw recovered.error;

      if (!replayable(request.body)) {
        throw new Error('The network gateway in front of Jira ended this session. It has been re-established — please try again.');
      }
    }
  };
}

/*
 * --- Keeping a browser-established session alive -------------------------------------
 *
 * An access gateway enforces two separate timeouts. The inactivity one — commonly 15-30
 * minutes — is what makes a session feel like it expires "after a while", and it resets
 * on any request. So while the app is in use, poll quietly and the session simply never
 * lapses. (The other, a hard maximum session lifetime, cannot be extended by anything;
 * when that one fires a fresh sign-in is genuinely required.)
 *
 * Only sessions in active use are kept warm. Once the app has been idle for a couple of
 * hours the pinging stops and the gateway session is allowed to lapse on its own, rather
 * than holding a corporate SSO session open indefinitely on an unattended machine.
 */
// Tunable, because gateway inactivity timeouts vary between deployments: the ping only
// helps if it lands comfortably inside whatever window yours enforces.
const KEEPALIVE_INTERVAL_MS = Number(process.env.JIRA_KEEPALIVE_MS) || 5 * 60 * 1000;
const KEEPALIVE_MAX_IDLE_MS = Number(process.env.JIRA_KEEPALIVE_MAX_IDLE_MS) || 2 * 60 * 60 * 1000;

async function keepSessionsAlive() {
  const now = Date.now();
  let refreshed = 0;

  for (const [id, session] of Object.entries(jiraSessions)) {
    // Only browser sessions lapse this way; token auth re-authenticates on every request.
    if (!session.auth || session.auth.authType !== 'sso') continue;
    if (now - (session.lastUsedAt || session.createdAt || 0) > KEEPALIVE_MAX_IDLE_MS) continue;

    try {
      // Deliberately the raw cookie-aware fetch, not jiraFetch: a background ping must
      // never pop a sign-in window at someone who is not looking at the app.
      const headers = { 'Accept': 'application/json' };
      const authHeader = buildAuthHeader(session.auth);
      if (authHeader) headers.Authorization = authHeader;
      const response = await fetchCookie(fetch, session.jar)(`${session.jiraUrl}/rest/api/2/myself`, {
        headers,
        redirect: 'follow'
      });
      if (classifyInterception(response, await response.text())) {
        console.log(`Jira session ${id.slice(0, 8)}… has lapsed; the next request will ask for a new sign-in.`);
      } else {
        refreshed++;
      }
    } catch (err) {
      // A transient network failure is not worth reporting; try again next tick.
    }
  }

  if (refreshed) saveSessions(); // the gateway may have rolled its cookie
}

setInterval(keepSessionsAlive, KEEPALIVE_INTERVAL_MS);

// Any call that names a session counts as activity, which is what decides whether the
// session is worth keeping warm above.
app.use('/api/jira', (req, res, next) => {
  const session = req.body && jiraSessions[req.body.sessionId];
  if (session) session.lastUsedAt = Date.now();
  next();
});

app.post('/api/jira/auth', async (req, res) => {
  const { jiraUrl, jiraUser, jiraToken, authType = 'basic' } = req.body;
  // PAT auth identifies the user by the token itself, so a username is not required.
  const missingUser = authType !== 'pat' && !jiraUser;
  if (!jiraUrl || !jiraToken || missingUser) {
    return res.status(400).json({ error: 'Missing Jira credentials or URL' });
  }
  try {
    const jar = new tough.CookieJar();
    const auth = { jiraUser, jiraToken, authType };
    const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
    // Make a simple request to verify credentials (e.g., get current user)
    const apiUrl = `${jiraUrl}/rest/api/2/myself`;
    const response = await fetchWithCookies(apiUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    if (!response.ok) {
      const rawText = await response.text();
      return res.status(response.status).json({ error: 'Jira authentication failed', body: rawText });
    }
    // Store session
    const sessionId = uuidv4();
    jiraSessions[sessionId] = { jar, jiraUrl, auth, createdAt: Date.now(), lastUsedAt: Date.now() };
    saveSessions();
    res.json({ sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sign in by opening a browser, for a Jira published through a gateway that insists on
// interactive SSO. No token is involved: the session rides on the cookies the sign-in
// produces, so there is no secret to type in and none to store beyond the cookies.
//
// This blocks for as long as the user takes to get through the identity provider, which
// is why the client has to be willing to wait rather than time the request out.
app.post('/api/jira/sso-login', async (req, res) => {
  const { jiraUrl, jiraToken } = req.body;
  if (!jiraUrl) {
    return res.status(400).json({ error: 'Missing Jira URL' });
  }
  try {
    const jar = new tough.CookieJar();
    const auth = { authType: 'sso', jiraToken: jiraToken || undefined };
    const summary = await loginWithBrowser(jiraUrl, jar, {
      // With a token, the browser only has to get past the gateway — Jira's own login is
      // answered by the token instead, so the window closes a step earlier.
      authHeader: buildAuthHeader(auth),
      onProgress: where => console.log(`  browser sign-in is at: ${where}`)
    });
    const sessionId = uuidv4();
    jiraSessions[sessionId] = { jar, jiraUrl, auth, createdAt: Date.now(), lastUsedAt: Date.now() };
    saveSessions();
    console.log(`Browser sign-in established a Jira session for ${summary.user} (${summary.cookies.join(', ')})`);
    res.json({ sessionId, user: summary.user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Who the session belongs to. PAT sessions carry no username at all, and even a basic
// session only stores whatever was typed into the login form, so ask Jira itself rather
// than trusting the stored credentials.
app.post('/api/jira/current-user', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  try {
    const apiUrl = `${jiraUrl}/rest/api/2/myself`;
    const response = await fetchWithCookies(apiUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const me = JSON.parse(rawText);
    // Same shape as /reporters, so the client can match one against the other
    res.json({ user: { key: me.accountId || me.name, name: me.displayName || me.name || '' } });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Sign out: forget the session in memory and on disk, so the stored token is removed
app.post('/api/jira/logout', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && jiraSessions[sessionId]) {
    delete jiraSessions[sessionId];
    saveSessions();
  }
  res.json({ ok: true });
});

app.post('/api/jira/projects', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  try {
    const apiUrl = `${jiraUrl}/rest/api/2/project`;
    const response = await fetchWithCookies(apiUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const data = JSON.parse(rawText);
    // Return only key and name for each project
    const projects = data.map(project => ({ key: project.key, name: project.name }));
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/api/jira/teams', async (req, res) => {
  const { sessionId, projectKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  const authHeader = buildAuthHeader(auth);
  const optLabel = (opt) => (typeof opt === 'string' ? opt : (opt.value || opt.name || opt.label || ''));
  try {
    // Step 1: Get all fields to find the custom field ID for 'team'
    const fieldsRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/field`, {
      headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
      redirect: 'follow'
    });
    const fieldsText = await fieldsRes.text();
    if (!fieldsRes.ok) {
      return res.status(fieldsRes.status).json({ error: 'Jira API error', status: fieldsRes.status, body: fieldsText });
    }
    const fields = JSON.parse(fieldsText);
    const teamField = fields.find(f => f.name && f.name.trim().toLowerCase() === 'team');
    if (!teamField) {
      return res.status(404).json({ error: 'Custom field "team" not found' });
    }

    let teams = [];

    // Strategy 1: context/option endpoint (works on Jira Cloud)
    try {
      const optionsRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/field/${teamField.id}/context/option`, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      if (optionsRes.ok) {
        const optionsData = JSON.parse(await optionsRes.text());
        teams = (optionsData.values || []).map(opt => ({ id: opt.id, value: optLabel(opt) }));
      }
    } catch (e) {
      console.warn('Team context/option lookup failed:', e.message);
    }

    // Strategy 2 (on-prem Jira Server/DC): read allowedValues from createmeta
    if (teams.length === 0 && projectKey) {
      const metaUrl = `${jiraUrl}/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes.fields`;
      const metaRes = await fetchWithCookies(metaUrl, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      if (metaRes.ok) {
        const meta = JSON.parse(await metaRes.text());
        const seen = new Set();
        (meta.projects || []).forEach(project => {
          (project.issuetypes || []).forEach(it => {
            const fieldMeta = it.fields && it.fields[teamField.id];
            (fieldMeta && fieldMeta.allowedValues ? fieldMeta.allowedValues : []).forEach(opt => {
              const value = optLabel(opt);
              if (value && !seen.has(value)) {
                seen.add(value);
                teams.push({ id: opt.id || value, value });
              }
            });
          });
        });
      } else {
        console.warn('Team createmeta lookup failed:', metaRes.status);
      }
    }

    // Strategy 3 (fallback): collect distinct team values already used on the project's issues
    if (teams.length === 0 && projectKey) {
      const jql = `project = "${projectKey}" AND "${teamField.name}" is not EMPTY`;
      const searchUrl = `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=${teamField.id}&maxResults=200`;
      const searchRes = await fetchWithCookies(searchUrl, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      if (searchRes.ok) {
        const searchData = JSON.parse(await searchRes.text());
        const seen = new Set();
        (searchData.issues || []).forEach(issue => {
          const fieldVal = (issue.fields || {})[teamField.id];
          const value = optLabel(fieldVal);
          // Capture the numeric option ID if Jira returns it on the field object
          const id = (fieldVal && typeof fieldVal === 'object' && fieldVal.id) ? fieldVal.id : value;
          if (value && !seen.has(value)) {
            seen.add(value);
            teams.push({ id, value });
          }
        });
        teams.sort((a, b) => a.value.localeCompare(b.value));
      } else {
        console.warn('Team search fallback failed:', searchRes.status);
      }
    }

    res.json({ teams, fieldId: teamField.id });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/api/jira/reporters', async (req, res) => {
  const { sessionId, projectKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  try {
    // Use assignable users endpoint. It pages at 50 by default, which on a large project
    // leaves most people — including whoever is signed in — off the list entirely.
    const apiUrl = `${jiraUrl}/rest/api/2/user/assignable/search?project=${projectKey}&maxResults=1000`;
    const response = await fetchWithCookies(apiUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const users = JSON.parse(rawText);
    // Return displayName and accountId/name
    res.json({ reporters: users.map(u => ({ key: u.accountId || u.name, name: u.displayName })) });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/api/jira/application-cis', async (req, res) => {
  const { sessionId, epicKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  try {
    // Step 1: Get all fields to find the custom field ID for 'Application CI'
    const fieldsUrl = `${jiraUrl}/rest/api/2/field`;
    const fieldsRes = await fetchWithCookies(fieldsUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const fieldsText = await fieldsRes.text();
    if (!fieldsRes.ok) {
      return res.status(fieldsRes.status).json({ error: 'Jira API error', status: fieldsRes.status, body: fieldsText });
    }
    const fields = JSON.parse(fieldsText);
    const appCIField = fields.find(f => f.name.trim().toLowerCase() === 'application ci (as per cmdb)');
    if (!appCIField) {
      return res.status(404).json({ error: 'Custom field "Application CI" not found' });
    }
    // Step 2: Get the epic issue to extract Application CI values
    const epicUrl = `${jiraUrl}/rest/api/2/issue/${epicKey}`;
    const epicRes = await fetchWithCookies(epicUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const epicText = await epicRes.text();
    if (!epicRes.ok) {
      return res.status(epicRes.status).json({ error: 'Jira API error', status: epicRes.status, body: epicText });
    }
    const epicData = JSON.parse(epicText);
    // Application CI could be a single value or array
    const appCIValue = epicData.fields[appCIField.id];
    let appCIs = [];
    if (Array.isArray(appCIValue)) {
      appCIs = appCIValue.map(val => (typeof val === 'string' ? val : val.value || val.name || JSON.stringify(val)));
    } else if (appCIValue) {
      appCIs = [typeof appCIValue === 'string' ? appCIValue : appCIValue.value || appCIValue.name || JSON.stringify(appCIValue)];
    }
    res.json({ applicationCIs: appCIs });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/api/jira/boards', async (req, res) => {
  const { sessionId, projectKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  try {
    const boardsUrl = `${jiraUrl}/rest/agile/1.0/board?projectKeyOrId=${projectKey}`;
    const boardsRes = await fetchWithCookies(boardsUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const boardsText = await boardsRes.text();
    if (!boardsRes.ok) {
      return res.status(boardsRes.status).json({ error: 'Jira API error', status: boardsRes.status, body: boardsText });
    }
    const boardsData = JSON.parse(boardsText);
    const boards = (boardsData.values || []).map(b => ({ id: b.id, name: b.name, type: b.type }));
    res.json({ boards });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/api/jira/sprints', async (req, res) => {
  const { sessionId, boardId } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  try {
    // Only fetch open sprints (active + future); exclude closed sprints
    const sprintsUrl = `${jiraUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active,future`;
    const sprintsRes = await fetchWithCookies(sprintsUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const sprintsText = await sprintsRes.text();
    if (!sprintsRes.ok) {
      return res.status(sprintsRes.status).json({ error: 'Jira API error', status: sprintsRes.status, body: sprintsText });
    }
    const sprintsData = JSON.parse(sprintsText);
    // Guard against instances that ignore the state filter by also excluding closed here
    const sprints = (sprintsData.values || [])
      .filter(s => s.state !== 'closed')
      .map(s => ({ id: s.id, name: s.name, state: s.state }));
    res.json({ sprints });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/api/jira/sprint-field-options', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  try {
    // Step 1: Get all fields to find the custom field ID for 'Sprint'
    const fieldsUrl = `${jiraUrl}/rest/api/2/field`;
    const fieldsRes = await fetchWithCookies(fieldsUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const fieldsText = await fieldsRes.text();
    if (!fieldsRes.ok) {
      return res.status(fieldsRes.status).json({ error: 'Jira API error', status: fieldsRes.status, body: fieldsText });
    }
    const fields = JSON.parse(fieldsText);
    const sprintField = fields.find(f => f.name.trim().toLowerCase() === 'sprint');
    if (!sprintField) {
      return res.status(404).json({ error: 'Custom field "Sprint" not found' });
    }
    // Step 2: Get options for the custom field (if it's a select list)
    const optionsUrl = `${jiraUrl}/rest/api/2/field/${sprintField.id}/context/option`;
    const optionsRes = await fetchWithCookies(optionsUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const optionsText = await optionsRes.text();
    if (!optionsRes.ok) {
      return res.status(optionsRes.status).json({ error: 'Jira API error', status: optionsRes.status, body: optionsText });
    }
    const optionsData = JSON.parse(optionsText);
    // The options are usually in optionsData.values
    const sprints = (optionsData.values || []).map(opt => ({ id: opt.id, name: opt.value }));
    res.json({ sprints });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// CSV upload endpoint for roadmap data
app.post('/api/csv/upload', async (req, res) => {
  try {
    const { csvData } = req.body;
    if (!csvData) {
      return res.status(400).json({ error: 'No CSV data provided' });
    }
    
    // Parse CSV data
    const lines = csvData.split('\n').filter(line => line.trim());
    if (lines.length < 2) {
      return res.status(400).json({ error: 'CSV file must have headers and at least one data row' });
    }
    
    const headers = lines[0].split(',').map(h => h.trim());
    const dataRows = lines.slice(1);
    
    const parsedData = dataRows.map((line, index) => {
      const values = line.split(',').map(v => v.trim());
      const row = {};
      
      headers.forEach((header, i) => {
        row[header] = values[i] || '';
      });
      
      // Ensure we have an ID
      if (!row.id) {
        row.id = index + 1;
      }
      
      return row;
    }).filter(row => row.capability && row.feature); // Filter out empty rows
    
    res.json({ 
      success: true, 
      data: parsedData,
      headers: headers,
      rowCount: parsedData.length 
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Get project versions endpoint
app.post('/api/jira/versions', async (req, res) => {
  const { sessionId, projectKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  try {
    const versionsUrl = `${jiraUrl}/rest/api/2/project/${projectKey}/versions`;
    const response = await fetchWithCookies(versionsUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const versions = JSON.parse(rawText);
    // Return versions with key info
    const versionList = versions.map(version => ({
      id: version.id,
      name: version.name,
      description: version.description,
      archived: version.archived,
      released: version.released,
      releaseDate: version.releaseDate
    }));
    res.json({ versions: versionList });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Get features (epics) by version endpoint
app.post('/api/jira/features', async (req, res) => {
  const { sessionId, projectKey, versionId, issueKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  const authHeader = buildAuthHeader(auth);
  try {
    const versionClause = versionId && versionId !== 'all' ? ` AND fixVersion = "${versionId}"` : '';
    const jqlCandidates = issueKey
      // Fetch a specific issue by key (for getting parent Features from any project)
      ? [`key = "${issueKey}"`]
      // Instances without an Initiative type reject the combined query, so fall back to
      // Feature alone rather than returning an error
      : [
        `project = "${projectKey}" AND (type = Feature OR type = Initiative)${versionClause} ORDER BY key DESC`,
        `project = "${projectKey}" AND type = Feature${versionClause} ORDER BY key DESC`
      ];
    console.log(`Features endpoint - JQL: ${jqlCandidates[0]}`);

    // Paged: the search API returns 50 by default, which silently truncated large
    // portfolio projects
    const features = await searchWithFallback(fetchWithCookies, jiraUrl, authHeader, jqlCandidates);

    const mappedFeatures = features.map(issue => ({
      id: issue.key,
      title: issue.fields.summary,
      status: (issue.fields.status && issue.fields.status.name) || '',
      owner: issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned',
      targetPI: issue.fields.fixVersions && issue.fields.fixVersions.length > 0 ? issue.fields.fixVersions[0].name : '',
      priority: issue.fields.priority ? issue.fields.priority.name : 'Medium',
      notes: issue.fields.description || '',
      created: issue.fields.created,
      updated: issue.fields.updated,
      type: (issue.fields.issuetype && issue.fields.issuetype.name) || ''
    }));

    res.json({ features: mappedFeatures });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Debug endpoint to get complete Epic payload
app.post('/api/jira/debug-epic', async (req, res) => {
  const { sessionId, epicKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  try {
    const issueUrl = `${jiraUrl}/rest/api/2/issue/${epicKey}`;
    console.log(`Debug endpoint - Fetching complete Epic payload for: ${epicKey}`);
    
    const response = await fetchWithCookies(issueUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const data = JSON.parse(rawText);
    
    // Return the complete payload for debugging
    console.log('Complete Epic payload fields:', Object.keys(data.fields));
    res.json({ epic: data });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Statuses that mean an issue is finished, so pickers can leave those out. Workflows
// name their terminal states differently, and JQL answers an unknown status name with a
// 400 rather than an empty result, so the clause is narrowed to what this instance
// actually defines. Status names are instance-wide, hence one cache keyed by Jira URL.
const CLOSED_STATUS_NAMES = ['Done', 'Cancelled'];
const statusNameCache = new Map();

async function openIssuesClause(fetchWithCookies, jiraUrl, authHeader) {
  let known = statusNameCache.get(jiraUrl);
  if (!known) {
    try {
      const res = await fetchWithCookies(`${jiraUrl}/rest/api/2/status`, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      const text = await res.text();
      if (!res.ok) throw new JiraApiError(res.status, text);
      known = new Set(JSON.parse(text).map(s => String(s.name || '').toLowerCase()));
      // Only a successful lookup is cached, so a gateway hiccup does not pin the
      // fallback in place for the rest of the process's life
      statusNameCache.set(jiraUrl, known);
    } catch (err) {
      console.warn('Status list unavailable, filtering by status category instead:', err.message);
      known = null;
    }
  }
  const names = known ? CLOSED_STATUS_NAMES.filter(n => known.has(n.toLowerCase())) : [];
  // Without the catalogue — or with neither name defined — the category covers the same
  // ground, since Jira files both Done and Cancelled under the Done category.
  if (names.length === 0) return 'statusCategory != Done';
  return `status NOT IN (${names.map(n => `"${n}"`).join(', ')})`;
}

// Get epics by version endpoint (separate from features - in case epics and features are different)
// `openOnly` drops finished issues from the result, for pickers that only offer live work.
app.post('/api/jira/epics', async (req, res) => {
  const { sessionId, projectKey, versionId, parentEpic, openOnly } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  try {
    // Search for epics in the project
    let jql = `project = "${projectKey}"`;
    
    if (parentEpic) {
      // Get stories/tasks under a specific epic
      jql += ` AND "Epic Link" = "${parentEpic}"`;
    } else {
      // Get ALL Epics in the project (regardless of Epic Link status)
      jql += ` AND type = Epic`;
    }
    
    if (versionId && versionId !== 'all') {
      jql += ` AND fixVersion = "${versionId}"`;
      console.log(`Epic endpoint - Added version filter for: ${versionId}`);
    } else {
      console.log('Epic endpoint - No version filter applied (versionId is "all" or empty)');
    }

    if (openOnly) {
      jql += ` AND ${await openIssuesClause(fetchWithCookies, jiraUrl, buildAuthHeader(auth))}`;
    }

    console.log(`Epic endpoint - Final JQL: ${jql}`);
    
    const searchUrl = `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=key,summary,status,assignee,fixVersions,priority,description,created,updated,customfield_10014,issuetype,customfield_15502`;
    const response = await fetchWithCookies(searchUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const data = JSON.parse(rawText);
    
    console.log(`Epic endpoint - Found ${data.issues.length} epics for project ${projectKey}, version ${versionId}`);
    
    // Debug the first epic's custom field values
    if (data.issues.length > 0) {
      const firstEpic = data.issues[0];
      console.log('First epic sample:', {
        key: firstEpic.key,
        summary: firstEpic.fields?.summary,
        issueType: firstEpic.fields?.issuetype?.name,
        customfield_15502: firstEpic.fields?.customfield_15502
      });
    }
    
    const epics = data.issues.map(issue => {
      const featureValue = issue.fields.customfield_15502;
      console.log(`Epic ${issue.key} - customfield_15502 value:`, featureValue, 'Type:', typeof featureValue);
      
      return {
        id: issue.key,
        title: issue.fields.summary,
        feature: featureValue || parentEpic || '', // Parent Feature field
        status: issue.fields.status.name,
        owner: issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned',
        targetPI: issue.fields.fixVersions && issue.fields.fixVersions.length > 0 ? issue.fields.fixVersions[0].name : '',
        storyPoints: issue.fields.customfield_10014 || 0, // Story points field ID may vary
        notes: issue.fields.description || '',
        created: issue.fields.created,
        updated: issue.fields.updated,
        type: issue.fields.issuetype.name
      };
    });
    
    res.json({ epics });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Get stories by epic endpoint
app.post('/api/jira/stories', async (req, res) => {
  const { sessionId, projectKey, epicKey, versionId } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  try {
    // Search for stories under an epic
    let jql = `project = "${projectKey}" AND type IN (Story, Task, Bug)`;
    
    if (epicKey) {
      jql += ` AND "Epic Link" = "${epicKey}"`;
    }
    
    if (versionId && versionId !== 'all') {
      jql += ` AND fixVersion = "${versionId}"`;
    }
    
    const searchUrl = `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=key,summary,status,assignee,fixVersions,priority,description,customfield_10014,labels`;
    const response = await fetchWithCookies(searchUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const data = JSON.parse(rawText);
    
    const stories = data.issues.map(issue => ({
      id: issue.key,
      title: issue.fields.summary,
      epic: epicKey || '',
      status: issue.fields.status.name,
      owner: issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned',
      storyPoints: issue.fields.customfield_10014 || 0,
      isPlaceholder: issue.fields.labels && issue.fields.labels.includes('placeholder'),
      notes: issue.fields.description || ''
    }));
    
    res.json({ stories });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Get available (non-subtask) issue types for a project
app.post('/api/jira/issue-types', async (req, res) => {
  const { sessionId, projectKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!projectKey) {
    return res.status(400).json({ error: 'projectKey is required.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  try {
    const projRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/project/${projectKey}`, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const projText = await projRes.text();
    if (!projRes.ok) {
      return res.status(projRes.status).json({ error: 'Jira API error', status: projRes.status, body: projText });
    }
    const projData = JSON.parse(projText);
    const issueTypes = (projData.issueTypes || [])
      .filter(it => !it.subtask)
      // iconUrl lets locally drafted rows show the same icon Jira uses for that type
      .map(it => ({ id: it.id, name: it.name, iconUrl: it.iconUrl || '' }));
    res.json({ issueTypes });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Fetch an existing issue by key and map it to the table row shape (for cloning)
// Thrown when Jira itself rejects a request, so the route can forward its status and body
class JiraApiError extends Error {
  constructor(status, body) {
    super('Jira API error');
    this.status = status;
    this.body = body;
  }
}

// Extract a display value from an option-style custom field (string | {value} | array).
// Advanced Roadmaps' Team field labels itself with `title` rather than `value`/`name`.
const optionValue = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(optionValue).filter(Boolean).join(', ');
  if (typeof v === 'object') return v.value || v.name || v.title || '';
  return String(v);
};
// The same fields are written back by option id, so keep the id alongside the label
const optionId = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return optionId(v[0]);
  if (typeof v === 'object') return v.id != null ? String(v.id) : optionValue(v);
  return String(v);
};
// Extract a sprint name from Jira's varied sprint field representations
const sprintName = (v) => {
  if (v == null) return '';
  const one = Array.isArray(v) ? v[v.length - 1] : v;
  if (!one) return '';
  if (typeof one === 'object') return one.name || '';
  const m = String(one).match(/name=([^,]+)/);
  return m ? m[1] : String(one);
};

// Look up the custom field IDs the table depends on; they vary per Jira instance
async function findTableFields(fetchWithCookies, jiraUrl, authHeader) {
  const fieldsRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/field`, {
    headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
    redirect: 'follow'
  });
  const fieldsText = await fieldsRes.text();
  if (!fieldsRes.ok) throw new JiraApiError(fieldsRes.status, fieldsText);
  const allFields = JSON.parse(fieldsText);
  const findField = (name) => allFields.find(f => f.name && f.name.trim().toLowerCase() === name);
  return {
    epicLinkField: findField('epic link'),
    storyPointsField: findField('story points'),
    sprintField: findField('sprint'),
    appCIField: findField('application ci (as per cmdb)'),
    teamField: findField('team')
  };
}

// Map one Jira issue onto the shape the table's rows use
function mapIssueToRow(data, custom) {
  const { epicLinkField, storyPointsField, sprintField, appCIField, teamField } = custom;
  const f = data.fields || {};
  return {
    summary: f.summary || '',
    description: f.description || '',
    // Workflow state, plus the category ('new' | 'indeterminate' | 'done') the table
    // colours by. Read-only here: status changes through transitions, not a field write.
    status: (f.status && f.status.name) || '',
    statusCategory: (f.status && f.status.statusCategory && f.status.statusCategory.key) || '',
    issueType: (f.issuetype && f.issuetype.name) || 'Story',
    issueTypeIcon: (f.issuetype && f.issuetype.iconUrl) || '',
    epicLink: epicLinkField && f[epicLinkField.id] ? String(f[epicLinkField.id]) : '',
    // Rows key people by username (that is what Jira accepts on write), but carry the
    // display name so the table can show it even for users outside the loaded lists
    reporter: (f.reporter && f.reporter.name) || '',
    reporterName: (f.reporter && f.reporter.displayName) || '',
    applicationCI: appCIField ? optionValue(f[appCIField.id]) : '',
    labels: (f.labels || []).join(', '),
    sprint: sprintField ? sprintName(f[sprintField.id]) : '',
    linkedIssues: '',
    issue: '',
    storyPoints: storyPointsField && f[storyPointsField.id] != null ? String(f[storyPointsField.id]) : '',
    assignee: (f.assignee && f.assignee.name) || '',
    assigneeName: (f.assignee && f.assignee.displayName) || '',
    // Rows key the team by id; the label is sent too so the client can still match
    // instances whose team list is keyed by name (createmeta fallback)
    team: teamField ? optionId(f[teamField.id]) : '',
    teamName: teamField ? optionValue(f[teamField.id]) : ''
  };
}

// Run a JQL search to completion, following Jira's paging
async function searchAllIssues(fetchWithCookies, jiraUrl, authHeader, jql) {
  const found = [];
  let startAt = 0;
  for (;;) {
    const searchUrl = `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=100&startAt=${startAt}`;
    const searchRes = await fetchWithCookies(searchUrl, {
      headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
      redirect: 'follow'
    });
    const searchText = await searchRes.text();
    if (!searchRes.ok) throw new JiraApiError(searchRes.status, searchText);
    const page = JSON.parse(searchText);
    const batch = page.issues || [];
    found.push(...batch);
    startAt += batch.length;
    if (batch.length === 0 || startAt >= (page.total || 0)) break;
  }
  return found;
}

/**
 * Jira instances differ in which parent fields they expose to JQL, so try the queries in
 * order and move on when one is rejected as malformed. Anything other than a 400 is a
 * real failure and is thrown.
 */
async function searchWithFallback(fetchWithCookies, jiraUrl, authHeader, jqlCandidates) {
  let lastError = null;
  for (const jql of jqlCandidates) {
    try {
      return await searchAllIssues(fetchWithCookies, jiraUrl, authHeader, jql);
    } catch (err) {
      if (err instanceof JiraApiError && err.status === 400) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// Turn raw Jira issues into table rows carrying their key and browse URL
function toTableRows(issues, custom, jiraUrl) {
  return issues.map(issue => ({
    ...mapIssueToRow(issue, custom),
    issue: issue.key,
    url: `${jiraUrl}/browse/${issue.key}`
  }));
}

app.post('/api/jira/get-issue', async (req, res) => {
  const { sessionId, issueKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!issueKey || !issueKey.trim()) {
    return res.status(400).json({ error: 'An issue key is required.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  const authHeader = buildAuthHeader(auth);

  try {
    const custom = await findTableFields(fetchWithCookies, jiraUrl, authHeader);

    const issueRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/issue/${encodeURIComponent(issueKey.trim())}`, {
      headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
      redirect: 'follow'
    });
    const issueText = await issueRes.text();
    if (!issueRes.ok) {
      return res.status(issueRes.status).json({ error: 'Jira API error', status: issueRes.status, body: issueText });
    }
    const data = JSON.parse(issueText);
    res.json({ issue: mapIssueToRow(data, custom), key: data.key, url: `${jiraUrl}/browse/${data.key}` });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Fetch every issue under an epic, mapped to table rows for bulk editing
app.post('/api/jira/epic-issues', async (req, res) => {
  const { sessionId, epicKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!epicKey || !epicKey.trim()) {
    return res.status(400).json({ error: 'An epic key is required.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  const authHeader = buildAuthHeader(auth);
  const key = epicKey.trim().replace(/"/g, '');

  try {
    const custom = await findTableFields(fetchWithCookies, jiraUrl, authHeader);
    // "Epic Link" covers classic projects and `parent` covers next-gen, but `parent` is not
    // queryable on every Jira version — fall back to Epic Link alone if the query is rejected
    const found = await searchWithFallback(fetchWithCookies, jiraUrl, authHeader, [
      `("Epic Link" = "${key}" OR parent = "${key}") AND type != Sub-task ORDER BY key ASC`,
      `"Epic Link" = "${key}" ORDER BY key ASC`
    ]);
    const issues = toTableRows(found, custom, jiraUrl);
    res.json({ issues, total: issues.length });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

/**
 * Map a table row onto Jira's `fields` object, shared by create-story and update-story.
 * Custom field IDs vary per Jira instance, so they are resolved by name first.
 * Only non-empty values are written: an empty epic link / sprint / CI leaves whatever
 * Jira already has rather than risking a rejection on a required field.
 */
async function buildIssueFields({ fetchWithCookies, jiraUrl, authHeader, boardId, values }) {
  const { epicLinkField, storyPointsField, sprintField, appCIField, teamField } =
    await findTableFields(fetchWithCookies, jiraUrl, authHeader);

  const { summary, description, epicLink, reporter, applicationCI, labels, sprint, storyPoints, assignee, team } = values;
  const fields = {};
  if (summary !== undefined) fields.summary = String(summary).trim();
  // Sent even when blank so clearing the description in the editor also clears it in Jira
  if (description !== undefined && description !== null) fields.description = description;
  if (reporter) fields.reporter = { name: reporter };
  if (assignee) fields.assignee = { name: assignee };
  if (labels !== undefined && labels !== null) {
    fields.labels = String(labels).split(',').map(l => l.trim().replace(/\s+/g, '_')).filter(Boolean);
  }
  if (epicLink && epicLinkField) fields[epicLinkField.id] = epicLink;
  if (storyPoints !== undefined && storyPoints !== '' && storyPointsField) {
    const pts = Number(storyPoints);
    if (!isNaN(pts)) fields[storyPointsField.id] = pts;
  }
  if (applicationCI && appCIField) {
    const schemaType = appCIField.schema && appCIField.schema.type;
    if (schemaType === 'array') fields[appCIField.id] = [{ value: applicationCI }];
    else if (schemaType === 'option') fields[appCIField.id] = { value: applicationCI };
    else fields[appCIField.id] = applicationCI;
  }
  if (team && teamField) {
    fields[teamField.id] = String(team);
  }
  // Sprint field expects a numeric sprint id; resolve from the board by name (best effort)
  if (sprint && sprintField && boardId) {
    try {
      const spRes = await fetchWithCookies(`${jiraUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active,future`, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      if (spRes.ok) {
        const spData = JSON.parse(await spRes.text());
        const match = (spData.values || []).find(s => s.name === sprint || String(s.id) === String(sprint));
        if (match) fields[sprintField.id] = match.id;
      }
    } catch (e) {
      console.warn('Could not resolve sprint id for', sprint, e.message);
    }
  }
  return fields;
}

// Create (publish) a story in Jira
app.post('/api/jira/create-story', async (req, res) => {
  const { sessionId, projectKey, boardId, summary, issueType } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!projectKey) {
    return res.status(400).json({ error: 'projectKey is required to publish a story.' });
  }
  if (!summary || !summary.trim()) {
    return res.status(400).json({ error: 'A summary is required to publish a story.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  const authHeader = buildAuthHeader(auth);
  try {
    const fields = await buildIssueFields({ fetchWithCookies, jiraUrl, authHeader, boardId, values: req.body });
    fields.project = { key: projectKey };
    fields.issuetype = { name: issueType || 'Story' };

    const createRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/issue`, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
      redirect: 'follow'
    });
    const createText = await createRes.text();
    if (!createRes.ok) {
      return res.status(createRes.status).json({ error: 'Jira API error', status: createRes.status, body: createText });
    }
    const created = JSON.parse(createText);
    res.json({ key: created.key, url: `${jiraUrl}/browse/${created.key}` });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Update an existing Jira issue in place (the edit counterpart of create-story)
app.post('/api/jira/update-story', async (req, res) => {
  const { sessionId, issueKey, boardId, summary, issueType } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!issueKey || !issueKey.trim()) {
    return res.status(400).json({ error: 'issueKey is required to update an issue.' });
  }
  if (!summary || !summary.trim()) {
    return res.status(400).json({ error: 'A summary is required to update an issue.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  const authHeader = buildAuthHeader(auth);
  const key = issueKey.trim();
  try {
    const fields = await buildIssueFields({ fetchWithCookies, jiraUrl, authHeader, boardId, values: req.body });
    // Only send an issue type change when one was chosen; some workflows reject the move
    if (issueType) fields.issuetype = { name: issueType };

    const updateRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Authorization': authHeader, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
      redirect: 'follow'
    });
    // A successful update returns 204 No Content
    if (!updateRes.ok) {
      const updateText = await updateRes.text();
      return res.status(updateRes.status).json({ error: 'Jira API error', status: updateRes.status, body: updateText });
    }
    res.json({ key, url: `${jiraUrl}/browse/${key}` });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Fetch the epics under a feature, mapped to table rows for bulk editing
app.post('/api/jira/feature-epics', async (req, res) => {
  const { sessionId, featureKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!featureKey || !featureKey.trim()) {
    return res.status(400).json({ error: 'A feature key is required.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  const authHeader = buildAuthHeader(auth);
  const key = featureKey.trim().replace(/"/g, '');

  try {
    const custom = await findTableFields(fetchWithCookies, jiraUrl, authHeader);
    // Epics hang off a feature by "Parent Link" under Advanced Roadmaps, and by `parent`
    // on newer Jira. Which one an instance accepts varies, so try the broad query first
    // and fall back to each field on its own.
    const found = await searchWithFallback(fetchWithCookies, jiraUrl, authHeader, [
      `("Parent Link" = "${key}" OR parent = "${key}") AND type = Epic ORDER BY key ASC`,
      `"Parent Link" = "${key}" ORDER BY key ASC`,
      `parent = "${key}" ORDER BY key ASC`,
      // Last resort for instances that model the feature as an epic's Epic Link
      `"Epic Link" = "${key}" AND type = Epic ORDER BY key ASC`
    ]);
    const issues = toTableRows(found, custom, jiraUrl);
    res.json({ issues, total: issues.length });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Search epics across the whole instance, so an epic owned by another team's project can
// still be picked. Deliberately not scoped to the selected project or board.
app.post('/api/jira/search-epics', async (req, res) => {
  const { sessionId, query, projectKey, openOnly } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  // Quotes and backslashes would break out of the JQL string literal
  const q = String(query || '').trim().replace(/["\\]/g, ' ').trim();
  if (q.length < 2) return res.json({ epics: [] });

  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  const authHeader = buildAuthHeader(auth);
  const looksLikeKey = /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(q);

  // A pasted key is looked up directly; anything else is a text search on the summary.
  // Ordering by recency keeps the most likely candidates at the top of the picker.
  // The open-only filter is left off the key lookup: typing an exact key is explicit
  // enough that a finished epic should still resolve.
  const open = openOnly ? ` AND ${await openIssuesClause(fetchWithCookies, jiraUrl, authHeader)}` : '';
  const candidates = looksLikeKey
    ? [`key = "${q.toUpperCase()}"`, `type = Epic AND summary ~ "${q}"${open} ORDER BY updated DESC`]
    : [
      `type = Epic AND summary ~ "${q}"${open} ORDER BY updated DESC`,
      `type = Epic AND text ~ "${q}"${open} ORDER BY updated DESC`
    ];

  try {
    let found = [];
    let lastError = null;
    for (const jql of candidates) {
      try {
        // One page is plenty for a search-as-you-type picker
        const url = `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=50&fields=key,summary,project,issuetype`;
        const searchRes = await fetchWithCookies(url, {
          headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
          redirect: 'follow'
        });
        const text = await searchRes.text();
        if (!searchRes.ok) throw new JiraApiError(searchRes.status, text);
        found = JSON.parse(text).issues || [];
        if (found.length > 0) break;
      } catch (err) {
        if (err instanceof JiraApiError && err.status === 400) { lastError = err; continue; }
        throw err;
      }
    }
    if (found.length === 0 && lastError) throw lastError;

    const epics = found.map(issue => ({
      id: issue.key,
      title: (issue.fields && issue.fields.summary) || '',
      project: (issue.fields && issue.fields.project && issue.fields.project.key) || '',
      // Flagged so the picker can show where an out-of-project epic came from
      foreign: Boolean(projectKey) && issue.fields && issue.fields.project
        && issue.fields.project.key !== projectKey
    }));
    res.json({ epics });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Every value the Application CI field allows, rather than just the ones already on an
// epic, so a CI can be chosen even when the epic does not carry it
app.post('/api/jira/application-ci-options', async (req, res) => {
  const { sessionId, projectKey, issueKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  const authHeader = buildAuthHeader(auth);

  try {
    const { appCIField } = await findTableFields(fetchWithCookies, jiraUrl, authHeader);
    if (!appCIField) return res.json({ applicationCIs: [], source: 'not-found' });

    const seen = new Set();
    const add = (value) => {
      const label = optionValue(value);
      if (label && !seen.has(label)) seen.add(label);
    };

    // Strategy 1: the field's own option list (Jira Cloud)
    try {
      const optRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/field/${appCIField.id}/context/option`, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      if (optRes.ok) {
        (JSON.parse(await optRes.text()).values || []).forEach(add);
      }
    } catch (err) {
      console.warn('Application CI context/option lookup failed:', err.message);
    }

    // Strategy 2 (on-prem): allowedValues from createmeta for the given project
    if (seen.size === 0 && projectKey) {
      const metaUrl = `${jiraUrl}/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes.fields`;
      const metaRes = await fetchWithCookies(metaUrl, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      if (metaRes.ok) {
        const meta = JSON.parse(await metaRes.text());
        (meta.projects || []).forEach(project => {
          (project.issuetypes || []).forEach(it => {
            const fieldMeta = it.fields && it.fields[appCIField.id];
            ((fieldMeta && fieldMeta.allowedValues) || []).forEach(add);
          });
        });
      }
    }

    // Strategy 3: editmeta on a real issue. createmeta only describes the create screen,
    // and on this instance the CI field is not on it — but it is editable, so the edit
    // screen knows its options. Use a caller-supplied issue, else find any in the project.
    if (seen.size === 0) {
      let sampleKey = issueKey && String(issueKey).trim();
      if (!sampleKey && projectKey) {
        const jql = `project = "${projectKey}" ORDER BY updated DESC`;
        const findRes = await fetchWithCookies(
          `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1&fields=key`,
          { headers: { 'Authorization': authHeader, 'Accept': 'application/json' }, redirect: 'follow' }
        );
        if (findRes.ok) {
          const first = (JSON.parse(await findRes.text()).issues || [])[0];
          if (first) sampleKey = first.key;
        }
      }
      if (sampleKey) {
        const editRes = await fetchWithCookies(
          `${jiraUrl}/rest/api/2/issue/${encodeURIComponent(sampleKey)}/editmeta`,
          { headers: { 'Authorization': authHeader, 'Accept': 'application/json' }, redirect: 'follow' }
        );
        if (editRes.ok) {
          const editMeta = JSON.parse(await editRes.text());
          const fieldMeta = editMeta.fields && editMeta.fields[appCIField.id];
          ((fieldMeta && fieldMeta.allowedValues) || []).forEach(add);
        }
      }
    }

    const applicationCIs = [...seen].sort((a, b) => a.localeCompare(b));
    // 'free-text' tells the client the field takes any value, so typing one is safe
    const source = applicationCIs.length > 0
      ? 'options'
      : ((appCIField.schema && appCIField.schema.type) === 'string' ? 'free-text' : 'none');
    res.json({ applicationCIs, source });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Which transitions each issue can currently make. Jira only offers the ones legal from
// the issue's present status, so this is per-issue and cannot be assumed across a set.
app.post('/api/jira/transitions', async (req, res) => {
  const { sessionId, issueKeys } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const keys = (Array.isArray(issueKeys) ? issueKeys : []).map(k => String(k || '').trim()).filter(Boolean);
  if (keys.length === 0) {
    return res.status(400).json({ error: 'At least one issue key is required.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  const authHeader = buildAuthHeader(auth);
  const transitions = {};
  const errors = {};
  try {
    for (const key of keys) {
      const url = `${jiraUrl}/rest/api/2/issue/${encodeURIComponent(key)}/transitions`;
      const transRes = await fetchWithCookies(url, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      const transText = await transRes.text();
      if (!transRes.ok) {
        // One unreadable issue should not sink the whole set
        errors[key] = transText;
        continue;
      }
      const data = JSON.parse(transText);
      transitions[key] = (data.transitions || []).map(t => ({
        id: String(t.id),
        name: t.name || '',
        to: (t.to && t.to.name) || '',
        toCategory: (t.to && t.to.statusCategory && t.to.statusCategory.key) || ''
      }));
    }
    res.json({ transitions, errors });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Execute one transition, then read the status back so the table shows what Jira did
// rather than what we assumed it would do
app.post('/api/jira/transition-issue', async (req, res) => {
  const { sessionId, issueKey, transitionId } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!issueKey || !String(issueKey).trim()) {
    return res.status(400).json({ error: 'issueKey is required.' });
  }
  if (!transitionId) {
    return res.status(400).json({ error: 'transitionId is required.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  const authHeader = buildAuthHeader(auth);
  const key = String(issueKey).trim();
  try {
    const transRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ transition: { id: String(transitionId) } }),
      redirect: 'follow'
    });
    // A successful transition returns 204 No Content
    if (!transRes.ok) {
      const transText = await transRes.text();
      return res.status(transRes.status).json({ error: 'Jira API error', status: transRes.status, body: transText });
    }
    let status = '';
    let statusCategory = '';
    try {
      const statusRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/issue/${encodeURIComponent(key)}?fields=status`, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      if (statusRes.ok) {
        const data = JSON.parse(await statusRes.text());
        const f = data.fields || {};
        status = (f.status && f.status.name) || '';
        statusCategory = (f.status && f.status.statusCategory && f.status.statusCategory.key) || '';
      }
    } catch (err) {
      // The transition itself succeeded; a stale chip is not worth failing the call
      console.warn('Could not read back status for', key, err.message);
    }
    res.json({ key, status, statusCategory });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Attach one or more files to an existing Jira issue (multipart upload)
app.post('/api/jira/attach', upload.array('files'), async (req, res) => {
  const { sessionId, issueKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!issueKey) {
    return res.status(400).json({ error: 'issueKey is required to attach files.' });
  }
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'No files were uploaded.' });
  }
  // This route is multipart, so req.body is only populated by multer — after the
  // middleware that stamps activity has already run. Mark it here instead.
  jiraSessions[sessionId].lastUsedAt = Date.now();
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = makeJiraFetch(jar, jiraUrl, auth);
  const authHeader = buildAuthHeader(auth);
  try {
    const form = new FormData();
    files.forEach(file => {
      // Multer decodes filenames as latin1; restore the original UTF-8 name
      const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
      form.append('file', file.buffer, { filename, contentType: file.mimetype });
    });
    const attachRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/attachments`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json',
        // Required by Jira to allow attachment uploads from a non-form context
        'X-Atlassian-Token': 'no-check',
        ...form.getHeaders()
      },
      body: form,
      redirect: 'follow'
    });
    const attachText = await attachRes.text();
    if (!attachRes.ok) {
      return res.status(attachRes.status).json({ error: 'Jira API error', status: attachRes.status, body: attachText });
    }
    const attached = JSON.parse(attachText);
    res.json({ attachments: (attached || []).map(a => ({ id: a.id, filename: a.filename, size: a.size })) });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Serve the built UI from this same origin, which is how the Docker image runs: one
// published port covers both the app and the proxy, and the browser needs no CORS hop.
// Opt-in, so `npm run server` alongside the CRA dev server keeps behaving as before and
// never answers with a stale bundle. Registered last so no API route is shadowed.
if (process.env.SERVE_UI === '1') {
  const UI_DIR = path.join(__dirname, '..', 'build');
  if (fs.existsSync(UI_DIR)) {
    app.use(express.static(UI_DIR));
    // React Router owns the paths below; anything that is not an API call or a real file
    // has to come back as index.html or a page refresh would 404
    app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(UI_DIR, 'index.html')));
    console.log(`Serving UI from ${UI_DIR}`);
  } else {
    console.warn(`SERVE_UI=1 but no build found at ${UI_DIR} — run "npm run build" first`);
  }
}

loadSessions();

app.listen(PORT, () => {
  console.log(`Jira proxy server running on port ${PORT}`);
});
