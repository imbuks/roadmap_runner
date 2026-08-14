/*
 * Signing in to Jira through a real browser.
 *
 * When Jira is published through a gateway that insists on interactive single sign-on
 * (a SAML round trip to an identity provider, usually with MFA), no Authorization header
 * can get through — the gateway rejects the request a layer above anything Jira would
 * accept. The only thing that satisfies such a policy is a browser, so open one, let the
 * user sign in, and lift the resulting cookies into the caller's jar. From then on the
 * ordinary REST calls carry a gateway session and are proxied through to Jira as normal.
 *
 * This is the user's own account on their own machine: the browser does exactly what it
 * would do if they visited Jira themselves. Nothing here bypasses the access policy — it
 * satisfies it, then reuses the session that legitimately produced.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SSO_LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // generous: MFA prompts can be slow

// The gateway's own session cookies, as opposed to Jira's.
const GATEWAY_COOKIE_RE = /^(MRHSession|LastMRH_Session|MRHSHint|F5_|TIN)/i;

/*
 * The sign-in browser keeps a profile directory of its own.
 *
 * Without one, every sign-in starts from a blank browser, so the identity provider has no
 * idea who you are and puts you through the full login and MFA each time — even when the
 * gateway session lapsed only minutes ago. With a persistent profile the IdP's own "stay
 * signed in" cookie survives, and re-establishing a lapsed gateway session is usually
 * silent: the window opens, bounces through, and closes on its own.
 *
 * It sits beside the session store, under the same 0700 permissions, because it holds an
 * identity-provider session and deserves the same care as the cookies it produces.
 *
 * ROADMAP_BROWSER_PROFILE moves it elsewhere. The Docker image sets it, because a profile
 * written by one platform's Chromium is not safe to reopen with another's — the container
 * shares the session store with the host but keeps a profile of its own.
 */
const PROFILE_DIR = process.env.ROADMAP_BROWSER_PROFILE
  || path.join(os.homedir(), '.roadmap-runner', 'browser-profile');

function requirePlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    throw new Error(
      'Browser sign-in needs Playwright. Install it with: npm install playwright && npx playwright install chromium'
    );
  }
}

// A visible browser with a profile that persists between sign-ins.
async function launchSignInBrowser() {
  const { chromium } = requirePlaywright();
  fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 });
  // mkdirSync only applies its mode when it creates the directory, so tighten explicitly
  fs.chmodSync(PROFILE_DIR, 0o700);
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    // Mirrors this server's TLS posture, so a corporate interception certificate does
    // not block the sign-in.
    ignoreHTTPSErrors: true,
    viewport: null
  });
  return { context, dispose: () => context.close() };
}

// Copy one Playwright cookie into a tough-cookie jar, preserving the attributes that
// decide whether it will be sent back (domain, path, secure, expiry).
function copyCookieToJar(jar, cookie) {
  const attributes = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path || '/'}`];
  // A leading dot means the cookie is valid for subdomains too; without the explicit
  // Domain attribute tough-cookie would pin it to the exact host we set it from.
  if (cookie.domain && cookie.domain.startsWith('.')) attributes.push(`Domain=${cookie.domain}`);
  if (cookie.secure) attributes.push('Secure');
  if (cookie.httpOnly) attributes.push('HttpOnly');
  if (cookie.expires && cookie.expires > 0) {
    attributes.push(`Expires=${new Date(cookie.expires * 1000).toUTCString()}`);
  }
  const host = (cookie.domain || '').replace(/^\./, '');
  const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`;
  return new Promise(resolve => {
    // ignoreError: a jar-level rejection of one cookie must not abort the whole capture
    jar.setCookie(attributes.join('; '), url, { ignoreError: true }, () => resolve());
  });
}

// Paths that mean the browser is still inside the gateway's own sign-on flow rather than
// looking at Jira.
const SSO_PATH_RE = /\/(my\.policy|vdesk|saml|remote\/logon)/i;

