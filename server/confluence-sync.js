/*
 * Publish a page bundle to Confluence Data Center / Server.
 *
 * A port of cst-confluence-sync/push_to_confluence.py, kept deliberately interchangeable
 * with it: the same bundle (manifest.json + storage-format pages + attachments), the same
 * `cst-sync` label, the same `cst-sync:<hash>` version comment computed over the same
 * bytes, and the same state file shape. A space first published by the script is picked up
 * here as "unchanged" rather than republished, and either can take over from the other.
 *
 * Safe to re-run: unchanged pages are skipped, changed pages get a new version, renamed
 * pages are tracked by key, and pages it did not create are never taken over unless asked.
 *
 * Nothing here knows about sessions or HTTP routes — it is handed a fetch and reports
 * through callbacks, so it can be driven by the server or by a script against a stub.
 */
const crypto = require('crypto');
const path = require('path');

const TAG = 'cst-sync:';
const SYNC_LABEL = 'cst-sync';
// Labels the bundle owns: one that has dropped out of the manifest is removed from the
// page. Anything else on the page was put there by a person and is left alone.
const MANAGED_PREFIXES = ['cst-', 'actor-', 'status-', 'provenance-', 'app-', 'release-', 'no-use-case'];
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

/*
 * --- Hashing, byte-compatible with the Python script -------------------------------------
 *
 * The digest is what decides "unchanged", so it has to agree with the script's to the
 * byte. That means reproducing two Python-isms: json.dumps(list) — ", " between items and
 * non-ASCII escaped as \uXXXX — and str(None) for a page with no parent.
 */
function pyJsonString(s) {
  return '"' + String(s).replace(/[\\"\u0000-\u001f\u007f-￿]/g, ch => {
    switch (ch) {
      case '"': return '\\"';
      case '\\': return '\\\\';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\t': return '\\t';
      case '\b': return '\\b';
      case '\f': return '\\f';
      default: return '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0');
    }
  }) + '"';
}

const pyJsonList = items => '[' + items.map(pyJsonString).join(', ') + ']';
const pyStr = value => (value === null || value === undefined ? 'None' : String(value));

