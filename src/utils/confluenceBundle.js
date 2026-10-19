/*
 * A Confluence page bundle, read in the browser: what the folder holds, and what each page
 * will look like. Nothing here talks to the server — choosing a folder costs nothing, and
 * the bundle is only sent when it is about to be previewed against or published to
 * Confluence. The server checks it again (server/confluence-sync.js readBundle), since a
 * browser's word is not something to publish on.
 */

const basename = path => path.split('/').pop();

// Of everything in the chosen folder, only the bundle itself (wherever manifest.json is)
// and the script's state file beside it are worth sending; the rest stays on this machine.
export function bundleEntries(fileList) {
  const files = Array.from(fileList).map(file => ({ file, path: file.webkitRelativePath || file.name }));
  const manifests = files
    .filter(f => basename(f.path) === 'manifest.json')
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  if (!manifests.length) return null;
  const root = manifests[0].path.split('/').slice(0, -1).join('/');
  const parent = root.split('/').slice(0, -1).join('/');
  const under = dir => p => (dir ? p.startsWith(dir + '/') : true);
  const entries = files.filter(({ path }) => {
    if (basename(path) === '.DS_Store') return false;
    if (under(root)(path)) return true;
    const rel = parent ? path.slice(parent.length + 1) : path;
    return under(parent)(path) && /^\.cst-sync-state-[^/]+\.json$/.test(rel);
  });
  return { entries, manifest: manifests[0], root };
}

/**
 * Read the chosen folder. Resolves with the manifest, the files by their path inside the
 * bundle, and the same problems the server would find — or rejects when there is no
 * bundle in the folder at all.
 */
