/*
 * The session handler: everything about holding a signed-in session to Jira or Confluence
 * through the F5 gateway — the store, its copy on disk, the gateway-aware fetch and its
 * recovery, the keepalive, and what state each session is in. Routes ask it for a
 * session by id and for a fetch for that session; nothing else in the server touches a
 * cookie jar.
 *
 * One session per site. Each sign-in mints a new id (the id is the bearer secret the
 * browser holds, so it is never handed out any other way), but every id for the same
 * product and URL shares one record: one cookie jar, one credential, and so one gateway
 * recovery and one sign-in window however many tabs or pages hit the wall together.
 * Signing in again refreshes the session for every id that already had it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const fetch = require('node-fetch');
const fetchCookie = require('fetch-cookie');
const tough = require('tough-cookie');
const { v4: uuidv4 } = require('uuid');
const { loginWithBrowser } = require('./browser-login');

// Session store: { [sessionId]: record }, record = { jar, jiraUrl, auth, createdAt, lastUsedAt }.
// Several ids may point at the same record (see above).
const jiraSessions = {};

const siteKey = (jiraUrl, auth) =>
  `${(auth && auth.product) || 'jira'}|${String(jiraUrl || '').trim().replace(/\/+$/, '').toLowerCase()}`;

const recordFor = (jiraUrl, auth) =>
  Object.values(jiraSessions).find(s => siteKey(s.jiraUrl, s.auth) === siteKey(jiraUrl, auth));

/**
 * Keep a newly signed-in session and return its id. An existing record for the same
 * site takes the new jar and credential in place, so ids issued earlier — other tabs, a
 * page that has not reloaded — carry on with the fresh session instead of the stale one.
 */
function createSession({ jar, jiraUrl, auth }) {
  const now = Date.now();
  let record = recordFor(jiraUrl, auth);
  if (record) {
    Object.assign(record, { jar, jiraUrl, auth, createdAt: now, lastUsedAt: now });
  } else {
    record = { jar, jiraUrl, auth, createdAt: now, lastUsedAt: now };
  }
  // A sign-in the user just did counts the same as one the server did for the loop guard
  // in makeJiraFetch: refused again straight away, another window would not help either.
  if (auth && auth.authType === 'sso') gatewayStateFor(jar).lastBrowserSignInAt = now;
  const sessionId = uuidv4();
  jiraSessions[sessionId] = record;
  saveSessions();
  return sessionId;
}

// The session for an id, if it is one of this product's
function getSession(sessionId, product = 'jira') {
  const session = sessionId && jiraSessions[sessionId];
  if (!session) return null;
  return ((session.auth && session.auth.product) || 'jira') === product ? session : null;
}

// Signing out signs the site out: every id sharing the record goes with it, since they
// all ride on the credential being forgotten.
function removeSession(sessionId) {
  const record = jiraSessions[sessionId];
  if (!record) return false;
  for (const [id, s] of Object.entries(jiraSessions)) if (s === record) delete jiraSessions[id];
  saveSessions();
  return true;
}

// What the UI needs to know about a session without making a request of its own
function sessionStatus(sessionId) {
  const session = jiraSessions[sessionId];
  if (!session) return { state: 'none' };
  const state = gatewayStateFor(session.jar);
  return {
    state: state.status,
    product: (session.auth && session.auth.product) || 'jira',
    baseUrl: session.jiraUrl,
    authType: session.auth && session.auth.authType,
    lastUsedAt: session.lastUsedAt,
    ...(state.lastError ? { lastError: state.lastError } : {})
  };
}

/**
 * The gateway turned the request away and nothing more can be done from here. A 502, so
 * a route can tell "the gateway is in the way" from its own failures and the browser can
 * tell it from Jira's; `code` says whether a browser sign-in is what's needed.
 */
class GatewayError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GatewayError';
    this.status = 502;
    this.code = code;
  }
}

