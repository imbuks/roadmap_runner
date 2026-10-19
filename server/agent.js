/*
 * The story-refinement agent.
 *
 * Proxied for the same reasons every Jira call is: the agent's endpoint and key are
 * secrets that have no business in a bundle, and the browser would be blocked by CORS
 * anyway. Unlike the Jira routes this one needs no Jira session — it never touches Jira.
 *
 * The conversation is stateless here on purpose. The transcript lives in the browser and
 * the whole of it is posted each turn, so nothing has to be tracked between requests and
 * a plain request/response transport is enough. (If the agent's own knowledge sources are
 * what grounds the answers, `callAgent` below is the one function that has to change.)
 */

const fetch = require('node-fetch');
const {
  parseStoryDoc,
  validateStoryDoc,
  toPatch,
  toPublishableDescription,
  checkConformance,
  buildSystemPrompt,
  splitReply,
  listTemplates,
  resolveTemplate
} = require('./story-template');

const DEBUG = /^(1|true|yes|on)$/i.test(process.env.DEBUG || '');
const debug = DEBUG ? (...args) => console.log(...args) : () => {};

// 'mock' answers locally so the whole path — prompt, contract, validation, the UI — can be
// built and reviewed before the Copilot Studio transport is settled.
const AGENT_MODE = process.env.AGENT_MODE || 'mock';

// 'flow': one POST to an endpoint that answers in the same response — a Power Automate
// HTTP trigger, say. The signature in such a URL is the credential, so it never leaves here.
const AGENT_URL = process.env.AGENT_URL || '';
const AGENT_KEY = process.env.AGENT_KEY || '';

// 'directline': the Copilot Studio agent itself, over Direct Line. Copilot Studio hands
// out a token endpoint (Channels -> Custom website / Mobile app) rather than a secret;
// either will do, and the endpoint is preferred because its tokens are short-lived.
const DIRECTLINE_BASE = process.env.AGENT_DIRECTLINE_URL || 'https://directline.botframework.com/v3/directline';
const AGENT_TOKEN_ENDPOINT = process.env.AGENT_TOKEN_ENDPOINT || '';
const AGENT_DIRECTLINE_SECRET = process.env.AGENT_DIRECTLINE_SECRET || '';

// 'ollama': a model running on this machine. No credits, no procurement, and the story
// text never leaves the host — which matters more here than the cost does, given what
// else is in a Jira story. Small local models drift from the format far more than a
// hosted one, which is what the validator and the single re-ask are there to absorb.
const AGENT_OLLAMA_URL = process.env.AGENT_OLLAMA_URL || 'http://localhost:11434';
// The default only: the UI lists what `ollama list` would show and can pick any of them
// per request, so this is what a fresh browser starts on rather than a hard setting.
const AGENT_OLLAMA_MODEL = process.env.AGENT_OLLAMA_MODEL || 'llama3.1';
// Low, because the job is to follow a format rather than to be interesting
const AGENT_OLLAMA_TEMPERATURE = Number(process.env.AGENT_OLLAMA_TEMPERATURE ?? 0.2);

// A bot answers when it answers; wait, but not forever. QUIET is how long the reply has to
// stay finished before it is treated as complete, since a bot may send several messages.
const REPLY_TIMEOUT_MS = Number(process.env.AGENT_REPLY_TIMEOUT_MS) || 60000;
const REPLY_QUIET_MS = Number(process.env.AGENT_REPLY_QUIET_MS) || 2000;

// Who we are in the transcript, so the bot's own messages can be told apart from ours
const USER_ID = 'roadmap-runner';

const MAX_TURNS = 12;       // the transcript is resent every turn; cap what it can cost
const MAX_CHARS = 12000;    // per message, so one pasted essay cannot run away

/*
 * Images ride along on user turns as data URLs (a screenshot, a whiteboard photo, a
 * mockup). The browser scales them down before sending; these caps are for a browser that
 * did not. The newest are kept, since they are what the current question is about.
 */
const MAX_IMAGES = 6;                       // across the whole transcript
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;    // per image, decoded
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;

// One turn's images as { mime, data }, dropping anything that is not a plain image
function readImages(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map(url => IMAGE_DATA_URL.exec(typeof url === 'string' ? url : ''))
    .filter(m => m && m[2].length * 0.75 <= MAX_IMAGE_BYTES)
    .map(m => ({ mime: m[1], data: m[2] }));
}

