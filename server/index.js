process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const fetch = require('node-fetch');
const fetchCookie = require('fetch-cookie');
const tough = require('tough-cookie');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// In-memory session store: { [sessionId]: { jar, jiraUrl } }
const jiraSessions = {};

app.post('/api/jira/auth', async (req, res) => {
  const { jiraUrl, jiraUser, jiraToken } = req.body;
  if (!jiraUrl || !jiraUser || !jiraToken) {
    return res.status(400).json({ error: 'Missing Jira credentials or URL' });
  }
  try {
    const jar = new tough.CookieJar();
    const fetchWithCookies = fetchCookie(fetch, jar);
    // Make a simple request to verify credentials (e.g., get current user)
    const apiUrl = `${jiraUrl}/rest/api/2/myself`;
    const response = await fetchWithCookies(apiUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${jiraUser}:${jiraToken}`).toString('base64'),
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
    jiraSessions[sessionId] = { jar, jiraUrl, auth: { jiraUser, jiraToken } };
    res.json({ sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/jira/epics', async (req, res) => {
  const { sessionId, projectKey, teamId, teamFieldId } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  try {
    let jql = 'issuetype=Epic';
    if (projectKey) {
      jql = `project=${projectKey} AND ${jql}`;
    }
    if (teamId && teamFieldId) {
      jql = `${jql} AND "${teamFieldId}"=${teamId}`;
    }
    const apiUrl = `${jiraUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=summary,key`;
    const response = await fetchWithCookies(apiUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${auth.jiraUser}:${auth.jiraToken}`).toString('base64'),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    if (!response.ok) {
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const data = JSON.parse(rawText);
    const epics = data.issues.map(issue => ({ key: issue.key, summary: issue.fields.summary }));
    res.json({ epics });
  } catch (err) {
    res.status(500).json({ error: err.message, stack: err.stack });
  }
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
        'Authorization': 'Basic ' + Buffer.from(`${auth.jiraUser}:${auth.jiraToken}`).toString('base64'),
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
  const { sessionId } = req.body;
  if (!sessionId || !jiraSessions[sessionId]) {
    return res.status(400).json({ error: 'Invalid or missing Jira session. Please authenticate first.' });
  }
  const { jar, jiraUrl, auth } = jiraSessions[sessionId];
  const fetchWithCookies = fetchCookie(fetch, jar);
  try {
    // Step 1: Get all fields to find the custom field ID for 'team'
    const fieldsUrl = `${jiraUrl}/rest/api/2/field`;
    const fieldsRes = await fetchWithCookies(fieldsUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${auth.jiraUser}:${auth.jiraToken}`).toString('base64'),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const fieldsText = await fieldsRes.text();
    if (!fieldsRes.ok) {
      return res.status(fieldsRes.status).json({ error: 'Jira API error', status: fieldsRes.status, body: fieldsText });
    }
    const fields = JSON.parse(fieldsText);
    const teamField = fields.find(f => f.name.toLowerCase() === 'team');
    if (!teamField) {
      return res.status(404).json({ error: 'Custom field "team" not found' });
    }
    // Step 2: Get options for the custom field (if it's a select list)
    // For custom fields, the options endpoint is usually /rest/api/2/customFieldOption/{fieldId}
    // But for context-based options, use /rest/api/2/field/{fieldId}/context/option
    // We'll try the context/option endpoint
    const optionsUrl = `${jiraUrl}/rest/api/2/field/${teamField.id}/context/option`;
    const optionsRes = await fetchWithCookies(optionsUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${auth.jiraUser}:${auth.jiraToken}`).toString('base64'),
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
    const teams = (optionsData.values || []).map(opt => ({ id: opt.id, value: opt.value }));
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
    // Use assignable users endpoint
    const apiUrl = `${jiraUrl}/rest/api/2/user/assignable/search?project=${projectKey}`;
    const response = await fetchWithCookies(apiUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${auth.jiraUser}:${auth.jiraToken}`).toString('base64'),
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
        'Authorization': 'Basic ' + Buffer.from(`${auth.jiraUser}:${auth.jiraToken}`).toString('base64'),
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
        'Authorization': 'Basic ' + Buffer.from(`${auth.jiraUser}:${auth.jiraToken}`).toString('base64'),
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
        'Authorization': 'Basic ' + Buffer.from(`${auth.jiraUser}:${auth.jiraToken}`).toString('base64'),
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
    const sprintsUrl = `${jiraUrl}/rest/agile/1.0/board/${boardId}/sprint`;
    const sprintsRes = await fetchWithCookies(sprintsUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${auth.jiraUser}:${auth.jiraToken}`).toString('base64'),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const sprintsText = await sprintsRes.text();
    if (!sprintsRes.ok) {
      return res.status(sprintsRes.status).json({ error: 'Jira API error', status: sprintsRes.status, body: sprintsText });
    }
    const sprintsData = JSON.parse(sprintsText);
    const sprints = (sprintsData.values || []).map(s => ({ id: s.id, name: s.name }));
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
        'Authorization': 'Basic ' + Buffer.from(`${auth.jiraUser}:${auth.jiraToken}`).toString('base64'),
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
        'Authorization': 'Basic ' + Buffer.from(`${auth.jiraUser}:${auth.jiraToken}`).toString('base64'),
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

app.listen(PORT, () => {
  console.log(`Jira proxy server running on port ${PORT}`);
});
