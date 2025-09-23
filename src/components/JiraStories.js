import React, { useState, useRef, useEffect } from 'react';
import { DataGrid } from '@mui/x-data-grid';
import { Button, Box, TextField, Dialog, DialogTitle, DialogContent, DialogActions, MenuItem, Checkbox, FormControlLabel, CircularProgress, Alert } from '@mui/material';
import Autocomplete from '@mui/material/Autocomplete';

const initialColumns = [
  { field: 'summary', headerName: 'Summary', width: 180, editable: true },
  { field: 'description', headerName: 'Description', width: 250, editable: false, renderCell: (params) => <span style={{ whiteSpace: 'pre-wrap' }}>{params.value}</span> },
  { field: 'epicLink', headerName: 'Epic Link', width: 120, editable: true },
  { field: 'reporter', headerName: 'Reporter', width: 120, editable: true },
  { field: 'applicationCI', headerName: 'Application CI', width: 150, editable: true },
  { field: 'labels', headerName: 'Labels', width: 120, editable: true },
  { field: 'sprint', headerName: 'Sprint', width: 100, editable: true },
  { field: 'linkedIssues', headerName: 'Linked Issues', width: 120, editable: true },
  { field: 'issue', headerName: 'Issue', width: 100, editable: true },
  { field: 'storyPoints', headerName: 'Story Points', width: 100, editable: true },
  { field: 'assignee', headerName: 'Assignee', width: 120, editable: true },
];