function sha(...chunks) {
  const h = crypto.createHash('sha256');
  chunks.forEach(c => h.update(Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8')));
  return h.digest('hex').slice(0, 16);
}

// Python's read_text() uses universal newlines, so the script hashes and sends the body
// with \r\n folded to \n. Doing the same keeps the digest — and the page — identical.
const readText = buffer => buffer.toString('utf8').replace(/\r\n?/g, '\n');

const labelNames = content =>
  new Set(((content && content.metadata && content.metadata.labels && content.metadata.labels.results) || [])
    .map(l => l.name));

/*
 * --- The bundle ---------------------------------------------------------------------------
 *
 * Arrives as a flat list of { path, buffer } — a folder picked in the browser, so every
 * path carries whatever folder the user chose as its first segment. The bundle's root is
 * wherever manifest.json sits, so picking `bundle/` itself or the folder around it both work.
 */
function readBundle(uploads) {
  const norm = p => String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const entries = uploads.map(u => ({ path: norm(u.path), buffer: u.buffer }));

  const manifests = entries
    .filter(e => path.posix.basename(e.path) === 'manifest.json')
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  if (!manifests.length) {
    throw new Error('No manifest.json in the chosen folder. Pick the bundle folder (the one holding manifest.json, pages/ and images/).');
  }

  let manifest;
  try {
    manifest = JSON.parse(manifests[0].buffer.toString('utf8'));
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${err.message}`);
  }
  if (!manifest || !Array.isArray(manifest.pages)) {
    throw new Error('manifest.json has no "pages" list, so this is not a sync bundle.');
  }

  const rootDir = path.posix.dirname(manifests[0].path);
  const prefix = rootDir === '.' ? '' : rootDir + '/';
  const files = new Map();
  entries.forEach(e => {
    if (e.path.startsWith(prefix)) files.set(e.path.slice(prefix.length), e.buffer);
  });

  // The script keeps its state file beside the bundle, so a user who picks the folder
  // around the bundle hands us the page ids the script has been tracking. Worth keeping:
  // without it a page renamed since the script last ran would be created a second time.
  const parentDir = rootDir === '.' ? '' : path.posix.dirname(rootDir);
  const statePrefix = parentDir && parentDir !== '.' ? parentDir + '/' : '';
  const stateFiles = {};
  entries.forEach(e => {
    const rel = statePrefix ? (e.path.startsWith(statePrefix) ? e.path.slice(statePrefix.length) : null) : e.path;
    const m = rel && /^\.cst-sync-state-([^/]+)\.json$/.exec(rel);
    if (!m) return;
    try {
      stateFiles[m[1]] = JSON.parse(e.buffer.toString('utf8'));
    } catch (err) {
      // A corrupt state file is simply not used
    }
  });

  const problems = [];
  const keys = new Set();
  manifest.pages.forEach((p, i) => {
    if (!p || !p.key || !p.title || !p.body) {
      problems.push(`Entry ${i + 1} in manifest.json is missing its key, title or body.`);
      return;
    }
    if (keys.has(p.key)) problems.push(`Page key "${p.key}" appears twice.`);
    if (p.parent && !keys.has(p.parent)) {
      // The script publishes in manifest order, so a parent must come before its children
      problems.push(`"${p.key}" names parent "${p.parent}", which is not listed before it.`);
    }
    keys.add(p.key);
    if (!files.has(p.body)) problems.push(`"${p.key}": ${p.body} is not in the folder.`);
    (p.attachments || []).forEach(a => {
      if (!files.has(a)) problems.push(`"${p.key}": attachment ${a} is not in the folder.`);
    });
  });

  return { manifest, files, stateFiles, problems };
}

function summarizeBundle(bundle) {
  const { manifest, files } = bundle;
  const attachments = new Set();
  manifest.pages.forEach(p => (p.attachments || []).forEach(a => attachments.add(a)));
  let bytes = 0;
  files.forEach(b => { bytes += b.length; });
  return {
    generated: manifest.generated || null,
    source: manifest.source || null,
    pageCount: manifest.pages.length,
    attachmentCount: attachments.size,
    bytes,
    problems: bundle.problems,
    stateFileSpaces: Object.keys(bundle.stateFiles),
    pages: manifest.pages.map(p => ({
      key: p.key,
      title: p.title,
      parent: p.parent || null,
      labels: p.labels || [],
      attachments: (p.attachments || []).length
    }))
  };
}

/*
 * --- Confluence REST ----------------------------------------------------------------------
 */
class ConfluenceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// Confluence words its refusals as { message } (sometimes nested under data.errors).
// Those words are what tells the user why, so prefer them over a raw dump.
function confluenceMessage(text) {
  try {
    const body = JSON.parse(text);
    const nested = body && body.data && Array.isArray(body.data.errors)
      ? body.data.errors.map(e => (e.message && (e.message.translation || e.message.key)) || '').filter(Boolean)
      : [];
    return [body.message, ...nested].filter(Boolean).join(' — ') || text.slice(0, 800);
  } catch (err) {
    return String(text || '').slice(0, 800);
  }
}

const HINTS = {
  401: 'The token is wrong or expired, or the browser session has lapsed.',
  403: 'Your account cannot do this in the space (it needs permission to add pages, add attachments and edit).'
};

class ConfluenceClient {
  /**
   * `fetch` is a jiraFetch-shaped function: it resolves to { ok, status, text() } and is
   * expected to deal with the network gateway itself.
   */
  constructor({ fetch, baseUrl, authHeader, sleep }) {
    this.fetch = fetch;
    this.base = String(baseUrl).replace(/\/+$/, '');
    this.authHeader = authHeader;
    this.sleep = sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async call(method, apiPath, { data, params, raw, headers, ok404 } = {}) {
    let url = this.base + apiPath;
    if (params) url += '?' + new URLSearchParams(params).toString();
    const h = { Accept: 'application/json', Authorization: this.authHeader };
    let body;
    if (data !== undefined) {
      body = JSON.stringify(data);
      h['Content-Type'] = 'application/json';
    }
    if (raw !== undefined) body = raw;
    // Cookie-authenticated writes (a browser session) must opt out of Confluence's XSRF
    // check, and multipart ones always must; for token auth it is simply ignored.
    if (method !== 'GET') h['X-Atlassian-Token'] = 'no-check';
    Object.assign(h, headers);

    for (let attempt = 0; ; attempt++) {
      const response = await this.fetch(url, { method, headers: h, body, redirect: 'follow' });
      const text = await response.text();
      if (response.ok) {
        try {
          return text ? JSON.parse(text) : {};
        } catch (err) {
          return {};
        }
      }
      if (response.status === 404 && ok404) return null;
      if (RETRY_STATUSES.has(response.status) && attempt < 3) {
        await this.sleep(2000 * (attempt + 1));
        continue;
      }
      const hint = HINTS[response.status] ? `\n${HINTS[response.status]}` : '';
      throw new ConfluenceError(
        `HTTP ${response.status} on ${method} ${apiPath}: ${confluenceMessage(text)}${hint}`,
        response.status
      );
    }
  }

  // ---- reads
  whoami() {
    return this.call('GET', '/rest/api/user/current');
  }

  space(key) {
    return this.call('GET', `/rest/api/space/${encodeURIComponent(key)}`, { ok404: true });
  }

  get(id) {
    return this.call('GET', `/rest/api/content/${encodeURIComponent(id)}`,
      { params: { expand: 'version,ancestors,metadata.labels,space' }, ok404: true });
  }

  async find(space, title) {
    const r = await this.call('GET', '/rest/api/content', {
      params: { spaceKey: space, title, type: 'page', expand: 'version,ancestors,metadata.labels' }
    });
    return (r.results || [])[0] || null;
  }

  // CQL, for what the content endpoint cannot ask: a title in any space, or titles that
  // are merely close. A query Confluence rejects (CQL is fussy about some characters) is
  // treated as finding nothing, since these only ever feed a suggestion.
  async search(cql, limit = 5, expand = 'space') {
    try {
      const r = await this.call('GET', '/rest/api/content/search', { params: { cql, limit, expand } });
      return r.results || [];
    } catch (err) {
      if (err.status === 400) return [];
      throw err;
    }
  }

  async labels(id) {
    const r = await this.call('GET', `/rest/api/content/${id}/label`, { params: { limit: 200 } });
    return new Set((r.results || []).map(x => x.name));
  }

  async attachments(id) {
    const r = await this.call('GET', `/rest/api/content/${id}/child/attachment`,
      { params: { limit: 200, expand: 'metadata' } });
    const byTitle = {};
    (r.results || []).forEach(a => { byTitle[a.title] = a; });
    return byTitle;
  }

  // ---- writes
  create(space, title, parentId, body, msg) {
    const data = {
      type: 'page', title, space: { key: space },
      body: { storage: { value: body, representation: 'storage' } },
      version: { message: msg }
    };
    if (parentId) data.ancestors = [{ id: String(parentId) }];
    return this.call('POST', '/rest/api/content', { data });
  }

  update(page, title, parentId, body, msg) {
    const data = {
      id: page.id, type: 'page', title,
      body: { storage: { value: body, representation: 'storage' } },
      version: { number: page.version.number + 1, message: msg }
    };
    if (parentId) data.ancestors = [{ id: String(parentId) }];
    return this.call('PUT', `/rest/api/content/${page.id}`, { data });
  }

  addLabels(id, names) {
    if (!names.length) return null;
    return this.call('POST', `/rest/api/content/${id}/label`,
      { data: [...names].sort().map(name => ({ prefix: 'global', name })) });
  }

  removeLabel(id, name) {
    return this.call('DELETE', `/rest/api/content/${id}/label`, { params: { name }, ok404: true });
  }

  // Built as one Buffer rather than a form-data stream: a Buffer can be sent again, so
  // when the gateway bounces an upload it is retried like any other call.
  upload(id, fileName, buffer, contentType, comment, existingId) {
    const boundary = crypto.randomBytes(16).toString('hex');
    const parts = [];
    [['comment', comment], ['minorEdit', 'true']].forEach(([k, v]) => {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    });
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`));
    parts.push(buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    let url = `/rest/api/content/${id}/child/attachment`;
    if (existingId) url += `/${existingId}/data`;
    return this.call('POST', url, {
      raw: Buffer.concat(parts),
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
    });
  }

  trash(id) {
    return this.call('DELETE', `/rest/api/content/${id}`, { ok404: true });
  }
}

const CONTENT_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.pdf': 'application/pdf'
};
const contentTypeFor = name => CONTENT_TYPES[path.extname(name).toLowerCase()] || 'application/octet-stream';

