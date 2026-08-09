process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const fetch = require('node-fetch');
const fetchCookie = require('fetch-cookie');
const tough = require('tough-cookie');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const FormData = require('form-data');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;

// Attachments are held in memory only long enough to forward them to Jira
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// Session store: { [sessionId]: { jar, jiraUrl, auth, createdAt } }
const jiraSessions = {};

// Sessions are mirrored to disk so restarting the server does not force everyone to
// re-enter their token. The file holds Jira credentials, so it lives in the user's home
// directory (never the repo, where it could be committed), is readable only by them,
// and entries expire so an abandoned token does not linger forever.
const SESSION_DIR = path.join(os.homedir(), '.roadmap-runner');
const SESSION_FILE = path.join(SESSION_DIR, 'sessions.json');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function saveSessions() {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
    const data = {};
    Object.entries(jiraSessions).forEach(([id, session]) => {
      data[id] = {
        jiraUrl: session.jiraUrl,
        auth: session.auth,
        createdAt: session.createdAt,
        // Keep the cookie jar so Jira's own session cookies survive the restart too
        cookies: session.jar && typeof session.jar.toJSON === 'function' ? session.jar.toJSON() : null
      };
    });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(data), { mode: 0o600 });
    // writeFileSync/mkdirSync only apply their mode when creating, so tighten explicitly
    // in case the file or directory already existed with looser permissions
    fs.chmodSync(SESSION_FILE, 0o600);
    fs.chmodSync(SESSION_DIR, 0o700);
  } catch (err) {
    // Losing persistence is not fatal; the session still works until the next restart
    console.warn('Could not persist Jira sessions:', err.message);
  }
}

function loadSessions() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return;
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const now = Date.now();
    let expired = 0;
    Object.entries(data).forEach(([id, session]) => {
      if (!session || !session.auth || !session.jiraUrl) return;
      if (session.createdAt && now - session.createdAt > SESSION_TTL_MS) {
        expired++;
        return;
      }
      let jar;
      try {
        jar = session.cookies ? tough.CookieJar.fromJSON(session.cookies) : new tough.CookieJar();
      } catch (err) {
        jar = new tough.CookieJar(); // a corrupt jar just means re-negotiating cookies
      }
      jiraSessions[id] = { jar, jiraUrl: session.jiraUrl, auth: session.auth, createdAt: session.createdAt || now };
    });
    const restored = Object.keys(jiraSessions).length;
    console.log(`Restored ${restored} Jira session(s) from ${SESSION_FILE}${expired ? ` (${expired} expired)` : ''}`);
    if (expired) saveSessions();
  } catch (err) {
    console.warn('Could not read stored Jira sessions:', err.message);
  }
}

/**
 * Build the correct Authorization header for a session's stored credentials.
 * - 'pat'   : Jira Data Center/Server Personal Access Token -> Bearer auth (no username)
 * - 'basic' : username + password/token -> Basic auth (default, legacy behaviour)
 */
function buildAuthHeader(auth) {
  if (auth && auth.authType === 'pat') {
    return 'Bearer ' + auth.jiraToken;
  }
  return 'Basic ' + Buffer.from(`${auth.jiraUser}:${auth.jiraToken}`).toString('base64');
}

