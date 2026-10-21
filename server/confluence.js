/*
 * Confluence: signing in, and publishing a page bundle (see confluence-sync.js).
 *
 * A Confluence session is an ordinary entry in the session handler (session-manager.js) — the same
 * cookie jar, the same gateway recovery, the same persistence and keepalive — marked
 * `auth.product: 'confluence'` so the gateway code probes Confluence's identity endpoint
 * rather than Jira's. The store's `jiraUrl` field holds the Confluence base URL; it is
 * the name every gateway helper already reads.
 *
 * A publish takes minutes (the first run of a full bundle is a few hundred requests), so
 * it runs as a job the browser polls rather than one request held open.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const tough = require('tough-cookie');
const { v4: uuidv4 } = require('uuid');
const {
  readBundle, summarizeBundle, runSync, resolvePage, searchPages, ConfluenceClient, SyncStopped
} = require('./confluence-sync');
const { tokenFor, afterSignIn, NOT_SAVED } = require('./credentials');
const {
  jiraSessions: sessions, createSession, getSession, removeSession, saveSessions,
  makeJiraFetch: makeFetch, buildAuthHeader, errorStatus
} = require('./session-manager');

const IDENTITY_PATH = '/rest/api/user/current';
const NO_SESSION = 'Invalid or missing Confluence session. Please sign in to Confluence first.';

// The script keeps its state beside itself; here it lives with the sessions, one file per
// server and space. Same shape as the script's, so either can be handed the other's.
const STATE_DIR = path.join(os.homedir(), '.roadmap-runner', 'confluence-sync');

const BUNDLE_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_BUNDLES = 5;
const JOB_TTL_MS = 2 * 60 * 60 * 1000;

// People paste whatever URL is in their address bar. Confluence DC often sits under a
// context path (/confluence), so keep the path — just not the page part of it.
function normalizeBase(raw) {
  let url = String(raw || '').trim();
  const cut = url.search(/\/(display|pages|spaces|wiki\/spaces|plugins|dashboard\.action)(\/|\?|$)/);
  if (cut > 0) url = url.slice(0, cut);
  return url.replace(/[?#].*$/, '').replace(/\/+$/, '');
}

const safeSpace = space => String(space || '').trim();
const validSpace = space => /^[A-Za-z0-9~_-]{1,255}$/.test(space);

function statePathFor(base, space) {
  const u = new URL(base);
  const slug = (u.host + u.pathname).replace(/[^A-Za-z0-9.-]+/g, '_').replace(/_+$/, '');
  return path.join(STATE_DIR, `state-${slug}-${space}.json`);
}

function readState(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeState(file, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(state, null, 1), { mode: 0o600 });
}

function registerConfluenceRoutes(app, { loginWithBrowser, upload }) {
  const bundles = new Map(); // id -> { bundle, summary, createdAt }
  const jobs = new Map();    // id -> job (see startJob)

  const sessionFor = id => getSession(id, 'confluence');

  const clientFor = session => new ConfluenceClient({
    fetch: makeFetch(session.jar, session.jiraUrl, session.auth),
    baseUrl: session.jiraUrl,
    authHeader: buildAuthHeader(session.auth)
  });

  const remember = (jar, base, auth) => createSession({ jar, jiraUrl: base, auth });

  const prune = () => {
    const now = Date.now();
    for (const [id, b] of bundles) if (now - b.createdAt > BUNDLE_TTL_MS) bundles.delete(id);
    while (bundles.size > MAX_BUNDLES) bundles.delete(bundles.keys().next().value);
    for (const [id, j] of jobs) if (j.finishedAt && now - j.finishedAt > JOB_TTL_MS) jobs.delete(id);
  };

  // Activity, which is what decides whether a browser session is kept warm
  app.use('/api/confluence', (req, res, next) => {
    const session = req.body && sessions[req.body.sessionId];
    if (session) session.lastUsedAt = Date.now();
    next();
  });

  app.post('/api/confluence/auth', async (req, res) => {
    const { user, authType = 'pat' } = req.body;
    const base = normalizeBase(req.body.baseUrl);
    // Only a PAT can be saved (see server/credentials.js); a password is always typed
    const token = authType === 'pat' ? tokenFor('confluence', base, req.body) : req.body.token;
    if (authType === 'pat' && !token && req.body.useSaved) {
      return res.status(400).json({ error: NOT_SAVED, code: 'no-saved-token' });
    }
    if (!/^https?:\/\//i.test(base) || !token || (authType === 'basic' && !user)) {
      return res.status(400).json({ error: 'Missing Confluence URL or credentials' });
    }
    if (authType !== 'pat' && authType !== 'basic') {
      return res.status(400).json({ error: `Unknown sign-in method "${authType}"` });
    }
    try {
      const jar = new tough.CookieJar();
      const auth = { product: 'confluence', authType, jiraUser: user, jiraToken: token };
      const me = await clientFor({ jar, jiraUrl: base, auth }).whoami();
      // Bad credentials are not always refused: with anonymous access switched on,
      // Confluence answers as the anonymous user instead.
      if (!me || me.type === 'anonymous') {
        return res.status(401).json({ error: 'Confluence did not accept those credentials.' });
      }
      const sessionId = remember(jar, base, auth);
      if (authType === 'pat') afterSignIn('confluence', base, req.body, token);
      res.json({ sessionId, user: me.displayName || me.username, baseUrl: base });
    } catch (err) {
      res.status(err.status === 401 ? 401 : errorStatus(err)).json({ error: err.message });
    }
  });

  // Same as Jira's browser sign-in, pointed at Confluence. See /api/jira/sso-login for why
  // it listens on the response, and why the session is kept even if nobody is left waiting.
  app.post('/api/confluence/sso-login', async (req, res) => {
    const base = normalizeBase(req.body.baseUrl);
    if (!/^https?:\/\//i.test(base)) return res.status(400).json({ error: 'Missing Confluence URL' });
    const gaveUp = new AbortController();
    res.on('close', () => { if (!res.writableEnded) gaveUp.abort(); });
    try {
      const jar = new tough.CookieJar();
      // The token is optional here; a saved one stands in for a blank field
      const token = tokenFor('confluence', base, req.body);
      const auth = { product: 'confluence', authType: 'sso', jiraToken: token || undefined };
      const summary = await loginWithBrowser(base, jar, {
        authHeader: buildAuthHeader(auth),
        identityPath: IDENTITY_PATH,
        siteName: 'Confluence',
        signal: gaveUp.signal,
        onProgress: where => console.log(`  browser sign-in is at: ${where}`)
      });
      const sessionId = remember(jar, base, auth);
      console.log(`Browser sign-in established a Confluence session for ${summary.user}`);
      if (token) afterSignIn('confluence', base, req.body, token);
      if (!res.writableEnded) res.json({ sessionId, user: summary.user, baseUrl: base });
    } catch (err) {
      if (gaveUp.signal.aborted) return console.log(`Browser sign-in dropped: ${err.message}`);
      res.status(errorStatus(err)).json({ error: err.message });
    }
  });

  app.post('/api/confluence/current-user', async (req, res) => {
    const session = sessionFor(req.body.sessionId);
    if (!session) return res.status(400).json({ error: NO_SESSION });
    try {
      const me = await clientFor(session).whoami();
      if (!me || me.type === 'anonymous') return res.status(401).json({ error: 'Your Confluence sign-in has expired.' });
      res.json({ user: me.displayName || me.username, baseUrl: session.jiraUrl, authType: session.auth.authType });
    } catch (err) {
      res.status(err.status === 401 ? 401 : errorStatus(err)).json({ error: err.message });
    }
  });

  app.post('/api/confluence/logout', (req, res) => {
    if (sessionFor(req.body.sessionId)) removeSession(req.body.sessionId);
    res.json({ ok: true });
  });

  // Where the bundle would land, in words: the space's name, the parent's title, and how
  // many pages an earlier sync has already put there.
  app.post('/api/confluence/target', async (req, res) => {
    const session = sessionFor(req.body.sessionId);
    if (!session) return res.status(400).json({ error: NO_SESSION });
    const space = safeSpace(req.body.space);
    const parentId = String(req.body.parentId || '').trim();
    if (!validSpace(space)) return res.status(400).json({ error: 'Enter a space key, like CST.' });
    try {
      const client = clientFor(session);
      const info = await client.space(space);
      if (!info) return res.status(404).json({ error: `Space ${space} not found, or not visible to you.` });
      let parent = null;
      if (parentId) {
        // An ID, a link or a title; what the user meant, or why it could not be found
        const page = await resolvePage(client, info.key, parentId);
        parent = { id: page.id, title: page.title };
      }
      const state = readState(statePathFor(session.jiraUrl, info.key));
      res.json({
        space: { key: info.key, name: info.name },
        parent,
        tracked: state && state.pages ? Object.keys(state.pages).length : 0
      });
    } catch (err) {
      res.status(err.status === 400 || err.status === 404 ? err.status : errorStatus(err)).json({ error: err.message });
    }
  });

  // The Parent page picker's suggestions, as the user types
  app.post('/api/confluence/search-pages', async (req, res) => {
    const session = sessionFor(req.body.sessionId);
    if (!session) return res.status(400).json({ error: NO_SESSION });
    const space = safeSpace(req.body.space);
    if (!validSpace(space)) return res.status(400).json({ error: 'Enter a space key, like CST.' });
    try {
      res.json({ pages: await searchPages(clientFor(session), space, req.body.query) });
    } catch (err) {
      res.status(err.status === 401 ? 401 : errorStatus(err)).json({ error: err.message });
    }
  });

  // The bundle comes up as the files of a folder picked in the browser, with their paths
  // alongside (multipart filenames lose their directories on the way through).
  app.post('/api/confluence/bundle', upload.array('files'), (req, res) => {
    try {
      const paths = JSON.parse(req.body.paths || '[]');
      const files = req.files || [];
      if (!files.length) return res.status(400).json({ error: 'The folder was empty.' });
      const bundle = readBundle(files.map((f, i) => ({ path: paths[i] || f.originalname, buffer: f.buffer })));
      const summary = summarizeBundle(bundle);
      prune();
      const bundleId = uuidv4();
      bundles.set(bundleId, { bundle, summary, createdAt: Date.now() });
      res.json({ bundleId, summary });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/confluence/sync', (req, res) => {
    const session = sessionFor(req.body.sessionId);
    if (!session) return res.status(400).json({ error: NO_SESSION });
    const entry = bundles.get(req.body.bundleId);
    if (!entry) return res.status(400).json({ error: 'The bundle is no longer on the server. Pick the folder again.' });
    const space = safeSpace(req.body.space);
    if (!validSpace(space)) return res.status(400).json({ error: 'Enter a space key, like CST.' });
    if (entry.bundle.problems.length && !req.body.dryRun) {
      return res.status(400).json({ error: `The bundle has ${entry.bundle.problems.length} problem(s); fix them before publishing.` });
    }

    const statePath = statePathFor(session.jiraUrl, space);
    const busy = [...jobs.values()].find(j => j.statePath === statePath && !j.finishedAt);
    if (busy) {
      return res.status(409).json({ error: `A ${busy.dryRun ? 'preview' : 'publish'} to ${space} is already running.`, jobId: busy.id });
    }

    const job = {
      id: uuidv4(),
      statePath,
      dryRun: !!req.body.dryRun,
      status: 'running',
      log: [],
      pages: {},
      stats: null,
      orphans: [],
      clashes: [],
      error: null,
      stop: false,
      startedAt: Date.now(),
      finishedAt: null
    };
    jobs.set(job.id, job);
    const say = (level, text) => {
      job.log.push({ at: Date.now(), level, text });
      if (level !== 'change') console.log(`[confluence ${space}] ${text}`);
    };

    const base = session.jiraUrl;
    let state = readState(statePath);
    if (state && state._base && state._base !== base) {
      // Cannot happen with per-server file names, unless someone copied a file in by hand
      state = null;
    }
    if (!state) {
      const seed = entry.bundle.stateFiles[space];
      if (seed && (!seed._base || seed._base.replace(/\/+$/, '') === base)) {
        state = seed;
        say('info', `Using the page ids from .cst-sync-state-${space}.json in the chosen folder.`);
      } else {
        state = {};
      }
    }
    state._base = base;

    const options = {
      space,
      parentId: String(req.body.parentId || '').trim() || null,
      dryRun: job.dryRun,
      only: Array.isArray(req.body.only) ? req.body.only : null,
      force: !!req.body.force,
      adoptExisting: !!req.body.adoptExisting,
      trashOrphans: !!req.body.trashOrphans
    };

    runSync({
      client: clientFor(session),
      bundle: entry.bundle,
      state,
      options,
      saveState: s => writeState(statePath, s),
      onLog: say,
      onPage: (key, action, detail) => { job.pages[key] = { action, detail: detail || null }; },
      stopped: () => job.stop
    })
      .then(result => {
        job.stats = result.stats;
        job.orphans = result.orphans;
        job.status = 'done';
      })
      .catch(err => {
        job.status = err instanceof SyncStopped ? 'stopped' : 'failed';
        job.error = err.message;
        job.clashes = err.clashes || [];
        say(job.status === 'stopped' ? 'warn' : 'error', err.message);
      })
      .finally(() => {
        job.finishedAt = Date.now();
        // A browser session's cookies may have rolled during a long run
        if (session.auth.authType === 'sso') saveSessions();
      });

    res.json({ jobId: job.id });
  });

  // `since` is how much of the transcript the browser already has, so each poll carries
  // only what is new. The per-page decisions are small enough to send whole.
  app.post('/api/confluence/sync-status', (req, res) => {
    const job = jobs.get(req.body.jobId);
    if (!job) return res.status(404).json({ error: 'That sync is no longer known to the server.' });
    const since = Math.max(0, Number(req.body.since) || 0);
    res.json({
      id: job.id,
      dryRun: job.dryRun,
      status: job.status,
      log: job.log.slice(since),
      logLength: job.log.length,
      pages: job.pages,
      stats: job.stats,
      orphans: job.orphans,
      clashes: job.clashes,
      error: job.error,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt
    });
  });

  // Stops between pages, never part-way through one, so no page is left without its
  // labels or images.
  app.post('/api/confluence/sync-stop', (req, res) => {
    const job = jobs.get(req.body.jobId);
    if (job && !job.finishedAt) job.stop = true;
    res.json({ ok: true });
  });
}

module.exports = { registerConfluenceRoutes, normalizeBase, IDENTITY_PATH };