export async function readLocalBundle(fileList) {
  const found = bundleEntries(fileList);
  if (!found) {
    throw new Error('No manifest.json in that folder. Choose the bundle folder (the one holding manifest.json, pages/ and images/), or the folder around it.');
  }
  const { entries, root } = found;

  let manifest;
  try {
    manifest = JSON.parse(await found.manifest.file.text());
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${err.message}`);
  }
  if (!manifest || !Array.isArray(manifest.pages)) {
    throw new Error('manifest.json has no "pages" list, so this is not a sync bundle.');
  }

  const prefix = root ? root + '/' : '';
  const files = new Map();
  const stateFileSpaces = [];
  let bytes = 0;
  entries.forEach(({ file, path }) => {
    if (path.startsWith(prefix)) {
      files.set(path.slice(prefix.length), file);
      bytes += file.size;
    } else {
      const m = /\.cst-sync-state-([^/]+)\.json$/.exec(path);
      if (m) stateFileSpaces.push(m[1]);
    }
  });

  const problems = [];
  const keys = new Set();
  const attachments = new Set();
  manifest.pages.forEach((p, i) => {
    if (!p || !p.key || !p.title || !p.body) {
      problems.push(`Entry ${i + 1} in manifest.json is missing its key, title or body.`);
      return;
    }
    if (keys.has(p.key)) problems.push(`Page key "${p.key}" appears twice.`);
    if (p.parent && !keys.has(p.parent)) problems.push(`"${p.key}" names parent "${p.parent}", which is not listed before it.`);
    keys.add(p.key);
    if (!files.has(p.body)) problems.push(`"${p.key}": ${p.body} is not in the folder.`);
    (p.attachments || []).forEach(a => {
      attachments.add(a);
      if (!files.has(a)) problems.push(`"${p.key}": attachment ${a} is not in the folder.`);
    });
  });

  const pages = manifest.pages.filter(p => p && p.key).map(p => ({
    key: p.key,
    title: p.title,
    parent: p.parent || null,
    labels: p.labels || [],
    body: p.body,
    attachments: p.attachments || []
  }));

  return {
    folder: (entries[0] && entries[0].path.split('/')[0]) || '',
    entries,
    files,
    pages,
    generated: manifest.generated || null,
    source: manifest.source || null,
    attachmentCount: attachments.size,
    bytes,
    problems,
    stateFileSpaces
  };
}

// Every page under `key`, however deep: what "this section" means when selecting
export function descendantsOf(pages, key) {
  const children = new Map();
  pages.forEach(p => {
    if (!p.parent) return;
    if (!children.has(p.parent)) children.set(p.parent, []);
    children.get(p.parent).push(p.key);
  });
  const out = [];
  const walk = k => (children.get(k) || []).forEach(child => { out.push(child); walk(child); });
  walk(key);
  return out;
}

/* --- Rendering a page's storage format for the preview --------------------------------
 *
 * Confluence pages are stored as XHTML with Confluence's own elements mixed in: macros
 * (ac:structured-macro), links to other pages by title (ac:link + ri:page), images by
 * attachment name (ac:image + ri:attachment). The preview turns those into plain HTML that
 * looks roughly as Confluence will draw them, and builds its output from an allowlist —
 * tags, attributes and URLs alike — so nothing in a bundle can run in this page.
 */

const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot',
  'tr', 'th', 'td', 'colgroup', 'col', 'strong', 'b', 'em', 'i', 'u', 's', 'del', 'sub', 'sup',
  'code', 'pre', 'br', 'hr', 'blockquote', 'span', 'div', 'a', 'img', 'details', 'summary'
]);
// Their content means nothing outside a browser that runs it
const DROPPED_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta']);
const CALLOUTS = new Set(['info', 'note', 'tip', 'warning', 'panel']);
const EMOTICONS = { tick: '✅', cross: '❌', warning: '⚠️', information: 'ℹ️', 'light-on': '💡', 'light-off': '💡', 'thumbs-up': '👍', 'thumbs-down': '👎', smile: '🙂', sad: '🙁', question: '❓', plus: '➕', minus: '➖', star_yellow: '⭐' };
const SAFE_HREF = /^(https?:|mailto:)/i;

const escapeHtml = text => text.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

// The browser's HTML parser does not know Confluence's elements: a CDATA section would
// become a comment, and a self-closed <ri:page/> would swallow everything after it
function toParseableHtml(storage) {
  return storage
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, text) => escapeHtml(text))
    .replace(/<((?:ac|ri):[\w-]+)([^<>]*?)\/>/g, '<$1$2></$1>');
}

const childrenNamed = (el, name) => Array.from(el.children).filter(c => c.localName === name);
const firstDescendant = (el, name) => el.getElementsByTagName(name)[0] || null;

/**
 * `imageUrl(filename)` gives a URL for an attachment of this page, or null;
 * `pageKeyForTitle(title)` gives the bundle key of a linked page, or null.
 * Returns an HTML string safe to set as innerHTML.
 */
export function renderStorage(storage, { imageUrl, pageKeyForTitle }) {
  const source = new DOMParser().parseFromString(`<body>${toParseableHtml(storage)}</body>`, 'text/html').body;
  const out = document.implementation.createHTMLDocument('');

  const el = (tag, className, children = []) => {
    const node = out.createElement(tag);
    if (className) node.className = className;
    children.forEach(child => child && node.appendChild(child));
    return node;
  };
  const text = value => out.createTextNode(value);
  const convertChildren = node => Array.from(node.childNodes).flatMap(convert);

  function macro(node) {
    const name = (node.getAttribute('ac:name') || '').toLowerCase();
    const params = {};
    childrenNamed(node, 'ac:parameter').forEach(p => { params[(p.getAttribute('ac:name') || '').toLowerCase()] = p.textContent; });
    const rich = childrenNamed(node, 'ac:rich-text-body')[0];
    const plain = childrenNamed(node, 'ac:plain-text-body')[0];
    const body = rich ? convertChildren(rich) : [];

    if (CALLOUTS.has(name)) {
      return [el('div', `cf-callout cf-${name}`, [params.title ? el('strong', 'cf-callout-title', [text(params.title)]) : null, ...body])];
    }
    if (name === 'details') return [el('div', 'cf-properties', body)];
    if (name === 'expand') return [el('details', 'cf-expand', [el('summary', null, [text(params.title || 'Expand')]), ...body])];
    if (name === 'code' || name === 'noformat') return [el('pre', 'cf-code', [el('code', null, [text(plain ? plain.textContent : '')])])];
    if (name === 'status') return [el('span', `cf-status cf-status-${(params.colour || params.color || 'grey').toLowerCase()}`, [text(params.title || '')])];

    const described = {
      detailssummary: 'Page Properties Report: Confluence builds this table from the properties boxes of the pages below',
      toc: 'Table of contents',
      children: 'List of child pages',
      pagetree: 'Page tree',
      'content-by-label': 'Pages with these labels',
      excerpt: null
    };
    if (name === 'excerpt') return body;
    const label = described[name] || `“${name}” macro`;
    return [el('div', 'cf-macro', [el('span', 'cf-macro-name', [text(label)]), ...(body.length ? [el('div', null, body)] : [])])];
  }

  function link(node) {
    const pageRef = firstDescendant(node, 'ri:page');
    const urlRef = firstDescendant(node, 'ri:url');
    const bodyText = (firstDescendant(node, 'ac:plain-text-link-body') || firstDescendant(node, 'ac:link-body'));
    const title = pageRef ? pageRef.getAttribute('ri:content-title') || '' : '';
    const label = bodyText ? bodyText.textContent : title || (urlRef ? urlRef.getAttribute('ri:value') : '');

    if (pageRef) {
      const key = pageKeyForTitle(title);
      if (key) {
        const a = el('a', 'cf-link', [text(label)]);
        a.setAttribute('href', '#');
        a.setAttribute('data-page-key', key);
        a.setAttribute('title', title);
        return [a];
      }
      // A page outside the bundle: Confluence links it; here there is nowhere to go
      const span = el('span', 'cf-link-outside', [text(label)]);
      span.setAttribute('title', `${title} (not in this bundle)`);
      return [span];
    }
    if (urlRef && SAFE_HREF.test(urlRef.getAttribute('ri:value') || '')) {
      const a = el('a', null, [text(label)]);
      a.setAttribute('href', urlRef.getAttribute('ri:value'));
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      return [a];
    }
    return [text(label)];
  }

  function image(node) {
    const attachment = firstDescendant(node, 'ri:attachment');
    const urlRef = firstDescendant(node, 'ri:url');
    let src = null;
    let name = '';
    if (attachment) {
      name = attachment.getAttribute('ri:filename') || '';
      src = imageUrl(name);
    } else if (urlRef && /^https:/i.test(urlRef.getAttribute('ri:value') || '')) {
      src = urlRef.getAttribute('ri:value');
    }
    if (!src) return [el('div', 'cf-macro', [el('span', 'cf-macro-name', [text(`Image ${name || ''} (not in the folder)`)])])];
    const img = el('img', 'cf-image');
    img.setAttribute('src', src);
    img.setAttribute('alt', node.getAttribute('ac:alt') || name);
    return [img];
  }

  function convert(node) {
    if (node.nodeType === 3) return [text(node.nodeValue)];
    if (node.nodeType !== 1) return [];
    const tag = node.localName;

    switch (tag) {
      case 'ac:structured-macro':
      case 'ac:macro':
        return macro(node);
      case 'ac:link':
        return link(node);
      case 'ac:image':
        return image(node);
      case 'ac:emoticon':
        return [text(EMOTICONS[node.getAttribute('ac:name')] || '')];
      case 'ac:task-list':
        return [el('ul', 'cf-tasks', convertChildren(node))];
      case 'ac:task': {
        const status = firstDescendant(node, 'ac:task-status');
        const body = firstDescendant(node, 'ac:task-body');
        const done = status && status.textContent.trim() === 'complete';
        return [el('li', null, [text(done ? '☑ ' : '☐ '), ...(body ? convertChildren(body) : [])])];
      }
      case 'ac:parameter':
      case 'ac:placeholder':
      case 'ac:task-id':
      case 'ac:task-status':
        return [];
      default:
        break;
    }
    if (DROPPED_TAGS.has(tag)) return [];
    // Anything else of Confluence's, or any tag not on the list: keep what it says, not
    // what it is
    if (!ALLOWED_TAGS.has(tag)) return convertChildren(node);

    const copy = out.createElement(tag);
    if ((tag === 'td' || tag === 'th') && node.getAttribute('colspan')) copy.setAttribute('colspan', node.getAttribute('colspan'));
    if ((tag === 'td' || tag === 'th') && node.getAttribute('rowspan')) copy.setAttribute('rowspan', node.getAttribute('rowspan'));
    if (tag === 'a' && SAFE_HREF.test(node.getAttribute('href') || '')) {
      copy.setAttribute('href', node.getAttribute('href'));
      copy.setAttribute('target', '_blank');
      copy.setAttribute('rel', 'noopener noreferrer');
    }
    if (tag === 'img') return []; // a bare <img> in storage format points somewhere we do not follow
    convertChildren(node).forEach(child => copy.appendChild(child));
    return [copy];
  }

  const container = out.createElement('div');
  convertChildren(source).forEach(child => container.appendChild(child));
  return container.innerHTML;
}
