/*
 * The canonical issue formats.
 *
 * The user keeps one story shape everywhere (BMAD-core's `jira-story-tmpl.md`, published
 * elsewhere by publish-jira-story.ps1). An agent asked nicely for that shape will produce
 * it most of the time and drift the rest, especially several turns into a refinement — so
 * the format is enforced here rather than merely requested in the prompt: parse what came
 * back, say exactly how it deviates, repair what can be repaired safely, and let the route
 * re-ask once for what cannot.
 *
 * A template's own metadata lines map onto Jira *fields*, not onto description text, so a
 * parsed document is split: fields go to the row's fields, and the template's sections
 * become the description. The instruction comment and the Notes section are explicitly
 * never published.
 *
 * `server/templates/<type>/<variant>.md` is the source of truth. Nothing in this file
 * restates a section name, so adding, renaming or reordering a section is a text edit in
 * one file — no code change, and no restart, since templates are re-read when they change.
 */

const fs = require('fs');
const path = require('path');

const TEMPLATES_DIR = path.join(__dirname, 'templates');

// The one section every format defines that must never reach Jira. Everything else a
// template declares is published, in that template's own order.
const NEVER_PUBLISHED = ['Notes'];

// The one section name the parser itself knows about: criteria are pulled apart heading by
// heading, so a template that drops it simply gets no criteria checks.
const CRITERIA_SECTION = 'Acceptance Criteria';

// What a type falls back to when it has no directory of its own. Every Jira instance
// invents issue types; only the ones worth their own shape need a folder here.
const FALLBACK_TYPE = 'story';

const SUMMARY_LIMIT = 255; // Jira's own cap; the template asks for 240 to leave room

/* ── The registry ────────────────────────────────────────────────────────────────── */

// `## Notes (optional)` and `## Notes` are the same section; the suffix marks it as one a
// document may leave out, which is the whole of how a template says "required" or not.
const isOptionalHeading = (heading) => /\(optional\)\s*$/i.test(String(heading).trim());
const normalizeSectionName = (name) => String(name).trim().replace(/\s*\(optional\)\s*$/i, '');

const titleCase = (slug) => String(slug).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/*
 * Optional frontmatter, `key: value` lines between two `---` rules at the very top. It
 * carries only what a filename cannot: the label the picker shows, and which variant a
 * type opens on. A template without it still works — the filename supplies both.
 */
function splitFrontmatter(text) {
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n?/.exec(text);
  if (!match) return { front: {}, body: text };
  const front = {};
  for (const line of match[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line.trim());
    if (kv) front[kv[1].toLowerCase()] = kv[2].trim();
  }
  return { front, body: text.slice(match[0].length) };
}

/*
 * The `**Field:** value` lines a template declares above its first section. They map onto
 * Jira fields rather than description text, so which ones a format asks for is the
 * template's business too — a title it does not declare is one no reply can be faulted for
 * leaving out.
 */