// The status a route should answer a thrown error with
const errorStatus = err => (err && err.status === 502 ? 502 : 500);

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
    // The file keeps one entry per id, as it always has (so an older copy of the server can
    // still read it). Ids for the same site are regrouped onto one record here, the most
    // recent sign-in winning: it is the one whose cookies are least likely to have lapsed.
    const entries = Object.entries(data)
      .filter(([, session]) => {
        if (!session || !session.auth || !session.jiraUrl) return false;
        if (session.createdAt && now - session.createdAt > SESSION_TTL_MS) {
          expired++;
          return false;
        }
        return true;
      })
      .sort(([, a], [, b]) => (b.createdAt || 0) - (a.createdAt || 0));
    const bySite = new Map();
    entries.forEach(([id, session]) => {
      const key = siteKey(session.jiraUrl, session.auth);
      let record = bySite.get(key);
      if (!record) {
        let jar;
        try {
          jar = session.cookies ? tough.CookieJar.fromJSON(session.cookies) : new tough.CookieJar();
        } catch (err) {
          jar = new tough.CookieJar(); // a corrupt jar just means re-negotiating cookies
        }
        record = {
          jar,
          jiraUrl: session.jiraUrl,
          auth: session.auth,
          createdAt: session.createdAt || now,
          lastUsedAt: session.lastUsedAt || session.createdAt || now
        };
        bySite.set(key, record);
      }
      record.lastUsedAt = Math.max(record.lastUsedAt, session.lastUsedAt || 0);
      jiraSessions[id] = record;
    });
    console.log(`Restored ${bySite.size} session(s) (${entries.length} id(s)) from ${SESSION_FILE}` +
      `${expired ? ` (${expired} expired)` : ''}`);
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

// The same wall, met by a session that already signed in through the browser: the advice
// about tokens and VPNs is beside the point, and signing in again is the only way on.
const SSO_EXPIRED_MESSAGE =
  'Your Jira sign-in has expired and signing in again did not get past the network ' +
  'gateway (F5 BIG-IP). Use "Sign in with browser" to start a fresh session.';

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
 *   status     - what the last request found, for sessionStatus:
 *                'unchecked'     nothing has been sent since the server started
 *                'signed-in'     the last request got through to the product
 *                'recovering'    re-establishing the gateway session, no window needed
 *                'signing-in'    a sign-in window is open
 *                'needs-sign-in' the gateway won; lastError says why
 */
const gatewayState = new WeakMap();

function gatewayStateFor(jar) {
  let state = gatewayState.get(jar);
  if (!state) {
    state = { recovery: null, generation: 0, status: 'unchecked', lastError: null };
    gatewayState.set(jar, state);
  }
  return state;
}

// The session store holds Confluence sessions too (auth.product === 'confluence'; see
// server/confluence.js). Everything that asks the gateway "is the session alive" goes
// through the product's own who-am-I endpoint — Confluence has no /rest/api/2/myself, and
// its error page for one would read as an interception — and its messages name the right
// product.
const IDENTITY_PATHS = { jira: '/rest/api/2/myself', confluence: '/rest/api/user/current' };
const identityPath = auth => IDENTITY_PATHS[auth && auth.product] || IDENTITY_PATHS.jira;
const productName = auth => (auth && auth.product === 'confluence' ? 'Confluence' : 'Jira');
const forProduct = (message, auth) =>
  productName(auth) === 'Jira' ? message : message.replace(/\bJira\b/g, productName(auth));

// An 'sso' session sends no Authorization header at all, so drop empty ones rather
// than letting "Authorization: null" go out on the wire.
const withoutEmptyHeaders = headers =>
  Object.fromEntries(Object.entries(headers || {}).filter(([, value]) => value != null));

// Ask a cheap endpoint what, if anything, is standing in front of Jira. Used when a
// request failed in a way that left no response to classify — a redirect node-fetch
// would not follow. Unlike priming, it disturbs nothing: no cookies are cleared.
async function probeInterception(fetchWithCookies, jiraUrl, auth) {
  try {
    const response = await fetchWithCookies(`${jiraUrl}${identityPath(auth)}`, {
      headers: withoutEmptyHeaders({ 'Authorization': buildAuthHeader(auth), 'Accept': 'application/json' }),
      redirect: 'follow'
    });
    return classifyInterception(response, await response.text());
  } catch (err) {
    // No answer is not a clean bill of health: treat it as the gateway misbehaving
    return 'apm';
  }
}