// Keep only the newest MAX_IMAGES across the transcript, walking back from the latest turn
function capImages(turns) {
  let budget = MAX_IMAGES;
  for (let i = turns.length - 1; i >= 0; i--) {
    const images = turns[i].images;
    if (!images) continue;
    const kept = images.slice(Math.max(0, images.length - budget));
    budget -= kept.length;
    if (kept.length) turns[i].images = kept;
    else delete turns[i].images;
  }
  return turns;
}

const imageCount = (messages) => messages.reduce((n, m) => n + (m.images ? m.images.length : 0), 0);

/*
 * A stand-in that answers in the agent's own contract: a note, then the complete document
 * in a fenced block. It echoes the current story back through the template, so applying
 * its reply exercises the real parse/validate/patch path rather than a happy path.
 */
function mockAgent({ messages, story, template, intent }) {
  const shape = template || resolveTemplate({});
  const ask = [...messages].reverse().find(m => m.role === 'user');
  const askText = (ask && ask.content) || '';
  const title = (story.summary || 'Untitled story').slice(0, 240);
  // What the row already says, so a second turn visibly builds on the first
  const current = parseStoryDoc(story.description || '');

  const criteria = () => {
    const titles = current.criteria.map(c => c.title).filter(Boolean);
    if (titles.length === 0) titles.push('Happy path', 'Validation failure');
    if (askText) titles.push(askText.slice(0, 60).replace(/\s+/g, ' ').trim());
    return titles.map((t, i) => [
      `### AC${i + 1}: ${t}`,
      '**Given** the user is on the story screen',
      `**When** they ${t.toLowerCase()}`,
      '**Then** the outcome is observable and testable'
    ].join('\n')).join('\n\n');
  };

  // The template's own sections, in its order, so the mock exercises whichever format the
  // row resolved to rather than a story shape hardcoded here.
  const body = shape.sections
    .filter(sec => sec.name !== 'Notes')
    .map((sec) => {
      if (sec.name === 'Acceptance Criteria') return `## Acceptance Criteria\n\n${criteria()}`;
      const existing = current.sections[sec.name];
      if (existing) return `## ${sec.name}\n\n${existing}`;
      if (sec.name === 'User Story') {
        return ['## User Story', '', '**As a** delivery team member',
          `**I want** ${title.toLowerCase()}`,
          '**So that** the work is understood before it is picked up'].join('\n');
      }
      return `## ${sec.name}\n\n(mock) ${sec.name} for "${title}".`;
    })
    .join('\n\n');

  const doc = [
    `**Story Title:** ${title}`,
    `**Story Points:** ${story.storyPoints || 3}`,
    `**Labels:** ${story.labels || 'needs-review'}`,
    '',
    body
  ].join('\n');

  // A brainstorm starts from an idea rather than a row, so it has no title of its own
  const idea = askText.replace(/\s+/g, ' ').trim().slice(0, 200) || 'the idea';
  const titled = (text) => doc.replace(/^\*\*Story Title:\*\*.*$/m, `**Story Title:** ${text}`);

  if (intent === 'brainstorm') {
    const parts = ['Capture', 'Review', 'Report on'].map(verb => titled(`${verb} ${idea}`.slice(0, 240)));
    const seen = imageCount(messages);
    return [
      `(mock agent) Broke "${idea.slice(0, 80)}" into ${parts.length} stories`
        + `${seen ? `, with ${seen} image${seen === 1 ? '' : 's'} attached (the mock cannot look at them)` : ''}.`,
      ...parts.flatMap(p => ['', '```story', p, '```'])
    ].join('\n');
  }

  // A split answers with one block per story, so the multi-story path can be exercised too
  if (/\bsplit\b/i.test(askText)) {
    const part = (n) => titled(`${title.slice(0, 225)} (part ${n})`);
    return [
      `(mock agent) Split the ${shape.type} into two.`,
      '',
      '```story', part(1), '```',
      '',
      '```story', part(2), '```'
    ].join('\n');
  }

  return [
    `(mock agent) Harmonized the ${shape.type} to the ${shape.label} template${askText ? ` and folded in: "${askText.slice(0, 80)}"` : ''}.`,
    '',
    '```story',
    doc,
    '```'
  ].join('\n');
}