function metaFieldNames(body) {
  const head = String(body).split(/^##\s+/m)[0];
  const names = [];
  const line = /^\*\*([^*:]+):\*\*/gm;
  let m;
  while ((m = line.exec(head)) !== null) names.push(m[1].trim().toLowerCase());
  return names;
}

function parseTemplateText(text) {
  const { front, body } = splitFrontmatter(String(text).replace(/\r\n/g, '\n'));
  const sections = (body.match(/^##[ \t]+(.+)$/gm) || []).map((heading) => {
    const raw = heading.replace(/^##[ \t]+/, '');
    return { name: normalizeSectionName(raw), optional: isOptionalHeading(raw) };
  });
  return { front, body: body.trim(), sections, fields: metaFieldNames(body) };
}

/*
 * Templates are read from disk on demand and re-read when the file changes. Editing a
 * format is a text edit; it should not also be a server restart, and a stale in-memory
 * copy looks exactly like the edit not having worked.
 */
const fileCache = new Map(); // path -> { mtimeMs, template }

function readTemplateFile(type, variant) {
  const file = path.join(TEMPLATES_DIR, type, `${variant}.md`);
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (err) {
    return null; // not a template; the caller falls back
  }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.template;

  const parsed = parseTemplateText(fs.readFileSync(file, 'utf8'));
  const names = parsed.sections.map(s => s.name);
  const template = {
    id: `${type}/${variant}`,
    type,
    variant,
    label: parsed.front.label || titleCase(variant),
    isDefault: /^(1|true|yes)$/i.test(parsed.front.default || '') || variant === 'default',
    text: parsed.body,
    sections: parsed.sections,
    fields: parsed.fields,
    /*
     * Which metadata line carries the summary, if this format has one: a story says
     * `**Story Title:**`, a bug or a task just `**Title:**`. A template that declares
     * neither is authored with its summary somewhere else, and demanding a title of every
     * reply would then fail every reply — so this is read off the file, not assumed.
     */
    titleField: parsed.fields.find(f => f === 'story title' || f === 'title') || null,
    // Sections that reach Jira, in the template's own order
    published: names.filter(n => !NEVER_PUBLISHED.includes(n)),
    // A section is required unless its heading says `(Optional)`
    required: parsed.sections.filter(s => !s.optional && !NEVER_PUBLISHED.includes(s.name)).map(s => s.name)
  };
  fileCache.set(file, { mtimeMs, template });
  return template;
}

// The directory listing changes far less often than the files do, and `validate` runs on
// every keystroke, so re-scan at most once a second rather than on every call.
let dirCache = { at: 0, types: [] };
const DIR_TTL_MS = 1000;

function scanTemplates() {
  if (Date.now() - dirCache.at < DIR_TTL_MS) return dirCache.types;

  let typeDirs = [];
  try {
    typeDirs = fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
      .sort();
  } catch (err) {
    console.warn(`No templates directory at ${TEMPLATES_DIR}: ${err.message}`);
  }

  const types = [];
  for (const type of typeDirs) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(TEMPLATES_DIR, type))
        .filter(f => f.endsWith('.md'))
        .map(f => f.slice(0, -3))
        .sort();
    } catch (err) { continue; }

    const variants = files.map(v => readTemplateFile(type, v)).filter(Boolean);
    if (variants.length === 0) continue;
    const preferred = variants.find(v => v.isDefault) || variants[0];
    types.push({ type, label: titleCase(type), defaultVariant: preferred.variant, variants });
  }

  dirCache = { at: Date.now(), types };
  return types;
}

// What the UI needs to build its picker: which issue types have a shape of their own, and
// what a person can choose within one. The template text itself stays on the server.
function listTemplates() {
  return scanTemplates().map(t => ({
    type: t.type,
    label: t.label,
    defaultVariant: t.defaultVariant,
    variants: t.variants.map(v => ({ id: v.id, variant: v.variant, label: v.label }))
  }));
}

const slugifyType = (issueType) => String(issueType || '')
  .trim().toLowerCase().replace(/\s+/g, '-');

/*
 * The last resort. A missing or empty templates directory is a deployment fault, but
 * `validate` runs on every keystroke and must not answer 500 — so resolution always
 * returns something, and the shape below is the format's irreducible core.
 */
const BUILTIN = parseTemplateText([
  '**Story Title:** <one concise line>', '',
  '## User Story', '',
  '**As a** <role>', '**I want** <capability>', '**So that** <benefit>', '',
  '## Acceptance Criteria', '',
  '### AC1: <short title>', '**Given** <precondition>', '**When** <action>', '**Then** <outcome>'
].join('\n'));

const BUILTIN_TEMPLATE = {
  id: 'builtin', type: FALLBACK_TYPE, variant: 'builtin', label: 'Built-in', isDefault: true,
  text: BUILTIN.body,
  sections: BUILTIN.sections,
  fields: BUILTIN.fields,
  titleField: 'story title',
  published: BUILTIN.sections.map(s => s.name),
  required: BUILTIN.sections.map(s => s.name)
};

/**
 * Pick the template for a row: the type's own shape if it has one, in the variant the
 * person chose. Type wins over variant on the way down — a Bug with no "detailed" variant
 * should be formatted as a bug, not as a detailed story.
 */
function resolveTemplate({ issueType, variant } = {}) {
  const types = scanTemplates();
  const wanted = slugifyType(issueType);
  const entry = types.find(t => t.type === wanted) || types.find(t => t.type === FALLBACK_TYPE);
  if (!entry) return BUILTIN_TEMPLATE;

  const chosen = variant && entry.variants.find(v => v.variant === variant);
  return chosen || entry.variants.find(v => v.variant === entry.defaultVariant) || entry.variants[0];
}

/* ── Parsing and validation ──────────────────────────────────────────────────────── */

const stripComments = (md) => String(md || '').replace(/<!--[\s\S]*?-->/g, '');

