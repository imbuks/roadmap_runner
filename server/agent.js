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
  splitReply
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
 * A stand-in that answers in the agent's own contract: a note, then the complete document
 * in a fenced block. It echoes the current story back through the template, so applying
 * its reply exercises the real parse/validate/patch path rather than a happy path.
 */
function mockAgent({ messages, story }) {
  const ask = [...messages].reverse().find(m => m.role === 'user');
  const askText = (ask && ask.content) || '';
  const title = (story.summary || 'Untitled story').slice(0, 240);

  // Reuse the criteria already in the description when there are any, so a second turn
  // visibly builds on the first rather than starting over.
  const existing = String(story.description || '').match(/^###[ \t]+AC\d+[ \t]*:[ \t]*(.*)$/gm) || [];
  const titles = existing.map(h => h.replace(/^###[ \t]+AC\d+[ \t]*:[ \t]*/, '').trim());
  if (titles.length === 0) titles.push('Happy path', 'Validation failure');
  if (askText) titles.push(askText.slice(0, 60).replace(/\s+/g, ' ').trim());

  const criteria = titles.map((t, i) => [
    `### AC${i + 1}: ${t}`,
    `**Given** the user is on the story screen`,
    `**When** they ${t.toLowerCase()}`,
    `**Then** the outcome is observable and testable`
  ].join('\n')).join('\n\n');

  const doc = [
    `**Story Title:** ${title}`,
    `**Story Points:** ${story.storyPoints || 3}`,
    `**Labels:** ${story.labels || 'needs-review'}`,
    '',
    '## User Story',
    '',
    '**As a** delivery team member',
    `**I want** ${title.toLowerCase()}`,
    '**So that** the work is understood before it is picked up',
    '',
    '## Business Value',
    '',
    '- Removes ambiguity before development starts',
    '- Makes the story testable as written',
    '',
    '## Acceptance Criteria',
    '',
    criteria
  ].join('\n');

  return [
    `(mock agent) Harmonized the story to the template${askText ? ` and folded in: "${askText.slice(0, 80)}"` : ''}.`,
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
async function callFlow({ messages, story, context, intent }) {
  if (!AGENT_URL) {
    throw new Error('AGENT_MODE=flow needs AGENT_URL. Set it to the endpoint URL, or set AGENT_MODE=mock.');
  }
  const response = await fetch(AGENT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AGENT_KEY ? { 'Authorization': `Bearer ${AGENT_KEY}` } : {})
    },
    body: JSON.stringify({ system: buildSystemPrompt({ intent }), messages, story, context, intent })
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

// Everything the agent needs to answer this turn, as one message. Direct Line has no
// notion of a system prompt or a message history, so everything is flattened into one.
function composeTurn({ messages, story, context, intent }) {
  const parts = [buildSystemPrompt({ intent }), ''];
  if (context && context.projectKey) parts.push(`Jira project: ${context.projectKey}`, '');
  parts.push('The story as it currently stands:', storyBlock(story), '');
  parts.push('Conversation so far:');
  for (const m of messages) parts.push(`${m.role === 'user' ? 'Person' : 'You'}: ${m.content}`);
  return parts.join('\n');
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function callDirectLine(payload) {
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

async function callOllama({ messages, story, context, intent, model }) {
  const modelName = pickOllamaModel(model);
  const history = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  const project = context && context.projectKey ? `Jira project: ${context.projectKey}\n\n` : '';

  const chat = [
    { role: 'system', content: buildSystemPrompt({ intent }) },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: `${project}The story as it currently stands:\n\n${storyBlock(story)}\n\n${last.content}` }
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
          // A whole story document is a few hundred tokens; leave room and no more
          num_predict: 2048,
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
function harmonize(raw) {
  const { prose, document } = splitReply(raw);
  if (!document) return { reply: prose, patch: null, violations: [], hard: [] };

  const doc = parseStoryDoc(document);
  const { violations, hard } = validateStoryDoc(doc);
  if (hard.length > 0) return { reply: prose, patch: null, violations, hard };

  return { reply: prose, patch: toPatch(doc), violations, hard: [] };
}

/*
 * Ask once, and if the answer breaks the format in a way that cannot be repaired locally,
 * ask again naming exactly what was wrong. Once only: a model that misses the format twice
 * is not going to find it on the third attempt, and the caller has a better error to show
 * than a fourth wait. Shared by the chat and the one-press format, which fail the same way.
 */
async function askWithRepair(payload) {
  const first = harmonize(await callAgent(payload));
  if (first.hard.length === 0) return first;

  debug('Story agent broke the format, re-asking:', first.hard);
  const retry = {
    ...payload,
    messages: [...payload.messages, {
      role: 'user',
      content: `Your last reply did not follow the story format: ${first.hard.join(' ')} `
        + 'Send the complete document again in a fenced ```story block, following the format exactly, '
        + 'with every field and criterion filled in.'
    }]
  };
  const second = harmonize(await callAgent(retry));
  if (second.hard.length > 0) return first; // no better; report the original diagnosis
  return { ...second, violations: [...second.violations, 'The first reply did not follow the format and was re-requested.'] };
}

function registerAgentRoutes(app) {
  app.post('/api/agent/chat', async (req, res) => {
    const { messages, story, context, model } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required.' });
    }

    // The transcript comes from the browser, so bound it here rather than trusting it
    const turns = messages
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-MAX_TURNS)
      .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
    if (turns.length === 0) {
      return res.status(400).json({ error: 'No usable messages in the transcript.' });
    }

    // model is honoured by the ollama transport and ignored by the rest, which have no
    // model to choose between
    const payload = { messages: turns, story: story || {}, context: context || {}, intent: 'refine', model };

    try {
      const result = await askWithRepair(payload);

      if (result.hard.length > 0) {
        return res.json({
          reply: result.reply || 'The agent did not return a story in the expected format.',
          patch: null,
          violations: result.violations
        });
      }

      res.json({ reply: result.reply, patch: result.patch, violations: result.violations });
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
    res.json(checkConformance(description));
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

    const doc = parseStoryDoc(description);
    // A description carries no title line, so its absence is not a reason to call a model
    const { violations, hard } = validateStoryDoc(doc, { requireTitle: false });
    if (hard.length === 0 && doc.criteria.length > 0) {
      return res.json({
        patch: { description: toPublishableDescription(doc) },
        violations,
        usedModel: false
      });
    }

    if (AGENT_MODE === 'mock') {
      // Say so rather than handing back the stand-in's invention as a formatting result
      return res.status(503).json({ error: 'This story needs a model to restructure, and none is configured (AGENT_MODE=mock).' });
    }

    try {
      const payload = {
        messages: [{ role: 'user', content: 'Reformat this story into the canonical format.' }],
        story: { summary, description, storyPoints, labels },
        context: context || {},
        intent: 'format',
        model
      };
      const result = await askWithRepair(payload);
      if (!result.patch) {
        return res.status(422).json({
          error: result.violations.length
            ? `The model did not return a usable document: ${result.violations.join(' ')}`
            : 'The model did not return a story document.'
        });
      }
      res.json({ patch: result.patch, violations: result.violations, usedModel: true });
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
        return res.json({
          available: models.length > 0,
          mode: AGENT_MODE,
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
    res.json({ available: configured, mode: AGENT_MODE });
  });
}

module.exports = { registerAgentRoutes, harmonize, mockAgent, composeTurn };