export default function JiraStories() {
  const [rows, setRows] = useState([]);
  const [openDialog, setOpenDialog] = useState(false);
  const [newRow, setNewRow] = useState({
    summary: '',
    description: '',
    epicLink: '',
    reporter: '',
    applicationCI: '',
    labels: '',
    sprint: '',
    linkedIssues: '',
    issue: '',
    storyPoints: '',
    assignee: ''
  });
  const fileInputRef = useRef(null);
  const [instanceCount, setInstanceCount] = useState(1);
  const [cloneSprint, setCloneSprint] = useState(false);
  const [jiraUrl, setJiraUrl] = useState('https://jiraagile.emirates.com');
  const [jiraUser, setJiraUser] = useState('s489589');
  const [jiraToken, setJiraToken] = useState('Kgmig5140@2020');
  const [epics, setEpics] = useState([]);
  const [jiraLoading, setJiraLoading] = useState(false);
  const [jiraError, setJiraError] = useState('');
  const [jiraSessionId, setJiraSessionId] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [epicsLoading, setEpicsLoading] = useState(false);
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [epicsForProject, setEpicsForProject] = useState([]);
  const [epicsForProjectLoading, setEpicsForProjectLoading] = useState(false);
  const [sessionValid, setSessionValid] = useState(false);
  const [reporters, setReporters] = useState([]);
  const [reportersLoading, setReportersLoading] = useState(false);
  const [applicationCIs, setApplicationCIs] = useState([]);
  const [applicationCIsLoading, setApplicationCIsLoading] = useState(false);
  const [sprints, setSprints] = useState([]);
  const [sprintsLoading, setSprintsLoading] = useState(false);
  const [boards, setBoards] = useState([]);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [selectedBoard, setSelectedBoard] = useState(null);

  // Session storage helpers
  const SESSION_KEY = 'jiraSession';
  const SESSION_EXPIRY_MINUTES = 30;
  useEffect(() => {
    // On mount, check for valid session in sessionStorage
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) {
      try {
        const { sessionId, timestamp } = JSON.parse(stored);
        if (sessionId && timestamp) {
          const now = Date.now();
          if (now - timestamp < SESSION_EXPIRY_MINUTES * 60 * 1000) {
            setJiraSessionId(sessionId);
            setSessionValid(true);
            // Optionally, fetch projects immediately
            fetchProjects(sessionId);
          } else {
            sessionStorage.removeItem(SESSION_KEY);
          }
        }
      } catch {}
    }
  }, []);

  const storeSession = (sessionId) => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ sessionId, timestamp: Date.now() }));
    setSessionValid(true);
  };

  const handleAddRow = () => {
    const count = parseInt(instanceCount, 10) || 1;
    let sprintNum = parseInt(newRow.sprint, 10);
    const isSprintNumeric = !isNaN(sprintNum);
    const newRows = [];
    for (let i = 0; i < count; i++) {
      newRows.push({
        id: (rows.length > 0 ? Math.max(...rows.map(r => r.id)) + 1 + i : 1 + i),
        ...newRow,
        sprint: cloneSprint ? newRow.sprint : (isSprintNumeric ? String(sprintNum + i) : newRow.sprint)
      });
    }
    setRows([...rows, ...newRows]);
    setNewRow({
      summary: '', description: '', epicLink: '', reporter: '', applicationCI: '', labels: '', sprint: '', linkedIssues: '', issue: '', storyPoints: '', assignee: ''
    });
    setInstanceCount(1);
    setCloneSprint(false);
    setOpenDialog(false);
  };

  const handleExportCSV = () => {
    if (rows.length === 0) return;
    const headers = initialColumns.map(col => col.field);
    const csvContent = [
      headers.join(','),
      ...rows.map(row => headers.map(header => '"' + (row[header] || '').replace(/"/g, '""') + '"').join(','))
    ].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'jira_stories.csv';
    link.click();
  };

  // Helper to handle session invalidation
  const handleSessionInvalid = async (res) => {
    if (res.status === 400) {
      try {
        const data = await res.json();
        if (data && data.error && data.error.includes('Invalid or missing Jira session')) {
          sessionStorage.removeItem(SESSION_KEY);
          setSessionValid(false);
          setJiraSessionId('');
          return true;
        }
      } catch {}
    }
    return false;
  };

  const handleJiraAuthenticate = async () => {
    setAuthLoading(true);
    setJiraError('');
    setJiraSessionId('');
    setProjects([]);
    setSelectedProject(null);
    try {
      const authRes = await fetch('/api/jira/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jiraUrl, jiraUser, jiraToken })
      });
      if (!authRes.ok) {
        const errData = await authRes.json();
        throw new Error(errData.error || 'Jira authentication failed');
      }
      const authResponse  = await authRes.json(); 
      console.log("Auth Res JSON: \n", authResponse);
      // const { sessionId } = await authRes.json();
      const {sessionId} = authResponse;
      console.log("Auth Res: \n", authRes)
      
      setJiraSessionId(sessionId);
      storeSession(sessionId);
      setProjectsLoading(true);
      try {
        const projRes = await fetch('/api/jira/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        });
        if (await handleSessionInvalid(projRes)) return;
        if (!projRes.ok) {
          const errData = await projRes.json();
          throw new Error(errData.error || 'Failed to fetch projects');
        }
        const data = await projRes.json();
        setProjects(data.projects || []);
      } catch (projErr) {
        setJiraError('Failed to fetch projects: ' + projErr.message);
      } finally {
        setProjectsLoading(false);
      }
    } catch (err) {
      setJiraError('Failed to authenticate: ' + err.message);
    } finally {
      setAuthLoading(false);
    }
  };

  // Fetch projects helper (for session restore)
  const fetchProjects = async (sessionId) => {
    setProjectsLoading(true);
    try {
      const projRes = await fetch('/api/jira/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      if (await handleSessionInvalid(projRes)) return;
      if (!projRes.ok) return;
      const data = await projRes.json();
      setProjects(data.projects || []);
    } finally {
      setProjectsLoading(false);
    }
  };

  // Fetch epics for selected project
  useEffect(() => {
    if (jiraSessionId && selectedProject) {
      setEpicsForProjectLoading(true);
      fetch('/api/jira/epics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: jiraSessionId, projectKey: selectedProject.key })
      })
        .then(async (res) => {
          if (await handleSessionInvalid(res)) return;
          if (!res.ok) throw new Error('Failed to fetch epics');
          const data = await res.json();
          setEpicsForProject(data.epics || []);
        })
        .catch(() => setEpicsForProject([]))
        .finally(() => setEpicsForProjectLoading(false));
    } else {
      setEpicsForProject([]);
    }
  }, [jiraSessionId, selectedProject]);

  // Fetch reporters for selected project
  useEffect(() => {
    if (jiraSessionId && selectedProject) {
      setReportersLoading(true);
      fetch('/api/jira/reporters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: jiraSessionId, projectKey: selectedProject.key })
      })
        .then(async (res) => {
          if (await handleSessionInvalid(res)) return;
          if (!res.ok) throw new Error('Failed to fetch reporters');
          const data = await res.json();
          setReporters(data.reporters || []);
        })
        .catch(() => setReporters([]))
        .finally(() => setReportersLoading(false));
    } else {
      setReporters([]);
    }
  }, [jiraSessionId, selectedProject]);

  // Fetch Application CIs for selected epic in Add Story dialog
  useEffect(() => {
    if (jiraSessionId && newRow.epicLink) {
      setApplicationCIsLoading(true);
      fetch('/api/jira/application-cis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: jiraSessionId, epicKey: newRow.epicLink })
      })
        .then(async (res) => {
          if (await handleSessionInvalid(res)) return;
          if (!res.ok) throw new Error('Failed to fetch Application CIs');
          const data = await res.json();
          setApplicationCIs(data.applicationCIs || []);
        })
        .catch(() => setApplicationCIs([]))
        .finally(() => setApplicationCIsLoading(false));
    } else {
      setApplicationCIs([]);
    }
  }, [jiraSessionId, newRow.epicLink]);

  // Fetch boards for selected project
  useEffect(() => {
    if (jiraSessionId && selectedProject) {
      setBoardsLoading(true);
      setBoards([]);
      setSelectedBoard(null);
      fetch('/api/jira/boards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: jiraSessionId, projectKey: selectedProject.key })
      })
        .then(async (res) => {
          if (await handleSessionInvalid(res)) return;
          if (!res.ok) throw new Error('Failed to fetch boards');
          const data = await res.json();
          setBoards(data.boards || []);
        })
        .catch(() => setBoards([]))
        .finally(() => setBoardsLoading(false));
    } else {
      setBoards([]);
      setSelectedBoard(null);
    }
  }, [jiraSessionId, selectedProject]);

  // Fetch sprints for selected board
  useEffect(() => {
    if (jiraSessionId && selectedBoard) {
      setSprintsLoading(true);
      fetch('/api/jira/sprints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: jiraSessionId, boardId: selectedBoard.id })
      })
        .then(async (res) => {
          if (await handleSessionInvalid(res)) return;
          if (!res.ok) throw new Error('Failed to fetch sprints');
          const data = await res.json();
          setSprints(data.sprints || []);
        })
        .catch(() => setSprints([]))
        .finally(() => setSprintsLoading(false));
    } else {
      setSprints([]);
    }
  }, [jiraSessionId, selectedBoard]);

  return (
    <div style={{ padding: 20 }}>
      <h2>Jira Stories Table</h2>
      <Box sx={{ mb: 2, p: 2, border: '1px solid #eee', borderRadius: 2 }}>
        <h4>Connect to Jira (On-Prem)</h4>
        <TextField label="Jira Base URL" value={jiraUrl} onChange={e => setJiraUrl(e.target.value)} size="small" sx={{ mr: 1, mb: 1 }} />
        <TextField label="Username" value={jiraUser} onChange={e => setJiraUser(e.target.value)} size="small" sx={{ mr: 1, mb: 1 }} />
        <TextField label="API Token/Password" value={jiraToken} onChange={e => setJiraToken(e.target.value)} size="small" type="password" sx={{ mr: 1, mb: 1 }} />
        <Button variant="contained" onClick={handleJiraAuthenticate} disabled={authLoading || !jiraUrl || !jiraUser || !jiraToken || sessionValid} sx={{ mb: 1, mr: 1 }}>
          {authLoading ? <CircularProgress size={20} /> : sessionValid ? 'Authenticated' : 'Authenticate'}
        </Button>
        <Box sx={{ mt: 2, mb: 1 }}>
          <Autocomplete
            options={projects}
            getOptionLabel={option => option ? `${option.key} - ${option.name}` : ''}
            loading={projectsLoading}
            value={selectedProject}
            onChange={(_, value) => setSelectedProject(value)}
            renderInput={(params) => (
              <TextField {...params} label="Select Project" variant="outlined" fullWidth InputProps={{ ...params.InputProps, endAdornment: (
                <>
                  {projectsLoading ? <CircularProgress color="inherit" size={20} /> : null}
                  {params.InputProps.endAdornment}
                </>
              ) }} />
            )}
            isOptionEqualToValue={(option, value) => option.key === value.key}
            disabled={!jiraSessionId || projectsLoading}
          />
          <Autocomplete
            options={boards}
            getOptionLabel={option => option ? `${option.name} (${option.type})` : ''}
            loading={boardsLoading}
            value={selectedBoard}
            onChange={(_, value) => setSelectedBoard(value)}
            renderInput={(params) => (
              <TextField {...params} label="Select Board" variant="outlined" fullWidth InputProps={{ ...params.InputProps, endAdornment: (
                <>
                  {boardsLoading ? <CircularProgress color="inherit" size={20} /> : null}
                  {params.InputProps.endAdornment}
                </>
              ) }} />
            )}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            disabled={!selectedProject || boardsLoading}
          />
        </Box>
        {jiraError && <Alert severity="error" sx={{ mt: 1 }}>{jiraError}</Alert>}
        {epics.length > 0 && <Alert severity="success" sx={{ mt: 1 }}>Fetched {epics.length} epics from Jira.</Alert>}
        {jiraSessionId && <Alert severity="info" sx={{ mt: 1 }}>Jira session established.</Alert>}
      </Box>
      <Box sx={{ mb: 2 }}>
        <Button variant="contained" onClick={() => setOpenDialog(true)} sx={{ mr: 2 }}>
          Add Story
        </Button>
        <Button variant="contained" color="primary" onClick={handleExportCSV} disabled={rows.length === 0}>
          Export CSV
        </Button>
      </Box>
      <Box sx={{ height: 400, width: '100%' }}>
        <DataGrid
          rows={rows}
          columns={initialColumns}
          disableRowSelectionOnClick
          experimentalFeatures={{ newEditingApi: true }}
        />
      </Box>
      <Dialog open={openDialog} onClose={() => setOpenDialog(false)}>
        <DialogTitle>Add Jira Story</DialogTitle>
        <DialogContent>
          <TextField label="Summary" value={newRow.summary} onChange={e => setNewRow({ ...newRow, summary: e.target.value })} fullWidth margin="normal" />
          <TextField label="Description (Markdown supported)" value={newRow.description} onChange={e => setNewRow({ ...newRow, description: e.target.value })} fullWidth margin="normal" multiline minRows={4} />
          <Autocomplete
            options={epicsForProject}
            getOptionLabel={option => option ? `${option.key} - ${option.summary}` : ''}
            loading={epicsForProjectLoading}
            value={epicsForProject.find(e => e.key === newRow.epicLink) || null}
            onChange={(_, value) => setNewRow({ ...newRow, epicLink: value ? value.key : '' })}
            renderInput={(params) => (
              <TextField {...params} label="Epic Link" variant="outlined" fullWidth margin="normal" InputProps={{ ...params.InputProps, endAdornment: (
                <>
                  {epicsForProjectLoading ? <CircularProgress color="inherit" size={20} /> : null}
                  {params.InputProps.endAdornment}
                </>
              ) }} />
            )}
            isOptionEqualToValue={(option, value) => option.key === value.key}
            disabled={!selectedProject || epicsForProjectLoading}
          />
          <Autocomplete
            options={reporters}
            getOptionLabel={option => option ? option.name : ''}
            loading={reportersLoading}
            value={reporters.find(r => r.key === newRow.reporter) || null}
            onChange={(_, value) => setNewRow({ ...newRow, reporter: value ? value.key : '' })}
            renderInput={(params) => (
              <TextField {...params} label="Reporter" variant="outlined" fullWidth margin="normal" InputProps={{ ...params.InputProps, endAdornment: (
                <>
                  {reportersLoading ? <CircularProgress color="inherit" size={20} /> : null}
                  {params.InputProps.endAdornment}
                </>
              ) }} />
            )}
            isOptionEqualToValue={(option, value) => option.key === value.key}
            disabled={!selectedProject || reportersLoading}
          />
          <Autocomplete
            options={applicationCIs}
            getOptionLabel={option => option || ''}
            loading={applicationCIsLoading}
            value={applicationCIs.find(ci => ci === newRow.applicationCI) || null}
            onChange={(_, value) => setNewRow({ ...newRow, applicationCI: value || '' })}
            renderInput={(params) => (
              <TextField {...params} label="Application CI (as per CMDB)" variant="outlined" fullWidth margin="normal" InputProps={{ ...params.InputProps, endAdornment: (
                <>
                  {applicationCIsLoading ? <CircularProgress color="inherit" size={20} /> : null}
                  {params.InputProps.endAdornment}
                </>
              ) }} />
            )}
            isOptionEqualToValue={(option, value) => option === value}
            disabled={!newRow.epicLink || applicationCIsLoading}
          />
          <TextField label="Labels" value={newRow.labels} onChange={e => setNewRow({ ...newRow, labels: e.target.value })} fullWidth margin="normal" />
          <Autocomplete
            options={sprints}
            getOptionLabel={option => option ? option.name : ''}
            loading={sprintsLoading}
            value={sprints.find(s => s.name === newRow.sprint) || null}
            onChange={(_, value) => setNewRow({ ...newRow, sprint: value ? value.name : '' })}
            renderInput={(params) => (
              <TextField {...params} label="Sprint" variant="outlined" fullWidth margin="normal" InputProps={{ ...params.InputProps, endAdornment: (
                <>
                  {sprintsLoading ? <CircularProgress color="inherit" size={20} /> : null}
                  {params.InputProps.endAdornment}
                </>
              ) }} />
            )}
            isOptionEqualToValue={(option, value) => option.id === value.id}
            disabled={!selectedBoard || sprintsLoading}
          />
          <TextField label="Linked Issues" value={newRow.linkedIssues} onChange={e => setNewRow({ ...newRow, linkedIssues: e.target.value })} fullWidth margin="normal" />
          <TextField label="Issue" value={newRow.issue} onChange={e => setNewRow({ ...newRow, issue: e.target.value })} fullWidth margin="normal" />
          <TextField label="Story Points" value={newRow.storyPoints} onChange={e => setNewRow({ ...newRow, storyPoints: e.target.value })} fullWidth margin="normal" />
          <TextField label="Assignee" value={newRow.assignee} onChange={e => setNewRow({ ...newRow, assignee: e.target.value })} fullWidth margin="normal" />
          <TextField label="Number of Instances" type="number" value={instanceCount} onChange={e => setInstanceCount(e.target.value)} fullWidth margin="normal" inputProps={{ min: 1 }} />
          <FormControlLabel
            control={<Checkbox checked={cloneSprint} onChange={e => setCloneSprint(e.target.checked)} />}
            label="Clone same Sprint value for all instances?"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenDialog(false)}>Cancel</Button>
          <Button onClick={handleAddRow} variant="contained">Add</Button>
        </DialogActions>
      </Dialog>
    </div>
  );
} 