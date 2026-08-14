#!/usr/bin/env node
/*
 * Answers one question: when Jira stops working, is it the access gateway in front of it,
 * or something else?
 *
 * Probes the Jira URL four ways — with credentials, following redirects or not, and
 * pointedly WITHOUT credentials — and reports what actually answered. The no-credentials
 * probe is the informative one: if it is identical to the authenticated probe, the gateway
 * is discarding the Authorization header before Jira ever sees the request, and no amount
 * of fixing the token will help.
 *
 * Usage:
 *   npm run diagnose                 # uses the Jira URL from the stored session
 *   npm run diagnose -- <jira-url>   # or probe a URL directly
 *
 * Credentials are read from the session store but never printed.
 *
 * Detection is deliberately re-implemented here rather than imported from index.js: this
 * has to be runnable precisely when the server is misbehaving, and requiring index.js
 * would start a server as a side effect.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fetch = require('node-fetch');
const fetchCookie = require('fetch-cookie');
const tough = require('tough-cookie');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SESSION_FILE = path.join(os.homedir(), '.roadmap-runner', 'sessions.json');

function loadNewestSession() {
  if (!fs.existsSync(SESSION_FILE)) return null;
  const sessions = Object.values(JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')));
  if (!sessions.length) return null;
  return sessions.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
}

function buildAuthHeader(auth) {
  if (!auth || auth.authType === 'sso') return null;
  if (auth.authType === 'pat') return 'Bearer ' + auth.jiraToken;
  return 'Basic ' + Buffer.from(`${auth.jiraUser}:${auth.jiraToken}`).toString('base64');
}

function verdict(response, body) {
  // A bare redirect has no body to inspect, so judge it by where it points.
  const location = response.headers.get('location') || '';
  if (response.status >= 300 && response.status < 400) {
    return /\/(my\.policy|vdesk|saml|remote\/logon)/i.test(location)
      ? `GATEWAY: redirected into its sign-on flow (${location})`
      : `redirect to ${location || '(no location header)'}`;
  }

  const contentType = response.headers.get('content-type') || '';
  const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
  if (!isHtml) {
    return body.trim().startsWith('{') || body.trim().startsWith('[')
      ? 'JSON — reached Jira'
      : `not HTML, not JSON (${contentType || 'no content-type'})`;
  }
  if (/Access policy evaluation is already in progress/i.test(body)) {
    return 'GATEWAY: "access policy evaluation already in progress" — competing requests';
  }
  if (/SAMLRequest|login\.microsoftonline\.com/i.test(body)) {
    return 'GATEWAY: SAML redirect to an identity provider — needs an interactive browser sign-in';
  }
  if (/my\.policy|name=["']?(username|password)/i.test(body)) {
    return 'GATEWAY: interactive logon page — a token cannot satisfy this';
  }
  if (/BIG-IP|F5 Networks|\/vdesk\//i.test(body)) {
    return 'GATEWAY: some other F5 BIG-IP page';
  }
  return 'HTML, but it does not identify itself as the gateway';
}

async function probe(label, url, options) {
  const jar = new tough.CookieJar(); // a fresh jar each time, so probes cannot pollute one another
  console.log(`--- ${label}`);
  console.log(`    GET ${url}`);
  try {
    const response = await fetchCookie(fetch, jar)(url, options);
    const body = await response.text();
    const setCookie = response.headers.raw && response.headers.raw()['set-cookie'];
    console.log(`    status      : ${response.status} ${response.statusText}`);
    console.log(`    content-type: ${response.headers.get('content-type') || '(none)'}`);
    if (response.headers.get('location')) console.log(`    location    : ${response.headers.get('location')}`);
    if (setCookie) console.log(`    set-cookie  : ${setCookie.map(c => c.split('=')[0]).join(', ')}`);
    console.log(`    verdict     : ${verdict(response, body)}`);
    console.log();
    return { response, body };
  } catch (err) {
    console.log(`    ERROR       : ${err.message}`);
    console.log(`    verdict     : host unreachable — VPN down, DNS, or the wrong URL`);
    console.log();
    return null;
  }
}

(async () => {
  const session = loadNewestSession();
  const jiraUrl = process.argv[2] || (session && session.jiraUrl);

  if (!jiraUrl) {
    console.error(`No Jira URL given and no stored session at ${SESSION_FILE}.`);
    console.error('Sign in through the app first, or: npm run diagnose -- https://your-jira-host');
    process.exit(1);
  }

  const auth = (session && session.jiraUrl === jiraUrl && session.auth) || null;
  const authHeader = buildAuthHeader(auth);

  console.log('Jira URL   :', jiraUrl);
  if (auth) {
    console.log('Auth type  :', auth.authType, auth.jiraUser ? `(user ${auth.jiraUser})` : '(no username)');
    console.log('Secret     :', auth.jiraToken ? `<${auth.jiraToken.length} chars, not shown>` : '(none — cookie session)');
    console.log('Stored at  :', new Date(session.createdAt).toISOString());
  } else {
    console.log('Auth       : none stored for this URL — probing anonymously');
  }
  console.log();

  const withCredentials = { 'Authorization': authHeader, 'Accept': 'application/json' };
  const anonymous = { 'Accept': 'application/json' };
  // node-fetch would send the literal string "null" for a missing header
  if (!authHeader) delete withCredentials.Authorization;

  const me = `${jiraUrl}/rest/api/2/myself`;
  const authed = await probe('With credentials, redirects NOT followed', me,
    { headers: withCredentials, redirect: 'manual' });
  await probe('With credentials, redirects followed (what the app does)', me,
    { headers: withCredentials, redirect: 'follow' });
  const anon = await probe('WITHOUT credentials — compare this against the first probe', me,
    { headers: anonymous, redirect: 'manual' });
  await probe('Bare host root', jiraUrl, { redirect: 'manual' });

  console.log('=== Conclusion ===');

  if (!authHeader) {
    // Without a token there is nothing to compare, and claiming the gateway "discarded"
    // a header that was never sent would be plain wrong.
    console.log('No token was available to probe with — the stored session signs in through the\n' +
                'browser, so it carries cookies rather than credentials. The probes above show\n' +
                'what the gateway does with an anonymous request; to test whether a token can get\n' +
                'through, re-run against a Jira URL after signing in with a PAT.');
  } else if (authed && anon) {
    const identical = authed.response.status === anon.response.status &&
      authed.response.headers.get('location') === anon.response.headers.get('location');
    console.log(identical
      ? 'The credentialed and anonymous probes are identical, so the gateway is discarding\n' +
        'the Authorization header before Jira sees it. No token will get through — use\n' +
        '"Sign in with browser" in the app.'
      : 'The credentials changed the response, so requests are reaching Jira. If something is\n' +
        'still failing, the problem is with the credentials or with Jira itself, not the gateway.');
  } else {
    console.log('Not enough probes succeeded to draw a conclusion — see the errors above.');
  }
})();
