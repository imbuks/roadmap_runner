/*
 * The canonical story format.
 *
 * The user keeps one story shape everywhere (BMAD-core's `jira-story-tmpl.md`, published
 * elsewhere by publish-jira-story.ps1). An agent asked nicely for that shape will produce
 * it most of the time and drift the rest, especially several turns into a refinement — so
 * the format is enforced here rather than merely requested in the prompt: parse what came
 * back, say exactly how it deviates, repair what can be repaired safely, and let the route
 * re-ask once for what cannot.
 *
 * The template's own metadata lines map onto Jira *fields*, not onto description text, so
 * a parsed document is split: fields go to the row's fields, and only the User Story /
 * Business Value / Acceptance Criteria sections become the description. The instruction
 * comment and the Notes section are explicitly never published.
 */

const fs = require('fs');
const path = require('path');

const TEMPLATE = fs.readFileSync(path.join(__dirname, 'story-template.md'), 'utf8');

// Sections that reach Jira, in the order they are rendered. Anything else parsed out of
// the document — Notes above all — is deliberately dropped.
const PUBLISHED_SECTIONS = ['User Story', 'Business Value', 'Acceptance Criteria'];

const SUMMARY_LIMIT = 255; // Jira's own cap; the template asks for 240 to leave room

const stripComments = (md) => String(md || '').replace(/<!--[\s\S]*?-->/g, '');

// The template separates its sections with `---`, so a naive split leaves each body
// wrapped in the rules that fenced it. Only leading and trailing ones are shed; a rule
// the author put inside a section is theirs to keep.
const trimRules = (text) => String(text || '')
  .replace(/^(?:\s*(?:-{3,}|\*{3,})\s*\n)+/, '')
  .replace(/(?:\n\s*(?:-{3,}|\*{3,})\s*)+$/, '')
  .trim();

/**
 * Pull a story document apart into metadata, sections and acceptance criteria.
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
    // "Notes (optional)" and "Notes" are the same section
    const name = parts[i].trim().replace(/\s*\(optional\)\s*$/i, '');
    sections[name] = trimRules(parts[i + 1]);
  }

  // Acceptance criteria are level-3 `### ACn: title` headings inside their section
  const criteria = [];
  const acBlock = sections['Acceptance Criteria'] || '';
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
 * Check a parsed document against the template's rules.
 * Returns { violations, repaired } — `violations` names every deviation for the user to
 * see, and `hard` ones are the ones worth spending a re-ask on. Renumbering and
 * over-long summaries are fixed here rather than bounced back.
 */
function validateStoryDoc(doc, { requireTitle = true } = {}) {
  const violations = [];
  const hard = [];

  /*
   * A whole document from the agent carries its title as a metadata line. A row's
   * *description* never does — the summary lives in its own field — so demanding one
   * there would mark every well-formed story as broken.
   */
  if (requireTitle && !doc.meta['story title']) hard.push('No `**Story Title:**` line.');
  if (!doc.sections['User Story']) hard.push('No `## User Story` section.');
  if (!doc.sections['Acceptance Criteria']) hard.push('No `## Acceptance Criteria` section.');
  else if (doc.criteria.length === 0) hard.push('`## Acceptance Criteria` contains no `### ACn:` criterion.');

  /*
   * Structure without substance: every heading present, nothing under any of them. A model
   * told firmly enough not to invent will produce exactly this, and it passes every check
   * that only looks at shape — so look at the contents too.
   */
  const hollow = doc.criteria.filter(c => !c.title || !c.body.replace(/\*\*[^*]+\*\*/g, '').trim());
  if (hollow.length) {
    hard.push(`${hollow.length} acceptance criteri${hollow.length === 1 ? 'on is' : 'a are'} empty.`);
  }
  const userStory = doc.sections['User Story'];
  // Strip the **As a** / **I want** labels: what matters is whether anything follows them
  if (userStory !== undefined && !userStory.replace(/\*\*[^*]+\*\*/g, '').trim()) {
    hard.push('The User Story section has headings but no content.');
  }

  if (doc.strayHeadings > 0) {
    violations.push(`${doc.strayHeadings} heading(s) under Acceptance Criteria are not in \`### ACn: title\` form and were dropped.`);
  }

  // Sequential numbering is a rule of the format, and renumbering cannot lose anything —
  // the criteria keep their order, so repair rather than re-ask.
  const outOfOrder = doc.criteria.some((c, i) => c.number !== i + 1);
  if (outOfOrder) {
    violations.push('Acceptance criteria were not numbered AC1..ACn in order; renumbered.');
    doc.criteria.forEach((c, i) => { c.number = i + 1; });
  }

  const title = doc.meta['story title'] || '';
  if (title.length > SUMMARY_LIMIT) {
    violations.push(`Story Title was ${title.length} chars; truncated to ${SUMMARY_LIMIT}.`);
    doc.meta['story title'] = title.slice(0, SUMMARY_LIMIT);
  }
  if (/\n/.test(title)) {
    violations.push('Story Title spanned more than one line; joined.');
    doc.meta['story title'] = doc.meta['story title'].replace(/\s*\n\s*/g, ' ');
  }

  return { violations: [...hard, ...violations], hard };
}

