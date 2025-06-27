import React, { useState, useRef } from 'react';
import { DataGrid } from '@mui/x-data-grid';
import { Button, Box, TextField, Dialog, DialogTitle, DialogContent, DialogActions, MenuItem, Checkbox, FormControlLabel, CircularProgress, Alert } from '@mui/material';

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

  const fetchEpics = async () => {
    setJiraLoading(true);
    setJiraError('');
    setEpics([]);
    try {
      const response = await fetch('/api/jira/epics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jiraUrl, jiraUser, jiraToken })
      });
      if (!response.ok) throw new Error('Jira connection failed');
      const data = await response.json();
      setEpics(data.epics || []);
    } catch (err) {
      setJiraError('Failed to fetch epics: ' + err.message);
    } finally {
      setJiraLoading(false);
    }
  };

  return (
    <div style={{ padding: 20 }}>
      <h2>Jira Stories Table</h2>
      <Box sx={{ mb: 2, p: 2, border: '1px solid #eee', borderRadius: 2 }}>
        <h4>Connect to Jira (On-Prem)</h4>
        <TextField label="Jira Base URL" value={jiraUrl} onChange={e => setJiraUrl(e.target.value)} size="small" sx={{ mr: 1, mb: 1 }} />
        <TextField label="Username" value={jiraUser} onChange={e => setJiraUser(e.target.value)} size="small" sx={{ mr: 1, mb: 1 }} />
        <TextField label="API Token/Password" value={jiraToken} onChange={e => setJiraToken(e.target.value)} size="small" type="password" sx={{ mr: 1, mb: 1 }} />
        <Button variant="contained" onClick={fetchEpics} disabled={jiraLoading || !jiraUrl || !jiraUser || !jiraToken} sx={{ mb: 1 }}>
          {jiraLoading ? <CircularProgress size={20} /> : 'Connect & Fetch Epics'}
        </Button>
        {jiraError && <Alert severity="error" sx={{ mt: 1 }}>{jiraError}</Alert>}
        {epics.length > 0 && <Alert severity="success" sx={{ mt: 1 }}>Fetched {epics.length} epics from Jira.</Alert>}
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
          {epics.length > 0 ? (
            <TextField
              select
              label="Epic Link"
              value={newRow.epicLink}
              onChange={e => setNewRow({ ...newRow, epicLink: e.target.value })}
              fullWidth
              margin="normal"
            >
              {epics.map(epic => (
                <MenuItem key={epic.key} value={epic.key}>{epic.key} - {epic.summary}</MenuItem>
              ))}
            </TextField>
          ) : (
            <TextField label="Epic Link" value={newRow.epicLink} onChange={e => setNewRow({ ...newRow, epicLink: e.target.value })} fullWidth margin="normal" />
          )}
          <TextField label="Reporter" value={newRow.reporter} onChange={e => setNewRow({ ...newRow, reporter: e.target.value })} fullWidth margin="normal" />
          <TextField label="Application CI (as per CMDB)" value={newRow.applicationCI} onChange={e => setNewRow({ ...newRow, applicationCI: e.target.value })} fullWidth margin="normal" />
          <TextField label="Labels" value={newRow.labels} onChange={e => setNewRow({ ...newRow, labels: e.target.value })} fullWidth margin="normal" />
          <TextField label="Sprint" value={newRow.sprint} onChange={e => setNewRow({ ...newRow, sprint: e.target.value })} fullWidth margin="normal" />
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