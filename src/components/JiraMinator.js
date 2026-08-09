import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  DataGrid,
  Toolbar,
  ToolbarButton,
  FilterPanelTrigger,
  GridToolbarQuickFilter
} from '@mui/x-data-grid';
import { Button, Box, TextField, Dialog, DialogTitle, DialogContent, DialogActions, Menu, MenuItem, Checkbox, FormControlLabel, CircularProgress, Alert, Typography, IconButton, Tooltip, Chip, Snackbar, Link, ToggleButton, ToggleButtonGroup } from '@mui/material';
import Autocomplete, { createFilterOptions } from '@mui/material/Autocomplete';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import {
  Visibility as VisibilityIcon,
  ContentCopy as ContentCopyIcon,
  Edit as EditIcon,
  PlaylistAdd as PlaylistAddIcon,
  ArrowDropDown as ArrowDropDownIcon,
  Bookmark as BookmarkIcon,
  CheckBox as CheckBoxIcon,
  BugReport as BugReportIcon,
  Bolt as BoltIcon,
  SubdirectoryArrowRight as SubdirectoryArrowRightIcon,
  TrendingUp as TrendingUpIcon,
  AddBox as AddBoxIcon,
  Assignment as AssignmentIcon,
  AttachFile as AttachFileIcon,
  Delete as DeleteIcon,
  DeleteOutline as DeleteOutlineIcon,
  FileUpload as FileUploadIcon,
  FileDownload as FileDownloadIcon,
  ViewColumn as ViewColumnIcon,
  FilterList as FilterListIcon,
  ArrowUpward as ArrowUpwardIcon,
  ArrowDownward as ArrowDownwardIcon,
  Difference as DifferenceIcon
} from '@mui/icons-material';
import Divider from '@mui/material/Divider';
import MDEditor from '@uiw/react-md-editor';
import '@uiw/react-md-editor/markdown-editor.css';
import '@uiw/react-markdown-preview/markdown.css';
import useJiraAuth, { jiraAuthService } from '../hooks/useJiraAuth';
import { markdownToJira } from '../utils/markdownToJira';

// Column visibility and order are remembered across sessions
const COLUMN_VISIBILITY_KEY = 'jiraMinatorColumnVisibility';
const COLUMN_ORDER_KEY = 'jiraMinatorColumnOrder';
// Which project the feature picker last searched, since features rarely sit in the
// same project as the epics and stories
const FEATURE_PROJECT_KEY = 'jiraMinatorFeatureProject';