app.post('/api/jira/auth', async (req, res) => {
  const { jiraUrl, jiraUser, jiraToken, authType = 'basic' } = req.body;
  // PAT auth identifies the user by the token itself, so a username is not required.
  const missingUser = authType !== 'pat' && !jiraUser;
  if (!jiraUrl || !jiraToken || missingUser) {
    return res.status(400).json({ error: 'Missing Jira credentials or URL' });
  }
  try {
    const jar = new tough.CookieJar();
    const fetchWithCookies = fetchCookie(fetch, jar);
    const auth = { jiraUser, jiraToken, authType };
    // Make a simple request to verify credentials (e.g., get current user)
    const apiUrl = `${jiraUrl}/rest/api/2/myself`;
    const response = await fetchWithCookies(apiUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    if (!response.ok) {
      const rawText = await response.text();
      return res.status(response.status).json({ error: 'Jira authentication failed', body: rawText });
    }
    // Store session
    const sessionId = uuidv4();
    jiraSessions[sessionId] = { jar, jiraUrl, auth, createdAt: Date.now() };
    saveSessions();
    res.json({ sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Who the session belongs to. PAT sessions carry no username at all, and even a basic
// session only stores whatever was typed into the login form, so ask Jira itself rather
// than trusting the stored credentials.
app.post('/api/jira/current-user', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  try {
    const apiUrl = `${jiraUrl}/rest/api/2/myself`;
    const response = await fetchWithCookies(apiUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const me = JSON.parse(rawText);
    // Same shape as /reporters, so the client can match one against the other
    res.json({ user: { key: me.accountId || me.name, name: me.displayName || me.name || '' } });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Sign out: forget the session in memory and on disk, so the stored token is removed
app.post('/api/jira/logout', (req, res) => {
  const { sessionId } = req.body;
  if (sessionId && jiraSessions[sessionId]) {
    delete jiraSessions[sessionId];
    saveSessions();
  }
  res.json({ ok: true });
});

app.post('/api/jira/projects', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  try {
    const apiUrl = `${jiraUrl}/rest/api/2/project`;
    const response = await fetchWithCookies(apiUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const data = JSON.parse(rawText);
    // Return only key and name for each project
    const projects = data.map(project => ({ key: project.key, name: project.name }));
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/api/jira/teams', async (req, res) => {
  const { sessionId, projectKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  const authHeader = buildAuthHeader(auth);
  const optLabel = (opt) => (typeof opt === 'string' ? opt : (opt.value || opt.name || opt.label || ''));
  try {
    // Step 1: Get all fields to find the custom field ID for 'team'
    const fieldsRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/field`, {
      headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
      redirect: 'follow'
    });
    const fieldsText = await fieldsRes.text();
    if (!fieldsRes.ok) {
      return res.status(fieldsRes.status).json({ error: 'Jira API error', status: fieldsRes.status, body: fieldsText });
    }
    const fields = JSON.parse(fieldsText);
    const teamField = fields.find(f => f.name && f.name.trim().toLowerCase() === 'team');
    if (!teamField) {
      return res.status(404).json({ error: 'Custom field "team" not found' });
    }

    let teams = [];

    // Strategy 1: context/option endpoint (works on Jira Cloud)
    try {
      const optionsRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/field/${teamField.id}/context/option`, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      if (optionsRes.ok) {
        const optionsData = JSON.parse(await optionsRes.text());
        teams = (optionsData.values || []).map(opt => ({ id: opt.id, value: optLabel(opt) }));
      }
    } catch (e) {
      console.warn('Team context/option lookup failed:', e.message);
    }

    // Strategy 2 (on-prem Jira Server/DC): read allowedValues from createmeta
    if (teams.length === 0 && projectKey) {
      const metaUrl = `${jiraUrl}/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes.fields`;
      const metaRes = await fetchWithCookies(metaUrl, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      if (metaRes.ok) {
        const meta = JSON.parse(await metaRes.text());
        const seen = new Set();
        (meta.projects || []).forEach(project => {
          (project.issuetypes || []).forEach(it => {
            const fieldMeta = it.fields && it.fields[teamField.id];
            (fieldMeta && fieldMeta.allowedValues ? fieldMeta.allowedValues : []).forEach(opt => {
              const value = optLabel(opt);
              if (value && !seen.has(value)) {
                seen.add(value);
                teams.push({ id: opt.id || value, value });
              }
            });
          });
        });
      } else {
        console.warn('Team createmeta lookup failed:', metaRes.status);
      }
    }

    // Strategy 3 (fallback): collect distinct team values already used on the project's issues
    if (teams.length === 0 && projectKey) {
      const jql = `project = "${projectKey}" AND "${teamField.name}" is not EMPTY`;
      const searchUrl = `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=${teamField.id}&maxResults=200`;
      const searchRes = await fetchWithCookies(searchUrl, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      if (searchRes.ok) {
        const searchData = JSON.parse(await searchRes.text());
        const seen = new Set();
        (searchData.issues || []).forEach(issue => {
          const fieldVal = (issue.fields || {})[teamField.id];
          const value = optLabel(fieldVal);
          // Capture the numeric option ID if Jira returns it on the field object
          const id = (fieldVal && typeof fieldVal === 'object' && fieldVal.id) ? fieldVal.id : value;
          if (value && !seen.has(value)) {
            seen.add(value);
            teams.push({ id, value });
          }
        });
        teams.sort((a, b) => a.value.localeCompare(b.value));
      } else {
        console.warn('Team search fallback failed:', searchRes.status);
      }
    }

    res.json({ teams, fieldId: teamField.id });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/api/jira/reporters', async (req, res) => {
  const { sessionId, projectKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  try {
    // Use assignable users endpoint. It pages at 50 by default, which on a large project
    // leaves most people — including whoever is signed in — off the list entirely.
    const apiUrl = `${jiraUrl}/rest/api/2/user/assignable/search?project=${projectKey}&maxResults=1000`;
    const response = await fetchWithCookies(apiUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const users = JSON.parse(rawText);
    // Return displayName and accountId/name
    res.json({ reporters: users.map(u => ({ key: u.accountId || u.name, name: u.displayName })) });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/api/jira/application-cis', async (req, res) => {
  const { sessionId, epicKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  try {
    // Step 1: Get all fields to find the custom field ID for 'Application CI'
    const fieldsUrl = `${jiraUrl}/rest/api/2/field`;
    const fieldsRes = await fetchWithCookies(fieldsUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const fieldsText = await fieldsRes.text();
    if (!fieldsRes.ok) {
      return res.status(fieldsRes.status).json({ error: 'Jira API error', status: fieldsRes.status, body: fieldsText });
    }
    const fields = JSON.parse(fieldsText);
    const appCIField = fields.find(f => f.name.trim().toLowerCase() === 'application ci (as per cmdb)');
    if (!appCIField) {
      return res.status(404).json({ error: 'Custom field "Application CI" not found' });
    }
    // Step 2: Get the epic issue to extract Application CI values
    const epicUrl = `${jiraUrl}/rest/api/2/issue/${epicKey}`;
    const epicRes = await fetchWithCookies(epicUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const epicText = await epicRes.text();
    if (!epicRes.ok) {
      return res.status(epicRes.status).json({ error: 'Jira API error', status: epicRes.status, body: epicText });
    }
    const epicData = JSON.parse(epicText);
    // Application CI could be a single value or array
    const appCIValue = epicData.fields[appCIField.id];
    let appCIs = [];
    if (Array.isArray(appCIValue)) {
      appCIs = appCIValue.map(val => (typeof val === 'string' ? val : val.value || val.name || JSON.stringify(val)));
    } else if (appCIValue) {
      appCIs = [typeof appCIValue === 'string' ? appCIValue : appCIValue.value || appCIValue.name || JSON.stringify(appCIValue)];
    }
    res.json({ applicationCIs: appCIs });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/api/jira/boards', async (req, res) => {
  const { sessionId, projectKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  try {
    const boardsUrl = `${jiraUrl}/rest/agile/1.0/board?projectKeyOrId=${projectKey}`;
    const boardsRes = await fetchWithCookies(boardsUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const boardsText = await boardsRes.text();
    if (!boardsRes.ok) {
      return res.status(boardsRes.status).json({ error: 'Jira API error', status: boardsRes.status, body: boardsText });
    }
    const boardsData = JSON.parse(boardsText);
    const boards = (boardsData.values || []).map(b => ({ id: b.id, name: b.name, type: b.type }));
    res.json({ boards });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/api/jira/sprints', async (req, res) => {
  const { sessionId, boardId } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  try {
    // Only fetch open sprints (active + future); exclude closed sprints
    const sprintsUrl = `${jiraUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active,future`;
    const sprintsRes = await fetchWithCookies(sprintsUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const sprintsText = await sprintsRes.text();
    if (!sprintsRes.ok) {
      return res.status(sprintsRes.status).json({ error: 'Jira API error', status: sprintsRes.status, body: sprintsText });
    }
    const sprintsData = JSON.parse(sprintsText);
    // Guard against instances that ignore the state filter by also excluding closed here
    const sprints = (sprintsData.values || [])
      .filter(s => s.state !== 'closed')
      .map(s => ({ id: s.id, name: s.name, state: s.state }));
    res.json({ sprints });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.post('/api/jira/sprint-field-options', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  try {
    // Step 1: Get all fields to find the custom field ID for 'Sprint'
    const fieldsUrl = `${jiraUrl}/rest/api/2/field`;
    const fieldsRes = await fetchWithCookies(fieldsUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const fieldsText = await fieldsRes.text();
    if (!fieldsRes.ok) {
      return res.status(fieldsRes.status).json({ error: 'Jira API error', status: fieldsRes.status, body: fieldsText });
    }
    const fields = JSON.parse(fieldsText);
    const sprintField = fields.find(f => f.name.trim().toLowerCase() === 'sprint');
    if (!sprintField) {
      return res.status(404).json({ error: 'Custom field "Sprint" not found' });
    }
    // Step 2: Get options for the custom field (if it's a select list)
    const optionsUrl = `${jiraUrl}/rest/api/2/field/${sprintField.id}/context/option`;
    const optionsRes = await fetchWithCookies(optionsUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const optionsText = await optionsRes.text();
    if (!optionsRes.ok) {
      return res.status(optionsRes.status).json({ error: 'Jira API error', status: optionsRes.status, body: optionsText });
    }
    const optionsData = JSON.parse(optionsText);
    // The options are usually in optionsData.values
    const sprints = (optionsData.values || []).map(opt => ({ id: opt.id, name: opt.value }));
    res.json({ sprints });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// CSV upload endpoint for roadmap data
app.post('/api/csv/upload', async (req, res) => {
  try {
    const { csvData } = req.body;
    if (!csvData) {
      return res.status(400).json({ error: 'No CSV data provided' });
    }
    
    // Parse CSV data
    const lines = csvData.split('\n').filter(line => line.trim());
    if (lines.length < 2) {
      return res.status(400).json({ error: 'CSV file must have headers and at least one data row' });
    }
    
    const headers = lines[0].split(',').map(h => h.trim());
    const dataRows = lines.slice(1);
    
    const parsedData = dataRows.map((line, index) => {
      const values = line.split(',').map(v => v.trim());
      const row = {};
      
      headers.forEach((header, i) => {
        row[header] = values[i] || '';
      });
      
      // Ensure we have an ID
      if (!row.id) {
        row.id = index + 1;
      }
      
      return row;
    }).filter(row => row.capability && row.feature); // Filter out empty rows
    
    res.json({ 
      success: true, 
      data: parsedData,
      headers: headers,
      rowCount: parsedData.length 
    });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Get project versions endpoint
app.post('/api/jira/versions', async (req, res) => {
  const { sessionId, projectKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  try {
    const versionsUrl = `${jiraUrl}/rest/api/2/project/${projectKey}/versions`;
    const response = await fetchWithCookies(versionsUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const versions = JSON.parse(rawText);
    // Return versions with key info
    const versionList = versions.map(version => ({
      id: version.id,
      name: version.name,
      description: version.description,
      archived: version.archived,
      released: version.released,
      releaseDate: version.releaseDate
    }));
    res.json({ versions: versionList });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Get features (epics) by version endpoint
app.post('/api/jira/features', async (req, res) => {
  const { sessionId, projectKey, versionId, issueKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  const authHeader = buildAuthHeader(auth);
  try {
    const versionClause = versionId && versionId !== 'all' ? ` AND fixVersion = "${versionId}"` : '';
    const jqlCandidates = issueKey
      // Fetch a specific issue by key (for getting parent Features from any project)
      ? [`key = "${issueKey}"`]
      // Instances without an Initiative type reject the combined query, so fall back to
      // Feature alone rather than returning an error
      : [
        `project = "${projectKey}" AND (type = Feature OR type = Initiative)${versionClause} ORDER BY key DESC`,
        `project = "${projectKey}" AND type = Feature${versionClause} ORDER BY key DESC`
      ];
    console.log(`Features endpoint - JQL: ${jqlCandidates[0]}`);

    // Paged: the search API returns 50 by default, which silently truncated large
    // portfolio projects
    const features = await searchWithFallback(fetchWithCookies, jiraUrl, authHeader, jqlCandidates);

    const mappedFeatures = features.map(issue => ({
      id: issue.key,
      title: issue.fields.summary,
      status: (issue.fields.status && issue.fields.status.name) || '',
      owner: issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned',
      targetPI: issue.fields.fixVersions && issue.fields.fixVersions.length > 0 ? issue.fields.fixVersions[0].name : '',
      priority: issue.fields.priority ? issue.fields.priority.name : 'Medium',
      notes: issue.fields.description || '',
      created: issue.fields.created,
      updated: issue.fields.updated,
      type: (issue.fields.issuetype && issue.fields.issuetype.name) || ''
    }));

    res.json({ features: mappedFeatures });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Debug endpoint to get complete Epic payload
app.post('/api/jira/debug-epic', async (req, res) => {
  const { sessionId, epicKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  try {
    const issueUrl = `${jiraUrl}/rest/api/2/issue/${epicKey}`;
    console.log(`Debug endpoint - Fetching complete Epic payload for: ${epicKey}`);
    
    const response = await fetchWithCookies(issueUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const data = JSON.parse(rawText);
    
    // Return the complete payload for debugging
    console.log('Complete Epic payload fields:', Object.keys(data.fields));
    res.json({ epic: data });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Get epics by version endpoint (separate from features - in case epics and features are different)
app.post('/api/jira/epics', async (req, res) => {
  const { sessionId, projectKey, versionId, parentEpic } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  try {
    // Search for epics in the project
    let jql = `project = "${projectKey}"`;
    
    if (parentEpic) {
      // Get stories/tasks under a specific epic
      jql += ` AND "Epic Link" = "${parentEpic}"`;
    } else {
      // Get ALL Epics in the project (regardless of Epic Link status)
      jql += ` AND type = Epic`;
    }
    
    if (versionId && versionId !== 'all') {
      jql += ` AND fixVersion = "${versionId}"`;
      console.log(`Epic endpoint - Added version filter for: ${versionId}`);
    } else {
      console.log('Epic endpoint - No version filter applied (versionId is "all" or empty)');
    }
    
    console.log(`Epic endpoint - Final JQL: ${jql}`);
    
    const searchUrl = `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=key,summary,status,assignee,fixVersions,priority,description,created,updated,customfield_10014,issuetype,customfield_15502`;
    const response = await fetchWithCookies(searchUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const data = JSON.parse(rawText);
    
    console.log(`Epic endpoint - Found ${data.issues.length} epics for project ${projectKey}, version ${versionId}`);
    
    // Debug the first epic's custom field values
    if (data.issues.length > 0) {
      const firstEpic = data.issues[0];
      console.log('First epic sample:', {
        key: firstEpic.key,
        summary: firstEpic.fields?.summary,
        issueType: firstEpic.fields?.issuetype?.name,
        customfield_15502: firstEpic.fields?.customfield_15502
      });
    }
    
    const epics = data.issues.map(issue => {
      const featureValue = issue.fields.customfield_15502;
      console.log(`Epic ${issue.key} - customfield_15502 value:`, featureValue, 'Type:', typeof featureValue);
      
      return {
        id: issue.key,
        title: issue.fields.summary,
        feature: featureValue || parentEpic || '', // Parent Feature field
        status: issue.fields.status.name,
        owner: issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned',
        targetPI: issue.fields.fixVersions && issue.fields.fixVersions.length > 0 ? issue.fields.fixVersions[0].name : '',
        storyPoints: issue.fields.customfield_10014 || 0, // Story points field ID may vary
        notes: issue.fields.description || '',
        created: issue.fields.created,
        updated: issue.fields.updated,
        type: issue.fields.issuetype.name
      };
    });
    
    res.json({ epics });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Get stories by epic endpoint
app.post('/api/jira/stories', async (req, res) => {
  const { sessionId, projectKey, epicKey, versionId } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  try {
    // Search for stories under an epic
    let jql = `project = "${projectKey}" AND type IN (Story, Task, Bug)`;
    
    if (epicKey) {
      jql += ` AND "Epic Link" = "${epicKey}"`;
    }
    
    if (versionId && versionId !== 'all') {
      jql += ` AND fixVersion = "${versionId}"`;
    }
    
    const searchUrl = `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=key,summary,status,assignee,fixVersions,priority,description,customfield_10014,labels`;
    const response = await fetchWithCookies(searchUrl, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const data = JSON.parse(rawText);
    
    const stories = data.issues.map(issue => ({
      id: issue.key,
      title: issue.fields.summary,
      epic: epicKey || '',
      status: issue.fields.status.name,
      owner: issue.fields.assignee ? issue.fields.assignee.displayName : 'Unassigned',
      storyPoints: issue.fields.customfield_10014 || 0,
      isPlaceholder: issue.fields.labels && issue.fields.labels.includes('placeholder'),
      notes: issue.fields.description || ''
    }));
    
    res.json({ stories });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Get available (non-subtask) issue types for a project
app.post('/api/jira/issue-types', async (req, res) => {
  const { sessionId, projectKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!projectKey) {
    return res.status(400).json({ error: 'projectKey is required.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  try {
    const projRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/project/${projectKey}`, {
      headers: {
        'Authorization': buildAuthHeader(auth),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const projText = await projRes.text();
    if (!projRes.ok) {
      return res.status(projRes.status).json({ error: 'Jira API error', status: projRes.status, body: projText });
    }
    const projData = JSON.parse(projText);
    const issueTypes = (projData.issueTypes || [])
      .filter(it => !it.subtask)
      // iconUrl lets locally drafted rows show the same icon Jira uses for that type
      .map(it => ({ id: it.id, name: it.name, iconUrl: it.iconUrl || '' }));
    res.json({ issueTypes });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Fetch an existing issue by key and map it to the table row shape (for cloning)
// Thrown when Jira itself rejects a request, so the route can forward its status and body
class JiraApiError extends Error {
  constructor(status, body) {
    super('Jira API error');
    this.status = status;
    this.body = body;
  }
}

// Extract a display value from an option-style custom field (string | {value} | array).
// Advanced Roadmaps' Team field labels itself with `title` rather than `value`/`name`.
const optionValue = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(optionValue).filter(Boolean).join(', ');
  if (typeof v === 'object') return v.value || v.name || v.title || '';
  return String(v);
};
// The same fields are written back by option id, so keep the id alongside the label
const optionId = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return optionId(v[0]);
  if (typeof v === 'object') return v.id != null ? String(v.id) : optionValue(v);
  return String(v);
};
// Extract a sprint name from Jira's varied sprint field representations
const sprintName = (v) => {
  if (v == null) return '';
  const one = Array.isArray(v) ? v[v.length - 1] : v;
  if (!one) return '';
  if (typeof one === 'object') return one.name || '';
  const m = String(one).match(/name=([^,]+)/);
  return m ? m[1] : String(one);
};

// Look up the custom field IDs the table depends on; they vary per Jira instance
async function findTableFields(fetchWithCookies, jiraUrl, authHeader) {
  const fieldsRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/field`, {
    headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
    redirect: 'follow'
  });
  const fieldsText = await fieldsRes.text();
  if (!fieldsRes.ok) throw new JiraApiError(fieldsRes.status, fieldsText);
  const allFields = JSON.parse(fieldsText);
  const findField = (name) => allFields.find(f => f.name && f.name.trim().toLowerCase() === name);
  return {
    epicLinkField: findField('epic link'),
    storyPointsField: findField('story points'),
    sprintField: findField('sprint'),
    appCIField: findField('application ci (as per cmdb)'),
    teamField: findField('team')
  };
}

// Map one Jira issue onto the shape the table's rows use
function mapIssueToRow(data, custom) {
  const { epicLinkField, storyPointsField, sprintField, appCIField, teamField } = custom;
  const f = data.fields || {};
  return {
    summary: f.summary || '',
    description: f.description || '',
    // Workflow state, plus the category ('new' | 'indeterminate' | 'done') the table
    // colours by. Read-only here: status changes through transitions, not a field write.
    status: (f.status && f.status.name) || '',
    statusCategory: (f.status && f.status.statusCategory && f.status.statusCategory.key) || '',
    issueType: (f.issuetype && f.issuetype.name) || 'Story',
    issueTypeIcon: (f.issuetype && f.issuetype.iconUrl) || '',
    epicLink: epicLinkField && f[epicLinkField.id] ? String(f[epicLinkField.id]) : '',
    // Rows key people by username (that is what Jira accepts on write), but carry the
    // display name so the table can show it even for users outside the loaded lists
    reporter: (f.reporter && f.reporter.name) || '',
    reporterName: (f.reporter && f.reporter.displayName) || '',
    applicationCI: appCIField ? optionValue(f[appCIField.id]) : '',
    labels: (f.labels || []).join(', '),
    sprint: sprintField ? sprintName(f[sprintField.id]) : '',
    linkedIssues: '',
    issue: '',
    storyPoints: storyPointsField && f[storyPointsField.id] != null ? String(f[storyPointsField.id]) : '',
    assignee: (f.assignee && f.assignee.name) || '',
    assigneeName: (f.assignee && f.assignee.displayName) || '',
    // Rows key the team by id; the label is sent too so the client can still match
    // instances whose team list is keyed by name (createmeta fallback)
    team: teamField ? optionId(f[teamField.id]) : '',
    teamName: teamField ? optionValue(f[teamField.id]) : ''
  };
}

// Run a JQL search to completion, following Jira's paging
async function searchAllIssues(fetchWithCookies, jiraUrl, authHeader, jql) {
  const found = [];
  let startAt = 0;
  for (;;) {
    const searchUrl = `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=100&startAt=${startAt}`;
    const searchRes = await fetchWithCookies(searchUrl, {
      headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
      redirect: 'follow'
    });
    const searchText = await searchRes.text();
    if (!searchRes.ok) throw new JiraApiError(searchRes.status, searchText);
    const page = JSON.parse(searchText);
    const batch = page.issues || [];
    found.push(...batch);
    startAt += batch.length;
    if (batch.length === 0 || startAt >= (page.total || 0)) break;
  }
  return found;
}

/**
 * Jira instances differ in which parent fields they expose to JQL, so try the queries in
 * order and move on when one is rejected as malformed. Anything other than a 400 is a
 * real failure and is thrown.
 */
async function searchWithFallback(fetchWithCookies, jiraUrl, authHeader, jqlCandidates) {
  let lastError = null;
  for (const jql of jqlCandidates) {
    try {
      return await searchAllIssues(fetchWithCookies, jiraUrl, authHeader, jql);
    } catch (err) {
      if (err instanceof JiraApiError && err.status === 400) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// Turn raw Jira issues into table rows carrying their key and browse URL
function toTableRows(issues, custom, jiraUrl) {
  return issues.map(issue => ({
    ...mapIssueToRow(issue, custom),
    issue: issue.key,
    url: `${jiraUrl}/browse/${issue.key}`
  }));
}

app.post('/api/jira/get-issue', async (req, res) => {
  const { sessionId, issueKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!issueKey || !issueKey.trim()) {
    return res.status(400).json({ error: 'An issue key is required.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  const authHeader = buildAuthHeader(auth);

  try {
    const custom = await findTableFields(fetchWithCookies, jiraUrl, authHeader);

    const issueRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/issue/${encodeURIComponent(issueKey.trim())}`, {
      headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
      redirect: 'follow'
    });
    const issueText = await issueRes.text();
    if (!issueRes.ok) {
      return res.status(issueRes.status).json({ error: 'Jira API error', status: issueRes.status, body: issueText });
    }
    const data = JSON.parse(issueText);
    res.json({ issue: mapIssueToRow(data, custom), key: data.key, url: `${jiraUrl}/browse/${data.key}` });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Fetch every issue under an epic, mapped to table rows for bulk editing
app.post('/api/jira/epic-issues', async (req, res) => {
  const { sessionId, epicKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!epicKey || !epicKey.trim()) {
    return res.status(400).json({ error: 'An epic key is required.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  const authHeader = buildAuthHeader(auth);
  const key = epicKey.trim().replace(/"/g, '');

  try {
    const custom = await findTableFields(fetchWithCookies, jiraUrl, authHeader);
    // "Epic Link" covers classic projects and `parent` covers next-gen, but `parent` is not
    // queryable on every Jira version — fall back to Epic Link alone if the query is rejected
    const found = await searchWithFallback(fetchWithCookies, jiraUrl, authHeader, [
      `("Epic Link" = "${key}" OR parent = "${key}") AND type != Sub-task ORDER BY key ASC`,
      `"Epic Link" = "${key}" ORDER BY key ASC`
    ]);
    const issues = toTableRows(found, custom, jiraUrl);
    res.json({ issues, total: issues.length });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

/**
 * Map a table row onto Jira's `fields` object, shared by create-story and update-story.
 * Custom field IDs vary per Jira instance, so they are resolved by name first.
 * Only non-empty values are written: an empty epic link / sprint / CI leaves whatever
 * Jira already has rather than risking a rejection on a required field.
 */
async function buildIssueFields({ fetchWithCookies, jiraUrl, authHeader, boardId, values }) {
  const { epicLinkField, storyPointsField, sprintField, appCIField, teamField } =
    await findTableFields(fetchWithCookies, jiraUrl, authHeader);

  const { summary, description, epicLink, reporter, applicationCI, labels, sprint, storyPoints, assignee, team } = values;
  const fields = {};
  if (summary !== undefined) fields.summary = String(summary).trim();
  // Sent even when blank so clearing the description in the editor also clears it in Jira
  if (description !== undefined && description !== null) fields.description = description;
  if (reporter) fields.reporter = { name: reporter };
  if (assignee) fields.assignee = { name: assignee };
  if (labels !== undefined && labels !== null) {
    fields.labels = String(labels).split(',').map(l => l.trim().replace(/\s+/g, '_')).filter(Boolean);
  }
  if (epicLink && epicLinkField) fields[epicLinkField.id] = epicLink;
  if (storyPoints !== undefined && storyPoints !== '' && storyPointsField) {
    const pts = Number(storyPoints);
    if (!isNaN(pts)) fields[storyPointsField.id] = pts;
  }
  if (applicationCI && appCIField) {
    const schemaType = appCIField.schema && appCIField.schema.type;
    if (schemaType === 'array') fields[appCIField.id] = [{ value: applicationCI }];
    else if (schemaType === 'option') fields[appCIField.id] = { value: applicationCI };
    else fields[appCIField.id] = applicationCI;
  }
  if (team && teamField) {
    fields[teamField.id] = String(team);
  }
  // Sprint field expects a numeric sprint id; resolve from the board by name (best effort)
  if (sprint && sprintField && boardId) {
    try {
      const spRes = await fetchWithCookies(`${jiraUrl}/rest/agile/1.0/board/${boardId}/sprint?state=active,future`, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      if (spRes.ok) {
        const spData = JSON.parse(await spRes.text());
        const match = (spData.values || []).find(s => s.name === sprint || String(s.id) === String(sprint));
        if (match) fields[sprintField.id] = match.id;
      }
    } catch (e) {
      console.warn('Could not resolve sprint id for', sprint, e.message);
    }
  }
  return fields;
}

// Create (publish) a story in Jira
app.post('/api/jira/create-story', async (req, res) => {
  const { sessionId, projectKey, boardId, summary, issueType } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!projectKey) {
    return res.status(400).json({ error: 'projectKey is required to publish a story.' });
  }
  if (!summary || !summary.trim()) {
    return res.status(400).json({ error: 'A summary is required to publish a story.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  const authHeader = buildAuthHeader(auth);
  try {
    const fields = await buildIssueFields({ fetchWithCookies, jiraUrl, authHeader, boardId, values: req.body });
    fields.project = { key: projectKey };
    fields.issuetype = { name: issueType || 'Story' };

    const createRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/issue`, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
      redirect: 'follow'
    });
    const createText = await createRes.text();
    if (!createRes.ok) {
      return res.status(createRes.status).json({ error: 'Jira API error', status: createRes.status, body: createText });
    }
    const created = JSON.parse(createText);
    res.json({ key: created.key, url: `${jiraUrl}/browse/${created.key}` });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Update an existing Jira issue in place (the edit counterpart of create-story)
app.post('/api/jira/update-story', async (req, res) => {
  const { sessionId, issueKey, boardId, summary, issueType } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!issueKey || !issueKey.trim()) {
    return res.status(400).json({ error: 'issueKey is required to update an issue.' });
  }
  if (!summary || !summary.trim()) {
    return res.status(400).json({ error: 'A summary is required to update an issue.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  const authHeader = buildAuthHeader(auth);
  const key = issueKey.trim();
  try {
    const fields = await buildIssueFields({ fetchWithCookies, jiraUrl, authHeader, boardId, values: req.body });
    // Only send an issue type change when one was chosen; some workflows reject the move
    if (issueType) fields.issuetype = { name: issueType };

    const updateRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/issue/${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Authorization': authHeader, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
      redirect: 'follow'
    });
    // A successful update returns 204 No Content
    if (!updateRes.ok) {
      const updateText = await updateRes.text();
      return res.status(updateRes.status).json({ error: 'Jira API error', status: updateRes.status, body: updateText });
    }
    res.json({ key, url: `${jiraUrl}/browse/${key}` });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Fetch the epics under a feature, mapped to table rows for bulk editing
app.post('/api/jira/feature-epics', async (req, res) => {
  const { sessionId, featureKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!featureKey || !featureKey.trim()) {
    return res.status(400).json({ error: 'A feature key is required.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  const authHeader = buildAuthHeader(auth);
  const key = featureKey.trim().replace(/"/g, '');

  try {
    const custom = await findTableFields(fetchWithCookies, jiraUrl, authHeader);
    // Epics hang off a feature by "Parent Link" under Advanced Roadmaps, and by `parent`
    // on newer Jira. Which one an instance accepts varies, so try the broad query first
    // and fall back to each field on its own.
    const found = await searchWithFallback(fetchWithCookies, jiraUrl, authHeader, [
      `("Parent Link" = "${key}" OR parent = "${key}") AND type = Epic ORDER BY key ASC`,
      `"Parent Link" = "${key}" ORDER BY key ASC`,
      `parent = "${key}" ORDER BY key ASC`,
      // Last resort for instances that model the feature as an epic's Epic Link
      `"Epic Link" = "${key}" AND type = Epic ORDER BY key ASC`
    ]);
    const issues = toTableRows(found, custom, jiraUrl);
    res.json({ issues, total: issues.length });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Search epics across the whole instance, so an epic owned by another team's project can
// still be picked. Deliberately not scoped to the selected project or board.
app.post('/api/jira/search-epics', async (req, res) => {
  const { sessionId, query, projectKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  // Quotes and backslashes would break out of the JQL string literal
  const q = String(query || '').trim().replace(/["\\]/g, ' ').trim();
  if (q.length < 2) return res.json({ epics: [] });

  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  const authHeader = buildAuthHeader(auth);
  const looksLikeKey = /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(q);

  // A pasted key is looked up directly; anything else is a text search on the summary.
  // Ordering by recency keeps the most likely candidates at the top of the picker.
  const candidates = looksLikeKey
    ? [`key = "${q.toUpperCase()}"`, `type = Epic AND summary ~ "${q}" ORDER BY updated DESC`]
    : [
      `type = Epic AND summary ~ "${q}" ORDER BY updated DESC`,
      `type = Epic AND text ~ "${q}" ORDER BY updated DESC`
    ];

  try {
    let found = [];
    let lastError = null;
    for (const jql of candidates) {
      try {
        // One page is plenty for a search-as-you-type picker
        const url = `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=50&fields=key,summary,project,issuetype`;
        const searchRes = await fetchWithCookies(url, {
          headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
          redirect: 'follow'
        });
        const text = await searchRes.text();
        if (!searchRes.ok) throw new JiraApiError(searchRes.status, text);
        found = JSON.parse(text).issues || [];
        if (found.length > 0) break;
      } catch (err) {
        if (err instanceof JiraApiError && err.status === 400) { lastError = err; continue; }
        throw err;
      }
    }
    if (found.length === 0 && lastError) throw lastError;

    const epics = found.map(issue => ({
      id: issue.key,
      title: (issue.fields && issue.fields.summary) || '',
      project: (issue.fields && issue.fields.project && issue.fields.project.key) || '',
      // Flagged so the picker can show where an out-of-project epic came from
      foreign: Boolean(projectKey) && issue.fields && issue.fields.project
        && issue.fields.project.key !== projectKey
    }));
    res.json({ epics });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Every value the Application CI field allows, rather than just the ones already on an
// epic, so a CI can be chosen even when the epic does not carry it
app.post('/api/jira/application-ci-options', async (req, res) => {
  const { sessionId, projectKey, issueKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  const authHeader = buildAuthHeader(auth);

  try {
    const { appCIField } = await findTableFields(fetchWithCookies, jiraUrl, authHeader);
    if (!appCIField) return res.json({ applicationCIs: [], source: 'not-found' });

    const seen = new Set();
    const add = (value) => {
      const label = optionValue(value);
      if (label && !seen.has(label)) seen.add(label);
    };

    // Strategy 1: the field's own option list (Jira Cloud)
    try {
      const optRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/field/${appCIField.id}/context/option`, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      if (optRes.ok) {
        (JSON.parse(await optRes.text()).values || []).forEach(add);
      }
    } catch (err) {
      console.warn('Application CI context/option lookup failed:', err.message);
    }

    // Strategy 2 (on-prem): allowedValues from createmeta for the given project
    if (seen.size === 0 && projectKey) {
      const metaUrl = `${jiraUrl}/rest/api/2/issue/createmeta?projectKeys=${encodeURIComponent(projectKey)}&expand=projects.issuetypes.fields`;
      const metaRes = await fetchWithCookies(metaUrl, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      if (metaRes.ok) {
        const meta = JSON.parse(await metaRes.text());
        (meta.projects || []).forEach(project => {
          (project.issuetypes || []).forEach(it => {
            const fieldMeta = it.fields && it.fields[appCIField.id];
            ((fieldMeta && fieldMeta.allowedValues) || []).forEach(add);
          });
        });
      }
    }

    // Strategy 3: editmeta on a real issue. createmeta only describes the create screen,
    // and on this instance the CI field is not on it — but it is editable, so the edit
    // screen knows its options. Use a caller-supplied issue, else find any in the project.
    if (seen.size === 0) {
      let sampleKey = issueKey && String(issueKey).trim();
      if (!sampleKey && projectKey) {
        const jql = `project = "${projectKey}" ORDER BY updated DESC`;
        const findRes = await fetchWithCookies(
          `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1&fields=key`,
          { headers: { 'Authorization': authHeader, 'Accept': 'application/json' }, redirect: 'follow' }
        );
        if (findRes.ok) {
          const first = (JSON.parse(await findRes.text()).issues || [])[0];
          if (first) sampleKey = first.key;
        }
      }
      if (sampleKey) {
        const editRes = await fetchWithCookies(
          `${jiraUrl}/rest/api/2/issue/${encodeURIComponent(sampleKey)}/editmeta`,
          { headers: { 'Authorization': authHeader, 'Accept': 'application/json' }, redirect: 'follow' }
        );
        if (editRes.ok) {
          const editMeta = JSON.parse(await editRes.text());
          const fieldMeta = editMeta.fields && editMeta.fields[appCIField.id];
          ((fieldMeta && fieldMeta.allowedValues) || []).forEach(add);
        }
      }
    }

    const applicationCIs = [...seen].sort((a, b) => a.localeCompare(b));
    // 'free-text' tells the client the field takes any value, so typing one is safe
    const source = applicationCIs.length > 0
      ? 'options'
      : ((appCIField.schema && appCIField.schema.type) === 'string' ? 'free-text' : 'none');
    res.json({ applicationCIs, source });
  } catch (err) {
    if (err instanceof JiraApiError) {
      return res.status(err.status).json({ error: err.message, status: err.status, body: err.body });
    }
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Which transitions each issue can currently make. Jira only offers the ones legal from
// the issue's present status, so this is per-issue and cannot be assumed across a set.
app.post('/api/jira/transitions', async (req, res) => {
  const { sessionId, issueKeys } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const keys = (Array.isArray(issueKeys) ? issueKeys : []).map(k => String(k || '').trim()).filter(Boolean);
  if (keys.length === 0) {
    return res.status(400).json({ error: 'At least one issue key is required.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  const authHeader = buildAuthHeader(auth);
  const transitions = {};
  const errors = {};
  try {
    for (const key of keys) {
      const url = `${jiraUrl}/rest/api/2/issue/${encodeURIComponent(key)}/transitions`;
      const transRes = await fetchWithCookies(url, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      const transText = await transRes.text();
      if (!transRes.ok) {
        // One unreadable issue should not sink the whole set
        errors[key] = transText;
        continue;
      }
      const data = JSON.parse(transText);
      transitions[key] = (data.transitions || []).map(t => ({
        id: String(t.id),
        name: t.name || '',
        to: (t.to && t.to.name) || '',
        toCategory: (t.to && t.to.statusCategory && t.to.statusCategory.key) || ''
      }));
    }
    res.json({ transitions, errors });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Execute one transition, then read the status back so the table shows what Jira did
// rather than what we assumed it would do
app.post('/api/jira/transition-issue', async (req, res) => {
  const { sessionId, issueKey, transitionId } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!issueKey || !String(issueKey).trim()) {
    return res.status(400).json({ error: 'issueKey is required.' });
  }
  if (!transitionId) {
    return res.status(400).json({ error: 'transitionId is required.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  const authHeader = buildAuthHeader(auth);
  const key = String(issueKey).trim();
  try {
    const transRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
      method: 'POST',
      headers: { 'Authorization': authHeader, 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ transition: { id: String(transitionId) } }),
      redirect: 'follow'
    });
    // A successful transition returns 204 No Content
    if (!transRes.ok) {
      const transText = await transRes.text();
      return res.status(transRes.status).json({ error: 'Jira API error', status: transRes.status, body: transText });
    }
    let status = '';
    let statusCategory = '';
    try {
      const statusRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/issue/${encodeURIComponent(key)}?fields=status`, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        redirect: 'follow'
      });
      if (statusRes.ok) {
        const data = JSON.parse(await statusRes.text());
        const f = data.fields || {};
        status = (f.status && f.status.name) || '';
        statusCategory = (f.status && f.status.statusCategory && f.status.statusCategory.key) || '';
      }
    } catch (err) {
      // The transition itself succeeded; a stale chip is not worth failing the call
      console.warn('Could not read back status for', key, err.message);
    }
    res.json({ key, status, statusCategory });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

// Attach one or more files to an existing Jira issue (multipart upload)
app.post('/api/jira/attach', upload.array('files'), async (req, res) => {
  const { sessionId, issueKey } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  if (!issueKey) {
    return res.status(400).json({ error: 'issueKey is required to attach files.' });
  }
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'No files were uploaded.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  const authHeader = buildAuthHeader(auth);
  try {
    const form = new FormData();
    files.forEach(file => {
      // Multer decodes filenames as latin1; restore the original UTF-8 name
      const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
      form.append('file', file.buffer, { filename, contentType: file.mimetype });
    });
    const attachRes = await fetchWithCookies(`${jiraUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}/attachments`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json',
        // Required by Jira to allow attachment uploads from a non-form context
        'X-Atlassian-Token': 'no-check',
        ...form.getHeaders()
      },
      body: form,
      redirect: 'follow'
    });
    const attachText = await attachRes.text();
    if (!attachRes.ok) {
      return res.status(attachRes.status).json({ error: 'Jira API error', status: attachRes.status, body: attachText });
    }
    const attached = JSON.parse(attachText);
    res.json({ attachments: (attached || []).map(a => ({ id: a.id, filename: a.filename, size: a.size })) });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

loadSessions();

app.listen(PORT, () => {
  console.log(`Jira proxy server running on port ${PORT}`);
});