/**
 * Has the browser reached Jira yet?
 *
 * Deliberately does NOT go by the gateway's session cookie: APM issues MRHSession on the
 * very first request, long before anyone has authenticated, so treating it as progress
 * reads as "signed in" the instant the window opens.
 *
 * Instead: is any open tab sitting on the Jira origin, outside the sign-on paths?
 */
function looksLikeJira(pages, origin) {
  return pages.some(page => {
    try {
      const url = new URL(page.url());
      return url.origin === origin && !SSO_PATH_RE.test(url.pathname);
    } catch (err) {
      return false; // about:blank and friends
    }
  });
}

/**
 * Ask Jira who we are, using the browser context's own cookies but WITHOUT navigating
 * any visible page — the user may be part-way through an MFA prompt, and stealing the
 * page out from under them is exactly what must not happen.
 *
 * `authHeader`, when supplied, is what lets the second sign-in be skipped. The gateway and
 * Jira authenticate independently: the browser session satisfies the gateway, and a Jira
 * token satisfies Jira. Sending both means that as soon as the gateway lets us through,
 * Jira answers — no need to wait for the user to log into Jira as well.
 */
async function probeIdentity(context, jiraUrl, authHeader) {
  try {
    const headers = { Accept: 'application/json' };
    if (authHeader) headers.Authorization = authHeader;
    const response = await context.request.get(`${jiraUrl}/rest/api/2/myself`, {
      headers,
      failOnStatusCode: false,
      timeout: 15000
    });
    const me = JSON.parse(await response.text());
    return me && (me.name || me.accountId || me.displayName) ? me : null;
  } catch (err) {
    return null; // HTML from the gateway, a redirect chain, a timeout: all "not yet"
  }
}

/**
 * Open a browser at the Jira URL, wait for the user to complete SSO, and seed `jar` with
 * the cookies that result. Resolves with { user, cookies }; rejects if the user closes
 * the window or the timeout elapses first.
 *
 * `launch` exists so tests can supply a browser they also drive; it returns
 * { context, dispose }. In normal use it is a visible Chromium with a persistent profile,
 * because the whole point is that a human interacts with it.
 */
async function loginWithBrowser(jiraUrl, jar, { timeoutMs = SSO_LOGIN_TIMEOUT_MS, launch, onProgress, authHeader } = {}) {
  const report = onProgress || (() => {});
  const origin = new URL(jiraUrl).origin;
  const { context, dispose } = await (launch || launchSignInBrowser)();
  try {
    // A persistent context opens with a blank page already; reuse it rather than leaving
    // an empty window alongside the real one.
    const page = context.pages().find(p => !p.isClosed()) || await context.newPage();
    await page.goto(jiraUrl, { waitUntil: 'domcontentloaded' });

    const deadline = Date.now() + timeoutMs;
    let lastReported = '';
    while (Date.now() < deadline) {
      // The identity provider often opens its own tab, so consider all of them; only an
      // empty context means the user actually gave up and closed the window.
      const pages = context.pages().filter(p => !p.isClosed());
      if (!pages.length) throw new Error('Browser sign-in was cancelled — the window was closed.');

      const where = pages.map(p => p.url()).join(' | ');
      if (where !== lastReported) {
        lastReported = where;
        report(where);
      }

      if (looksLikeJira(pages, origin)) {
        // Try the token first: if it works we are done the moment the gateway relents,
        // and the user never sees Jira's own login page. Falling back to the bare probe
        // keeps this working when there is no token, or the gateway strips the header.
        const me = (authHeader && await probeIdentity(context, jiraUrl, authHeader))
          || await probeIdentity(context, jiraUrl);
        if (me) {
          const captured = await context.cookies();
          for (const cookie of captured) await copyCookieToJar(jar, cookie);
          return {
            user: me.displayName || me.name,
            cookies: captured.filter(c => GATEWAY_COOKIE_RE.test(c.name)).map(c => c.name)
          };
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Browser sign-in timed out before the Jira session was established.');
  } finally {
    await Promise.resolve(dispose()).catch(() => {});
  }
}

module.exports = {
  loginWithBrowser,
  copyCookieToJar,
  GATEWAY_COOKIE_RE,
  SSO_LOGIN_TIMEOUT_MS,
  PROFILE_DIR
};
