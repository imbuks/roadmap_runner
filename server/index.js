process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const fetch = require('node-fetch');
const fetchCookie = require('fetch-cookie');
const tough = require('tough-cookie');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const jar = new tough.CookieJar();
const fetchWithCookies = fetchCookie(fetch, jar);

app.post('/api/jira/epics', async (req, res) => {
  const { jiraUrl, jiraUser, jiraToken } = req.body;
  console.log('Received request:', { jiraUrl, jiraUser: !!jiraUser, jiraToken: !!jiraToken });
  if (!jiraUrl || !jiraUser || !jiraToken) {
    console.error('Missing Jira credentials or URL', req.body);
    return res.status(400).json({ error: 'Missing Jira credentials or URL' });
  }
  try {
    const apiUrl = `${jiraUrl}/rest/api/2/search?jql=issuetype=Epic&fields=summary,key`;
    console.log('Fetching from Jira:', apiUrl);
    const response = await fetchWithCookies(apiUrl, {
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${jiraUser}:${jiraToken}`).toString('base64'),
        'Accept': 'application/json'
      },
      redirect: 'follow'
    });
    const rawText = await response.text();
    console.log('Raw Jira response:', rawText);
    if (!response.ok) {
      console.error('Jira API error:', response.status, response.statusText, rawText);
      return res.status(response.status).json({ error: 'Jira API error', status: response.status, body: rawText });
    }
    const data = JSON.parse(rawText);
    const epics = data.issues.map(issue => ({ key: issue.key, summary: issue.fields.summary }));
    res.json({ epics });
  } catch (err) {
    console.error('Unexpected server error:', err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
});

app.listen(PORT, () => {
  console.log(`Jira proxy server running on port ${PORT}`);
}); 