/**
 * Send one turn to an endpoint that answers in a single response — a Power Automate HTTP
 * trigger, or anything else shaped like one. Use this when the generation logic lives in
 * the flow; if it lives in the Copilot Studio agent, use Direct Line below instead.
 */
async function callFlow({ messages, story, context, intent, template }) {
  if (!AGENT_URL) {
    throw new Error('AGENT_MODE=flow needs AGENT_URL. Set it to the endpoint URL, or set AGENT_MODE=mock.');
  }
  const response = await fetch(AGENT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AGENT_KEY ? { 'Authorization': `Bearer ${AGENT_KEY}` } : {})
    },
    body: JSON.stringify({
      system: buildSystemPrompt({ intent, template }),
      // Images go back out as the data URLs they arrived as, which is what most HTTP
      // endpoints (and Power Automate's base64 handling) can take directly
      messages: messages.map(m => (m.images
        ? { ...m, images: m.images.map(img => `data:${img.mime};base64,${img.data}`) }
        : m)),
      story, context, intent,
      template: template && template.id
    })
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`The story agent returned ${response.status}: ${text.slice(0, 500)}`);
  }
  // Tolerate both a bare string and the usual JSON envelopes
  try {
    const data = JSON.parse(text);
    return data.reply || data.text || data.output || data.result || text;
  } catch (err) {
    return text;
  }
}

/*
 * Talking to the Copilot Studio agent over Direct Line.
 *
 * A conversation is created per turn and thrown away. That sounds wasteful and is exactly
 * what makes this safe to run behind a stateless route: nothing has to be remembered
 * between requests, two browser tabs cannot tread on each other, and a conversation that
 * fails halfway leaves nothing to clean up. The cost is one handshake per message, which
 * against a person typing is not a cost worth optimising.
 *
 * The whole turn — the format contract, the transcript, the story as it stands — goes in
 * as a single message, because the agent is not being asked to remember anything either.
 */
async function directLineToken() {
  if (AGENT_DIRECTLINE_SECRET) return AGENT_DIRECTLINE_SECRET;
  if (!AGENT_TOKEN_ENDPOINT) {
    throw new Error('AGENT_MODE=directline needs AGENT_TOKEN_ENDPOINT (or AGENT_DIRECTLINE_SECRET). Copilot Studio shows the token endpoint under Channels.');
  }
  const response = await fetch(AGENT_TOKEN_ENDPOINT, { headers: { 'Accept': 'application/json' } });
  const text = await response.text();
  if (!response.ok) throw new Error(`The Copilot Studio token endpoint returned ${response.status}: ${text.slice(0, 300)}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error('The token endpoint did not return JSON. Check that AGENT_TOKEN_ENDPOINT is the Direct Line token URL.');
  }
  if (!data.token) throw new Error('The token endpoint returned no token.');
  return data.token;
}

// The row rendered back as a template document, so the agent sees the story in the same
// shape it is asked to reply in
function storyBlock(story) {
  return ['```story', [
    `**Story Title:** ${story.summary || ''}`,
    `**Story Points:** ${story.storyPoints || ''}`,
    `**Labels:** ${story.labels || ''}`,
    '',
    story.description || '(no description yet)'
  ].join('\n'), '```'].join('\n');
}

/*
 * The stories the agent proposed last time, put back into its own turn.
 *
 * The transcript otherwise carries only the agent's prose, which is right for the story
 * editor (the story itself is sent fresh each turn) and wrong for a brainstorm: there, the
 * proposals *are* the thing under discussion, and a model asked to "make the second one
 * smaller" without them either rebuilds every story from scratch or answers with no story
 * at all. Only the latest set is put back — they are whole documents, the transcript is
 * resent every turn, and an older set is superseded by the newer one anyway.
 */
const MAX_PROPOSALS = 10;
function readProposals(list) {
  if (!Array.isArray(list)) return [];
  const text = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v).slice(0, MAX_CHARS) : '');
  return list.slice(0, MAX_PROPOSALS)
    .filter(p => p && typeof p === 'object')
    .map(p => ({ summary: text(p.summary), storyPoints: text(p.storyPoints), labels: text(p.labels), description: text(p.description) }))
    .filter(p => p.summary || p.description);
}