class SyncStopped extends Error {}

const cqlString = text => '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

// People type a hyphen where Confluence titles often have an en or em dash
function dashVariants(title) {
  const variants = [title];
  if (/ - /.test(title)) variants.push(title.replace(/ - /g, ' – '), title.replace(/ - /g, ' — '));
  return variants;
}

/**
 * Pages in `space` for the Parent page picker: titles containing what has been typed so
 * far (the last word as a prefix, since it is usually half-typed), or with nothing typed,
 * the pages most recently changed. An ID is looked up directly. Each comes with the
 * titles above it, which is what tells two "Features" pages apart.
 */
async function searchPages(client, space, query, limit = 15) {
  const text = String(query || '').trim();
  const results = [];
  if (/^\d+$/.test(text)) {
    const page = await client.get(text);
    if (page && (!page.space || page.space.key.toUpperCase() === space.toUpperCase())) results.push(page);
  }

  // Lucene syntax characters in a title would only make CQL refuse the query
  const words = text.replace(/[^\p{L}\p{N}\s]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const inSpace = `type = page and space = ${cqlString(space)}`;
  const expand = 'space,ancestors';
  if (!words.length) {
    results.push(...await client.search(`${inSpace} order by lastmodified desc`, limit, expand));
  } else {
    let found = await client.search(`${inSpace} and title ~ ${cqlString(words.join(' ') + '*')}`, limit, expand);
    // A wildcard is not welcome everywhere; the plain words are the fallback
    if (!found.length) found = await client.search(`${inSpace} and title ~ ${cqlString(words.join(' '))}`, limit, expand);
    results.push(...found);
  }

  const seen = new Set();
  return results
    .filter(p => !seen.has(p.id) && seen.add(p.id))
    .map(p => ({ id: String(p.id), title: p.title, path: (p.ancestors || []).map(a => a.title).filter(Boolean) }));
}

/**
 * Find the page the user means by whatever they put in the Parent page field: its ID, a
 * link (?pageId=, /pages/<id>/, or /display/SPACE/Title, which carries no ID at all), or
 * its title. Resolves with the page, or rejects saying what was looked for and — where
 * it can tell — what the user probably meant.
 */
async function resolvePage(client, space, input) {
  const text = String(input || '').trim();
  if (!text) return null;

  let id = null;
  let title = null;
  const byId = /^\d+$/.test(text) ? [null, text] : (/[?&]pageId=(\d+)/.exec(text) || /\/pages\/(\d+)(?:[/?#]|$)/.exec(text));
  if (byId) {
    id = byId[1];
  } else {
    const display = /\/display\/([^/?#]+)\/([^?#]+)/.exec(text);
    if (display) {
      const linkSpace = decodeURIComponent(display[1]);
      if (linkSpace.toUpperCase() !== space.toUpperCase()) {
        throw new ConfluenceError(`That link is to a page in space ${linkSpace}, not ${space}.`, 400);
      }
      title = decodeURIComponent(display[2].replace(/\+/g, ' '));
    } else if (/^https?:\/\//i.test(text)) {
      throw new ConfluenceError("That link does not say which page it is. Use the page's ID (… → Page Information) or its exact title.", 400);
    } else {
      title = text;
    }
  }

  if (id) {
    const page = await client.get(id);
    if (!page) throw new ConfluenceError(`Page ${id} not found, or not visible to you.`, 404);
    if (page.space && page.space.key.toUpperCase() !== space.toUpperCase()) {
      throw new ConfluenceError(`Page ${id} ("${page.title}") is in space ${page.space.key}, not ${space}.`, 400);
    }
    return page;
  }

  for (const variant of dashVariants(title)) {
    const found = await client.find(space, variant);
    if (found) return found;
  }

  // Not in this space under that title. Say why, as precisely as Confluence lets us.
  const elsewhere = await client.search(`type = page and title = ${cqlString(title)}`);
  if (elsewhere.length && elsewhere[0].space) {
    const other = elsewhere[0].space.key;
    throw new ConfluenceError(`"${title}" is in space ${other}, not ${space}. Change the space key to ${other}, or choose a page in ${space}.`, 404);
  }
  const similar = await client.search(`type = page and space = ${cqlString(space)} and title ~ ${cqlString(title)}`);
  const names = similar.map(p => `"${p.title}"`);
  throw new ConfluenceError(
    `No page titled "${title}" in space ${space}.` +
    (names.length ? ` Did you mean ${names.length === 1 ? names[0] : `one of ${names.join(', ')}`}?` : '') +
    " A title has to match exactly; the page's ID always works.", 404);
}

/**
 * Run one sync. Mirrors the script's main() step for step.
 *
 *   state      { _base, pages: { key: pageId } } — mutated in place, and handed to
 *              saveState after every page written, as the script does, so a run that
 *              dies halfway still remembers what it created.
 *   onLog      (level, text) for the transcript
 *   onPage     (key, action, detail) as each page is decided: create, update, unchanged,
 *              clash, failed
 *   stopped    () => true to stop between pages
 *
 * Resolves with { stats, orphans, clashes }. A clash or a refused write rejects, as the
 * script exits — with the pages already written left written and remembered.
 */
async function runSync({ client, bundle, state, options, saveState, onLog, onPage, stopped }) {
  const { space, dryRun, force, adoptExisting, trashOrphans } = options;
  const only = options.only && options.only.length ? new Set(options.only) : null;
  const log = onLog || (() => {});
  const mark = onPage || (() => {});
  const save = saveState || (() => {});
  const checkStop = () => {
    if (stopped && stopped()) throw new SyncStopped('Stopped. Pages already written are kept and remembered.');
  };

  const pages = bundle.manifest.pages;
  const keys = new Set(pages.map(p => p.key));
  const ids = state.pages || (state.pages = {});
  const selected = pages.filter(p => !only || only.has(p.key));
  if (only) {
    const unknown = [...only].filter(k => !keys.has(k));
    if (unknown.length) log('warn', `Not in the bundle, so skipped: ${unknown.join(', ')}`);
  }

  const me = await client.whoami();
  if (!me || me.type === 'anonymous') {
    throw new ConfluenceError('Confluence treats this session as anonymous. Sign in again.', 401);
  }
  log('info', `Connected as ${me.displayName || me.username}. Space ${space}. Bundle built ${bundle.manifest.generated || 'at an unknown time'}.${dryRun ? '  PREVIEW — nothing will be written.' : ''}`);

  const spaceInfo = await client.space(space);
  if (!spaceInfo) throw new ConfluenceError(`Space ${space} not found or not visible to you.`, 404);
  // The field may hold a title or a link; from here on it is the page's ID
  let parentId = null;
  if (options.parentId) {
    const parentPage = await resolvePage(client, space, options.parentId);
    parentId = parentPage.id;
    log('info', `The home page goes under "${parentPage.title}" (page id ${parentId}).`);
  }

  // Preflight: before writing anything, make sure no page we would create clashes with a
  // page someone else owns in the space. What each lookup finds is kept for the main pass,
  // which would otherwise ask Confluence the same question again for every page.
  log('info', `Checking ${selected.length} page${selected.length === 1 ? '' : 's'} against the space…`);
  const known = new Map(); // key -> the Confluence page we will write to, or null to create
  const clashes = [];
  for (const p of selected) {
    checkStop();
    if (ids[p.key]) {
      const page = await client.get(ids[p.key]);
      if (page) {
        known.set(p.key, page);
        continue;
      }
    }
    const found = await client.find(space, p.title);
    if (found) {
      if (!labelNames(found).has(SYNC_LABEL) && !adoptExisting) {
        clashes.push({ key: p.key, title: p.title, id: found.id });
        mark(p.key, 'clash', `page id ${found.id}`);
        continue;
      }
      known.set(p.key, await client.get(found.id));
    } else {
      known.set(p.key, null);
    }
  }
  if (clashes.length) {
    const list = clashes.map(c => `  '${c.title}' (page id ${c.id})`).join('\n');
    const err = new ConfluenceError(
      `These pages already exist in space ${space} and were not created by this sync:\n${list}\n` +
      'Nothing was changed. Rename or move them, or turn on "Take over same-titled pages".', 409);
    err.clashes = clashes;
    throw err;
  }

  // Publishing part of a bundle: a selected page whose parent is neither selected nor
  // already in Confluence has nowhere to go. Find that out now, not halfway through.
  if (only) {
    const byKey = new Map(pages.map(p => [p.key, p]));
    const placed = new Map(); // parent key -> whether it is in Confluence
    const needed = new Map(); // parent key -> titles of selected pages waiting on it
    for (const p of selected) {
      if (!p.parent || only.has(p.parent)) continue;
      if (!placed.has(p.parent)) {
        checkStop();
        let there = !!(ids[p.parent] && await client.get(ids[p.parent]));
        const parentPage = byKey.get(p.parent);
        if (!there && parentPage) {
          const found = await client.find(space, parentPage.title);
          if (found && (labelNames(found).has(SYNC_LABEL) || adoptExisting)) {
            ids[p.parent] = found.id; // an earlier sync made it; remember it as ours
            there = true;
          }
        }
        placed.set(p.parent, there);
      }
      if (!placed.get(p.parent)) {
        if (!needed.has(p.parent)) needed.set(p.parent, []);
        needed.get(p.parent).push(p.title);
        mark(p.key, 'blocked', `Its parent "${(byKey.get(p.parent) || {}).title || p.parent}" is not in Confluence yet`);
      }
    }
    if (needed.size) {
      const list = [...needed].map(([key, children]) =>
        `  "${(byKey.get(key) || {}).title || key}" (needed by ${children.length} selected page${children.length === 1 ? '' : 's'})`).join('\n');
      throw new ConfluenceError(
        `Some selected pages would go under a page that is not in Confluence yet. Select these too:\n${list}\nNothing was changed.`, 409);
    }
  }

  const stats = { created: 0, updated: 0, unchanged: 0, attachments: 0 };
  for (const p of selected) {
    checkStop();
    const body = readText(bundle.files.get(p.body));
    const files = (p.attachments || []).map(a => ({ name: path.posix.basename(a), buffer: bundle.files.get(a) }));
    const labels = p.labels || [];
    const parent = p.parent || null;
    const pageParent = parent === null ? parentId : ids[parent];
    if (parent && !pageParent && !dryRun) {
      throw new ConfluenceError(`Parent ${parent} of ${p.key} has no page id yet. Publish it first.`, 409);
    }
    const digest = sha(p.title, body, pyJsonList(labels), pyStr(parent), ...files.map(f => f.buffer));
    const msg = TAG + digest;

    let page = known.get(p.key);
    let changed = false;
    try {
      if (!page) {
        log('change', `CREATE  ${p.title}`);
        stats.created++;
        mark(p.key, 'create');
        if (dryRun) continue;
        page = await client.create(space, p.title, pageParent, body, msg);
        ids[p.key] = page.id;
        changed = true;
      } else {
        ids[p.key] = page.id;
        const same = (page.version && page.version.message) === msg && !force;
        if (same) {
          stats.unchanged++;
          mark(p.key, 'unchanged');
          continue;
        }
        log('change', `UPDATE  ${p.title}`);
        stats.updated++;
        mark(p.key, 'update');
        if (dryRun) continue;
        page = await client.update(page, p.title, pageParent, body, msg);
        changed = true;
      }

      if (changed) {
        const have = await client.labels(page.id);
        const want = new Set(labels);
        await client.addLabels(page.id, [...want].filter(l => !have.has(l)));
        for (const old of have) {
          if (!want.has(old) && MANAGED_PREFIXES.some(prefix => old.startsWith(prefix))) {
            await client.removeLabel(page.id, old);
          }
        }
        if (files.length) {
          const existing = await client.attachments(page.id);
          for (const f of files) {
            const fileTag = TAG + sha(f.buffer);
            const cur = existing[f.name];
            if (cur && cur.metadata && cur.metadata.comment === fileTag) continue;
            await client.upload(page.id, f.name, f.buffer, contentTypeFor(f.name), fileTag, cur && cur.id);
            stats.attachments++;
          }
        }
        save(state);
      }
    } catch (err) {
      mark(p.key, 'failed', err.message);
      // Whatever was created before the failure is real; keep its id
      save(state);
      throw err;
    }
  }

  const orphans = Object.entries(ids)
    .filter(([k]) => !keys.has(k))
    .map(([key, id]) => ({ key, id }));
  if (orphans.length) {
    log('warn', 'Pages created by an earlier sync that are no longer in the bundle:\n' +
      orphans.map(o => `  ${o.key} (page id ${o.id})`).join('\n'));
    if (trashOrphans && !dryRun) {
      for (const o of orphans) {
        await client.trash(o.id);
        delete ids[o.key];
      }
      log('info', 'Moved to the space trash.');
    } else {
      log('info', 'Left in place. Turn on "Trash pages no longer in the bundle" to remove them.');
    }
  }
  if (!dryRun) save(state);
  log('info', `Done. created ${stats.created}, updated ${stats.updated}, unchanged ${stats.unchanged}, attachments uploaded ${stats.attachments}`);
  return { stats, orphans, clashes };
}

module.exports = {
  readBundle,
  summarizeBundle,
  runSync,
  resolvePage,
  searchPages,
  ConfluenceClient,
  ConfluenceError,
  SyncStopped,
  sha,
  pyJsonList,
  SYNC_LABEL,
  TAG
};