// Render the publishable half of the document: the three sections that go to Jira, with
// the criteria renumbered as validated. Metadata lines and Notes never appear here.
function toPublishableDescription(doc) {
  const out = [];
  for (const name of PUBLISHED_SECTIONS) {
    if (name === 'Acceptance Criteria') {
      if (doc.criteria.length === 0) continue;
      out.push('## Acceptance Criteria');
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
function toPatch(doc) {
  const patch = {
    summary: doc.meta['story title'] || '',
    description: toPublishableDescription(doc)
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
function buildSystemPrompt({ intent = 'refine' } = {}) {
  // Formatting and refining are different jobs. Asked to refine, the model should think
  // about the story; asked to format, it should think about the shape and leave the
  // substance alone — the same prompt for both produces a rewrite when a tidy-up was wanted.
  const job = intent === 'format'
    ? [
      'You are reformatting one Jira story into the canonical format below. Keep the',
      "author's meaning and their wording wherever it survives the restructuring, and stay",
      'close to the scope they described rather than enlarging it.',
      '',
      'NEVER leave a field or a criterion blank. A source of one line still has to come back',
      'as a complete, readable story: draft the least that makes it coherent and testable.',
      'An empty **As a** or a criterion with no Given/When/Then is a failed answer, worse',
      'than one that commits to a reasonable reading of what the author meant.'
    ]
    : ['You help refine a single Jira story.'];

  return [
    ...job,
    ''
  ].concat([
    'Reply with a short plain-language note about what you changed or what you need, and then',
    'the COMPLETE story document in a fenced ```story block.',
    '',
    'The document must follow this format exactly:',
    '  - Metadata lines use the exact pattern `**Field:** value`.',
    '  - Section headers are level-2: `## User Story`, `## Business Value`, `## Acceptance Criteria`.',
    '  - Every acceptance criterion is a level-3 heading `### ACn: <title>`, numbered from AC1 in order,',
    '    with its Given/When/Then body directly underneath.',
    '  - Always emit the whole document, not a diff or an excerpt.',
    '',
    'Leave `**Epic:**`, `**Priority:**` and `**Status:**` alone — a human sets those.',
    'Never invent Jira issue keys, team names or sprint names.',
    'If you are missing information needed to write a criterion, say so in the note instead of guessing.',
    '',
    'The template:',
    '```story',
    TEMPLATE.trim(),
    '```'
  ]).join('\n');
}

/**
 * Does this description already follow the format? Pure parsing — no model, no cost — so
 * the editor can say where a story stands continuously rather than only when asked.
 */
function checkConformance(markdown) {
  const doc = parseStoryDoc(markdown || '');
  const { violations, hard } = validateStoryDoc(doc, { requireTitle: false });
  return {
    conforms: hard.length === 0 && doc.criteria.length > 0,
    violations,
    criteria: doc.criteria.length,
    sections: Object.keys(doc.sections)
  };
}

/**
 * Lift the story document out of an agent reply, and return the prose separately.
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
  const doc = blocks.reverse().find(b => /\*\*Story Title:\*\*/i.test(b) || /^##\s+User Story/mi.test(b));
  if (doc) {
    const prose = raw.replace(/```(?:story|markdown|md)?\s*\n[\s\S]*?```/g, '').trim();
    return { prose, document: doc };
  }
  if (/\*\*Story Title:\*\*/i.test(raw)) return { prose: '', document: raw };
  return { prose: raw.trim(), document: null };
}

module.exports = {
  TEMPLATE,
  checkConformance,
  SUMMARY_LIMIT,
  parseStoryDoc,
  validateStoryDoc,
  toPublishableDescription,
  toPatch,
  buildSystemPrompt,
  splitReply
};