function withLatestProposals(turns) {
  const last = turns.map(t => Boolean(t.proposals)).lastIndexOf(true);
  return turns.map((t, i) => {
    const { proposals, ...turn } = t;
    if (i !== last) return turn;
    return {
      ...turn,
      content: [turn.content, '', `The ${proposals.length === 1 ? 'story' : 'stories'} I proposed:`, '',
        proposals.map(storyBlock).join('\n\n')].join('\n')
    };
  });
}

// What the agent is told about the story in hand. A brainstorm has none — it starts from
// an idea — and showing it an empty story would only invite it to fill that one in.
function storyPreamble({ story, intent }) {
  if (intent === 'brainstorm') return '';
  return `The story as it currently stands:\n\n${storyBlock(story)}\n\n`;
}

// Everything the agent needs to answer this turn, as one message. Direct Line has no
// notion of a system prompt or a message history, so everything is flattened into one.
function composeTurn({ messages, story, context, intent, template }) {
  const parts = [buildSystemPrompt({ intent, template }), ''];
  if (context && context.projectKey) parts.push(`Jira project: ${context.projectKey}`, '');
  const preamble = storyPreamble({ story, intent });
  if (preamble) parts.push(preamble);
  parts.push('Conversation so far:');
  for (const m of messages) parts.push(`${m.role === 'user' ? 'Person' : 'You'}: ${m.content}`);
  return parts.join('\n');
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callDirectLine(payload) {
  if (imageCount(payload.messages) > 0) {
    throw new Error('Images cannot be sent to the Copilot Studio agent over Direct Line. Remove them, or describe what they show.');
  }
  const token = await directLineToken();
  const auth = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };

  const startRes = await fetch(`${DIRECTLINE_BASE}/conversations`, { method: 'POST', headers: auth });
  const startText = await startRes.text();
  if (!startRes.ok) throw new Error(`Direct Line refused to start a conversation (${startRes.status}): ${startText.slice(0, 300)}`);
  const { conversationId } = JSON.parse(startText);
  if (!conversationId) throw new Error('Direct Line started a conversation without an id.');

  // Read once before saying anything, purely for the watermark: it puts the agent's
  // greeting behind us so only the reply to this turn is collected.
  let watermark = '';
  try {
    const seed = await fetch(`${DIRECTLINE_BASE}/conversations/${conversationId}/activities`, { headers: auth });
    if (seed.ok) watermark = (JSON.parse(await seed.text()).watermark) || '';
  } catch (err) {
    // No watermark just means the greeting is filtered by sender instead
  }

  const postRes = await fetch(`${DIRECTLINE_BASE}/conversations/${conversationId}/activities`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'message', from: { id: USER_ID }, text: composeTurn(payload) })
  });
  if (!postRes.ok) {
    throw new Error(`Direct Line rejected the message (${postRes.status}): ${(await postRes.text()).slice(0, 300)}`);
  }

  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  const collected = [];
  let lastHeard = Date.now();
  let done = false;

  while (Date.now() < deadline && !done) {
    const url = `${DIRECTLINE_BASE}/conversations/${conversationId}/activities`
      + (watermark ? `?watermark=${encodeURIComponent(watermark)}` : '');
    const pollRes = await fetch(url, { headers: auth });
    if (pollRes.ok) {
      const page = JSON.parse(await pollRes.text());
      if (page.watermark) watermark = page.watermark;
      for (const activity of page.activities || []) {
        if (activity.type !== 'message') continue;
        if (activity.from && activity.from.id === USER_ID) continue;
        if (activity.text) { collected.push(activity.text); lastHeard = Date.now(); }
        // The bot saying it is waiting on us means the reply is finished
        if (activity.inputHint === 'expectingInput' && collected.length) done = true;
      }
    }
    if (collected.length && Date.now() - lastHeard >= REPLY_QUIET_MS) break;
    if (!done) await sleep(500);
  }

  if (collected.length === 0) {
    throw new Error(`The agent did not reply within ${Math.round(REPLY_TIMEOUT_MS / 1000)}s.`);
  }
  return collected.join('\n\n');
}

/*
 * A model served by Ollama on this machine.
 *
 * Unlike Direct Line this speaks a real chat shape, so the format contract goes in the
 * system slot and the transcript stays a transcript. The story is folded into the last
 * user turn rather than sent first: context then instruction reads better to a small
 * model than the other way round.
 */