const loadColumnOrder = () => {
  try {
    const stored = localStorage.getItem(COLUMN_ORDER_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
};

// The saved order wins; any column it does not mention keeps its declared position and
// lands at the end, so columns added in a later release still appear rather than vanish.
// Array.sort is stable, which is what preserves their relative order.
const orderColumns = (cols, order) => {
  if (!order || order.length === 0) return cols;
  const rank = new Map(order.map((field, i) => [field, i]));
  const rankOf = (col) => (rank.has(col.field) ? rank.get(col.field) : Number.MAX_SAFE_INTEGER);
  return [...cols].sort((a, b) => rankOf(a) - rankOf(b));
};

// Status is shown as a chip under the issue key, so its own column stays hidden by
// default — it exists so the Filters panel and quick search can still work on status.
// Issue type is shown as an icon on the summary, status as a chip under the issue key,
// so neither needs its own column — but both stay defined so filtering and sorting work.
const DEFAULT_COLUMN_VISIBILITY = { status: false, issueType: false };

const loadColumnVisibility = () => {
  try {
    const stored = localStorage.getItem(COLUMN_VISIBILITY_KEY);
    return { ...DEFAULT_COLUMN_VISIBILITY, ...(stored ? JSON.parse(stored) : {}) };
  } catch (err) {
    return { ...DEFAULT_COLUMN_VISIBILITY };
  }
};

// The CI list runs to thousands of entries, so cap how many are rendered per keystroke
const limitedFilter = createFilterOptions({ limit: 100 });

// Jira groups every workflow status into one of three categories
const STATUS_COLORS = { new: 'default', indeterminate: 'info', done: 'success' };

// Stand-ins for Jira's own issue type icons, in Jira's colours. Used for rows drafted
// locally, and whenever the real icon cannot be loaded from the Jira server.
const FALLBACK_TYPE_ICONS = {
  story: { Icon: BookmarkIcon, color: '#63BA3C' },
  task: { Icon: CheckBoxIcon, color: '#4BADE8' },
  bug: { Icon: BugReportIcon, color: '#E5493A' },
  epic: { Icon: BoltIcon, color: '#904EE2' },
  'sub-task': { Icon: SubdirectoryArrowRightIcon, color: '#4BADE8' },
  subtask: { Icon: SubdirectoryArrowRightIcon, color: '#4BADE8' },
  improvement: { Icon: TrendingUpIcon, color: '#63BA3C' },
  'new feature': { Icon: AddBoxIcon, color: '#63BA3C' }
};

// Jira's icon URLs point at the Jira server, which the browser may not be signed in to,
// so fall back to a local icon rather than showing a broken image.
function IssueTypeIcon({ name, iconUrl }) {
  const [broken, setBroken] = useState(false);
  const { Icon, color } = FALLBACK_TYPE_ICONS[String(name || '').trim().toLowerCase()]
    || { Icon: AssignmentIcon, color: '#5E6C84' };
  if (iconUrl && !broken) {
    return (
      <Box
        component="img"
        src={iconUrl}
        alt={name || 'Issue type'}
        onError={() => setBroken(true)}
        sx={{ width: 16, height: 16, flexShrink: 0, mt: '2px' }}
      />
    );
  }
  return <Icon sx={{ fontSize: 16, color, flexShrink: 0, mt: '2px' }} />;
}

// Field order used for CSV export
const EXPORT_FIELDS = ['summary', 'issueType', 'team', 'description', 'epicLink', 'reporter', 'applicationCI', 'labels', 'sprint', 'linkedIssues', 'issue', 'storyPoints', 'assignee'];

// Fields offered by the bulk editor. Summary and description are deliberately absent:
// they are per-issue prose, and setting them across a selection is never what you want.
const BULK_FIELDS = [
  { field: 'epicLink', label: 'Epic Link' },
  { field: 'team', label: 'Team' },
  { field: 'applicationCI', label: 'Application CI (as per CMDB)' },
  { field: 'sprint', label: 'Sprint' },
  { field: 'assignee', label: 'Assignee' },
  { field: 'reporter', label: 'Reporter' },
  { field: 'issueType', label: 'Issue Type' },
  { field: 'storyPoints', label: 'Story Points' },
  { field: 'labels', label: 'Labels' }
];

// Grid toolbar: the built-in column/filter/search controls plus import, export and clear.
// Declared outside the component so the grid does not remount it on every render.
function StoriesToolbar({ onImport, onExport, onClear, onArrange, hasRows }) {
  const verticalDivider = (
    <Divider orientation="vertical" flexItem sx={{ height: '60%', alignSelf: 'center', mx: 0.5 }} />
  );
  return (
    <Toolbar>
      {/* Visibility and order in one dialog. The built-in columns panel only covers
          visibility, and dragging headers to reorder is a Pro-only feature. */}
      <Tooltip title="Columns">
        <ToolbarButton onClick={onArrange}>
          <ViewColumnIcon fontSize="small" />
        </ToolbarButton>
      </Tooltip>
      <Tooltip title="Filters">
        <FilterPanelTrigger render={<ToolbarButton />}>
          <FilterListIcon fontSize="small" />
        </FilterPanelTrigger>
      </Tooltip>
      {verticalDivider}
      <Tooltip title="Import CSV">
        <ToolbarButton onClick={onImport}>
          <FileUploadIcon fontSize="small" />
        </ToolbarButton>
      </Tooltip>
      <Tooltip title={hasRows ? 'Export CSV' : 'Download CSV template'}>
        <ToolbarButton onClick={onExport}>
          <FileDownloadIcon fontSize="small" />
        </ToolbarButton>
      </Tooltip>
      <Tooltip title={hasRows ? 'Clear table' : 'Table is already empty'}>
        <span>
          <ToolbarButton onClick={onClear} disabled={!hasRows} color={hasRows ? 'error' : 'default'}>
            <DeleteIcon fontSize="small" />
          </ToolbarButton>
        </span>
      </Tooltip>
      {verticalDivider}
      <GridToolbarQuickFilter />
    </Toolbar>
  );
}

// Labels are stored as a comma-separated string (CSV export, Jira payload) but edited as chips
const labelsToArray = (labels) => String(labels || '').split(',').map(l => l.trim()).filter(Boolean);

const isEdgeBrowser = () => /\bEdg(e|A|iOS)?\//.test(navigator.userAgent);

// Open a Jira issue in Edge. When the app is already running in Edge a normal tab is
// enough; otherwise hand the URL to Edge's protocol handler. Browsers cannot report
// whether that handler is registered, so if we still have focus a moment later assume
// nothing launched and fall back to a normal tab.
const openInEdge = (url) => {
  if (!url) return;
  if (isEdgeBrowser()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const fallback = setTimeout(() => {
    if (document.hasFocus()) window.open(url, '_blank', 'noopener,noreferrer');
  }, 700);
  window.addEventListener('blur', () => clearTimeout(fallback), { once: true });
  window.location.href = `microsoft-edge:${url}`;
};

const formatFileSize = (bytes) => {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const emptyRow = (reporter = '', reporterName = '') => ({
  summary: '',
  description: '',
  descriptionFormat: 'jira', // 'richtext' | 'markdown' | 'jira'
  issueType: 'Story',
  issueTypeIcon: '', // Jira's own icon URL, when the row came from Jira
  team: '',
  epicLink: '',
  reporter,
  // Display names shown in the table; the fields above hold the usernames Jira writes
  reporterName,
  assigneeName: '',
  applicationCI: '',
  labels: '',
  sprint: '',
  linkedIssues: '',
  issue: '',
  storyPoints: '',
  assignee: '',
  // Read back from Jira for existing rows; blank for anything drafted locally
  status: '',
  statusCategory: '',
  // Set when the row was loaded from Jira for editing: its action publishes changes
  // back to the existing issue instead of creating a new one
  existing: false,
  attachments: [], // File objects, uploaded to Jira after the issue is created
  // Names of the above already sent to this row's issue, so repeated publishes or
  // updates do not upload the same file twice. Jira keys attachments by name too.
  uploadedAttachments: []
});

export default function JiraMinator() {
  // Use shared Jira authentication
  const {
    sessionId: jiraSessionId,
    isAuthenticated,
    authError: jiraError,
    fetchProjects: fetchJiraProjects,
    getStoredCredentials
  } = useJiraAuth();

  const storedCreds = getStoredCredentials();
  const jiraBaseUrl = (storedCreds?.jiraUrl || '').replace(/\/+$/, '');

  // Who new rows are reported by. The stored username is only a starting point — it is
  // whatever was typed at sign-in, and is empty altogether for PAT sessions — so it is
  // replaced by Jira's own answer as soon as the session is up.
  const [currentUser, setCurrentUser] = useState({
    key: storedCreds?.jiraUser || '',
    name: ''
  });

  // Any row carrying an issue key can link to Jira: publishing and loading record the
  // URL on the row, and anything else (CSV import, a key typed by hand) is derived
  // from the authenticated instance.
  const issueUrl = (row) => {
    if (row.jiraUrl) return row.jiraUrl;
    if (!row.issue || !jiraBaseUrl) return '';
    return `${jiraBaseUrl}/browse/${String(row.issue).trim()}`;
  };

  const [rows, setRows] = useState([]);
  const [openDialog, setOpenDialog] = useState(false);
  const [dialogMode, setDialogMode] = useState('create'); // 'create' | 'edit'
  const [editingId, setEditingId] = useState(null);
  const [newRow, setNewRow] = useState(emptyRow());
  const [instanceCount, setInstanceCount] = useState(1);
  const [cloneSprint, setCloneSprint] = useState(false);
  const [viewDescription, setViewDescription] = useState(null);

  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [projectsLoading, setProjectsLoading] = useState(false);

  const [epicsForProject, setEpicsForProject] = useState([]);
  const [epicsForProjectLoading, setEpicsForProjectLoading] = useState(false);
  const [reporters, setReporters] = useState([]);
  const [reportersLoading, setReportersLoading] = useState(false);
  const [applicationCIs, setApplicationCIs] = useState([]);
  const [applicationCIsLoading, setApplicationCIsLoading] = useState(false);
  // The field's full option list, which is far wider than whatever the chosen epic carries
  const [allApplicationCIs, setAllApplicationCIs] = useState([]);
  const [allApplicationCIsLoading, setAllApplicationCIsLoading] = useState(false);
  // Epics found by searching the whole instance, not just the selected project
  const [epicSearchResults, setEpicSearchResults] = useState([]);
  const [epicSearching, setEpicSearching] = useState(false);
  const epicSearchTimer = useRef(null);
  const [sprints, setSprints] = useState([]);
  const [sprintsLoading, setSprintsLoading] = useState(false);
  const [boards, setBoards] = useState([]);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [selectedBoard, setSelectedBoard] = useState(null);
  const [publishingId, setPublishingId] = useState(null);
  const [updatingId, setUpdatingId] = useState(null);
  const [bulkPublishing, setBulkPublishing] = useState(false);
  const [publishError, setPublishError] = useState('');
  const [publishSuccess, setPublishSuccess] = useState('');
  const [issueTypes, setIssueTypes] = useState([]);
  const [issueTypesLoading, setIssueTypesLoading] = useState(false);
  const [teams, setTeams] = useState([]);
  const [teamsLoading, setTeamsLoading] = useState(false);
  const [rowSelectionModel, setRowSelectionModel] = useState({ type: 'include', ids: new Set() });
  const [columnVisibilityModel, setColumnVisibilityModel] = useState(loadColumnVisibility);
  const [columnOrder, setColumnOrder] = useState(loadColumnOrder);
  const [arrangeOpen, setArrangeOpen] = useState(false);
  const [draftOrder, setDraftOrder] = useState([]);
  const [draftVisibility, setDraftVisibility] = useState({});
  const [deletedRow, setDeletedRow] = useState(null); // kept briefly so the delete can be undone
  const [jiraCurrentDescription, setJiraCurrentDescription] = useState(null); // null = not fetched, string = fetched
  const [diffLoading, setDiffLoading] = useState(false);
  const [descDiffOpen, setDescDiffOpen] = useState(false);
  const [descDiffValue, setDescDiffValue] = useState('');
  const [descDiffFormat, setDescDiffFormat] = useState('markdown');
  const wikiRef = useRef(null);
  const importInputRef = useRef(null);

  // Below md the two dialog columns stack, so go full screen instead of a tall floating panel
  const theme = useTheme();
  const compactDialog = useMediaQuery(theme.breakpoints.down('md'));

  // The description editors need a pixel height, so measure the space the flex layout gives them
  const editorAreaRef = useRef(null);
  const [editorHeight, setEditorHeight] = useState(260);
  useEffect(() => {
    if (!openDialog) return undefined;
    const el = editorAreaRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(entries => {
      const height = entries[0].contentRect.height;
      if (height > 0) setEditorHeight(Math.max(160, Math.round(height)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [openDialog]);

  // Wrap the current selection in the Jira wiki markup textarea with before/after markers
  const surroundWiki = (before, after = before, placeholder = 'text') => {
    const el = wikiRef.current;
    const val = newRow.description || '';
    const start = el ? el.selectionStart : val.length;
    const end = el ? el.selectionEnd : val.length;
    const selected = val.slice(start, end) || placeholder;
    const next = val.slice(0, start) + before + selected + after + val.slice(end);
    setNewRow(prev => ({ ...prev, description: next }));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };

  // Prefix every line touched by the selection (headings, lists, quotes)
  const prefixLinesWiki = (prefix) => {
    const el = wikiRef.current;
    const val = newRow.description || '';
    const start = el ? el.selectionStart : val.length;
    const end = el ? el.selectionEnd : val.length;
    const lineStart = val.lastIndexOf('\n', start - 1) + 1;
    const lineEndIdx = val.indexOf('\n', end);
    const lineEnd = lineEndIdx === -1 ? val.length : lineEndIdx;
    const block = val.slice(lineStart, lineEnd) || 'text';
    const newBlock = block.split('\n').map(l => prefix + l).join('\n');
    const next = val.slice(0, lineStart) + newBlock + val.slice(lineEnd);
    setNewRow(prev => ({ ...prev, description: next }));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(lineStart, lineStart + newBlock.length);
    });
  };

  const WIKI_TOOLBAR = [
    { label: 'Bold', apply: () => surroundWiki('*') },
    { label: 'Italic', apply: () => surroundWiki('_') },
    { label: 'Strike', apply: () => surroundWiki('-') },
    { label: 'Code', apply: () => surroundWiki('{{', '}}') },
    { label: 'Code block', apply: () => surroundWiki('{code}\n', '\n{code}') },
    { label: 'H1', apply: () => prefixLinesWiki('h1. ') },
    { label: 'H2', apply: () => prefixLinesWiki('h2. ') },
    { label: 'H3', apply: () => prefixLinesWiki('h3. ') },
    { label: '• List', apply: () => prefixLinesWiki('* ') },
    { label: '1. List', apply: () => prefixLinesWiki('# ') },
    { label: 'Quote', apply: () => prefixLinesWiki('bq. ') },
    { label: 'Link', apply: () => surroundWiki('[', '|https://]', 'text') }
  ];
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  // Look up an existing Jira issue, either to copy it into a new row ('clone')
  // or to load it for editing in place ('edit')
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupMode, setLookupMode] = useState('clone');
  const [lookupKey, setLookupKey] = useState('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupError, setLookupError] = useState('');
  // Bulk edit: only the fields ticked in `bulkEnabled` are written to the selected rows,
  // so an untouched control means "leave alone" rather than "set to empty"
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkEnabled, setBulkEnabled] = useState({});
  const [bulkValues, setBulkValues] = useState({});
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [bulkApplicationCIs, setBulkApplicationCIs] = useState([]);
  const [bulkApplicationCIsLoading, setBulkApplicationCIsLoading] = useState(false);
  // Transitions, both from a row's status chip and in bulk
  const [transitionAnchor, setTransitionAnchor] = useState(null);
  const [transitionRow, setTransitionRow] = useState(null);
  const [rowTransitions, setRowTransitions] = useState([]);
  const [rowTransitionsLoading, setRowTransitionsLoading] = useState(false);
  const [transitioningId, setTransitioningId] = useState(null);
  const [bulkTransitionOpen, setBulkTransitionOpen] = useState(false);
  const [bulkTransitionMap, setBulkTransitionMap] = useState({});
  const [bulkTransitionLoading, setBulkTransitionLoading] = useState(false);
  const [bulkTransitionTarget, setBulkTransitionTarget] = useState('');
  const [bulkTransitionRunning, setBulkTransitionRunning] = useState(false);
  const [bulkTransitionError, setBulkTransitionError] = useState('');
  const [selectionMenuAnchor, setSelectionMenuAnchor] = useState(null);
  // Bulk-load into the table: either the epics under a feature, or the issues under an epic
  const [epicLoadOpen, setEpicLoadOpen] = useState(false);
  const [loadMode, setLoadMode] = useState('epic'); // 'feature' | 'epic'
  const [epicsToLoad, setEpicsToLoad] = useState([]);
  const [featureToLoad, setFeatureToLoad] = useState(null);
  const [features, setFeatures] = useState([]);
  const [featuresLoading, setFeaturesLoading] = useState(false);
  // Features usually live in a portfolio project separate from the delivery project the
  // table is working in, so they get their own project selector, remembered between visits
  const [featureProject, setFeatureProject] = useState(null);
  const featureProjectSeeded = useRef(false);
  const [epicLoading, setEpicLoading] = useState(false);
  const [epicLoadError, setEpicLoadError] = useState('');

  // Resolve the set of currently selected rows from the v8 selection model
  const getSelectedRows = () => {
    const model = rowSelectionModel;
    if (!model) return [];
    if (Array.isArray(model)) return rows.filter(r => model.includes(r.id));
    const ids = model.ids || new Set();
    if (model.type === 'exclude') return rows.filter(r => !ids.has(r.id));
    return rows.filter(r => ids.has(r.id));
  };
  // Rows key the team by id, but CSV imports and issues loaded from Jira may identify it
  // by name (or by an id the teams list doesn't use), so match on either
  const findTeam = (value) => {
    if (!value) return null;
    return teams.find(t => String(t.id) === String(value) || t.value === value) || null;
  };

  // The people the Reporter and Assignee pickers offer: the project's assignable users,
  // plus whoever is signed in. Jira leaves the signed-in user off that list when they are
  // not assignable on the project, and the default reporter has to be selectable regardless.
  const userOptions = (() => {
    if (!currentUser.key) return reporters;
    const known = reporters.some(r => (r.key || '').toLowerCase() === currentUser.key.toLowerCase());
    return known ? reporters : [{ key: currentUser.key, name: currentUser.name || currentUser.key }, ...reporters];
  })();

  const findUser = (username) => {
    if (!username) return null;
    return userOptions.find(u => (u.key || '').toLowerCase() === String(username).toLowerCase()) || null;
  };

  // Rows store the Jira username, which is a staff id here. Prefer the display name the
  // row was loaded with, then the project's user list, and only then the raw username —
  // rows pulled from another project will not appear in the loaded list.
  const userLabel = (username, displayName) => {
    if (displayName) return displayName;
    if (!username) return '';
    const match = findUser(username);
    return match ? match.name : username;
  };

  // Rows loaded from Jira for editing already exist, so they are never bulk-published
  const isPublishable = (row) => !row.published && !row.existing;
  const selectedCount = getSelectedRows().length;
  const selectedPublishableCount = getSelectedRows().filter(isPublishable).length;
  const selectedExistingCount = getSelectedRows().filter(r => r.existing && r.issue).length;

  const handleOpenBulkEdit = () => {
    setBulkEnabled({});
    setBulkValues({});
    setBulkEditOpen(true);
  };

  // Debounced cross-project epic search, so typing does not fire a request per keystroke
  const searchEpics = (query) => {
    if (epicSearchTimer.current) clearTimeout(epicSearchTimer.current);
    const q = String(query || '').trim();
    if (q.length < 2) {
      setEpicSearchResults([]);
      return;
    }
    epicSearchTimer.current = setTimeout(() => {
      setEpicSearching(true);
      jiraAuthService.apiCall('search-epics', {
        query: q,
        projectKey: selectedProject ? selectedProject.key : undefined
      })
        .then(data => setEpicSearchResults(data.epics || []))
        .catch(err => {
          console.error('Epic search failed:', err.message);
          setEpicSearchResults([]);
        })
        .finally(() => setEpicSearching(false));
    }, 350);
  };

  // Clear the debounce if the component goes away mid-search
  useEffect(() => () => {
    if (epicSearchTimer.current) clearTimeout(epicSearchTimer.current);
  }, []);

  const setBulkValue = (field, value) => setBulkValues(prev => ({ ...prev, [field]: value }));

  // Controls for the bulk editor. Each is disabled until its field is ticked, so the
  // dialog reads as "these are the fields I am changing".
  const renderBulkField = (field, label) => {
    const off = !bulkEnabled[field];
    const input = (params) => <TextField {...params} label={label} size="small" fullWidth />;
    switch (field) {
      case 'epicLink':
        return (
          <Autocomplete
            size="small" disabled={off} options={epicsForProject} loading={epicsForProjectLoading}
            getOptionLabel={o => (o ? `${o.id} - ${o.title}` : '')}
            value={epicsForProject.find(e => e.id === bulkValues.epicLink) || null}
            onChange={(_, v) => setBulkValue('epicLink', v ? v.id : '')}
            isOptionEqualToValue={(o, v) => o.id === v.id}
            renderInput={input}
          />
        );
      case 'team':
        return (
          <Autocomplete
            size="small" disabled={off} options={teams} loading={teamsLoading}
            getOptionLabel={o => (typeof o === 'object' ? o.value : o) || ''}
            value={findTeam(bulkValues.team)}
            onChange={(_, v) => setBulkValue('team', v ? v.id : '')}
            isOptionEqualToValue={(o, v) => String(o.id) === String(v.id)}
            renderInput={input}
          />
        );
      case 'applicationCI':
        return (
          <Autocomplete
            size="small" disabled={off} freeSolo
            options={[...new Set([...bulkApplicationCIs, ...allApplicationCIs])]}
            filterOptions={limitedFilter}
            loading={bulkApplicationCIsLoading || allApplicationCIsLoading}
            getOptionLabel={o => o || ''}
            value={bulkValues.applicationCI || ''}
            onChange={(_, v) => setBulkValue('applicationCI', v || '')}
            onInputChange={(_, v) => setBulkValue('applicationCI', v || '')}
            renderInput={(params) => (
              <TextField {...params} label={label} size="small" fullWidth />
            )}
          />
        );
      case 'sprint':
        return (
          <Autocomplete
            size="small" disabled={off || !selectedBoard} options={sprints} loading={sprintsLoading}
            getOptionLabel={o => (o ? o.name : '')}
            value={sprints.find(s => s.name === bulkValues.sprint) || null}
            onChange={(_, v) => setBulkValue('sprint', v ? v.name : '')}
            isOptionEqualToValue={(o, v) => o.id === v.id}
            renderInput={input}
          />
        );
      case 'assignee':
      case 'reporter':
        return (
          <Autocomplete
            size="small" disabled={off} options={userOptions} loading={reportersLoading}
            getOptionLabel={o => (o ? o.name : '')}
            value={findUser(bulkValues[field])}
            onChange={(_, v) => setBulkValue(field, v ? v.key : '')}
            isOptionEqualToValue={(o, v) => o.key === v.key}
            renderInput={input}
          />
        );
      case 'issueType':
        return (
          <TextField
            select size="small" fullWidth label={label} disabled={off}
            value={bulkValues.issueType || ''}
            onChange={e => setBulkValue('issueType', e.target.value)}
          >
            {(issueTypes.length > 0 ? issueTypes.map(it => it.name) : ['Story']).map(name => (
              <MenuItem key={name} value={name}>{name}</MenuItem>
            ))}
          </TextField>
        );
      case 'labels':
        return (
          <Autocomplete
            multiple freeSolo size="small" disabled={off} options={[]}
            value={labelsToArray(bulkValues.labels)}
            onChange={(_, v) => setBulkValue('labels', v.map(x => String(x).trim()).filter(Boolean).join(', '))}
            renderInput={(params) => (
              <TextField {...params} label={label} size="small" fullWidth helperText="Replaces the labels on each row" />
            )}
          />
        );
      default:
        return (
          <TextField
            size="small" fullWidth label={label} disabled={off}
            value={bulkValues[field] || ''}
            onChange={e => setBulkValue(field, e.target.value)}
          />
        );
    }
  };

  const doPublish = async (row) => {
    const result = await jiraAuthService.apiCall('create-story', {
      projectKey: selectedProject.key,
      boardId: selectedBoard ? selectedBoard.id : undefined,
      issueType: row.issueType,
      team: row.team,
      summary: row.summary,
      // Jira renders wiki markup; convert Markdown/rich-text unless it's already wiki markup
      description: row.descriptionFormat === 'jira' ? row.description : markdownToJira(row.description),
      epicLink: row.epicLink,
      reporter: row.reporter,
      applicationCI: row.applicationCI,
      labels: row.labels,
      sprint: row.sprint,
      storyPoints: row.storyPoints,
      assignee: row.assignee
    });
    // Attachments upload separately once the issue exists; a failure here does not
    // undo the created issue, so report it as a warning alongside the key
    const files = row.attachments || [];
    if (files.length > 0) {
      try {
        await jiraAuthService.uploadAttachments(result.key, files);
      } catch (err) {
        return { ...result, attachmentError: err.message };
      }
    }
    return { ...result, uploaded: files.map(f => f.name) };
  };

  const handlePublishRow = async (row) => {
    if (!selectedProject) {
      setPublishError('Select a project before publishing.');
      return;
    }
    if (!row.summary || !row.summary.trim()) {
      setPublishError('This story needs a summary before it can be published.');
      return;
    }
    setPublishError('');
    setPublishSuccess('');
    setPublishingId(row.id);
    try {
      const result = await doPublish(row);
      setRows(prev => prev.map(r =>
        r.id === row.id ? { ...r, issue: result.key, published: true, jiraUrl: result.url } : r
      ));
      setPublishSuccess(`Published ${result.key}.`);
      if (result.attachmentError) {
        setPublishError(`${result.key} was created but its attachments failed to upload: ${result.attachmentError}`);
      }
    } catch (err) {
      setPublishError(`Failed to publish "${row.summary}": ${err.message}`);
    } finally {
      setPublishingId(null);
    }
  };

  // Push one row's fields back to its existing Jira issue. Mirrors doPublish so the
  // single-row and bulk paths share exactly one implementation.
  const doUpdate = async (row) => {
    const result = await jiraAuthService.apiCall('update-story', {
      issueKey: row.issue,
      boardId: selectedBoard ? selectedBoard.id : undefined,
      issueType: row.issueType,
      team: row.team,
      summary: row.summary,
      description: row.descriptionFormat === 'jira' ? row.description : markdownToJira(row.description),
      epicLink: row.epicLink,
      reporter: row.reporter,
      applicationCI: row.applicationCI,
      labels: row.labels,
      sprint: row.sprint,
      storyPoints: row.storyPoints,
      assignee: row.assignee
    });
    // Attachments are added locally, so upload the ones this row has not sent yet.
    // Files already on the issue in Jira are never loaded back into the row.
    const alreadySent = row.uploadedAttachments || [];
    const pending = (row.attachments || []).filter(f => !alreadySent.includes(f.name));
    let uploaded = alreadySent;
    let attachmentError = '';
    if (pending.length > 0) {
      try {
        await jiraAuthService.uploadAttachments(row.issue, pending);
        uploaded = [...alreadySent, ...pending.map(f => f.name)];
      } catch (err) {
        attachmentError = err.message;
      }
    }
    setRows(prev => prev.map(r => (
      r.id === row.id ? { ...r, jiraUrl: result.url, uploadedAttachments: uploaded } : r
    )));
    return { ...result, attachmentError };
  };

  const handleUpdateRow = async (row) => {
    if (!row.issue) {
      setPublishError('This row has no Jira issue key to update.');
      return;
    }
    if (!row.summary || !row.summary.trim()) {
      setPublishError('This story needs a summary before it can be updated.');
      return;
    }
    setPublishError('');
    setPublishSuccess('');
    setUpdatingId(row.id);
    try {
      const result = await doUpdate(row);
      setPublishSuccess(`Updated ${result.key}.`);
      if (result.attachmentError) {
        setPublishError(`${row.issue} was updated but its attachments failed to upload: ${result.attachmentError}`);
      }
    } catch (err) {
      setPublishError(`Failed to update ${row.issue}: ${err.message}`);
    } finally {
      setUpdatingId(null);
    }
  };

  const selectedExistingRows = () => getSelectedRows().filter(r => r.existing && r.issue);

  // Push every selected Jira-backed row, one at a time so a failure is attributable
  const handleBulkUpdate = async () => {
    const selected = selectedExistingRows();
    if (selected.length === 0) {
      setPublishError('Select at least one issue loaded from Jira.');
      return;
    }
    setPublishError('');
    setPublishSuccess('');
    setBulkUpdating(true);
    const succeeded = [];
    const failed = [];
    for (const row of selected) {
      if (!row.summary || !row.summary.trim()) {
        failed.push(`${row.issue} (missing summary)`);
        continue;
      }
      try {
        const result = await doUpdate(row);
        succeeded.push(result.key);
        if (result.attachmentError) {
          failed.push(`${result.key} attachments: ${result.attachmentError}`);
        }
      } catch (err) {
        failed.push(`${row.issue}: ${err.message}`);
      }
    }
    setBulkUpdating(false);
    if (succeeded.length) setPublishSuccess(`Updated ${succeeded.length} issue(s): ${succeeded.join(', ')}.`);
    if (failed.length) setPublishError(`Failed ${failed.length}: ${failed.join(' | ')}`);
  };

  const handleBulkPublish = async () => {
    if (!selectedProject) {
      setPublishError('Select a project before publishing.');
      return;
    }
    const selected = getSelectedRows().filter(isPublishable);
    if (selected.length === 0) {
      setPublishError('Select at least one unpublished record to publish.');
      return;
    }
    setPublishError('');
    setPublishSuccess('');
    setBulkPublishing(true);
    const succeeded = [];
    const failed = [];
    for (const row of selected) {
      if (!row.summary || !row.summary.trim()) {
        failed.push(`Row ${row.id} (missing summary)`);
        continue;
      }
      try {
        const result = await doPublish(row);
        setRows(prev => prev.map(r =>
          r.id === row.id
            ? { ...r, issue: result.key, published: true, jiraUrl: result.url, uploadedAttachments: result.uploaded || [] }
            : r
        ));
        succeeded.push(result.key);
        if (result.attachmentError) {
          failed.push(`${result.key} attachments: ${result.attachmentError}`);
        }
      } catch (err) {
        failed.push(`"${row.summary}": ${err.message}`);
      }
    }
    setBulkPublishing(false);
    if (succeeded.length) setPublishSuccess(`Published ${succeeded.length} issue(s): ${succeeded.join(', ')}.`);
    if (failed.length) setPublishError(`Failed ${failed.length}: ${failed.join(' | ')}`);
  };

  // Apply the ticked fields to every selected row. Changes stay local until the rows are
  // published or updated, so there is a review step before anything reaches Jira.
  const handleApplyBulkEdit = () => {
    const fields = Object.keys(bulkEnabled).filter(f => bulkEnabled[f]);
    if (fields.length === 0) return;
    const selectedIds = new Set(getSelectedRows().map(r => r.id));
    const patch = {};
    fields.forEach(f => {
      patch[f] = bulkValues[f] !== undefined ? bulkValues[f] : '';
      // Keep the display name in step, or the table would keep showing the previous person
      if (f === 'reporter' || f === 'assignee') {
        const user = findUser(patch[f]);
        patch[`${f}Name`] = user ? user.name : '';
      }
    });
    setRows(prev => prev.map(r => (selectedIds.has(r.id) ? { ...r, ...patch } : r)));
    setBulkEditOpen(false);
    setPublishError('');
    setPublishSuccess(
      `Changed ${fields.length} field(s) on ${selectedIds.size} row(s). Nothing has been sent to Jira yet — use Update in Jira.`
    );
  };

  // Load the transitions legal for one row right now, then show them as a menu
  const handleOpenRowTransitions = async (event, row) => {
    if (transitioningId !== null) return; // a transition is already in flight
    setTransitionAnchor(event.currentTarget);
    setTransitionRow(row);
    setRowTransitions([]);
    setRowTransitionsLoading(true);
    try {
      const data = await jiraAuthService.apiCall('transitions', { issueKeys: [row.issue] });
      setRowTransitions((data.transitions || {})[row.issue] || []);
    } catch (err) {
      setPublishError(`Could not load transitions for ${row.issue}: ${err.message}`);
      setTransitionAnchor(null);
    } finally {
      setRowTransitionsLoading(false);
    }
  };

  const closeRowTransitions = () => {
    setTransitionAnchor(null);
    setTransitionRow(null);
    setRowTransitions([]);
  };

  const handleRunTransition = async (row, transition) => {
    closeRowTransitions();
    setPublishError('');
    setPublishSuccess('');
    setTransitioningId(row.id);
    try {
      const result = await jiraAuthService.apiCall('transition-issue', {
        issueKey: row.issue,
        transitionId: transition.id
      });
      setRows(prev => prev.map(r => (
        r.id === row.id ? { ...r, status: result.status || transition.to, statusCategory: result.statusCategory || transition.toCategory } : r
      )));
      setPublishSuccess(`${row.issue} moved to ${result.status || transition.to}.`);
    } catch (err) {
      setPublishError(`Could not transition ${row.issue}: ${err.message}`);
    } finally {
      setTransitioningId(null);
    }
  };

  // Bulk transitions cannot be a single call: the transition id for a given target status
  // differs per issue, so fetch what each selected issue can legally do first
  const handleOpenBulkTransition = async () => {
    const selected = selectedExistingRows();
    if (selected.length === 0) {
      setPublishError('Select at least one issue loaded from Jira.');
      return;
    }
    setBulkTransitionError('');
    setBulkTransitionTarget('');
    setBulkTransitionMap({});
    setBulkTransitionOpen(true);
    setBulkTransitionLoading(true);
    try {
      const data = await jiraAuthService.apiCall('transitions', { issueKeys: selected.map(r => r.issue) });
      setBulkTransitionMap(data.transitions || {});
      const failedKeys = Object.keys(data.errors || {});
      if (failedKeys.length) {
        setBulkTransitionError(`Could not read transitions for: ${failedKeys.join(', ')}.`);
      }
    } catch (err) {
      setBulkTransitionError(err.message);
    } finally {
      setBulkTransitionLoading(false);
    }
  };

  // Every status any selected issue can reach, with how many can get there in one step
  const bulkTransitionTargets = () => {
    const counts = new Map();
    Object.values(bulkTransitionMap).forEach(list => {
      const seen = new Set();
      (list || []).forEach(t => {
        if (!t.to || seen.has(t.to)) return;
        seen.add(t.to);
        counts.set(t.to, (counts.get(t.to) || 0) + 1);
      });
    });
    return [...counts.entries()].map(([to, count]) => ({ to, count })).sort((a, b) => b.count - a.count);
  };

  const handleRunBulkTransition = async () => {
    const target = bulkTransitionTarget;
    if (!target) {
      setBulkTransitionError('Choose a target status.');
      return;
    }
    const selected = selectedExistingRows();
    setBulkTransitionRunning(true);
    const moved = [];
    const skipped = [];
    const failed = [];
    for (const row of selected) {
      const options = bulkTransitionMap[row.issue] || [];
      const match = options.find(t => t.to === target);
      // No single-step path from this issue's current status; multi-hop is not guessed
      if (!match) {
        skipped.push(`${row.issue} (${row.status || 'unknown status'})`);
        continue;
      }
      try {
        const result = await jiraAuthService.apiCall('transition-issue', {
          issueKey: row.issue,
          transitionId: match.id
        });
        setRows(prev => prev.map(r => (
          r.id === row.id ? { ...r, status: result.status || match.to, statusCategory: result.statusCategory || match.toCategory } : r
        )));
        moved.push(row.issue);
      } catch (err) {
        failed.push(`${row.issue}: ${err.message}`);
      }
    }
    setBulkTransitionRunning(false);
    setBulkTransitionOpen(false);
    const parts = [];
    if (moved.length) parts.push(`Moved ${moved.length} to ${target}`);
    if (skipped.length) parts.push(`skipped ${skipped.length} with no direct path: ${skipped.join(', ')}`);
    setPublishSuccess(parts.length ? `${parts.join('; ')}.` : '');
    setPublishError(failed.length ? `Failed ${failed.length}: ${failed.join(' | ')}` : '');
  };

  // Remove a single row, remembering its position so Undo can put it back
  const handleDeleteRow = (row) => {
    setDeletedRow({ row, index: rows.findIndex(r => r.id === row.id) });
    setRows(prev => prev.filter(r => r.id !== row.id));
    setRowSelectionModel(prev => {
      if (!prev || Array.isArray(prev) || !prev.ids) return prev;
      const ids = new Set(prev.ids);
      ids.delete(row.id);
      return { ...prev, ids };
    });
  };

  const handleUndoDelete = () => {
    if (!deletedRow) return;
    setRows(prev => {
      const next = [...prev];
      next.splice(Math.max(0, deletedRow.index), 0, deletedRow.row);
      return next;
    });
    setDeletedRow(null);
  };

  // Empties the local staging table; issues already published stay in Jira
  const handleClearTable = () => {
    setRows([]);
    setRowSelectionModel({ type: 'include', ids: new Set() });
    setPublishError('');
    setPublishSuccess('');
    setClearConfirmOpen(false);
  };

  const handleOpenCreate = () => {
    setDialogMode('create');
    setEditingId(null);
    setNewRow(emptyRow(currentUser.key, currentUser.name));
    setInstanceCount(1);
    setCloneSprint(false);
    setOpenDialog(true);
  };

  const handleOpenEdit = (row) => {
    setDialogMode('edit');
    setEditingId(row.id);
    setNewRow({ ...row });
    setJiraCurrentDescription(null);
    setOpenDialog(true);

    // For existing issues: fetch the full Jira record, populate all metadata fields into the
    // dialog, and store the Jira description separately so the diff button can compare it
    // against the locally-held description without overwriting it.
    if (row.existing && row.issue && jiraSessionId) {
      setDiffLoading(true);
      jiraAuthService.apiCall('get-issue', { issueKey: row.issue })
        .then(data => {
          const { issue: jira, url } = normalizeLoadedIssue({
            ...(data.issue || {}),
            issue: data.key || row.issue,
            url: data.url
          });

          // Stash the Jira description so the diff button can compare it
          setJiraCurrentDescription(String(jira.description ?? ''));

          // Merge Jira metadata into the dialog row. The local description is preserved
          // (that's what the user may be updating); everything else comes from Jira so
          // the form shows the live state of the issue.
          setNewRow(prev => ({
            ...prev,
            summary:        jira.summary        || prev.summary,
            issueType:      jira.issueType       || prev.issueType,
            issueTypeIcon:  jira.issueTypeIcon   || prev.issueTypeIcon,
            team:           jira.team            || prev.team,
            epicLink:       jira.epicLink        || prev.epicLink,
            reporter:       jira.reporter        || prev.reporter,
            reporterName:   jira.reporterName    || prev.reporterName,
            assignee:       jira.assignee        || prev.assignee,
            assigneeName:   jira.assigneeName    || prev.assigneeName,
            applicationCI:  jira.applicationCI   || prev.applicationCI,
            labels:         jira.labels          || prev.labels,
            sprint:         jira.sprint          || prev.sprint,
            storyPoints:    jira.storyPoints     || prev.storyPoints,
            linkedIssues:   jira.linkedIssues    || prev.linkedIssues,
            status:         jira.status          || prev.status,
            statusCategory: jira.statusCategory  || prev.statusCategory,
            jiraUrl:        url                  || prev.jiraUrl,
            // description and descriptionFormat are intentionally left as-is (the local
            // CSV value is what the user wants to review / update)
          }));
        })
        .catch(() => setJiraCurrentDescription(null))
        .finally(() => setDiffLoading(false));
    }
  };

  // Duplicate an existing table row into a new, unpublished row
  const handleCloneRow = (row) => {
    const nextId = rows.length > 0 ? Math.max(...rows.map(r => r.id)) + 1 : 1;
    const { published, issue, jiraUrl, existing, status, statusCategory, ...rest } = row;
    setRows(prev => [...prev, {
      ...rest,
      id: nextId,
      // The copy is not in Jira yet, so it has no workflow status of its own
      status: '',
      statusCategory: '',
      attachments: [...(rest.attachments || [])],
      // The copy targets a different issue, so its files still need uploading
      uploadedAttachments: [],
      published: false,
      existing: false,
      issue: '',
      jiraUrl: undefined
    }]);
  };

  const openLookup = (mode) => {
    setLookupMode(mode);
    setLookupError('');
    setLookupKey('');
    setLookupOpen(true);
  };

  // Server issue payloads carry a team label and a browse URL alongside the row fields;
  // fold those into the shape the table stores
  const normalizeLoadedIssue = (payload) => {
    const { teamName, url, ...issue } = payload || {};
    const team = findTeam(issue.team) || findTeam(teamName);
    return {
      // Description returned by Jira is already wiki markup
      issue: { ...issue, team: team ? team.id : (issue.team || ''), descriptionFormat: 'jira' },
      url
    };
  };

  // Pull a parent's children into the table as editable, existing rows: the epics under a
  // feature, or the issues under an epic
  const handleLoadEpicIssues = async () => {
    const byFeature = loadMode === 'feature';
    if (byFeature) {
      if (!featureToLoad) {
        setEpicLoadError('Select a feature to load.');
        return;
      }
    } else {
      if (epicsToLoad.length === 0) {
        setEpicLoadError('Select at least one epic to load.');
        return;
      }
    }
    setEpicLoadError('');
    setEpicLoading(true);
    try {
      let allLoaded = [];
      const parentIds = [];
      if (byFeature) {
        const data = await jiraAuthService.apiCall('feature-epics', { featureKey: featureToLoad.id });
        allLoaded = (data.issues || []).map(normalizeLoadedIssue);
        parentIds.push(featureToLoad.id);
      } else {
        for (const epic of epicsToLoad) {
          const data = await jiraAuthService.apiCall('epic-issues', { epicKey: epic.id });
          allLoaded = allLoaded.concat((data.issues || []).map(normalizeLoadedIssue));
          parentIds.push(epic.id);
        }
      }
      if (allLoaded.length === 0) {
        setEpicLoadError(byFeature
          ? `No epics found under ${featureToLoad.id}.`
          : `No issues found under ${epicsToLoad.map(e => e.id).join(', ')}.`);
        return;
      }
      setRows(prev => {
        let nextId = prev.length > 0 ? Math.max(...prev.map(r => r.id)) + 1 : 1;
        const next = [...prev];
        allLoaded.forEach(({ issue, url }) => {
          const row = { ...emptyRow(currentUser.key, currentUser.name), ...issue, existing: true, jiraUrl: url };
          const at = next.findIndex(r => r.existing && r.issue === issue.issue);
          // Reloading an epic refreshes rows already in the table rather than duplicating
          // them, keeping any files staged locally but not yet uploaded
          if (at >= 0) {
            next[at] = {
              ...row,
              id: next[at].id,
              attachments: next[at].attachments || [],
              uploadedAttachments: next[at].uploadedAttachments || []
            };
          } else {
            next.push({ ...row, id: nextId++ });
          }
        });
        return next;
      });
      setPublishError('');
      setPublishSuccess(`Loaded ${allLoaded.length} ${byFeature ? 'epic' : 'issue'}(s) from ${parentIds.join(', ')}.`);
      setEpicLoadOpen(false);
    } catch (err) {
      setEpicLoadError(err.message);
    } finally {
      setEpicLoading(false);
    }
  };

  // Fetch an existing Jira issue by key and open the dialog pre-filled.
  // In 'clone' mode the loaded values seed a brand new issue; in 'edit' mode the row
  // stays tied to its key so saving it offers an Update action.
  const handleLoadExisting = async () => {
    if (!lookupKey.trim()) {
      setLookupError('Enter an issue key (e.g. PROJ-123).');
      return;
    }
    setLookupError('');
    setLookupLoading(true);
    try {
      const data = await jiraAuthService.apiCall('get-issue', { issueKey: lookupKey.trim() });
      const { issue, url } = normalizeLoadedIssue({
        ...(data.issue || {}),
        issue: data.key || lookupKey.trim(),
        url: data.url
      });
      const isEdit = lookupMode === 'edit';
      setDialogMode('create');
      setEditingId(null);
      setNewRow({
        ...emptyRow(currentUser.key, currentUser.name),
        ...issue,
        existing: isEdit,
        // A clone is a brand new issue, so it carries neither the source key nor the
        // source's workflow status
        issue: isEdit ? issue.issue : '',
        jiraUrl: isEdit ? url : undefined,
        status: isEdit ? issue.status : '',
        statusCategory: isEdit ? issue.statusCategory : ''
      });
      setInstanceCount(1);
      setCloneSprint(false);
      setLookupOpen(false);
      setLookupKey('');
      setOpenDialog(true);
    } catch (err) {
      setLookupError(err.message);
    } finally {
      setLookupLoading(false);
    }
  };

  const handleAddAttachments = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) {
      setNewRow(prev => ({ ...prev, attachments: [...(prev.attachments || []), ...files] }));
    }
    e.target.value = ''; // allow re-selecting the same file
  };

  // Removing a file only stops this row tracking it; anything already uploaded stays in Jira.
  // Its name is dropped too, so re-adding the same file uploads it again.
  const handleRemoveAttachment = (index) => {
    setNewRow(prev => {
      const removed = (prev.attachments || [])[index];
      return {
        ...prev,
        attachments: (prev.attachments || []).filter((_, i) => i !== index),
        uploadedAttachments: (prev.uploadedAttachments || []).filter(name => name !== (removed && removed.name))
      };
    });
  };

  const handleSubmitDialog = () => {
    if (dialogMode === 'edit') {
      setRows(prev => prev.map(r => (r.id === editingId ? { ...r, ...newRow, id: editingId } : r)));
      setOpenDialog(false);
      return;
    }
    // An issue loaded for editing is always a single row tied to its Jira key.
    // Loading the same key twice refreshes that row rather than duplicating it.
    if (newRow.existing) {
      const match = rows.find(r => r.existing && r.issue === newRow.issue);
      if (match) {
        setRows(prev => prev.map(r => (r.id === match.id ? { ...r, ...newRow, id: match.id } : r)));
      } else {
        setRows(prev => [...prev, {
          ...newRow,
          id: prev.length > 0 ? Math.max(...prev.map(r => r.id)) + 1 : 1,
          attachments: [...(newRow.attachments || [])]
        }]);
      }
      setNewRow(emptyRow(currentUser.key, currentUser.name));
      setOpenDialog(false);
      return;
    }
    // Create mode: support creating multiple instances at once
    const count = parseInt(instanceCount, 10) || 1;
    const sprintNum = parseInt(newRow.sprint, 10);
    const isSprintNumeric = !isNaN(sprintNum);
    const newRows = [];
    for (let i = 0; i < count; i++) {
      newRows.push({
        id: (rows.length > 0 ? Math.max(...rows.map(r => r.id)) + 1 + i : 1 + i),
        ...newRow,
        // Each instance gets its own list so removing a file from one row leaves the others intact
        attachments: [...(newRow.attachments || [])],
        sprint: cloneSprint ? newRow.sprint : (isSprintNumeric ? String(sprintNum + i) : newRow.sprint)
      });
    }
    setRows([...rows, ...newRows]);
    setNewRow(emptyRow(currentUser.key, currentUser.name));
    setInstanceCount(1);
    setCloneSprint(false);
    setOpenDialog(false);
  };

  const parseCSV = (text) => {
    const result = [];
    let row = [], field = '', inQuote = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') {
        if (inQuote && text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuote = !inQuote;
      } else if (ch === ',' && !inQuote) {
        row.push(field); field = '';
      } else if ((ch === '\n' || ch === '\r') && !inQuote) {
        if (ch === '\r' && text[i + 1] === '\n') i++; // CRLF
        row.push(field); field = '';
        if (row.some(f => f !== '')) result.push(row);
        row = [];
      } else {
        field += ch;
      }
    }
    if (field || row.length > 0) { row.push(field); if (row.some(f => f !== '')) result.push(row); }
    return result;
  };

  const handleImportCSV = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const parsed = parseCSV(evt.target.result);
      if (parsed.length < 2) return;
      const headers = parsed[0].map(h => h.trim());
      const nextId = rows.length > 0 ? Math.max(...rows.map(r => r.id)) + 1 : 1;
      const imported = parsed.slice(1).map((values, i) => {
        const row = { ...emptyRow(currentUser.key, currentUser.name), id: nextId + i, published: false };
        headers.forEach((h, idx) => { if (h in row) row[h] = values[idx] ?? ''; });
        // Normalize the description so MDEditor.Markdown renders it readably:
        //   1. Unescape literal \n sequences written by simple CSV editors
        //   2. Normalize CRLF/bare CR to LF
        //   3. Promote single newlines → double (markdown needs \n\n for a paragraph break;
        //      a single \n is collapsed to a space by every markdown renderer)
        //   4. Collapse 3+ blank lines to 2
        // markdownToJira conversion still runs at publish/update time via doPublish/doUpdate
        if (row.description) {
          row.description = row.description
            .replace(/\\n/g, '\n')
            .replace(/\r\n/g, '\n')
            .replace(/\r/g, '\n')
            .replace(/([^\n])\n([^\n])/g, '$1\n\n$2')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          row.descriptionFormat = 'markdown';
        }
        // Resolve team display name to numeric ID using the loaded teams list
        if (row.team) {
          const match = findTeam(row.team);
          if (match) row.team = match.id;
        }
        // A row with an issue key targets an existing Jira issue — action becomes Update
        if (row.issue && String(row.issue).trim()) {
          row.existing = true;
          row.issue = String(row.issue).trim();
        }
        return row;
      });
      setRows(prev => [...prev, ...imported]);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleExportCSV = () => {
    const isTemplate = rows.length === 0;
    const csvContent = [
      EXPORT_FIELDS.join(','),
      ...rows.map(row => EXPORT_FIELDS.map(header => '"' + String(row[header] ?? '').replace(/"/g, '""') + '"').join(','))
    ].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = isTemplate ? 'jira_stories_template.csv' : 'jira_stories.csv';
    link.click();
  };

  const handleFetchProjects = useCallback(async () => {
    if (!jiraSessionId) return;
    setProjectsLoading(true);
    try {
      const projectsList = await fetchJiraProjects();
      setProjects(projectsList);
    } catch (err) {
      console.error('Failed to fetch projects:', err.message);
    } finally {
      setProjectsLoading(false);
    }
  }, [jiraSessionId, fetchJiraProjects]);

  // Load projects when already authenticated
  useEffect(() => {
    if (isAuthenticated && jiraSessionId && projects.length === 0) {
      handleFetchProjects();
    } else if (!isAuthenticated || !jiraSessionId) {
      setProjects([]);
      setSelectedProject(null);
    }
  }, [isAuthenticated, jiraSessionId, projects.length, handleFetchProjects]);

  // Remember which columns are hidden between sessions
  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(columnVisibilityModel));
    } catch (err) {
      console.error('Failed to save column visibility:', err.message);
    }
  }, [columnVisibilityModel]);

  // ...and the order they are in
  useEffect(() => {
    try {
      localStorage.setItem(COLUMN_ORDER_KEY, JSON.stringify(columnOrder));
    } catch (err) {
      console.error('Failed to save column order:', err.message);
    }
  }, [columnOrder]);

  // Fetch epics for selected project
  useEffect(() => {
    if (jiraSessionId && selectedProject) {
      setEpicsForProjectLoading(true);
      jiraAuthService.apiCall('epics', { projectKey: selectedProject.key })
        .then(data => setEpicsForProject(data.epics || []))
        .catch(err => {
          console.error('Failed to fetch epics:', err.message);
          setEpicsForProject([]);
        })
        .finally(() => setEpicsForProjectLoading(false));
    } else {
      setEpicsForProject([]);
    }
  }, [jiraSessionId, selectedProject]);

  // Ask Jira who the session belongs to, so new rows can default their reporter to that
  // person by the key Jira actually writes. Falls back to the stored username on failure.
  useEffect(() => {
    if (!jiraSessionId) return;
    jiraAuthService.apiCall('current-user')
      .then(data => {
        if (data.user && data.user.key) setCurrentUser(data.user);
      })
      .catch(err => console.error('Failed to fetch the current Jira user:', err.message));
  }, [jiraSessionId]);

  // Fetch reporters for selected project
  useEffect(() => {
    if (jiraSessionId && selectedProject) {
      setReportersLoading(true);
      jiraAuthService.apiCall('reporters', { projectKey: selectedProject.key })
        .then(data => setReporters(data.reporters || []))
        .catch(err => {
          console.error('Failed to fetch reporters:', err.message);
          setReporters([]);
        })
        .finally(() => setReportersLoading(false));
    } else {
      setReporters([]);
    }
  }, [jiraSessionId, selectedProject]);

  // The field's full option list, fetched once per project rather than per dialog open.
  // On this instance it comes from the edit screen's metadata, which is the only place
  // the options are exposed, so it is a few calls — worth caching.
  useEffect(() => {
    if (jiraSessionId && selectedProject) {
      setAllApplicationCIsLoading(true);
      jiraAuthService.apiCall('application-ci-options', { projectKey: selectedProject.key })
        .then(data => setAllApplicationCIs(data.applicationCIs || []))
        .catch(err => {
          console.error('Failed to fetch Application CI options:', err.message);
          setAllApplicationCIs([]);
        })
        .finally(() => setAllApplicationCIsLoading(false));
    } else {
      setAllApplicationCIs([]);
    }
  }, [jiraSessionId, selectedProject]);

  // Fetch Application CIs for the selected epic and auto-populate the CI field
  useEffect(() => {
    if (jiraSessionId && newRow.epicLink) {
      setApplicationCIsLoading(true);
      jiraAuthService.apiCall('application-cis', { epicKey: newRow.epicLink })
        .then(data => {
          const list = data.applicationCIs || [];
          setApplicationCIs(list);
          // Auto-select the epic's CI; keep the current value if it is already valid
          if (list.length > 0) {
            setNewRow(prev => (list.includes(prev.applicationCI) ? prev : { ...prev, applicationCI: list[0] }));
          }
        })
        .catch(err => {
          console.error('Failed to fetch Application CIs:', err.message);
          setApplicationCIs([]);
        })
        .finally(() => setApplicationCIsLoading(false));
    } else {
      setApplicationCIs([]);
    }
  }, [jiraSessionId, newRow.epicLink]);

  // Default the feature project to the last one used, else the project being worked in.
  // Seeded once per opening rather than whenever the value is empty, so clearing it sticks
  // instead of being immediately refilled.
  useEffect(() => {
    if (!epicLoadOpen) {
      featureProjectSeeded.current = false;
      return;
    }
    if (loadMode !== 'feature' || featureProjectSeeded.current || projects.length === 0) return;
    featureProjectSeeded.current = true;
    const remembered = localStorage.getItem(FEATURE_PROJECT_KEY);
    const match = remembered ? projects.find(p => p.key === remembered) : null;
    setFeatureProject(match || selectedProject || null);
  }, [epicLoadOpen, loadMode, projects, selectedProject]);

  // Features are only needed by the load dialog, so fetch them when it is actually open
  useEffect(() => {
    if (jiraSessionId && featureProject && epicLoadOpen && loadMode === 'feature') {
      setFeaturesLoading(true);
      jiraAuthService.apiCall('features', { projectKey: featureProject.key })
        .then(data => setFeatures(data.features || []))
        .catch(err => {
          console.error('Failed to fetch features:', err.message);
          setFeatures([]);
        })
        .finally(() => setFeaturesLoading(false));
    } else if (!featureProject) {
      setFeatures([]);
    }
  }, [jiraSessionId, featureProject, epicLoadOpen, loadMode]);

  // The CIs on offer in the bulk editor follow whichever epic it is moving rows to
  useEffect(() => {
    if (jiraSessionId && bulkEditOpen && bulkValues.epicLink) {
      setBulkApplicationCIsLoading(true);
      jiraAuthService.apiCall('application-cis', { epicKey: bulkValues.epicLink })
        .then(data => setBulkApplicationCIs(data.applicationCIs || []))
        .catch(err => {
          console.error('Failed to fetch Application CIs:', err.message);
          setBulkApplicationCIs([]);
        })
        .finally(() => setBulkApplicationCIsLoading(false));
    } else {
      setBulkApplicationCIs([]);
    }
  }, [jiraSessionId, bulkEditOpen, bulkValues.epicLink]);

  // Fetch boards for selected project
  useEffect(() => {
    if (jiraSessionId && selectedProject) {
      setBoardsLoading(true);
      setBoards([]);
      setSelectedBoard(null);
      jiraAuthService.apiCall('boards', { projectKey: selectedProject.key })
        .then(data => setBoards(data.boards || []))
        .catch(err => {
          console.error('Failed to fetch boards:', err.message);
          setBoards([]);
        })
        .finally(() => setBoardsLoading(false));
    } else {
      setBoards([]);
      setSelectedBoard(null);
    }
  }, [jiraSessionId, selectedProject]);

  // Fetch available issue types for selected project
  useEffect(() => {
    if (jiraSessionId && selectedProject) {
      setIssueTypesLoading(true);
      jiraAuthService.apiCall('issue-types', { projectKey: selectedProject.key })
        // Epics have a distinct creation flow (require an Epic Name), so exclude them here
        .then(data => setIssueTypes((data.issueTypes || []).filter(it => it.name.toLowerCase() !== 'epic')))
        .catch(err => {
          console.error('Failed to fetch issue types:', err.message);
          setIssueTypes([]);
        })
        .finally(() => setIssueTypesLoading(false));
    } else {
      setIssueTypes([]);
    }
  }, [jiraSessionId, selectedProject]);

  // Fetch available teams (custom field options); pass project so on-prem createmeta fallback works
  useEffect(() => {
    if (jiraSessionId) {
      setTeamsLoading(true);
      jiraAuthService.apiCall('teams', selectedProject ? { projectKey: selectedProject.key } : {})
        .then(data => setTeams(data.teams || []))
        .catch(err => {
          console.error('Failed to fetch teams:', err.message);
          setTeams([]);
        })
        .finally(() => setTeamsLoading(false));
    } else {
      setTeams([]);
    }
  }, [jiraSessionId, selectedProject]);

  // Fetch sprints for selected board
  useEffect(() => {
    if (jiraSessionId && selectedBoard) {
      setSprintsLoading(true);
      jiraAuthService.apiCall('sprints', { boardId: selectedBoard.id })
        .then(data => setSprints(data.sprints || []))
        .catch(err => {
          console.error('Failed to fetch sprints:', err.message);
          setSprints([]);
        })
        .finally(() => setSprintsLoading(false));
    } else {
      setSprints([]);
    }
  }, [jiraSessionId, selectedBoard]);

  const columns = [
    {
      field: 'summary',
      headerName: 'Summary',
      width: 240,
      // The type icon lives here so the Issue Type column can stay hidden
      renderCell: (params) => {
        const type = params.row.issueType;
        const iconUrl = params.row.issueTypeIcon
          || (issueTypes.find(it => it.name === type) || {}).iconUrl
          || '';
        return (
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, py: 0.75 }}>
            <Tooltip title={type || ''}>
              <Box component="span" sx={{ display: 'inline-flex' }}>
                <IssueTypeIcon name={type} iconUrl={iconUrl} />
              </Box>
            </Tooltip>
            <Box sx={{ whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: 1.4 }}>
              {params.value}
            </Box>
          </Box>
        );
      }
    },
    { field: 'issueType', headerName: 'Issue Type', width: 110 },
    {
      field: 'team',
      headerName: 'Team',
      width: 130,
      // Rows store the numeric team id (used for syncing); show the readable name.
      // Falls back to the raw value if the teams list hasn't loaded or has no match.
      valueGetter: (value) => {
        if (!value) return '';
        const match = findTeam(value);
        return match ? match.value : value;
      }
    },
    {
      field: 'description',
      headerName: 'Description',
      width: 280,
      sortable: false,
      renderCell: (params) => (
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5, width: '100%', py: 0.75 }}>
          <Box
            sx={{
              flex: 1,
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              maxHeight: '3em',
              fontSize: '12px',
              lineHeight: 1.4,
              '& p': { m: 0 }
            }}
          >
            <MDEditor.Markdown
              source={params.value || ''}
              style={{ backgroundColor: 'transparent', color: 'inherit', fontSize: '12px' }}
            />
          </Box>
          {params.value ? (
            <Tooltip title="View full description">
              <IconButton
                size="small"
                onClick={(e) => { e.stopPropagation(); setViewDescription(params.value); }}
              >
                <VisibilityIcon fontSize="inherit" />
              </IconButton>
            </Tooltip>
          ) : null}
        </Box>
      )
    },
    { field: 'epicLink', headerName: 'Epic Link', width: 120 },
    {
      field: 'reporter',
      headerName: 'Reporter',
      width: 140,
      valueGetter: (value, row) => userLabel(value, row.reporterName)
    },
    { field: 'applicationCI', headerName: 'Application CI', width: 150 },
    { field: 'labels', headerName: 'Labels', width: 120 },
    { field: 'sprint', headerName: 'Sprint', width: 100 },
    { field: 'linkedIssues', headerName: 'Linked Issues', width: 120 },
    {
      field: 'issue',
      headerName: 'Issue',
      width: 150,
      // The key links straight to the issue in Jira, with its workflow status beneath.
      // Stacking keeps status visible without spending another column's width.
      renderCell: (params) => {
        if (!params.value) return null;
        const url = issueUrl(params.row);
        const key = url ? (
          <Tooltip title={`Open ${params.value} in Edge`}>
            <Link
              component="button"
              type="button"
              underline="always"
              color="success.main"
              sx={{ textAlign: 'left', fontSize: 'inherit', fontFamily: 'inherit', cursor: 'pointer' }}
              onClick={(e) => { e.stopPropagation(); openInEdge(url); }}
            >
              {params.value}
            </Link>
          </Tooltip>
        ) : params.value;
        return (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.25, py: 0.75, maxWidth: '100%' }}>
            {key}
            {params.row.status ? (
              <Tooltip title={params.row.existing ? 'Change status' : params.row.status}>
                <Chip
                  size="small"
                  variant="outlined"
                  label={transitioningId === params.row.id ? 'Moving…' : params.row.status}
                  color={STATUS_COLORS[params.row.statusCategory] || 'default'}
                  // Only issues that exist in Jira can be transitioned
                  onClick={params.row.existing ? (e) => { e.stopPropagation(); handleOpenRowTransitions(e, params.row); } : undefined}
                  sx={{ height: 18, maxWidth: '100%', '& .MuiChip-label': { px: 0.75, fontSize: 11 } }}
                />
              </Tooltip>
            ) : null}
          </Box>
        );
      }
    },
    // Hidden by default: the chip above shows status, but a real column keeps it
    // available to the Filters panel, the quick search and sorting
    { field: 'status', headerName: 'Status', width: 140 },
    { field: 'storyPoints', headerName: 'Story Points', width: 100 },
    {
      field: 'assignee',
      headerName: 'Assignee',
      width: 140,
      valueGetter: (value, row) => userLabel(value, row.assigneeName)
    },
    {
      field: 'attachments',
      headerName: 'Attachments',
      width: 120,
      sortable: false,
      filterable: false,
      renderCell: (params) => {
        const files = params.value || [];
        if (files.length === 0) return null;
        const sent = params.row.uploadedAttachments || [];
        const pending = files.filter(f => !sent.includes(f.name)).length;
        return (
          <Tooltip title={files.map(f => `${f.name}${sent.includes(f.name) ? ' (in Jira)' : ''}`).join(', ')}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.75 }}>
              <AttachFileIcon fontSize="inherit" color={pending === 0 ? 'success' : 'inherit'} />
              <span>{files.length}</span>
            </Box>
          </Tooltip>
        );
      }
    },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 150,
      sortable: false,
      filterable: false,
      renderCell: (params) => (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Tooltip title="Clone this row">
            <IconButton
              size="small"
              onClick={(e) => { e.stopPropagation(); handleCloneRow(params.row); }}
            >
              <ContentCopyIcon fontSize="inherit" />
            </IconButton>
          </Tooltip>
          <Tooltip title={params.row.published ? 'Remove from table (stays in Jira)' : 'Delete this row'}>
            <IconButton
              size="small"
              onClick={(e) => { e.stopPropagation(); handleDeleteRow(params.row); }}
            >
              <DeleteOutlineIcon fontSize="inherit" />
            </IconButton>
          </Tooltip>
          {/* The issue key itself links to Jira from the Issue column */}
          {params.row.existing ? (
            <Button
              size="small"
              variant="contained"
              color="warning"
              disabled={updatingId !== null || publishingId !== null || bulkPublishing}
              onClick={(e) => { e.stopPropagation(); handleUpdateRow(params.row); }}
            >
              {updatingId === params.row.id ? <CircularProgress size={16} /> : 'Update'}
            </Button>
          ) : params.row.published ? null : (
            <Button
              size="small"
              variant="contained"
              disabled={publishingId !== null || bulkPublishing}
              onClick={(e) => { e.stopPropagation(); handlePublishRow(params.row); }}
            >
              {publishingId === params.row.id ? <CircularProgress size={16} /> : 'Publish'}
            </Button>
          )}
        </Box>
      )
    }
  ];

  // The project's epics plus anything the search turned up, deduped by key. The row's own
  // epic is added too so a value from another project still displays after reopening.
  const epicOptions = (() => {
    const byKey = new Map();
    [...epicsForProject, ...epicSearchResults].forEach(e => { if (e && e.id) byKey.set(e.id, e); });
    if (newRow.epicLink && !byKey.has(newRow.epicLink)) {
      byKey.set(newRow.epicLink, { id: newRow.epicLink, title: '(not in this project)', project: '', foreign: true });
    }
    return [...byKey.values()];
  })();

  // Epic-derived CIs first, since one of them is usually the right answer, then the rest
  const applicationCIOptions = [...new Set([...applicationCIs, ...allApplicationCIs])];

  const orderedColumns = orderColumns(columns, columnOrder);
  const columnsByField = Object.fromEntries(columns.map(c => [c.field, c]));

  const handleOpenArrange = () => {
    setDraftOrder(orderedColumns.map(c => c.field));
    setDraftVisibility({ ...columnVisibilityModel });
    setArrangeOpen(true);
  };

  const moveDraftColumn = (index, delta) => {
    setDraftOrder(prev => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  return (
    <div style={{ padding: 20 }}>
      {/* The page name is in the app bar, and sign-in is behind the avatar there */}

      {/* Project and board sit inline with the actions, so the page has no separate
          selection panel taking a band of vertical space */}
      <Box sx={{ mb: 2, display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
        <Autocomplete
          size="small"
          sx={{ width: 230 }}
          options={projects}
          getOptionLabel={option => option ? `${option.key} - ${option.name}` : ''}
          loading={projectsLoading}
          value={selectedProject}
          onChange={(_, value) => setSelectedProject(value)}
          renderInput={(params) => (
            <TextField {...params} label="Project" variant="outlined" InputProps={{ ...params.InputProps, endAdornment: (
              <>
                {projectsLoading ? <CircularProgress color="inherit" size={18} /> : null}
                {params.InputProps.endAdornment}
              </>
            ) }} />
          )}
          isOptionEqualToValue={(option, value) => option.key === value.key}
          disabled={!jiraSessionId || projectsLoading}
        />
        <Autocomplete
          size="small"
          sx={{ width: 230 }}
          options={boards}
          getOptionLabel={option => option ? `${option.name} (${option.type})` : ''}
          loading={boardsLoading}
          value={selectedBoard}
          onChange={(_, value) => setSelectedBoard(value)}
          renderInput={(params) => (
            <TextField {...params} label="Board" variant="outlined" InputProps={{ ...params.InputProps, endAdornment: (
              <>
                {boardsLoading ? <CircularProgress color="inherit" size={18} /> : null}
                {params.InputProps.endAdornment}
              </>
            ) }} />
          )}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          disabled={!selectedProject || boardsLoading}
        />
        <Divider orientation="vertical" flexItem sx={{ mx: 0.5, height: 28, alignSelf: 'center' }} />
        <Button variant="contained" onClick={handleOpenCreate}>
          Create Issue
        </Button>
        <Button
          variant="outlined"
          startIcon={<ContentCopyIcon />}
          onClick={() => openLookup('clone')}
          disabled={!jiraSessionId}
        >
          Clone Issue
        </Button>
        <Button
          variant="outlined"
          startIcon={<EditIcon />}
          onClick={() => openLookup('edit')}
          disabled={!jiraSessionId}
        >
          Edit Issue
        </Button>
        <Tooltip title={selectedProject ? '' : 'Select a project to list its epics'}>
          <span>
            <Button
              variant="outlined"
              startIcon={<PlaylistAddIcon />}
              onClick={() => { setEpicLoadError(''); setEpicsToLoad([]); setFeatureToLoad(null); setEpicLoadOpen(true); }}
              disabled={!jiraSessionId || !selectedProject}
            >
              Load from Jira
            </Button>
          </span>
        </Tooltip>
        {/* One menu for everything that acts on the current selection, so adding actions
            does not keep widening this row of buttons */}
        <Button
          variant="outlined"
          color="secondary"
          endIcon={<ArrowDropDownIcon />}
          onClick={(e) => setSelectionMenuAnchor(e.currentTarget)}
          disabled={selectedCount === 0 || bulkPublishing || bulkUpdating}
        >
          {bulkPublishing || bulkUpdating ? <CircularProgress size={18} /> : `Selected (${selectedCount})`}
        </Button>
        <Menu
          anchorEl={selectionMenuAnchor}
          open={Boolean(selectionMenuAnchor)}
          onClose={() => setSelectionMenuAnchor(null)}
        >
          <MenuItem
            onClick={() => { setSelectionMenuAnchor(null); handleOpenBulkEdit(); }}
            disabled={selectedCount === 0}
          >
            Edit fields…
          </MenuItem>
          <MenuItem
            onClick={() => { setSelectionMenuAnchor(null); handleBulkUpdate(); }}
            disabled={selectedExistingCount === 0}
          >
            {`Update in Jira (${selectedExistingCount})`}
          </MenuItem>
          <MenuItem
            onClick={() => { setSelectionMenuAnchor(null); handleOpenBulkTransition(); }}
            disabled={selectedExistingCount === 0}
          >
            {`Transition… (${selectedExistingCount})`}
          </MenuItem>
          <Divider />
          <MenuItem
            onClick={() => { setSelectionMenuAnchor(null); handleBulkPublish(); }}
            disabled={selectedPublishableCount === 0}
          >
            {`Publish new issues (${selectedPublishableCount})`}
          </MenuItem>
        </Menu>
      </Box>
      {/* Triggered by the toolbar's import button */}
      <input type="file" accept=".csv" hidden ref={importInputRef} onChange={handleImportCSV} />
      {/* Connection state itself is the app bar avatar; only real failures get a banner */}
      {jiraError && <Alert severity="error" sx={{ mb: 1 }}>{jiraError}</Alert>}
      {publishError && <Alert severity="error" sx={{ mb: 1 }} onClose={() => setPublishError('')}>{publishError}</Alert>}
      {publishSuccess && <Alert severity="success" sx={{ mb: 1 }} onClose={() => setPublishSuccess('')}>{publishSuccess}</Alert>}
      <Box sx={{ width: '100%' }}>
        <DataGrid
          autoHeight
          rows={rows}
          columns={orderedColumns}
          checkboxSelection
          disableRowSelectionOnClick
          rowSelectionModel={rowSelectionModel}
          onRowSelectionModelChange={(model) => setRowSelectionModel(model)}
          columnVisibilityModel={columnVisibilityModel}
          onColumnVisibilityModelChange={(model) => setColumnVisibilityModel(model)}
          getRowHeight={() => 'auto'}
          // Quick search skips hidden columns by default, which would leave the hidden
          // status column unsearchable
          initialState={{ filter: { filterModel: { items: [], quickFilterExcludeHiddenColumns: false } } }}
          showToolbar
          slots={{ toolbar: StoriesToolbar }}
          slotProps={{
            toolbar: {
              hasRows: rows.length > 0,
              onImport: () => importInputRef.current && importInputRef.current.click(),
              onExport: handleExportCSV,
              onArrange: handleOpenArrange,
              onClear: () => setClearConfirmOpen(true)
            }
          }}
          onCellClick={(params) => {
            // Open the view/edit dialog for data cells (skip checkbox and actions columns)
            if (params.field === '__check__' || params.field === 'actions') return;
            handleOpenEdit(params.row);
          }}
          sx={{
            '& .MuiDataGrid-cell': { alignItems: 'flex-start' },
            '& .MuiDataGrid-row': { cursor: 'pointer' }
          }}
        />
      </Box>

      <Snackbar
        open={deletedRow !== null}
        autoHideDuration={8000}
        onClose={() => setDeletedRow(null)}
        message={deletedRow ? `Removed "${deletedRow.row.summary || 'untitled row'}"` : ''}
        action={<Button color="secondary" size="small" onClick={handleUndoDelete}>Undo</Button>}
      />

      {/* View full description */}
      <Dialog open={viewDescription !== null} onClose={() => setViewDescription(null)} maxWidth="md" fullWidth>
        <DialogTitle>Description</DialogTitle>
        <DialogContent dividers>
          <MDEditor.Markdown source={viewDescription || ''} style={{ backgroundColor: 'transparent' }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setViewDescription(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Confirm before discarding the whole table */}
      <Dialog open={clearConfirmOpen} onClose={() => setClearConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Clear table?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This removes all {rows.length} row{rows.length === 1 ? '' : 's'} from the table
            {rows.filter(r => !r.published).length > 0
              ? `, including ${rows.filter(r => !r.published).length} not yet published to Jira.`
              : '.'}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Issues already published stay in Jira — only this local list is cleared. Export to CSV first if you want a copy.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClearConfirmOpen(false)}>Cancel</Button>
          <Button onClick={handleClearTable} variant="contained" color="error">Clear Table</Button>
        </DialogActions>
      </Dialog>

      {/* Which columns show and in what order — the grid's own panel covers only the first */}
      <Dialog open={arrangeOpen} onClose={() => setArrangeOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Columns</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Tick to show a column, and use the arrows to order them. Both are remembered on
            this browser.
          </Typography>
          {draftOrder.map((field, index) => {
            const col = columnsByField[field];
            if (!col) return null;
            const visible = draftVisibility[field] !== false;
            return (
              <Box
                key={field}
                sx={{
                  display: 'flex', alignItems: 'center', gap: 0.5, py: 0.25,
                  borderBottom: '1px solid', borderColor: 'divider'
                }}
              >
                <Checkbox
                  size="small"
                  checked={visible}
                  onChange={e => setDraftVisibility(prev => ({ ...prev, [field]: e.target.checked }))}
                />
                <Typography
                  variant="body2"
                  sx={{ flex: 1, minWidth: 0, color: visible ? 'text.primary' : 'text.disabled' }}
                >
                  {col.headerName || field}
                </Typography>
                <IconButton size="small" disabled={index === 0} onClick={() => moveDraftColumn(index, -1)}>
                  <ArrowUpwardIcon fontSize="inherit" />
                </IconButton>
                <IconButton
                  size="small"
                  disabled={index === draftOrder.length - 1}
                  onClick={() => moveDraftColumn(index, 1)}
                >
                  <ArrowDownwardIcon fontSize="inherit" />
                </IconButton>
              </Box>
            );
          })}
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setDraftOrder(columns.map(c => c.field));
              setDraftVisibility({ ...DEFAULT_COLUMN_VISIBILITY });
            }}
          >
            Reset to default
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button onClick={() => setArrangeOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              setColumnOrder(draftOrder);
              setColumnVisibilityModel(draftVisibility);
              setArrangeOpen(false);
            }}
          >
            Save
          </Button>
        </DialogActions>
      </Dialog>

      {/* Transitions available to one row right now */}
      <Menu
        anchorEl={transitionAnchor}
        open={Boolean(transitionAnchor)}
        onClose={closeRowTransitions}
      >
        {rowTransitionsLoading && (
          <MenuItem disabled>
            <CircularProgress size={16} sx={{ mr: 1 }} /> Loading transitions…
          </MenuItem>
        )}
        {!rowTransitionsLoading && rowTransitions.length === 0 && (
          <MenuItem disabled>No transitions available</MenuItem>
        )}
        {!rowTransitionsLoading && rowTransitions.map(t => (
          <MenuItem key={t.id} onClick={() => handleRunTransition(transitionRow, t)}>
            {t.name}
            {t.to && t.to !== t.name ? (
              <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>→ {t.to}</Typography>
            ) : null}
          </MenuItem>
        ))}
      </Menu>

      {/* Bulk field edit: ticked fields only, applied locally */}
      <Dialog open={bulkEditOpen} onClose={() => setBulkEditOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit {selectedCount} selected row{selectedCount === 1 ? '' : 's'}</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Only ticked fields are changed — anything left unticked keeps its current value on
            each row. Changes stay in the table until you run Update in Jira.
          </Typography>
          {BULK_FIELDS.map(({ field, label }) => (
            <Box key={field} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
              <Checkbox
                size="small"
                checked={Boolean(bulkEnabled[field])}
                onChange={e => setBulkEnabled(prev => ({ ...prev, [field]: e.target.checked }))}
              />
              <Box sx={{ flex: 1, minWidth: 0, opacity: bulkEnabled[field] ? 1 : 0.5 }}>
                {renderBulkField(field, label)}
              </Box>
            </Box>
          ))}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkEditOpen(false)}>Cancel</Button>
          <Button
            onClick={handleApplyBulkEdit}
            variant="contained"
            disabled={!Object.values(bulkEnabled).some(Boolean)}
          >
            Apply to {selectedCount} row{selectedCount === 1 ? '' : 's'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Bulk transition: one target status, resolved per issue */}
      <Dialog open={bulkTransitionOpen} onClose={() => setBulkTransitionOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Transition {selectedExistingCount} issue{selectedExistingCount === 1 ? '' : 's'}</DialogTitle>
        <DialogContent dividers>
          {bulkTransitionLoading ? (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 2 }}>
              <CircularProgress size={20} />
              <Typography variant="body2">Reading what each issue can do from its current status…</Typography>
            </Box>
          ) : (
            <>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                Jira allows different moves depending on each issue's current status, so pick a
                target and anything that cannot reach it in one step is skipped and listed.
              </Typography>
              <TextField
                select
                size="small"
                label="Move to status"
                value={bulkTransitionTarget}
                onChange={e => setBulkTransitionTarget(e.target.value)}
                fullWidth
                margin="dense"
              >
                {bulkTransitionTargets().map(({ to, count }) => (
                  <MenuItem key={to} value={to}>
                    {to} — {count} of {selectedExistingCount} can move here
                  </MenuItem>
                ))}
              </TextField>
              {bulkTransitionTargets().length === 0 && (
                <Alert severity="info" sx={{ mt: 1 }}>
                  None of the selected issues offer a transition.
                </Alert>
              )}
            </>
          )}
          {bulkTransitionError && <Alert severity="warning" sx={{ mt: 1 }}>{bulkTransitionError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setBulkTransitionOpen(false)}>Cancel</Button>
          <Button
            onClick={handleRunBulkTransition}
            variant="contained"
            disabled={!bulkTransitionTarget || bulkTransitionRunning || bulkTransitionLoading}
          >
            {bulkTransitionRunning ? <CircularProgress size={18} /> : 'Transition'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Bulk-load a parent's children into the table */}
      <Dialog open={epicLoadOpen} onClose={() => setEpicLoadOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Load from Jira</DialogTitle>
        <DialogContent>
          <ToggleButtonGroup
            value={loadMode}
            exclusive
            size="small"
            color="primary"
            fullWidth
            sx={{ mt: 1, mb: 1.5 }}
            onChange={(_, value) => { if (value) { setLoadMode(value); setEpicLoadError(''); } }}
          >
            <ToggleButton value="feature">Epics of a feature</ToggleButton>
            <ToggleButton value="epic">Issues of an epic</ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {loadMode === 'feature'
              ? 'Every epic under the chosen feature is added to the table for editing.'
              : 'Every issue under the chosen epic is added to the table for editing.'}
            {' '}Each row keeps its Jira key, so its Update button pushes changes back to that issue.
          </Typography>
          {loadMode === 'feature' ? (
            <>
              <Autocomplete
                size="small"
                options={projects}
                getOptionLabel={option => (option ? `${option.key} - ${option.name}` : '')}
                value={featureProject}
                onChange={(_, value) => {
                  setFeatureProject(value);
                  setFeatureToLoad(null);
                  // Clearing is remembered too, so it does not reappear on the next open
                  if (value) localStorage.setItem(FEATURE_PROJECT_KEY, value.key);
                  else localStorage.removeItem(FEATURE_PROJECT_KEY);
                }}
                isOptionEqualToValue={(option, value) => option.key === value.key}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label="Feature project"
                    variant="outlined"
                    margin="normal"
                    helperText="Features often live in a separate portfolio project from the epics"
                  />
                )}
              />
              <Autocomplete
                options={features}
                getOptionLabel={option => (option ? `${option.id} - ${option.title}` : '')}
                loading={featuresLoading}
                value={featureToLoad}
                onChange={(_, value) => setFeatureToLoad(value)}
                isOptionEqualToValue={(option, value) => option.id === value.id}
                renderInput={(params) => (
                  <TextField {...params} label="Feature" variant="outlined" fullWidth margin="normal" autoFocus InputProps={{ ...params.InputProps, endAdornment: (
                    <>
                      {featuresLoading ? <CircularProgress color="inherit" size={20} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ) }} />
                )}
                disabled={featuresLoading || !featureProject}
              />
            </>
          ) : (
            <Autocomplete
              multiple
              options={epicsForProject}
              getOptionLabel={option => (option ? `${option.id} - ${option.title}` : '')}
              loading={epicsForProjectLoading}
              value={epicsToLoad}
              onChange={(_, value) => setEpicsToLoad(value)}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              renderTags={(value, getTagProps) =>
                value.map((option, index) => (
                  <Chip
                    key={option.id}
                    label={option.id}
                    size="small"
                    {...getTagProps({ index })}
                  />
                ))
              }
              renderInput={(params) => (
                <TextField {...params} label="Epics" variant="outlined" fullWidth margin="normal" autoFocus
                  helperText={epicsToLoad.length > 0 ? `${epicsToLoad.length} epic${epicsToLoad.length === 1 ? '' : 's'} selected` : 'Select one or more epics'}
                  InputProps={{ ...params.InputProps, endAdornment: (
                    <>
                      {epicsForProjectLoading ? <CircularProgress color="inherit" size={20} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ) }}
                />
              )}
              disabled={epicsForProjectLoading}
            />
          )}
          {/* An epic loaded here can be fed straight back in as the parent for its own issues */}
          {loadMode === 'feature' && !featuresLoading && featureProject && features.length === 0 && (
            <Alert severity="info" sx={{ mt: 1 }}>
              No Feature or Initiative issues in {featureProject.key}. Try the project your
              portfolio lives in — it is usually not the same one as the epics.
            </Alert>
          )}
          {epicLoadError && <Alert severity="error" sx={{ mt: 1 }}>{epicLoadError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEpicLoadOpen(false)}>Cancel</Button>
          <Button
            onClick={handleLoadEpicIssues}
            variant="contained"
            disabled={epicLoading || (loadMode === 'feature' ? !featureToLoad : epicsToLoad.length === 0)}
          >
            {epicLoading ? <CircularProgress size={18} /> : (loadMode === 'feature' ? 'Load Epics' : `Load Issues${epicsToLoad.length > 1 ? ` (${epicsToLoad.length} epics)` : ''}`)}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Side-by-side description diff with editable right pane */}
      <Dialog open={descDiffOpen} onClose={() => setDescDiffOpen(false)} maxWidth="xl" fullWidth
        slotProps={{ paper: { sx: { height: '88vh' } } }}
      >
        <DialogTitle sx={{ pb: 1 }}>
          Description — {newRow.issue || 'compare'}
          <Typography variant="caption" color="text.secondary" sx={{ ml: 1.5 }}>
            Edit the right pane, then Save to apply.
          </Typography>
        </DialogTitle>
        <DialogContent dividers sx={{ p: 0, display: 'flex', overflow: 'hidden' }}>

          {/* Left: current Jira value — read-only, wiki markup as plain text */}
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '2px solid', borderColor: 'divider', overflow: 'hidden' }}>
            <Box sx={{ px: 2, py: 1, bgcolor: 'grey.100', borderBottom: '1px solid', borderColor: 'divider', flexShrink: 0 }}>
              <Typography variant="subtitle2">Current in Jira</Typography>
              <Typography variant="caption" color="text.secondary">Read-only · Jira wiki markup</Typography>
            </Box>
            <Box sx={{ flex: 1, overflowY: 'auto', p: 2, fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6, color: 'text.secondary' }}>
              {jiraCurrentDescription || '(empty)'}
            </Box>
          </Box>

          {/* Right: editable local value with format switcher */}
          <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <Box sx={{ px: 2, py: 1, bgcolor: 'grey.50', borderBottom: '1px solid', borderColor: 'divider', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 2 }}>
              <Box sx={{ flex: 1 }}>
                <Typography variant="subtitle2">Local — edit here</Typography>
              </Box>
              <TextField
                select
                size="small"
                label="Format"
                value={descDiffFormat}
                onChange={e => setDescDiffFormat(e.target.value)}
                sx={{ minWidth: 190 }}
              >
                <MenuItem value="richtext">Rich Text (WYSIWYG)</MenuItem>
                <MenuItem value="markdown">Markdown (source)</MenuItem>
                <MenuItem value="jira">Jira Wiki Markup</MenuItem>
              </TextField>
            </Box>
            <Box sx={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {descDiffFormat === 'jira' ? (
                <TextField
                  value={descDiffValue}
                  onChange={e => setDescDiffValue(e.target.value)}
                  multiline
                  fullWidth
                  sx={{
                    flex: 1,
                    '& .MuiInputBase-root': { height: '100%', alignItems: 'flex-start', borderRadius: 0 },
                    '& .MuiInputBase-inputMultiline': { height: '100% !important', overflow: 'auto !important', fontFamily: 'monospace', fontSize: 13, p: 2 },
                    '& fieldset': { border: 'none' }
                  }}
                />
              ) : (
                <MDEditor
                  value={descDiffValue}
                  onChange={v => setDescDiffValue(v || '')}
                  preview={descDiffFormat === 'markdown' ? 'edit' : 'live'}
                  height="100%"
                  style={{ flex: 1, borderRadius: 0 }}
                  data-color-mode="light"
                />
              )}
            </Box>
          </Box>

        </DialogContent>
        <DialogActions sx={{ px: 2 }}>
          <Button onClick={() => setDescDiffOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => {
              setNewRow(prev => ({ ...prev, description: descDiffValue, descriptionFormat: descDiffFormat }));
              setDescDiffOpen(false);
            }}
          >
            Save description
          </Button>
        </DialogActions>
      </Dialog>

      {/* Load an existing Jira issue by key, to clone or to edit */}
      <Dialog open={lookupOpen} onClose={() => setLookupOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{lookupMode === 'edit' ? 'Edit Existing Issue' : 'Clone Existing Issue'}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {lookupMode === 'edit'
              ? 'Enter a Jira issue key to load it for editing. Saving adds it to the table, where Update pushes your changes back to that issue.'
              : 'Enter a Jira issue key to load its details. You can edit them before adding to the table.'}
          </Typography>
          <TextField
            label="Issue Key"
            placeholder="e.g. PROJ-123"
            value={lookupKey}
            onChange={e => setLookupKey(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleLoadExisting(); }}
            fullWidth
            margin="normal"
            autoFocus
          />
          {lookupError && <Alert severity="error" sx={{ mt: 1 }}>{lookupError}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setLookupOpen(false)}>Cancel</Button>
          <Button onClick={handleLoadExisting} variant="contained" disabled={lookupLoading}>
            {lookupLoading ? <CircularProgress size={18} /> : 'Load & Edit'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={openDialog}
        onClose={() => { setOpenDialog(false); setJiraCurrentDescription(null); }}
        maxWidth="lg"
        fullWidth
        fullScreen={compactDialog}
        slotProps={{ paper: { sx: compactDialog ? undefined : { height: '88vh' } } }}
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, py: 1.5 }}>
          <Box sx={{ flex: 1 }}>
            {newRow.existing
              ? `Edit ${newRow.issue}`
              : (dialogMode === 'edit' ? 'Edit Issue' : 'Create Jira Issue')}
          </Box>
          {selectedProject && <Chip size="small" color="primary" label={selectedProject.key} />}
          {selectedBoard && <Chip size="small" variant="outlined" label={selectedBoard.name} />}
        </DialogTitle>
        <DialogContent dividers sx={{ p: 0, overflow: 'hidden', display: 'flex', flexDirection: compactDialog ? 'column' : 'row' }}>

          {/* Authoring column: the fields you write */}
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1.5, p: 2, overflowY: 'auto' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <TextField
                label="Summary"
                value={newRow.summary}
                onChange={e => setNewRow({ ...newRow, summary: e.target.value })}
                fullWidth
                autoFocus
                InputProps={{ sx: { fontSize: 18, fontWeight: 500 } }}
              />
              {newRow.existing && newRow.issue && (
                <Tooltip title={diffLoading ? `Loading ${newRow.issue}…` : jiraCurrentDescription === null ? 'Sign in to Jira to compare' : 'Compare description to current Jira'}>
                  <span>
                    <IconButton
                      disabled={diffLoading || jiraCurrentDescription === null}
                      onClick={() => {
                        setDescDiffValue(newRow.description || '');
                        setDescDiffFormat(newRow.descriptionFormat || 'jira');
                        setDescDiffOpen(true);
                      }}
                    >
                      {diffLoading ? <CircularProgress size={20} /> : <DifferenceIcon />}
                    </IconButton>
                  </span>
                </Tooltip>
              )}
            </Box>

            <Box sx={{ flex: 1, minHeight: 240, display: 'flex', flexDirection: 'column' }}>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mb: 1 }}>
                <TextField
                  select
                  size="small"
                  label="Description Format"
                  value={newRow.descriptionFormat || 'jira'}
                  onChange={e => setNewRow({ ...newRow, descriptionFormat: e.target.value })}
                  sx={{ flex: 1, minWidth: 200 }}
                >
                  <MenuItem value="richtext">Rich Text (Markdown WYSIWYG)</MenuItem>
                  <MenuItem value="markdown">Markdown (source)</MenuItem>
                  <MenuItem value="jira">Jira Wiki Markup</MenuItem>
                </TextField>
                <TextField
                  select
                  size="small"
                  label="Issue Type"
                  value={newRow.issueType}
                  onChange={e => setNewRow({ ...newRow, issueType: e.target.value })}
                  sx={{ flex: 1, minWidth: 140 }}
                  disabled={issueTypesLoading}
                  helperText={
                    issueTypesLoading
                      ? 'Loading issue types…'
                      : (!selectedProject ? 'Select a project to load its issue types' : '')
                  }
                >
                  {(() => {
                    const names = issueTypes.length > 0 ? issueTypes.map(it => it.name) : ['Story'];
                    const options = names.includes(newRow.issueType) ? names : [newRow.issueType, ...names];
                    return options.map(name => (
                      <MenuItem key={name} value={name}>{name}</MenuItem>
                    ));
                  })()}
                </TextField>
                <TextField
                  size="small"
                  label="Story Points"
                  value={newRow.storyPoints}
                  onChange={e => setNewRow({ ...newRow, storyPoints: e.target.value })}
                  sx={{ width: 120 }}
                />
              </Box>
              {newRow.descriptionFormat === 'jira' && (
                // Enough room below the buttons for the field's floating label to clear them
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mb: 1.75 }}>
                  {WIKI_TOOLBAR.map(btn => (
                    <Button
                      key={btn.label}
                      size="small"
                      variant="outlined"
                      onClick={btn.apply}
                      sx={{ minWidth: 0, px: 1, textTransform: 'none' }}
                    >
                      {btn.label}
                    </Button>
                  ))}
                </Box>
              )}
              {/* The Markdown editors have no built-in label, unlike the wiki TextField */}
              {newRow.descriptionFormat !== 'jira' && (
                <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5 }}>
                  Description
                </Typography>
              )}
              {/* Measured so the editor fills whatever height the dialog leaves it */}
              <Box ref={editorAreaRef} sx={{ flex: 1, minHeight: 160, overflow: 'hidden' }}>
                {newRow.descriptionFormat === 'jira' ? (
                  <TextField
                    label="Description"
                    value={newRow.description}
                    onChange={e => setNewRow({ ...newRow, description: e.target.value })}
                    inputRef={wikiRef}
                    placeholder="Sent to Jira as-is, e.g. *bold*, _italic_, h1."
                    fullWidth
                    multiline
                    // Stretch the textarea to the measured area instead of guessing a row count,
                    // so it never overflows the container and gets clipped
                    sx={{
                      height: '100%',
                      '& .MuiInputBase-root': { height: '100%', alignItems: 'flex-start' },
                      '& .MuiInputBase-inputMultiline': { height: '100% !important', overflow: 'auto !important' }
                    }}
                  />
                ) : (
                  <MDEditor
                    value={newRow.description}
                    onChange={(value) => setNewRow({ ...newRow, description: value || '' })}
                    preview={newRow.descriptionFormat === 'markdown' ? 'edit' : 'live'}
                    height={editorHeight}
                    data-color-mode="light"
                  />
                )}
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5 }}>
                {newRow.descriptionFormat === 'jira'
                  ? 'Wiki markup is sent to Jira unchanged.'
                  : 'Markdown is converted to Jira wiki markup on publish.'}
              </Typography>
            </Box>

            <Autocomplete
              multiple
              freeSolo
              size="small"
              options={[]}
              value={labelsToArray(newRow.labels)}
              onChange={(_, value) => setNewRow(prev => ({
                ...prev,
                labels: value.map(v => String(v).trim()).filter(Boolean).join(', ')
              }))}
              renderInput={(params) => (
                <TextField {...params} label="Labels" placeholder="Add label…" helperText="Press Enter after each label" />
              )}
            />

            <Box>
              <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                Attachments{(newRow.attachments || []).length > 0 ? ` (${newRow.attachments.length})` : ''}
              </Typography>
              <Button variant="outlined" size="small" startIcon={<AttachFileIcon />} component="label">
                Add Files
                <input type="file" hidden multiple onChange={handleAddAttachments} />
              </Button>
              {(newRow.attachments || []).length > 0 ? (
                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
                  {newRow.attachments.map((file, idx) => {
                    // Already in Jira: shown so the row still lists it, but not re-uploaded
                    const sent = (newRow.uploadedAttachments || []).includes(file.name);
                    return (
                      <Chip
                        key={`${file.name}-${idx}`}
                        label={`${file.name} (${formatFileSize(file.size)})`}
                        onDelete={() => handleRemoveAttachment(idx)}
                        size="small"
                        color={sent ? 'success' : 'default'}
                        variant={sent ? 'outlined' : 'filled'}
                        icon={sent ? <AttachFileIcon fontSize="inherit" /> : undefined}
                      />
                    );
                  })}
                </Box>
              ) : (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                  {newRow.existing
                    ? 'Files are uploaded to the issue when you press Update. Existing attachments are not listed here.'
                    : 'Files are uploaded to the issue after it is published.'}
                </Typography>
              )}
            </Box>
          </Box>

          {/* Metadata column: the fields you pick */}
          <Box
            sx={{
              width: compactDialog ? 'auto' : 340,
              flexShrink: 0,
              p: 2,
              overflowY: 'auto',
              bgcolor: 'grey.50',
              borderLeft: compactDialog ? 0 : '1px solid',
              borderTop: compactDialog ? '1px solid' : 0,
              borderColor: 'divider'
            }}
          >
            <Autocomplete
              size="small"
              options={teams}
              getOptionLabel={option => (typeof option === 'object' ? option.value : option) || ''}
              loading={teamsLoading}
              value={findTeam(newRow.team)}
              onChange={(_, value) => setNewRow(prev => ({ ...prev, team: value ? value.id : '' }))}
              isOptionEqualToValue={(option, value) => String(option.id) === String(value.id)}
              renderInput={(params) => (
                <TextField {...params} label="Team" variant="outlined" fullWidth margin="dense" InputProps={{ ...params.InputProps, endAdornment: (
                  <>
                    {teamsLoading ? <CircularProgress color="inherit" size={20} /> : null}
                    {params.InputProps.endAdornment}
                  </>
                ) }} />
              )}
            />
            {/* Typing searches every project, so an epic on another team's board can be
                picked even though it is not in this project's list */}
            <Autocomplete
              size="small"
              freeSolo
              options={epicOptions}
              filterOptions={limitedFilter}
              getOptionLabel={option => (typeof option === 'string' ? option : `${option.id} - ${option.title}`)}
              loading={epicsForProjectLoading || epicSearching}
              value={epicOptions.find(e => e.id === newRow.epicLink) || newRow.epicLink || null}
              onChange={(_, value) => setNewRow(prev => ({
                ...prev,
                epicLink: typeof value === 'string' ? value.trim() : (value ? value.id : '')
              }))}
              onInputChange={(_, value, reason) => { if (reason === 'input') searchEpics(value); }}
              renderOption={(props, option) => (
                <li {...props} key={option.id}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
                    <Box component="span" sx={{ flex: 1, minWidth: 0 }}>{option.id} - {option.title}</Box>
                    {option.foreign && <Chip size="small" variant="outlined" label={option.project} />}
                  </Box>
                </li>
              )}
              renderInput={(params) => (
                <TextField {...params} label="Epic Link" variant="outlined" fullWidth margin="dense"
                  helperText="Type to search any project, or paste a key"
                  InputProps={{ ...params.InputProps, endAdornment: (
                    <>
                      {(epicsForProjectLoading || epicSearching) ? <CircularProgress color="inherit" size={20} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ) }} />
              )}
              isOptionEqualToValue={(option, value) => option.id === (value && value.id)}
            />
            {/* Every value the field allows, not just the ones already on the epic */}
            <Autocomplete
              size="small"
              freeSolo
              options={applicationCIOptions}
              filterOptions={limitedFilter}
              getOptionLabel={option => option || ''}
              loading={applicationCIsLoading || allApplicationCIsLoading}
              value={newRow.applicationCI || null}
              onChange={(_, value) => setNewRow({ ...newRow, applicationCI: value || '' })}
              onInputChange={(_, value, reason) => {
                if (reason === 'input') setNewRow(prev => ({ ...prev, applicationCI: value }));
              }}
              renderInput={(params) => (
                <TextField {...params} label="Application CI (as per CMDB)" variant="outlined" fullWidth margin="dense"
                  helperText={allApplicationCIsLoading
                    ? 'Loading the full CI list…'
                    : `${applicationCIOptions.length} available — type to search`}
                  InputProps={{ ...params.InputProps, endAdornment: (
                    <>
                      {(applicationCIsLoading || allApplicationCIsLoading) ? <CircularProgress color="inherit" size={20} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ) }} />
              )}
              isOptionEqualToValue={(option, value) => option === value}
            />
            <Autocomplete
              size="small"
              options={userOptions}
              getOptionLabel={option => option ? option.name : ''}
              loading={reportersLoading}
              value={findUser(newRow.reporter)}
              onChange={(_, value) => setNewRow({
                ...newRow,
                reporter: value ? value.key : '',
                reporterName: value ? value.name : ''
              })}
              renderInput={(params) => (
                <TextField {...params} label="Reporter" variant="outlined" fullWidth margin="dense" InputProps={{ ...params.InputProps, endAdornment: (
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
              size="small"
              options={userOptions}
              getOptionLabel={option => option ? option.name : ''}
              loading={reportersLoading}
              value={findUser(newRow.assignee)}
              onChange={(_, value) => setNewRow({
                ...newRow,
                assignee: value ? value.key : '',
                assigneeName: value ? value.name : ''
              })}
              isOptionEqualToValue={(option, value) => option.key === value.key}
              renderInput={(params) => (
                <TextField {...params} label="Assignee" variant="outlined" fullWidth margin="dense" InputProps={{ ...params.InputProps, endAdornment: (
                  <>
                    {reportersLoading ? <CircularProgress color="inherit" size={20} /> : null}
                    {params.InputProps.endAdornment}
                  </>
                ) }} />
              )}
              disabled={!selectedProject || reportersLoading}
            />
            <Autocomplete
              size="small"
              options={sprints}
              getOptionLabel={option => option ? option.name : ''}
              loading={sprintsLoading}
              value={sprints.find(s => s.name === newRow.sprint) || null}
              onChange={(_, value) => setNewRow({ ...newRow, sprint: value ? value.name : '' })}
              renderInput={(params) => (
                <TextField {...params} label="Sprint" variant="outlined" fullWidth margin="dense" InputProps={{ ...params.InputProps, endAdornment: (
                  <>
                    {sprintsLoading ? <CircularProgress color="inherit" size={20} /> : null}
                    {params.InputProps.endAdornment}
                  </>
                ) }} />
              )}
              isOptionEqualToValue={(option, value) => option.id === value.id}
              disabled={!selectedBoard || sprintsLoading}
            />
            <TextField size="small" label="Linked Issues" value={newRow.linkedIssues} onChange={e => setNewRow({ ...newRow, linkedIssues: e.target.value })} fullWidth margin="dense" />
            <TextField size="small" label="Issue" value={newRow.issue} onChange={e => setNewRow({ ...newRow, issue: e.target.value })} fullWidth margin="dense" />

            {newRow.status ? (
              <Box sx={{ mt: 1.5 }}>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                  Status
                </Typography>
                <Chip
                  size="small"
                  variant="outlined"
                  label={newRow.status}
                  color={STATUS_COLORS[newRow.statusCategory] || 'default'}
                />
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                  Changed by transitioning the issue, not by saving fields.
                </Typography>
              </Box>
            ) : null}

            {dialogMode === 'create' && !newRow.existing && (
              <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                <Typography variant="subtitle2">Instances</Typography>
                <TextField
                  size="small"
                  label="Number of Instances"
                  type="number"
                  value={instanceCount}
                  onChange={e => setInstanceCount(e.target.value)}
                  fullWidth
                  margin="dense"
                  inputProps={{ min: 1 }}
                />
                <FormControlLabel
                  control={<Checkbox size="small" checked={cloneSprint} onChange={e => setCloneSprint(e.target.checked)} />}
                  label={<Typography variant="body2">Clone same Sprint value for all instances?</Typography>}
                />
              </Box>
            )}
          </Box>
        </DialogContent>
        <DialogActions sx={{ px: 2 }}>
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
            {newRow.existing && dialogMode === 'create'
              ? `Adds ${newRow.issue} to the table — use Update to send your changes to Jira.`
              : (dialogMode === 'create' && (parseInt(instanceCount, 10) || 1) > 1
                ? `Adds ${parseInt(instanceCount, 10)} rows to the table.`
                : '')}
          </Typography>
          <Button onClick={() => setOpenDialog(false)}>Cancel</Button>
          <Button onClick={handleSubmitDialog} variant="contained">
            {dialogMode === 'edit' || newRow.existing ? 'Save' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>
    </div>
  );
}