// Drop the stale gateway cookies, then send one cheap request on its own so the gateway
// can run its access policy through to completion without competition. Its own request
// can lose a race too, so give it a few tries before leaving it to the caller's retry.
// A browser session keeps its cookies: they are the credential, and clearing them turns
// a hiccup into a sign-in that could otherwise have been avoided.
async function primeGatewaySession(jar, fetchWithCookies, jiraUrl, auth) {
  if (!auth || auth.authType !== 'sso') {
    await new Promise(resolve => jar.removeAllCookies(() => resolve()));
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetchWithCookies(`${jiraUrl}${identityPath(auth)}`, {
        headers: withoutEmptyHeaders({ 'Authorization': buildAuthHeader(auth), 'Accept': 'application/json' }),
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
    identityPath: identityPath(auth),
    siteName: productName(auth),
    onProgress: where => console.log(`  browser sign-in is at: ${where}`)
  });
  saveSessions(); // the refreshed cookies are the credential; keep them across restarts
  console.log(`Re-established the ${productName(auth)} browser session for ${summary.user}`);
  return summary;
}

const MAX_GATEWAY_ATTEMPTS = 3;

// How soon after a successful browser sign-in a refusal means "the sign-in is not what is
// wrong" rather than "the session lapsed". Gateway sessions last hours, not minutes.
const SIGN_IN_LOOP_WINDOW_MS = 2 * 60 * 1000;

const SIGN_IN_LOOP_MESSAGE =
  'You signed in to Jira successfully, but the network gateway (F5 BIG-IP) is still refusing ' +
  'this app\'s requests, so another sign-in would not help. Try again in a couple of minutes; if it ' +
  'keeps happening, the gateway is rejecting requests that do not come from the browser itself.';

// Enough of the gateway's answer to tell its reasons apart in the log: where it sent the
// request (the query is left out — a SAML redirect carries a signed request in it) and
// which of the gateway's cookies it was refused with.
function describeInterception(url, response) {
  const location = response.headers.get('location');
  const target = location ? (u => u.origin + u.pathname)(new URL(location, url)) : null;
  return [
    `${new URL(url).pathname} → ${response.status}`,
    target ? `to ${target}` : null,
    response.url && response.url !== url ? `ended at ${new URL(response.url).pathname}` : null,
    response.headers.get('content-type') || null
  ].filter(Boolean).join(', ');
}

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
  // A streamed body (a file upload) cannot be sent twice, so such a request is recovered
  // but not retried here — resending it would send an empty form. Call sites able to
  // build a fresh copy pass `newBody` instead, and are retried like anything else.
  const replayable = body => !body || typeof body === 'string' || Buffer.isBuffer(body);

  const jiraFetch = async (url, options = {}) => {
    // `newBody` is a factory returning { body, headers } — a multipart body carries its
    // own boundary in a Content-Type header, so the two have to be rebuilt together.
    const { newBody, ...rest } = options;
    const buildRequest = () => {
      if (!newBody) return { ...rest, headers: withoutEmptyHeaders(rest.headers) };
      const fresh = newBody();
      return {
        ...rest,
        body: fresh.body,
        headers: withoutEmptyHeaders({ ...rest.headers, ...fresh.headers })
      };
    };

    for (let attempt = 0; ; attempt++) {
      // If the gateway session is already being re-established, wait for it rather than
      // racing it — competing evaluations are exactly what the gateway rejects.
      if (state.recovery) await state.recovery;
      const generation = state.generation;
      const request = buildRequest();

      // A redirect cannot be followed while the body is a stream (fetch-cookie throws, and
      // the Location is lost with it), so a streamed request takes its redirect by hand.
      const streamed = !!request.body && typeof request.body.pipe === 'function';
      const response = await fetchWithCookies(url, streamed ? { ...request, redirect: 'manual' } : request);
      const body = await response.text();

      let kind;
      if (streamed && response.status >= 300 && response.status < 400) {
        // Jira answers these calls with JSON and never redirects, so the gateway is the
        // only thing this can be. Say where it pointed: the query is left out, since a
        // SAML redirect carries a signed request in it.
        const location = response.headers.get('location');
        const target = location ? (u => u.origin + u.pathname)(new URL(location, url)) : '(no Location)';
        console.warn(`Gateway redirected ${request.method || 'GET'} ${new URL(url).pathname}: ${response.status} → ${target}`);
        kind = await probeInterception(fetchWithCookies, jiraUrl, auth);
        // The gateway sometimes bounces a request through its policy check and straight
        // back. Every other call follows that without noticing; an upload cannot, and the
        // probe above has just made the trip for it. So the session is fine: send the
        // upload again rather than re-establishing a session that needs nothing, which
        // would cost a sign-in for no reason.
        if (!kind) {
          if (!newBody) {
            throw new GatewayError(forProduct('The network gateway in front of Jira interrupted this upload. Please try again.', auth), 'retry');
          }
          if (attempt >= MAX_GATEWAY_ATTEMPTS) {
            throw new GatewayError(forProduct(`The network gateway in front of Jira keeps turning this upload away ` +
              `(${response.status} → ${target}), although the Jira session itself is working.`, auth), 'retry');
          }
          continue;
        }
      } else {
        kind = classifyInterception(response, body);
        if (!kind) return buffered(response, body);
      }

      // Only a browser can complete an SSO flow. A session that was established that way
      // can re-open one; anything else has nothing left to try, so report it now rather
      // than spending three rounds of retries arriving at the same wall.
      const canReopenBrowser = auth && auth.authType === 'sso';
      if (kind === 'sso' && !canReopenBrowser) throw new GatewayError(forProduct(SSO_MESSAGE, auth), 'sso-required');
      if (attempt >= MAX_GATEWAY_ATTEMPTS) {
        if (kind !== 'sso') throw new GatewayError(forProduct(APM_MESSAGE, auth), 'gateway');
        throw new GatewayError(forProduct(canReopenBrowser ? SSO_EXPIRED_MESSAGE : SSO_MESSAGE, auth), 'sso-required');
      }

      // One line per burst — the first request to find the wall — so the log shows how long
      // a session actually lasts, and what the gateway said when it ended.
      if (!state.recovery && state.generation === generation) {
        const age = state.lastBrowserSignInAt ? `, ${Math.round((Date.now() - state.lastBrowserSignInAt) / 1000)}s after the last sign-in` : '';
        console.warn(`${productName(auth)} gateway intercepted a request (${kind}: ${describeInterception(url, response)}${age})`);
      }

      // Whichever failing request gets here first picks the recovery for all of them, and
      // under a burst one may see the SAML redirect while another sees the gateway's
      // "evaluation already in progress" page. So a gentle recovery that turns out to be
      // facing a sign-in escalates to the browser itself — otherwise a browser session
      // would be told that no token can help, and never be offered a window.
      const recovered = await recoverGatewaySession(state, generation, async () => {
        if (kind !== 'sso') {
          state.status = 'recovering';
          const primed = await primeGatewaySession(jar, fetchWithCookies, jiraUrl, auth);
          if (primed !== 'sso' || !canReopenBrowser) return primed;
        }
        // A sign-in that has only just succeeded and is already being refused again was not
        // the problem, and another window will not be the answer: the gateway is accepting
        // the browser but turning this server's requests away. Say so, once, rather than
        // opening a window for every request that follows.
        const sinceSignIn = Date.now() - (state.lastBrowserSignInAt || 0);
        if (sinceSignIn < SIGN_IN_LOOP_WINDOW_MS) {
          console.warn(`${productName(auth)} refused this server's request ${Math.round(sinceSignIn / 1000)}s after a ` +
            `successful browser sign-in (${describeInterception(url, response)}); not opening another window.`);
          return { error: new GatewayError(forProduct(SIGN_IN_LOOP_MESSAGE, auth), 'gateway-rejects-client') };
        }
        state.status = 'signing-in';
        const summary = await reloginWithBrowser(jar, jiraUrl, auth);
        state.lastBrowserSignInAt = Date.now();
        return summary;
      });

      if (recovered === 'sso') throw new GatewayError(forProduct(SSO_MESSAGE, auth), 'sso-required');
      // A browser sign-in that failed outright (cancelled, timed out) is the user's
      // answer, so surface it instead of silently retrying.
      if (recovered && recovered.error) {
        if (recovered.error instanceof GatewayError) throw recovered.error;
        throw new GatewayError(recovered.error.message, 'sso-required');
      }

      if (!newBody && !replayable(request.body)) {
        throw new GatewayError(forProduct('The network gateway in front of Jira ended this session. It has been re-established — please try again.', auth), 'retry');
      }
    }
  };

  // What each request found is what sessionStatus reports. Only the gateway's verdicts
  // change it: a network failure says nothing about whether the session is still good.
  return async function trackedFetch(url, options) {
    try {
      const response = await jiraFetch(url, options);
      state.status = 'signed-in';
      state.lastError = null;
      return response;
    } catch (err) {
      if (err instanceof GatewayError) {
        state.status = err.code === 'retry' ? 'signed-in' : 'needs-sign-in';
        state.lastError = err.code === 'retry' ? null : err.message;
      }
      throw err;
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

  // Ids share records, and a record needs one ping however many ids lead to it
  const seen = new Set();
  for (const [id, session] of Object.entries(jiraSessions)) {
    if (seen.has(session)) continue;
    seen.add(session);
    // Only browser sessions lapse this way; token auth re-authenticates on every request.
    if (!session.auth || session.auth.authType !== 'sso') continue;
    if (now - (session.lastUsedAt || session.createdAt || 0) > KEEPALIVE_MAX_IDLE_MS) continue;

    try {
      // Deliberately the raw cookie-aware fetch, not jiraFetch: a background ping must
      // never pop a sign-in window at someone who is not looking at the app.
      const headers = { 'Accept': 'application/json' };
      const authHeader = buildAuthHeader(session.auth);
      if (authHeader) headers.Authorization = authHeader;
      const response = await fetchCookie(fetch, session.jar)(`${session.jiraUrl}${identityPath(session.auth)}`, {
        headers,
        redirect: 'follow'
      });
      const state = gatewayStateFor(session.jar);
      if (classifyInterception(response, await response.text())) {
        console.log(`${productName(session.auth)} session ${id.slice(0, 8)}… has lapsed; the next request will ask for a new sign-in.`);
        // Unless a window is already open for it: then the lapse is old news
        if (!state.recovery) state.status = 'needs-sign-in';
      } else {
        refreshed++;
        if (!state.recovery) state.status = 'signed-in';
      }
    } catch (err) {
      // A transient network failure is not worth reporting; try again next tick.
    }
  }

  if (refreshed) saveSessions(); // the gateway may have rolled its cookie
}

// Started by the server rather than on require, so a script that only borrows a helper
// from here (a diagnostic, a test) is not kept alive by the timer.
let keepaliveTimer = null;
function startKeepalive() {
  if (!keepaliveTimer) keepaliveTimer = setInterval(keepSessionsAlive, KEEPALIVE_INTERVAL_MS);
}

module.exports = {
  // the store, for routes that read a session by id
  jiraSessions,
  createSession,
  getSession,
  removeSession,
  sessionStatus,
  saveSessions,
  loadSessions,
  startKeepalive,
  // talking through the gateway
  makeJiraFetch,
  buildAuthHeader,
  classifyInterception,
  identityPath,
  productName,
  GatewayError,
  errorStatus
};