// A model name from the browser is still a string from outside, so it is checked against
// the shape Ollama uses (name[:tag], optionally namespaced) before being sent on. An
// unknown-but-well-formed name is left to Ollama, whose 404 says exactly which model is missing.
const OLLAMA_MODEL_RE = /^[\w.\-]+(\/[\w.\-]+)*(:[\w.\-]+)?$/;
const pickOllamaModel = (requested) => {
  const name = String(requested || '').trim();
  if (!name) return AGENT_OLLAMA_MODEL;
  if (!OLLAMA_MODEL_RE.test(name) || name.length > 200) {
    throw new Error(`"${name.slice(0, 60)}" is not a usable Ollama model name.`);
  }
  return name;
};

// Ollama resolves an untagged name to its ":latest" tag, so AGENT_OLLAMA_MODEL=llama3.1 and
// the installed "llama3.1:latest" are the same model and must not read as two.
const sameOllamaModel = (a, b) => {
  const tagged = (n) => (String(n || '').includes(':') ? String(n) : `${n}:latest`);
  return tagged(a) === tagged(b);
};

// The models installed on this host, newest-loaded first as Ollama lists them.
async function listOllamaModels() {
  const response = await fetch(`${AGENT_OLLAMA_URL}/api/tags`, { timeout: 2000 });
  if (!response.ok) throw new Error(`Ollama returned ${response.status} when listing models.`);
  const data = JSON.parse(await response.text());
  return (data.models || [])
    .map(m => m && m.name)
    .filter(name => typeof name === 'string' && name);
}

/*
 * Which installed models can read an image. Ollama reports it per model (`capabilities`
 * from /api/show), and a model without it does not fail on an image — it quietly answers
 * without having seen it, which is worse. Cached per name: a model's abilities do not
 * change while it is installed, and the status call would otherwise ask every time.
 */
const visionCache = new Map();
async function ollamaSeesImages(name) {
  if (visionCache.has(name)) return visionCache.get(name);
  try {
    const response = await fetch(`${AGENT_OLLAMA_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
      timeout: 3000
    });
    if (!response.ok) return false;
    const data = JSON.parse(await response.text());
    const sees = Array.isArray(data.capabilities) && data.capabilities.includes('vision');
    visionCache.set(name, sees);
    return sees;
  } catch (err) {
    return false; // not cached, so a hiccup is asked again next time
  }
}

async function callOllama({ messages, story, context, intent, model, template }) {
  const modelName = pickOllamaModel(model);
  if (imageCount(messages) > 0 && !(await ollamaSeesImages(modelName))) {
    const installed = await listOllamaModels().catch(() => []);
    const seeing = [];
    for (const name of installed) if (await ollamaSeesImages(name)) seeing.push(name);
    throw new Error(`${modelName} cannot read images. `
      + (seeing.length
        ? `Switch to ${seeing.join(' or ')}, which can.`
        : 'Pull a vision model (gemma3, llama3.2-vision or qwen2.5vl, say) with "ollama pull".'));
  }
  const history = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  const project = context && context.projectKey ? `Jira project: ${context.projectKey}\n\n` : '';

  const chat = [
    { role: 'system', content: buildSystemPrompt({ intent, template }) },
    // Ollama takes images per message, as bare base64 with no data: prefix
    ...history.map(m => ({ role: m.role, content: m.content, ...(m.images ? { images: m.images.map(i => i.data) } : {}) })),
    {
      role: 'user',
      content: `${project}${storyPreamble({ story, intent })}${last.content}`,
      ...(last.images ? { images: last.images.map(i => i.data) } : {})
    }
  ];

  let response;
  try {
    response = await fetch(`${AGENT_OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelName,
        messages: chat,
        stream: false,
        options: {
          temperature: AGENT_OLLAMA_TEMPERATURE,
          // A whole story document is a few hundred tokens, but a split returns several of
          // them in one reply — and a reply cut off mid-block loses that story outright
          num_predict: Number(process.env.AGENT_OLLAMA_NUM_PREDICT) || 4096,
          /*
           * Pinned, because Ollama's default context is sized from available VRAM and can
           * land at 4096 — and the format contract sits at the *front* of this prompt, so
           * it is the first thing dropped when a grown story overflows the window. Losing
           * it silently is the worst failure available: the model keeps answering, just
           * not in the format, and every reply fails validation for no visible reason.
           */
          num_ctx: Number(process.env.AGENT_OLLAMA_NUM_CTX) || 8192
        }
      }),
      timeout: REPLY_TIMEOUT_MS
    });
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      throw new Error(`No Ollama at ${AGENT_OLLAMA_URL}. Start it with "ollama serve", or point AGENT_OLLAMA_URL somewhere else.`);
    }
    if (err.type === 'request-timeout') {
      throw new Error(`Ollama did not answer within ${Math.round(REPLY_TIMEOUT_MS / 1000)}s. A larger model on CPU can need longer — raise AGENT_REPLY_TIMEOUT_MS.`);
    }
    throw err;
  }

  const text = await response.text();
  if (!response.ok) {
    // Ollama says exactly what is wrong; a missing model is much the commonest case
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) detail = parsed.error;
    } catch (err) { /* keep the raw body */ }
    throw new Error(`Ollama returned ${response.status}: ${detail}`);
  }

  const data = JSON.parse(text);
  const reply = data.message && data.message.content;
  if (!reply) throw new Error('Ollama returned no message content.');
  debug(`ollama ${modelName}: ${data.eval_count || '?'} tokens in ${Math.round((data.total_duration || 0) / 1e9)}s`);
  return reply;
}