// Templates separate their sections with `---`, so a naive split leaves each body wrapped
// in the rules that fenced it. Only leading and trailing ones are shed; a rule the author
// put inside a section is theirs to keep.
const trimRules = (text) => String(text || '')
  .replace(/^(?:\s*(?:-{3,}|\*{3,})\s*\n)+/, '')
  .replace(/(?:\n\s*(?:-{3,}|\*{3,})\s*)+$/, '')
  .trim();

// Whether anything survives once the **As a** / **Given** style labels are removed: a
// section of nothing but its own scaffolding is empty however full it looks.
const hasSubstance = (text) => Boolean(String(text || '').replace(/\*\*[^*]+\*\*/g, '').trim());

// Stories say `**Story Title:**`, other types just `**Title:**`; both mean the summary.
const docTitle = (doc) => doc.meta['story title'] || doc.meta['title'] || '';

/**
 * Pull a document apart into metadata, sections and acceptance criteria.
 * Deliberately tolerant: it reports what is missing rather than throwing, because the
 * caller wants to tell the agent precisely what to fix.
 */
function parseStoryDoc(markdown) {
  const text = stripComments(markdown).replace(/\r\n/g, '\n');

  // Metadata lines are `**Field:** value`, anywhere above the first level-2 section
  const head = text.split(/^##\s+/m)[0];
  const meta = {};
  const metaLine = /^\*\*([^*:]+):\*\*[ \t]*(.*)$/gm;
  let m;
  while ((m = metaLine.exec(head)) !== null) {
    meta[m[1].trim().toLowerCase()] = m[2].trim();
  }

  // Level-2 sections. The split keeps the heading text and the body that follows it.
  const sections = {};
  const parts = text.split(/^##[ \t]+(.+)$/m);
  for (let i = 1; i < parts.length; i += 2) {
    sections[normalizeSectionName(parts[i])] = trimRules(parts[i + 1]);
  }

  // Acceptance criteria are level-3 `### ACn: title` headings inside their section
  const criteria = [];
  const acBlock = sections[CRITERIA_SECTION] || '';
  const acParts = acBlock.split(/^###[ \t]+AC(\d+)[ \t]*:[ \t]*(.*)$/m);
  for (let i = 1; i < acParts.length; i += 3) {
    criteria.push({
      number: Number(acParts[i]),
      title: (acParts[i + 1] || '').trim(),
      body: trimRules(acParts[i + 2])
    });
  }
  // A heading that is not in `### ACn: title` shape would otherwise vanish silently
  const strayHeadings = (acBlock.match(/^###[ \t]+(?!AC\d+[ \t]*:).*$/gm) || []).length;

  return { meta, sections, criteria, strayHeadings };
}

/**
 * Check a parsed document against its template's rules.
 * Returns { violations, hard } — `violations` names every deviation for the user to see,
 * and `hard` ones are the ones worth spending a re-ask on. Renumbering and over-long
 * summaries are fixed here rather than bounced back.
 */
function validateStoryDoc(doc, { requireTitle, template } = {}) {
  const shape = template || resolveTemplate({});
  const violations = [];
  const hard = [];

  /*
   * A whole document from the agent carries its title as a metadata line. A row's
   * *description* never does — the summary lives in its own field — so callers say
   * `requireTitle: false` there, and demanding one would mark every well-formed story as
   * broken. Left unsaid, the template decides: a format that does not declare a title line
   * is not asking for one, and faulting a reply for omitting what it was never shown is
   * how an edit to a template file breaks every answer the model gives.
   */
  const wantsTitle = requireTitle === undefined ? Boolean(shape.titleField) : requireTitle;
  if (wantsTitle && !docTitle(doc)) hard.push(`No \`**${titleCase(shape.titleField || 'story title')}:**\` line.`);

  /*
   * Which sections must be there, and which may be left out, is the template's business:
   * a heading it marks `(Optional)` is optional and every other one is required. Structure
   * without substance counts as missing — a model told firmly enough not to invent will
   * return every heading with nothing under it, and that passes any check that only looks
   * at shape.
   */
  for (const name of shape.required) {
    if (doc.sections[name] === undefined) hard.push(`No \`## ${name}\` section.`);
    else if (name !== CRITERIA_SECTION && !hasSubstance(doc.sections[name])) {
      hard.push(`The ${name} section has headings but no content.`);
    }
  }

  const wantsCriteria = shape.required.includes(CRITERIA_SECTION);
  if (wantsCriteria && doc.sections[CRITERIA_SECTION] !== undefined && doc.criteria.length === 0) {
    hard.push(`\`## ${CRITERIA_SECTION}\` contains no \`### ACn:\` criterion.`);
  }

  const hollow = doc.criteria.filter(c => !c.title || !hasSubstance(c.body));
  if (hollow.length) {
    hard.push(`${hollow.length} acceptance criteri${hollow.length === 1 ? 'on is' : 'a are'} empty.`);
  }

  if (doc.strayHeadings > 0) {
    violations.push(`${doc.strayHeadings} heading(s) under ${CRITERIA_SECTION} are not in \`### ACn: title\` form and were dropped.`);
  }

  // Sequential numbering is a rule of the format, and renumbering cannot lose anything —
  // the criteria keep their order, so repair rather than re-ask.
  const outOfOrder = doc.criteria.some((c, i) => c.number !== i + 1);
  if (outOfOrder) {
    violations.push('Acceptance criteria were not numbered AC1..ACn in order; renumbered.');
    doc.criteria.forEach((c, i) => { c.number = i + 1; });
  }

  const title = docTitle(doc);
  if (title.length > SUMMARY_LIMIT) {
    violations.push(`Story Title was ${title.length} chars; truncated to ${SUMMARY_LIMIT}.`);
    doc.meta['story title'] = title.slice(0, SUMMARY_LIMIT);
    delete doc.meta['title'];
  }
  if (/\n/.test(docTitle(doc))) {
    violations.push('Story Title spanned more than one line; joined.');
    doc.meta['story title'] = docTitle(doc).replace(/\s*\n\s*/g, ' ');
    delete doc.meta['title'];
  }

  return { violations: [...hard, ...violations], hard };
}

// Render the publishable half of the document: the template's sections, with the criteria
// renumbered as validated. Metadata lines and Notes never appear here.
function toPublishableDescription(doc, template) {
  const shape = template || resolveTemplate({});
  /*
   * The template's sections first, in its order, then any section this document carries
   * that the template does not name. Keeping the strays is deliberate: dropping a section
   * an author wrote is worse than rendering it last, and templates are edited often enough
   * that a description written against last week's version should still survive a reformat.
   */
  const extras = Object.keys(doc.sections)
    .filter(name => !shape.published.includes(name) && !NEVER_PUBLISHED.includes(name));

  const out = [];
  for (const name of [...shape.published, ...extras]) {
    if (name === CRITERIA_SECTION) {
      if (doc.criteria.length === 0) continue;
      out.push(`## ${CRITERIA_SECTION}`);
      for (const c of doc.criteria) {
        // The format asks for the Given/When/Then body directly under the heading
        out.push(c.body ? `### AC${c.number}: ${c.title}\n${c.body}` : `### AC${c.number}: ${c.title}`);
      }
      continue;
    }
    const body = doc.sections[name];
    if (!body) continue;
    out.push(`## ${name}`);
    out.push(body);
  }
  return out.join('\n\n').trim();
}

/**
 * Map a validated document onto the row fields the grid uses.
 *
 * Only the *authored* fields are returned. Epic, Priority and Status are parsed and then
 * deliberately withheld: an agent guesses instance-specific epic keys, and this app has
 * nowhere to write priority and moves status through transitions rather than a field
 * write. They stay the human's job, which is the same split the dialog's two columns draw.
 */
function toPatch(doc, template) {
  const patch = {
    summary: docTitle(doc),
    description: toPublishableDescription(doc, template)
  };

  const points = doc.meta['story points'];
  if (points !== undefined && points !== '') {
    const n = Number(points);
    if (!Number.isNaN(n)) patch.storyPoints = String(n);
  }

  const labels = doc.meta['labels'];
  if (labels !== undefined) {
    // Jira labels cannot contain spaces; buildIssueFields does the same substitution
    const cleaned = labels.split(',').map(l => l.trim().replace(/\s+/g, '_')).filter(Boolean);
    if (cleaned.length) patch.labels = cleaned.join(', ');
  }

  return patch;
}

// What the agent is told, every turn. The rules are spelled out here rather than shipped
// as the template's own comment block: that block documents the PowerShell parser, and
// including it mostly teaches the model to echo it back.
function buildSystemPrompt({ intent = 'refine', template } = {}) {
  const shape = template || resolveTemplate({});
  // "story" for a story, "bug" for a bug: a model told to write a story writes user-story
  // prose whatever headings it is given.
  const noun = shape.type === 'story' ? 'story' : shape.type;

  // Formatting and refining are different jobs. Asked to refine, the model should think
  // about the story; asked to format, it should think about the shape and leave the
  // substance alone — the same prompt for both produces a rewrite when a tidy-up was wanted.
  const job = intent === 'format'
    ? [
      `You are reformatting one Jira ${noun} into the canonical format below. Keep the`,
      "author's meaning and their wording wherever it survives the restructuring, and stay",
      'close to the scope they described rather than enlarging it.',
      '',
      'NEVER leave a field or a criterion blank. A source of one line still has to come back',
      `as a complete, readable ${noun}: draft the least that makes it coherent and testable.`,
      'An empty **As a** or a criterion with no Given/When/Then is a failed answer, worse',
      'than one that commits to a reasonable reading of what the author meant.'
    ]
    : [`You help refine a single Jira ${noun}.`];

  const headings = shape.sections.map(s => `\`## ${s.name}\``).join(', ');
  const optional = shape.sections.filter(s => s.optional).map(s => s.name);

  return [
    ...job,
    ''
  ].concat([
    `Reply with a short plain-language note about what you changed or what you need, and then`,
    'the COMPLETE document in a fenced ```story block.',
    '',
    'The document must follow this format exactly:',
    '  - Metadata lines use the exact pattern `**Field:** value`.',
    // Named outright, not left to the template to imply. A small model that drops the
    // title costs a whole re-ask, and the re-ask is what says this out loud anyway.
    shape.titleField
      ? `  - The \`**${titleCase(shape.titleField)}:**\` line is required; it becomes the Jira summary.`
      : null,
    `  - Section headers are level-2: ${headings}.`,
    optional.length
      ? `  - Every section is required except ${optional.join(' and ')}, which may be left out.`
      : '  - Every section is required.',
    `  - Every acceptance criterion is a level-3 heading \`### ACn: <title>\`, numbered from AC1 in order,`,
    '    with its Given/When/Then body directly underneath.',
    '  - Always emit the whole document, not a diff or an excerpt.',
    '',
    'Leave `**Epic:**`, `**Priority:**` and `**Status:**` alone — a human sets those.',
    'Never invent Jira issue keys, team names or sprint names.',
    'If you are missing information needed to write a criterion, say so in the note instead of guessing.',
    '',
    'The template:',
    '```story',
    shape.text,
    '```'
  ]).filter(line => line !== null).join('\n');
}

/**
 * Does this description already follow the format? Pure parsing — no model, no cost — so
 * the editor can say where a story stands continuously rather than only when asked.
 */
function checkConformance(markdown, template) {
  const shape = template || resolveTemplate({});
  const doc = parseStoryDoc(markdown || '');
  const { violations, hard } = validateStoryDoc(doc, { requireTitle: false, template: shape });
  const wantsCriteria = shape.required.includes(CRITERIA_SECTION);
  return {
    conforms: hard.length === 0 && (!wantsCriteria || doc.criteria.length > 0),
    violations,
    criteria: doc.criteria.length,
    sections: Object.keys(doc.sections),
    template: { id: shape.id, type: shape.type, variant: shape.variant, label: shape.label }
  };
}

/**
 * Lift the document out of an agent reply, and return the prose separately.
 * Models label the block inconsistently, so accept the usual spellings and fall back to
 * treating the whole reply as a document when it plainly is one.
 */
function splitReply(text) {
  const raw = String(text || '');
  const fence = /```(?:story|markdown|md)?\s*\n([\s\S]*?)```/g;
  const blocks = [];
  let m;
  while ((m = fence.exec(raw)) !== null) blocks.push(m[1]);

  // The last block is the document; earlier ones are usually examples in the prose
  const titled = /\*\*(?:Story )?Title:\*\*/i;
  const doc = blocks.reverse().find(b => titled.test(b) || /^##\s+/m.test(b));
  if (doc) {
    const prose = raw.replace(/```(?:story|markdown|md)?\s*\n[\s\S]*?```/g, '').trim();
    return { prose, document: doc };
  }
  if (titled.test(raw)) return { prose: '', document: raw };
  return { prose: raw.trim(), document: null };
}

module.exports = {
  listTemplates,
  resolveTemplate,
  checkConformance,
  SUMMARY_LIMIT,
  parseStoryDoc,
  validateStoryDoc,
  toPublishableDescription,
  toPatch,
  buildSystemPrompt,
  splitReply
};
