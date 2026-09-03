/*
 * Reading the story assistant's configuration out of `.env`.
 *
 * The proxy takes its configuration from the environment, which is fine for Docker but
 * awkward for `npm run dev`: the obvious place to put settings is `.env`, and nothing here
 * reads it. The obvious fix — dotenv — is a trap, because `.env` belongs to the CRA dev
 * server and sets PORT for *the UI*. Loading it wholesale would move this process off 4000,
 * which is exactly where the UI's API_BASE points, and quietly break the dev split.
 *
 * So take only what is unambiguously ours: AGENT_* and nothing else. A variable already
 * set in the real environment always wins, so Docker and one-off overrides still behave.
 */

const fs = require('fs');
const path = require('path');

function loadAgentEnv(file = path.join(__dirname, '..', '.env')) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return []; // no .env at all is perfectly normal
  }

  const applied = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?(AGENT_[A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    // An explicit environment variable outranks the file, so `AGENT_MODE=mock npm run dev`
    // still does what it looks like
    if (process.env[key] !== undefined) continue;

    let value = rawValue.trim();
    const quoted = /^"(.*)"$/.exec(value) || /^'(.*)'$/.exec(value);
    // Only an unquoted value can carry a trailing comment; inside quotes a # is content
    value = quoted ? quoted[1] : value.replace(/\s+#.*$/, '').trim();

    process.env[key] = value;
    applied.push(key);
  }
  return applied;
}

module.exports = { loadAgentEnv };
