/*
 * Saved Personal Access Tokens, for Jira and Confluence.
 *
 * A session lasts 30 days at most and can be lost sooner (a server whose sessions.json was
 * rewritten by another copy of it, say), and without the token there is nothing to sign
 * back in with. So a token can be kept — but not in a form that signs anybody in:
 *
 *   - the server holds it encrypted, in ~/.roadmap-runner/credentials.json (0600);
 *   - the key is a random value the browser made and keeps in its own storage, sent with
 *     each request that needs it and never written down here.
 *
 * The dev server listens on every interface and has no authentication of its own, so a
 * plain "sign in with the saved token" would hand the token to anyone on the network who
 * asked. With the key held by the browser, neither half is any use without the other,
 * and the token is never sent back to the browser at all — only its last four characters.
 *
 * Entries are per browser key, so two browsers can each keep their own without
 * overwriting the other's; one whose key is gone simply finds nothing saved.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VAULT_DIR = path.join(os.homedir(), '.roadmap-runner');
const VAULT_FILE = path.join(VAULT_DIR, 'credentials.json');
const PRODUCTS = new Set(['jira', 'confluence']);

// The browser's key is 32 random bytes, base64url
const validKey = key => typeof key === 'string' && /^[A-Za-z0-9_-]{43,}$/.test(key);

// One spelling per site, so a trailing slash does not hide a saved token
const normalizeUrl = url => String(url || '').trim().replace(/\/+$/, '').toLowerCase();

const cipherKey = key => crypto.createHash('sha256').update(`roadmap-runner vault:${key}`).digest();
const fingerprint = key => crypto.createHash('sha256').update(`roadmap-runner key id:${key}`).digest('hex').slice(0, 16);
const entryId = (product, url, key) => `${product}|${normalizeUrl(url)}|${fingerprint(key)}`;

function readVault() {
  try {
    return JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  } catch (err) {
    return {};
  }
}

function writeVault(vault) {
  fs.mkdirSync(VAULT_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(VAULT_FILE, JSON.stringify(vault, null, 1), { mode: 0o600 });
  fs.chmodSync(VAULT_FILE, 0o600); // the mode above only applies when the file is created
}

function saveToken(product, url, key, token) {
  if (!PRODUCTS.has(product) || !validKey(key) || !token) return false;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', cipherKey(key), iv);
  const data = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  const vault = readVault();
  vault[entryId(product, url, key)] = {
    product,
    url: normalizeUrl(url),
    savedAt: Date.now(),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  };
  writeVault(vault);
  return true;
}

function loadToken(product, url, key) {
  if (!PRODUCTS.has(product) || !validKey(key)) return null;
  const entry = readVault()[entryId(product, url, key)];
  if (!entry) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', cipherKey(key), Buffer.from(entry.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(entry.data, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    return null; // tampered with, or not this key's: either way, nothing saved
  }
}

function forgetToken(product, url, key) {
  if (!validKey(key)) return;
  const vault = readVault();
  const id = entryId(product, url, key);
  if (vault[id]) {
    delete vault[id];
    writeVault(vault);
  }
}

function describeToken(product, url, key) {
  const token = loadToken(product, url, key);
  if (!token) return { saved: false };
  const entry = readVault()[entryId(product, url, key)];
  return { saved: true, hint: token.slice(-4), savedAt: entry.savedAt };
}

/**
 * Resolve the token a sign-in should use, and record what the user asked for:
 *   remember: true   keep the token that worked
 *   remember: false  forget any token kept for this site
 *   (absent)         leave things as they are — an automatic re-sign-in says nothing
 * `useSaved` stands in for a token the user did not type.
 */
function tokenFor(product, url, body) {
  if (body.token) return body.token;
  if (body.useSaved) return loadToken(product, url, body.vaultKey);
  return null;
}

function afterSignIn(product, url, body, token) {
  try {
    if (body.remember === true && token) saveToken(product, url, body.vaultKey, token);
    else if (body.remember === false) forgetToken(product, url, body.vaultKey);
  } catch (err) {
    // The sign-in worked; failing to remember it is worth a warning, not a failure
    console.warn(`Could not update the saved ${product} token:`, err.message);
  }
}

const NOT_SAVED = 'No token is saved for this site in this browser. Enter your Personal Access Token.';

function registerCredentialRoutes(app) {
  app.post('/api/credentials/status', (req, res) => {
    const { product, url, vaultKey } = req.body || {};
    if (!PRODUCTS.has(product) || !url) return res.status(400).json({ error: 'Missing product or URL' });
    res.json(describeToken(product, url, vaultKey));
  });

  app.post('/api/credentials/forget', (req, res) => {
    const { product, url, vaultKey } = req.body || {};
    if (!PRODUCTS.has(product) || !url) return res.status(400).json({ error: 'Missing product or URL' });
    forgetToken(product, url, vaultKey);
    res.json({ saved: false });
  });
}

module.exports = { registerCredentialRoutes, tokenFor, afterSignIn, loadToken, NOT_SAVED };