const TRANSPORTS = {
  mock: (payload) => Promise.resolve(mockAgent(payload)),
  flow: callFlow,
  directline: callDirectLine,
  ollama: callOllama
};

const callAgent = (payload) => {
  const transport = TRANSPORTS[AGENT_MODE];
  if (!transport) {
    return Promise.reject(new Error(`Unknown AGENT_MODE "${AGENT_MODE}". Use mock, flow, directline or ollama.`));
  }
  return transport(payload);
};

// Turn a raw reply into the shape the client renders: prose for the bubble, a validated
// patch for the Apply button, and the deviations that were repaired along the way.
function harmonize(raw, template, intent) {
  const { prose, documents } = splitReply(raw);
  if (documents.length === 0) return { reply: prose, patch: null, stories: null, violations: [], hard: [] };

  // A brainstorm has no row to patch, so even a single story is one to add
  if (documents.length === 1 && intent !== 'brainstorm') {
    const doc = parseStoryDoc(documents[0]);
    const { violations, hard } = validateStoryDoc(doc, { template });
    if (hard.length > 0) return { reply: prose, patch: null, stories: null, violations, hard };
    return { reply: prose, patch: toPatch(doc, template), stories: null, violations, hard: [] };
  }

  /*
   * A split or a brainstorm: several stories, each checked on its own. They are never a
   * patch to the row being edited — they come back as `stories`, which the grid adds as
   * rows of their own.
   * Findings are prefixed with which story they belong to, or "AC numbering" is ambiguous.
   */
  const violations = [];
  const hard = [];
  const stories = [];
  documents.forEach((text, i) => {
    const doc = parseStoryDoc(text);
    const result = validateStoryDoc(doc, { template });
    const label = `Story ${i + 1}${docLabel(doc)}`;
    violations.push(...result.violations.map(v => `${label}: ${v}`));
    // One broken story does not sink the others: the sound ones are kept, and the broken
    // one is named — hard, so it is worth a re-ask, but not a reason to show nothing
    if (result.hard.length) hard.push(...result.hard.map(v => `${label}: ${v}`));
    else stories.push(toPatch(doc, template));
  });
  return { reply: prose, patch: null, stories: stories.length ? stories : null, violations, hard };
}

// " (Export as CSV)", so a finding can be matched to a story without counting blocks
function docLabel(doc) {
  const title = doc.meta['story title'] || doc.meta.title || '';
  return title ? ` ("${title.length > 50 ? `${title.slice(0, 47)}...` : title}")` : '';
}

/*
 * Ask once, and if the answer breaks the format in a way that cannot be repaired locally,
 * ask again naming exactly what was wrong. Once only: a model that misses the format twice
 * is not going to find it on the third attempt, and the caller has a better error to show
 * than a fourth wait. Shared by the chat and the one-press format, which fail the same way.
 */
async function askWithRepair(payload) {
  const first = harmonize(await callAgent(payload), payload.template, payload.intent);
  if (first.hard.length === 0) return first;

  debug('Story agent broke the format, re-asking:', first.hard);
  const retry = {
    ...payload,
    messages: [...payload.messages, {
      role: 'user',
      content: `Your last reply did not follow the story format: ${first.hard.join(' ')} `
        + (/^Story \d+:/.test(first.hard[0])
          ? 'Send every story again, each complete in its own fenced ```story block, '
          : 'Send the complete document again in a fenced ```story block, ')
        + 'following the format exactly, with every field and criterion filled in.'
    }]
  };
  const second = harmonize(await callAgent(retry), payload.template, payload.intent);
  // Named, not just announced: a re-ask doubles the wait, and "it did not follow the
  // format" gives nobody anything to change
  const note = `The first reply was re-requested because: ${first.hard.join(' ')}`;
  if (second.hard.length === 0) return { ...second, violations: [...second.violations, note] };

  // Neither is clean. With several stories, whichever answer kept more of them is the one
  // worth showing, its broken stories named rather than silently gone.
  const kept = (r) => (r.stories ? r.stories.length : 0);
  if (kept(second) > kept(first)) return { ...second, violations: [...second.violations, note] };
  return first; // no better; report the original diagnosis
}

/*
 * Which format this request is about. The row's issue type picks the folder and the
 * person's choice picks the variant within it; both are hints, and `resolveTemplate`
 * falls back rather than failing, so a Jira type nobody has written a template for is
 * still formatted as a story instead of erroring.
 */
const templateFor = (body) => resolveTemplate({
  issueType: body && body.issueType,
  variant: body && body.templateVariant
});

function registerAgentRoutes(app) {
  // What templates exist, so the dialog can offer the variants this type actually has.
  app.get('/api/agent/templates', (req, res) => {
    res.json({ templates: listTemplates() });
  });

  app.post('/api/agent/chat', async (req, res) => {
    const { messages, story, context, model } = req.body || {};
    // 'brainstorm' is the page-level assistant: an idea in, stories to add out. Anything
    // else is the story editor's rail, refining the one row it was opened on.
    const intent = req.body && req.body.intent === 'brainstorm' ? 'brainstorm' : 'refine';
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required.' });
    }

    // The transcript comes from the browser, so bound it here rather than trusting it
    const turns = withLatestProposals(capImages(messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-MAX_TURNS)
      .map((m) => {
        const turn = { role: m.role, content: m.content.slice(0, MAX_CHARS) };
        // Only a person attaches images; an assistant turn claiming some is ignored
        const images = m.role === 'user' ? readImages(m.images) : [];
        if (images.length) turn.images = images;
        // ...and only the agent proposes stories
        const proposals = m.role === 'assistant' ? readProposals(m.stories) : [];
        if (proposals.length) turn.proposals = proposals;
        return turn;
      })));
    if (turns.length === 0) {
      return res.status(400).json({ error: 'No usable messages in the transcript.' });
    }

    // model is honoured by the ollama transport and ignored by the rest, which have no
    // model to choose between
    const template = templateFor(req.body);
    const payload = {
      messages: turns, story: story || {}, context: context || {},
      intent, model, template
    };

    try {
      const result = await askWithRepair(payload);

      // Stories that passed are still offered when others did not; the ones left out are
      // named in the violations, so a partial answer is never mistaken for a whole one
      if (result.hard.length > 0 && !result.stories) {
        return res.json({
          reply: result.reply || 'The agent did not return a story in the expected format.',
          patch: null,
          violations: result.violations,
          template: template.id
        });
      }
      if (result.hard.length > 0) {
        return res.json({
          reply: result.reply,
          patch: null,
          stories: result.stories,
          // Every finding already carries its story's number and title; say what they mean
          violations: [
            'Stories named below did not follow the format and were left out; ask again for those.',
            ...result.violations
          ],
          template: template.id
        });
      }

      res.json({
        reply: result.reply,
        patch: result.patch,
        // Set instead of patch when the reply split the story: each is a new row's fields
        stories: result.stories,
        violations: result.violations,
        template: template.id
      });
    } catch (err) {
      console.warn('Story agent failed:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  /*
   * Does this description follow the template? No model involved, so the editor can ask
   * on every keystroke without costing anything or waiting on anyone.
   */
  app.post('/api/agent/validate', (req, res) => {
    const { description } = req.body || {};
    if (typeof description !== 'string') {
      return res.status(400).json({ error: 'description is required.' });
    }
    res.json(checkConformance(description, templateFor(req.body)));
  });

  /*
   * One-press harmonize.
   *
   * A story that already parses needs no model at all — rendering the parsed document back
   * out is the reformat, and it is instant, free and exactly repeatable. The model is for
   * the other case: prose that has to be restructured before it can be formatted. Trying
   * the cheap path first is what keeps the button quick on the stories where it should be.
   */
  app.post('/api/agent/format', async (req, res) => {
    const { description, summary, storyPoints, labels, context, model } = req.body || {};
    if (typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ error: 'There is no description to format yet.' });
    }

    const template = templateFor(req.body);
    const doc = parseStoryDoc(description);
    // A description carries no title line, so its absence is not a reason to call a model
    const { violations, hard } = validateStoryDoc(doc, { requireTitle: false, template });
    const wantsCriteria = template.required.includes('Acceptance Criteria');
    if (hard.length === 0 && (!wantsCriteria || doc.criteria.length > 0)) {
      return res.json({
        patch: { description: toPublishableDescription(doc, template) },
        violations,
        usedModel: false,
        template: template.id
      });
    }

    if (AGENT_MODE === 'mock') {
      // Say so rather than handing back the stand-in's invention as a formatting result
      return res.status(503).json({ error: 'This story needs a model to restructure, and none is configured (AGENT_MODE=mock).' });
    }

    try {
      const payload = {
        messages: [{ role: 'user', content: `Reformat this ${template.type} into the canonical format.` }],
        story: { summary, description, storyPoints, labels },
        context: context || {},
        intent: 'format',
        model,
        template
      };
      const result = await askWithRepair(payload);
      if (!result.patch) {
        return res.status(422).json({
          error: result.violations.length
            ? `The model did not return a usable document: ${result.violations.join(' ')}`
            : 'The model did not return a story document.'
        });
      }
      res.json({ patch: result.patch, violations: result.violations, usedModel: true, template: template.id });
    } catch (err) {
      console.warn('Magic Format failed:', err.message);
      res.status(502).json({ error: err.message });
    }
  });

  // Lets the UI hide the chat entirely when no agent is configured, and say which mode
  // it is talking to rather than passing a mock answer off as the real thing.
  app.get('/api/agent/status', async (req, res) => {
    if (AGENT_MODE === 'ollama') {
      // Ollama is configuration-free, so "is it running" is the only question worth
      // asking. A refused connection answers instantly; a hung one should not hold the UI.
      // The same call already lists what is installed, so the UI gets the choice for free.
      try {
        const models = await listOllamaModels();
        // Ollama running with nothing pulled cannot answer, so do not offer the assistant:
        // every turn would fail on a model that is not there.
        const visionModels = [];
        for (const name of models) if (await ollamaSeesImages(name)) visionModels.push(name);
        return res.json({
          available: models.length > 0,
          mode: AGENT_MODE,
          // Which of them can be sent an image, so the UI can say so before a turn fails
          visionModels,
          images: visionModels.length > 0,
          // The env default when it is actually installed, reported under its full tag so
          // the picker shows the same name as the list. Otherwise the first installed model,
          // rather than opening on a name every request then fails on.
          model: models.find(m => sameOllamaModel(m, AGENT_OLLAMA_MODEL)) || models[0] || AGENT_OLLAMA_MODEL,
          defaultModel: AGENT_OLLAMA_MODEL,
          models
        });
      } catch (err) {
        return res.json({ available: false, mode: AGENT_MODE, model: AGENT_OLLAMA_MODEL, models: [] });
      }
    }
    const configured = AGENT_MODE === 'mock'
      || (AGENT_MODE === 'flow' && Boolean(AGENT_URL))
      || (AGENT_MODE === 'directline' && Boolean(AGENT_TOKEN_ENDPOINT || AGENT_DIRECTLINE_SECRET));
    // A flow endpoint is sent images and may do what it likes with them; Direct Line is not
    res.json({ available: configured, mode: AGENT_MODE, images: AGENT_MODE !== 'directline' });
  });
}

module.exports = { registerAgentRoutes, harmonize, mockAgent, composeTurn };
