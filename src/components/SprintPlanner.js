import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Box,
  Paper,
  Typography,
  Button,
  IconButton,
  Chip,
  Tooltip,
  TextField,
  Autocomplete,
  MenuItem,
  Menu,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Drawer,
  Divider,
  CircularProgress,
  Alert,
  Snackbar,
  FormControlLabel,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  InputAdornment,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow
} from '@mui/material';
import {
  Add as AddIcon,
  Refresh as RefreshIcon,
  OpenInNew as OpenInNewIcon,
  Close as CloseIcon,
  PlayArrow as StartIcon,
  DoneAll as CompleteIcon,
  MoreVert as MoreIcon,
  Search as SearchIcon,
  ViewKanban as BoardViewIcon,
  ViewList as ListViewIcon,
  AutoAwesome as AutoAwesomeIcon,
  KeyboardArrowDown as CollapseIcon,
  KeyboardArrowRight as ExpandIcon
} from '@mui/icons-material';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  closestCorners
} from '@dnd-kit/core';
import MDEditor from '@uiw/react-md-editor';
import '@uiw/react-markdown-preview/markdown.css';
import { jiraToMarkdown } from '../utils/jiraToMarkdown';
import { planNextSprint, inferCadenceDays } from '../utils/sprintPlan';
import useJiraAuth, { jiraAuthService } from '../hooks/useJiraAuth';
import { debug } from '../utils/debug';
import { openConnections } from './Connections';

// The backlog is one more column on the board, and the server takes the same word as a
// stand-in for a sprint id when moving issues out of every sprint.
const BACKLOG = 'backlog';

const DAY = 24 * 60 * 60 * 1000;

const PROJECT_KEY = 'sprintPlannerProject';
const VIEW_KEY = 'sprintPlannerView';
const BOARD_KEY = 'sprintPlannerBoard';
const CLOSED_KEY = 'sprintPlannerShowClosed';

// Columns read the way planning does: what is running now, what is being filled next,
// then the backlog it is all drawn from. Closed sprints are history and trail behind.
const STATE_ORDER = { active: 0, future: 1, backlog: 2, closed: 3 };

const STATE_CHIP = {
  active: { label: 'Active', color: 'success' },
  future: { label: 'Future', color: 'info' },
  closed: { label: 'Closed', color: 'default' },
  backlog: { label: 'Backlog', color: 'default' }
};

// Jira colours a board by status category, so the cards do too
const CATEGORY_COLOR = {
  new: '#626F86',
  indeterminate: '#0B66E4',
  done: '#22A06B'
};

const pointsOf = row => {
  const points = Number(row.storyPoints);
  return isNaN(points) ? 0 : points;
};

const sumPoints = rows => (rows || []).reduce((total, row) => total + pointsOf(row), 0);

const formatDay = iso => {
  if (!iso) return '';
  const date = new Date(iso);
  return isNaN(date.getTime()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

// <input type="datetime-local"> wants wall-clock time, which toISOString would shift
const toDateTimeInput = date =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

const fromDateTimeInput = value => (value ? new Date(value).toISOString() : '');

/**
 * Run `fn` over `items` a few at a time. Every column is its own request, and a board
 * with a dozen sprints would otherwise open a dozen at once — which the gateway in front
 * of Jira handles far less happily than a steady few.
 */
async function forEachWithLimit(items, limit, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

/**
 * What a column amounts to: how much is in it, and how much of that the filters let
 * through. Points follow the filter too — filtering to one person is how you find out
 * what that person is carrying.
 */
function columnSummary(column, rows, filtered, loading) {
  if (loading) return 'Loading…';
  const all = (rows || []).length;
  const shown = filtered.length;
  const dates = column.startDate || column.endDate
    ? ` · ${formatDay(column.startDate)}${column.endDate ? ` – ${formatDay(column.endDate)}` : ''}`
    : '';
  if (shown !== all) return `${shown} of ${all} issues · ${sumPoints(filtered)} pts${dates}`;
  return `${all} issue${all === 1 ? '' : 's'} · ${sumPoints(rows)} pts${dates}`;
}

function SprintStateChip({ state }) {
  const chip = STATE_CHIP[state] || STATE_CHIP.future;
  return <Chip size="small" label={chip.label} color={chip.color} variant={state === 'active' ? 'filled' : 'outlined'} sx={{ height: 20, '& .MuiChip-label': { fontSize: 11, px: 0.75 } }} />;
}

/** One issue on the board. The whole card is the drag handle, and a click opens the peek. */
function IssueCard({ row, columnId, onPeek, isSelected }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: row.issue,
    data: { from: columnId }
  });

  return (
    <Paper
      ref={setNodeRef}
      elevation={0}
      onClick={() => onPeek(row, columnId)}
      {...listeners}
      {...attributes}
      sx={{
        p: 1.25,
        mb: 1,
        cursor: 'grab',
        border: '1px solid',
        borderColor: isSelected ? 'primary.main' : 'divider',
        boxShadow: isSelected ? '0 0 0 1px rgba(0, 82, 204, 0.4)' : 'none',
        // The original stays in place but steps back while its copy rides the cursor
        opacity: isDragging ? 0.35 : 1,
        touchAction: 'none',
        transition: 'border-color 120ms, box-shadow 120ms',
        '&:hover': { borderColor: 'primary.light' }
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
        {row.issueTypeIcon
          ? <Box component="img" src={row.issueTypeIcon} alt={row.issueType} sx={{ width: 14, height: 14 }} />
          : null}
        <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>{row.issue}</Typography>
        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 0.5 }}>
          {pointsOf(row) > 0 && (
            <Chip size="small" label={pointsOf(row)} sx={{ height: 18, '& .MuiChip-label': { fontSize: 10, px: 0.6, fontWeight: 700 } }} />
          )}
        </Box>
      </Box>
      <Typography variant="body2" sx={{ lineHeight: 1.35, mb: 0.75 }}>{row.summary}</Typography>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
        {row.status && (
          <Chip
            size="small"
            label={row.status}
            sx={{
              height: 18,
              bgcolor: 'transparent',
              border: '1px solid',
              borderColor: CATEGORY_COLOR[row.statusCategory] || 'divider',
              color: CATEGORY_COLOR[row.statusCategory] || 'text.secondary',
              '& .MuiChip-label': { fontSize: 10, px: 0.6 }
            }}
          />
        )}
        {row.assigneeName && (
          <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: 120 }}>
            {row.assigneeName}
          </Typography>
        )}
      </Box>
    </Paper>
  );
}

/** A sprint (or the backlog) and everything currently in it. */
function SprintColumn({ column, rows, loading, filtered, onPeek, peekKey, onAction }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const [menuAnchor, setMenuAnchor] = useState(null);
  const total = rows ? rows.length : 0;

  return (
    <Paper
      variant="outlined"
      sx={{
        width: 310,
        minWidth: 310,
        display: 'flex',
        flexDirection: 'column',
        maxHeight: '100%',
        bgcolor: isOver ? 'rgba(0, 82, 204, 0.06)' : 'background.default',
        borderColor: isOver ? 'primary.main' : 'divider',
        transition: 'background-color 120ms, border-color 120ms'
      }}
    >
      <Box sx={{ p: 1.25, pb: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0 }} title={column.name}>
            {column.name}
          </Typography>
          <SprintStateChip state={column.state} />
          {column.id !== BACKLOG && (
            <IconButton size="small" onClick={e => setMenuAnchor(e.currentTarget)}>
              <MoreIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.25 }}>
          {columnSummary(column, rows, filtered, loading)}
        </Typography>
        {column.goal && (
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block', fontStyle: 'italic' }} title={column.goal}>
            {column.goal}
          </Typography>
        )}
      </Box>
      <Divider />
      {/* The droppable is the list itself, so an empty column is still a target */}
      <Box ref={setNodeRef} sx={{ flex: 1, overflowY: 'auto', p: 1.25, pt: 1, minHeight: 120 }}>
        {loading && [0, 1, 2].map(i => (
          <Skeleton key={i} variant="rounded" height={72} sx={{ mb: 1 }} />
        ))}
        {!loading && filtered.length === 0 && (
          <Typography variant="caption" color="text.disabled">
            {total === 0 ? 'Nothing here yet — drag an issue in.' : 'Nothing matches the filter.'}
          </Typography>
        )}
        {!loading && filtered.map(row => (
          <IssueCard
            key={row.issue}
            row={row}
            columnId={column.id}
            onPeek={onPeek}
            isSelected={peekKey === row.issue}
          />
        ))}
      </Box>
      <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
        {column.state === 'future' && (
          <MenuItem onClick={() => { setMenuAnchor(null); onAction('start', column); }}>
            <StartIcon fontSize="small" sx={{ mr: 1 }} /> Start sprint
          </MenuItem>
        )}
        {column.state === 'active' && (
          <MenuItem onClick={() => { setMenuAnchor(null); onAction('complete', column); }}>
            <CompleteIcon fontSize="small" sx={{ mr: 1 }} /> Complete sprint
          </MenuItem>
        )}
        <MenuItem onClick={() => { setMenuAnchor(null); onAction('refresh', column); }}>
          <RefreshIcon fontSize="small" sx={{ mr: 1 }} /> Reload issues
        </MenuItem>
      </Menu>
    </Paper>
  );
}

/**
 * The same board as a list: one table, a section per sprint, so issues line up in columns
 * that can be read down. Everything the board does by dragging, this does with the Sprint
 * cell on each row — the two views share their data, their filters and the peek.
 */
function IssueList({ columns, issuesByColumn, loadingColumns, matches, onPeek, peekKey, onMove, collapsed, onToggleSection, onAction }) {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: 120 }}>Key</TableCell>
            <TableCell>Summary</TableCell>
            <TableCell sx={{ width: 140 }}>Status</TableCell>
            <TableCell sx={{ width: 160 }}>Assignee</TableCell>
            <TableCell sx={{ width: 70 }} align="right">Points</TableCell>
            <TableCell sx={{ width: 200 }}>Sprint</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {columns.map(column => {
            const rows = issuesByColumn[column.id];
            const filtered = (rows || []).filter(matches);
            const isCollapsed = Boolean(collapsed[column.id]);
            return (
              <React.Fragment key={column.id}>
                <TableRow
                  hover
                  onClick={() => onToggleSection(column.id)}
                  sx={{ cursor: 'pointer', '& td': { bgcolor: 'background.default', py: 0.75 } }}
                >
                  <TableCell colSpan={6}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      {isCollapsed ? <ExpandIcon fontSize="small" /> : <CollapseIcon fontSize="small" />}
                      <Typography variant="subtitle2">{column.name}</Typography>
                      <SprintStateChip state={column.state} />
                      <Typography variant="caption" color="text.secondary">
                        {columnSummary(column, rows, filtered, Boolean(loadingColumns[column.id]))}
                      </Typography>
                      {column.goal && (
                        <Typography variant="caption" color="text.secondary" noWrap sx={{ fontStyle: 'italic', maxWidth: 280 }}>
                          {column.goal}
                        </Typography>
                      )}
                      <Box sx={{ ml: 'auto' }} onClick={e => e.stopPropagation()}>
                        {column.state === 'future' && (
                          <Button size="small" startIcon={<StartIcon />} onClick={() => onAction('start', column)}>Start</Button>
                        )}
                        {column.state === 'active' && (
                          <Button size="small" startIcon={<CompleteIcon />} onClick={() => onAction('complete', column)}>Complete</Button>
                        )}
                      </Box>
                    </Box>
                  </TableCell>
                </TableRow>
                {!isCollapsed && filtered.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <Typography variant="caption" color="text.disabled">
                        {loadingColumns[column.id] ? 'Loading…' : 'Nothing here.'}
                      </Typography>
                    </TableCell>
                  </TableRow>
                )}
                {!isCollapsed && filtered.map(row => (
                  <TableRow
                    key={row.issue}
                    hover
                    selected={peekKey === row.issue}
                    onClick={() => onPeek(row, column.id)}
                    sx={{ cursor: 'pointer' }}
                  >
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                        {row.issueTypeIcon && (
                          <Box component="img" src={row.issueTypeIcon} alt={row.issueType} sx={{ width: 14, height: 14 }} />
                        )}
                        <Typography variant="caption" sx={{ fontWeight: 700 }}>{row.issue}</Typography>
                      </Box>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 0 }}>
                      <Typography variant="body2" noWrap title={row.summary}>{row.summary}</Typography>
                    </TableCell>
                    <TableCell>
                      {row.status && (
                        <Chip
                          size="small"
                          label={row.status}
                          sx={{
                            height: 20,
                            bgcolor: 'transparent',
                            border: '1px solid',
                            borderColor: CATEGORY_COLOR[row.statusCategory] || 'divider',
                            color: CATEGORY_COLOR[row.statusCategory] || 'text.secondary',
                            '& .MuiChip-label': { fontSize: 11, px: 0.75 }
                          }}
                        />
                      )}
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" noWrap color={row.assigneeName ? 'text.primary' : 'text.disabled'}>
                        {row.assigneeName || 'Unassigned'}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="body2">{pointsOf(row) || ''}</Typography>
                    </TableCell>
                    {/* Moving without dragging: the same call the board makes on a drop */}
                    <TableCell onClick={e => e.stopPropagation()}>
                      <TextField
                        select
                        size="small"
                        variant="standard"
                        fullWidth
                        value={column.id}
                        onChange={e => onMove(row.issue, column.id, e.target.value)}
                        slotProps={{ input: { disableUnderline: true } }}
                        sx={{ '& .MuiSelect-select': { fontSize: 13, py: 0.25 } }}
                      >
                        {columns.map(option => (
                          <MenuItem key={option.id} value={option.id}>{option.name}</MenuItem>
                        ))}
                      </TextField>
                    </TableCell>
                  </TableRow>
                ))}
              </React.Fragment>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export default function SprintPlanner() {
  const { isAuthenticated, isValidating } = useJiraAuth();

  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState(null);
  const [boards, setBoards] = useState([]);
  const [selectedBoard, setSelectedBoard] = useState(null);
  const [sprints, setSprints] = useState([]);
  const [sprintsLoading, setSprintsLoading] = useState(false);
  const [showClosed, setShowClosed] = useState(() => {
    try { return localStorage.getItem(CLOSED_KEY) === '1'; } catch (err) { return false; }
  });

  // Issues and their in-flight state, both keyed by column id
  const [issuesByColumn, setIssuesByColumn] = useState({});
  const [loadingColumns, setLoadingColumns] = useState({});
  const [filter, setFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState([]);
  const [view, setView] = useState(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board'; } catch (err) { return 'board'; }
  });
  const [collapsed, setCollapsed] = useState({});
  const [notice, setNotice] = useState(null);
  const [dragging, setDragging] = useState(null);

  // Peek panel
  const [peek, setPeek] = useState(null);      // { row, columnId }
  const [draft, setDraft] = useState(null);    // the editable copy
  const [saving, setSaving] = useState(false);
  const [descPreview, setDescPreview] = useState('edit');
  const [assignees, setAssignees] = useState([]);

  // Dialogs
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', startDate: '', endDate: '', goal: '' });
  // What the dialog was opened with, kept so it can say why and keep the cycle length
  const [plan, setPlan] = useState(null);
  const [creating, setCreating] = useState(false);
  const [stateDialog, setStateDialog] = useState(null); // { action, sprint, startDate, endDate }
  const [stateBusy, setStateBusy] = useState(false);

  const sensors = useSensors(
    // A few pixels of travel before a drag starts, so a click still opens the peek
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const say = (message, severity = 'success') => setNotice({ message, severity });

  // --- Loading the board -------------------------------------------------------------

  useEffect(() => {
    if (!isAuthenticated) { setProjects([]); return; }
    jiraAuthService.apiCall('projects')
      .then(data => {
        const list = data.projects || [];
        setProjects(list);
        let remembered = null;
        try { remembered = localStorage.getItem(PROJECT_KEY); } catch (err) { /* storage blocked */ }
        if (remembered) {
          const match = list.find(p => p.key === remembered);
          if (match) setSelectedProject(match);
        }
      })
      .catch(err => say(`Could not load projects: ${err.message}`, 'error'));
  }, [isAuthenticated]);

  useEffect(() => {
    if (!isAuthenticated || !selectedProject) { setBoards([]); setSelectedBoard(null); return; }
    setBoards([]);
    setSelectedBoard(null);
    jiraAuthService.apiCall('boards', { projectKey: selectedProject.key })
      .then(data => {
        const list = data.boards || [];
        setBoards(list);
        let remembered = null;
        try { remembered = localStorage.getItem(BOARD_KEY); } catch (err) { /* storage blocked */ }
        // A board only matters alongside its project, so fall back to the first one
        const match = remembered && list.find(b => String(b.id) === remembered);
        setSelectedBoard(match || list[0] || null);
      })
      .catch(err => say(`Could not load boards: ${err.message}`, 'error'));
  }, [isAuthenticated, selectedProject]);

  const loadSprints = useCallback(() => {
    if (!isAuthenticated || !selectedBoard) { setSprints([]); return; }
    setSprintsLoading(true);
    jiraAuthService.apiCall('sprints', { boardId: selectedBoard.id, includeClosed: showClosed })
      .then(data => setSprints(data.sprints || []))
      .catch(err => {
        setSprints([]);
        say(`Could not load sprints: ${err.message}`, 'error');
      })
      .finally(() => setSprintsLoading(false));
  }, [isAuthenticated, selectedBoard, showClosed]);

  useEffect(() => { loadSprints(); }, [loadSprints]);

  // Assignable users for the peek's picker, which is per project
  useEffect(() => {
    if (!isAuthenticated || !selectedProject) { setAssignees([]); return; }
    jiraAuthService.apiCall('reporters', { projectKey: selectedProject.key })
      .then(data => setAssignees(data.reporters || []))
      .catch(err => debug('Could not load assignable users:', err.message));
  }, [isAuthenticated, selectedProject]);

  const columns = useMemo(() => {
    // A sprint's id is its column id; the backlog brings its own
    const all = [...sprints, { id: BACKLOG, name: 'Backlog', state: 'backlog' }];
    return all.sort((a, b) => {
      const byState = (STATE_ORDER[a.state] ?? 9) - (STATE_ORDER[b.state] ?? 9);
      if (byState !== 0) return byState;
      // Closed sprints read best most-recent-first; everything else runs forwards
      const aDate = a.startDate || a.endDate || '';
      const bDate = b.startDate || b.endDate || '';
      if (aDate && bDate && aDate !== bDate) {
        return a.state === 'closed' ? bDate.localeCompare(aDate) : aDate.localeCompare(bDate);
      }
      return String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
    });
  }, [sprints]);

  const loadColumn = useCallback(async (columnId) => {
    if (!selectedBoard) return;
    setLoadingColumns(prev => ({ ...prev, [columnId]: true }));
    try {
      const data = await jiraAuthService.apiCall('sprint-issues', {
        boardId: selectedBoard.id,
        sprintId: columnId
      });
      setIssuesByColumn(prev => ({ ...prev, [columnId]: data.issues || [] }));
    } catch (err) {
      setIssuesByColumn(prev => ({ ...prev, [columnId]: [] }));
      say(`Could not load issues: ${err.message}`, 'error');
    } finally {
      setLoadingColumns(prev => ({ ...prev, [columnId]: false }));
    }
  }, [selectedBoard]);

  // Fill every column whenever the board's shape changes. Columns are keyed by sprint id,
  // so what is already loaded is kept and only the new columns are fetched.
  useEffect(() => {
    if (!isAuthenticated || !selectedBoard || columns.length === 0) return;
    let cancelled = false;
    const ids = columns.map(c => c.id);
    setIssuesByColumn(prev => {
      const kept = {};
      ids.forEach(id => { if (prev[id]) kept[id] = prev[id]; });
      return kept;
    });
    forEachWithLimit(ids.filter(id => !issuesByColumn[id]), 4, async id => {
      if (!cancelled) await loadColumn(id);
    });
    return () => { cancelled = true; };
    // issuesByColumn is deliberately not a dependency: it is what this effect writes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, selectedBoard, columns, loadColumn]);

  const refreshAll = useCallback(() => {
    setIssuesByColumn({});
    loadSprints();
  }, [loadSprints]);

  // --- Moving issues -----------------------------------------------------------------

  const moveIssue = useCallback(async (issueKey, from, to) => {
    if (String(from) === String(to)) return;
    // Read the card being moved from state rather than from inside the updater below:
    // React runs an updater on its own schedule, so anything it assigns is not there yet
    // when the next line looks for it — and the move would never reach Jira.
    const moving = (issuesByColumn[from] || []).find(row => row.issue === issueKey);
    if (!moving) return;
    const target = columns.find(c => String(c.id) === String(to));
    const landed = { ...moving, sprint: to === BACKLOG ? '' : (target ? target.name : moving.sprint) };

    // Move the card first: planning is a dragging exercise, and waiting on a round trip
    // for every drop makes the board feel broken. A failure puts it straight back.
    const place = (row, into, outOf) => setIssuesByColumn(prev => ({
      ...prev,
      [outOf]: (prev[outOf] || []).filter(r => r.issue !== issueKey),
      [into]: [row, ...(prev[into] || []).filter(r => r.issue !== issueKey)]
    }));
    // The peek may be showing this issue, so keep the sprint it names honest too
    const follow = (row, column) =>
      setPeek(prev => (prev && prev.row.issue === issueKey ? { ...prev, columnId: column, row } : prev));

    place(landed, to, from);
    follow(landed, to);

    try {
      await jiraAuthService.apiCall('move-issues', { sprintId: to, issueKeys: [issueKey] });
      say(`${issueKey} moved to ${to === BACKLOG ? 'the backlog' : (target ? target.name : 'sprint')}`);
    } catch (err) {
      place(moving, from, to);
      follow(moving, from);
      say(`Could not move ${issueKey}: ${err.message}`, 'error');
    }
  }, [columns, issuesByColumn]);

  const handleDragEnd = ({ active, over }) => {
    setDragging(null);
    if (!over || !active) return;
    const from = active.data.current && active.data.current.from;
    if (from == null) return;
    moveIssue(active.id, from, over.id);
  };

  // --- The peek ----------------------------------------------------------------------

  const openPeek = (row, columnId) => {
    setPeek({ row, columnId });
    setDraft({
      summary: row.summary || '',
      description: row.description || '',
      storyPoints: row.storyPoints || '',
      labels: row.labels || '',
      assignee: row.assignee || '',
      assigneeName: row.assigneeName || ''
    });
    setDescPreview('edit');
  };

  const closePeek = () => { setPeek(null); setDraft(null); };

  const peekDirty = useMemo(() => {
    if (!peek || !draft) return false;
    return ['summary', 'description', 'storyPoints', 'labels', 'assignee']
      .some(field => String(draft[field] || '') !== String(peek.row[field] || ''));
  }, [peek, draft]);

  const savePeek = async () => {
    if (!peek || !draft) return;
    if (!draft.summary.trim()) { say('An issue needs a summary.', 'error'); return; }
    setSaving(true);
    try {
      await jiraAuthService.apiCall('update-story', {
        issueKey: peek.row.issue,
        boardId: selectedBoard ? selectedBoard.id : undefined,
        summary: draft.summary,
        description: draft.description,
        storyPoints: draft.storyPoints,
        labels: draft.labels,
        assignee: draft.assignee
      });
      const updated = { ...peek.row, ...draft };
      setIssuesByColumn(prev => ({
        ...prev,
        [peek.columnId]: (prev[peek.columnId] || []).map(r => (r.issue === updated.issue ? updated : r))
      }));
      setPeek(prev => (prev ? { ...prev, row: updated } : prev));
      say(`${updated.issue} saved`);
    } catch (err) {
      say(`Could not save ${peek.row.issue}: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // --- Creating and running sprints --------------------------------------------------

  // Open on what the next sprint almost certainly is, read off the ones already there
  const openCreate = () => {
    const next = planNextSprint(sprints);
    setPlan(next);
    setCreateForm({
      name: next.name,
      startDate: toDateTimeInput(next.start),
      endDate: toDateTimeInput(next.end),
      goal: ''
    });
    setCreateOpen(true);
  };

  // Moving the start moves the end with it: the cycle length is the thing being kept
  const setCreateStart = value => setCreateForm(prev => {
    const start = value ? new Date(value) : null;
    const cadence = plan ? plan.cadenceDays : 14;
    return {
      ...prev,
      startDate: value,
      endDate: start && !isNaN(start.getTime())
        ? toDateTimeInput(new Date(start.getTime() + cadence * DAY))
        : prev.endDate
    };
  });

  const submitCreate = async () => {
    if (!createForm.name.trim() || !selectedBoard) return;
    setCreating(true);
    try {
      const data = await jiraAuthService.apiCall('create-sprint', {
        boardId: selectedBoard.id,
        name: createForm.name.trim(),
        startDate: fromDateTimeInput(createForm.startDate),
        endDate: fromDateTimeInput(createForm.endDate),
        goal: createForm.goal
      });
      const created = data.sprint;
      setSprints(prev => [...prev, created]);
      setIssuesByColumn(prev => ({ ...prev, [created.id]: [] }));
      setCreateOpen(false);
      say(`${created.name} created`);
    } catch (err) {
      say(`Could not create the sprint: ${err.message}`, 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleColumnAction = (action, column) => {
    if (action === 'refresh') { loadColumn(column.id); return; }
    const start = column.startDate ? new Date(column.startDate) : new Date();
    const end = column.endDate
      ? new Date(column.endDate)
      : new Date(start.getTime() + inferCadenceDays(sprints) * DAY);
    setStateDialog({
      action,
      sprint: column,
      startDate: toDateTimeInput(start),
      endDate: toDateTimeInput(end)
    });
  };

  const submitStateChange = async () => {
    if (!stateDialog) return;
    const { action, sprint, startDate, endDate } = stateDialog;
    setStateBusy(true);
    try {
      const data = await jiraAuthService.apiCall('sprint-state', {
        sprintId: sprint.id,
        state: action === 'start' ? 'active' : 'closed',
        // Jira insists on both dates to start a sprint, and ignores them on completion
        startDate: action === 'start' ? fromDateTimeInput(startDate) : undefined,
        endDate: action === 'start' ? fromDateTimeInput(endDate) : undefined
      });
      const updated = data.sprint;
      setSprints(prev => prev
        .map(s => (s.id === updated.id ? { ...s, ...updated } : s))
        // A completed sprint leaves the board unless closed ones are being shown
        .filter(s => showClosed || s.state !== 'closed'));
      setStateDialog(null);
      say(action === 'start' ? `${updated.name} started` : `${updated.name} completed`);
      // Completing a sprint sends its unfinished issues to the backlog
      if (action === 'complete') loadColumn(BACKLOG);
    } catch (err) {
      say(`Could not ${action} the sprint: ${err.message}`, 'error');
    } finally {
      setStateBusy(false);
    }
  };

  // --- Render ------------------------------------------------------------------------

  // What the dialog worked out, in words, so a wrong guess is obvious rather than silent
  const planSummary = !plan
    ? ''
    : plan.follows
      ? `Follows ${plan.follows}, picking up the day it ends, on this board's ${plan.cadenceDays}-day cycle.`
      : plan.cadenceAssumed
        ? 'Nothing dated on this board to learn from yet, so this assumes a two-week cycle.'
        : `This board runs ${plan.cadenceDays}-day sprints. The last one has already ended, so this starts on the next ${plan.start.toLocaleDateString(undefined, { weekday: 'long' })}.`;

  const sprintLength = useMemo(() => {
    const start = createForm.startDate ? new Date(createForm.startDate) : null;
    const end = createForm.endDate ? new Date(createForm.endDate) : null;
    if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return null;
    return Math.round((end - start) / DAY);
  }, [createForm.startDate, createForm.endDate]);

  // Everyone who actually holds an issue on this board, which is a shorter and more useful
  // list than the project's assignable users — with Unassigned first, since that is the
  // pile planning is usually trying to empty.
  const assigneeOptions = useMemo(() => {
    const seen = new Map();
    Object.values(issuesByColumn).flat().forEach(row => {
      const key = row.assignee || '';
      if (!seen.has(key)) seen.set(key, { key, name: key ? (row.assigneeName || key) : 'Unassigned' });
    });
    return [...seen.values()].sort((a, b) => {
      if (a.key === '') return -1;
      if (b.key === '') return 1;
      return a.name.localeCompare(b.name);
    });
  }, [issuesByColumn]);

  const matches = useCallback(row => {
    if (assigneeFilter.length > 0 && !assigneeFilter.some(person => person.key === (row.assignee || ''))) {
      return false;
    }
    const needle = filter.trim().toLowerCase();
    if (!needle) return true;
    return [row.issue, row.summary, row.assigneeName, row.epicLink, row.labels]
      .some(value => String(value || '').toLowerCase().includes(needle));
  }, [filter, assigneeFilter]);

  const draggingRow = useMemo(() => {
    if (!dragging) return null;
    return Object.values(issuesByColumn).flat().find(r => r.issue === dragging) || null;
  }, [dragging, issuesByColumn]);

  if (isValidating) {
    return <Box sx={{ p: 4, textAlign: 'center' }}><CircularProgress /></Box>;
  }

  if (!isAuthenticated) {
    return (
      <Alert
        severity="info"
        sx={{ maxWidth: 640 }}
        action={<Button color="inherit" size="small" onClick={openConnections}>Connect</Button>}
      >
        Connect to Jira to plan sprints.
      </Alert>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 110px)' }}>
      {/* What the board is showing, and what can be done to it */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1.5 }}>
        <Autocomplete
          size="small"
          sx={{ width: 240 }}
          options={projects}
          value={selectedProject}
          getOptionLabel={option => (option ? `${option.key} — ${option.name}` : '')}
          isOptionEqualToValue={(option, value) => option.key === value.key}
          onChange={(e, value) => {
            setSelectedProject(value);
            try {
              if (value) localStorage.setItem(PROJECT_KEY, value.key);
              else localStorage.removeItem(PROJECT_KEY);
            } catch (err) { /* the choice just will not persist */ }
          }}
          renderInput={params => <TextField {...params} label="Project" />}
        />
        <Autocomplete
          size="small"
          sx={{ width: 220 }}
          options={boards}
          value={selectedBoard}
          disabled={!selectedProject}
          getOptionLabel={option => (option ? option.name : '')}
          isOptionEqualToValue={(option, value) => option.id === value.id}
          onChange={(e, value) => {
            setSelectedBoard(value);
            setIssuesByColumn({});
            try {
              if (value) localStorage.setItem(BOARD_KEY, String(value.id));
              else localStorage.removeItem(BOARD_KEY);
            } catch (err) { /* the choice just will not persist */ }
          }}
          renderInput={params => <TextField {...params} label="Board" />}
        />
        <TextField
          size="small"
          placeholder="Filter issues"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          sx={{ width: 200 }}
          InputProps={{
            startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>
          }}
        />
        <Autocomplete
          multiple
          size="small"
          sx={{ minWidth: 230, maxWidth: 380 }}
          options={assigneeOptions}
          value={assigneeFilter}
          limitTags={1}
          getOptionLabel={option => option.name}
          isOptionEqualToValue={(option, value) => option.key === value.key}
          onChange={(e, value) => setAssigneeFilter(value)}
          renderInput={params => <TextField {...params} label="Assignee" placeholder={assigneeFilter.length ? '' : 'Anyone'} />}
        />
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={showClosed}
              onChange={e => {
                setShowClosed(e.target.checked);
                try { localStorage.setItem(CLOSED_KEY, e.target.checked ? '1' : '0'); } catch (err) { /* not persisted */ }
              }}
            />
          }
          label={<Typography variant="body2">Closed sprints</Typography>}
        />
        <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1 }}>
          {/* The same sprints either way: buckets to plan by dragging, a list to read down */}
          <ToggleButtonGroup
            exclusive
            size="small"
            color="primary"
            value={view}
            onChange={(e, value) => {
              if (!value) return;
              setView(value);
              try { localStorage.setItem(VIEW_KEY, value); } catch (err) { /* the choice just will not persist */ }
            }}
          >
            <ToggleButton value="board" aria-label="Board view">
              <Tooltip title="Board"><BoardViewIcon fontSize="small" /></Tooltip>
            </ToggleButton>
            <ToggleButton value="list" aria-label="List view">
              <Tooltip title="List"><ListViewIcon fontSize="small" /></Tooltip>
            </ToggleButton>
          </ToggleButtonGroup>
          <Button size="small" startIcon={<RefreshIcon />} onClick={refreshAll} disabled={!selectedBoard}>
            Refresh
          </Button>
          <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={openCreate} disabled={!selectedBoard}>
            Create sprint
          </Button>
        </Box>
      </Box>

      {!selectedBoard && !sprintsLoading && (
        <Alert severity="info">Pick a project and board to see its sprints.</Alert>
      )}

      {selectedBoard && view === 'list' && (
        <IssueList
          columns={columns}
          issuesByColumn={issuesByColumn}
          loadingColumns={loadingColumns}
          matches={matches}
          onPeek={openPeek}
          peekKey={peek ? peek.row.issue : null}
          onMove={moveIssue}
          collapsed={collapsed}
          onToggleSection={id => setCollapsed(prev => ({ ...prev, [id]: !prev[id] }))}
          onAction={handleColumnAction}
        />
      )}

      {selectedBoard && view === 'board' && (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCorners}
          onDragStart={({ active }) => setDragging(active.id)}
          onDragCancel={() => setDragging(null)}
          onDragEnd={handleDragEnd}
        >
          <Box sx={{ flex: 1, minHeight: 0, display: 'flex', gap: 1.5, overflowX: 'auto', pb: 1 }}>
            {sprintsLoading && columns.length <= 1 && [0, 1, 2].map(i => (
              <Skeleton key={i} variant="rounded" width={310} sx={{ minWidth: 310 }} />
            ))}
            {columns.map(column => (
              <SprintColumn
                key={column.id}
                column={column}
                rows={issuesByColumn[column.id]}
                filtered={(issuesByColumn[column.id] || []).filter(matches)}
                loading={Boolean(loadingColumns[column.id])}
                onPeek={openPeek}
                peekKey={peek ? peek.row.issue : null}
                onAction={handleColumnAction}
              />
            ))}
          </Box>
          {/* The card rides the cursor rather than the column's own copy, so it stays
              visible once it has left the column it started in */}
          <DragOverlay>
            {draggingRow ? (
              <Paper elevation={6} sx={{ p: 1.25, width: 285, cursor: 'grabbing', transform: 'rotate(1.5deg)' }}>
                <Typography variant="caption" sx={{ fontWeight: 700, color: 'text.secondary' }}>
                  {draggingRow.issue}
                </Typography>
                <Typography variant="body2" sx={{ lineHeight: 1.35 }}>{draggingRow.summary}</Typography>
              </Paper>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {/* The peek: the issue in full, beside the board rather than instead of it */}
      <Drawer
        anchor="right"
        open={Boolean(peek)}
        onClose={closePeek}
        slotProps={{ paper: { sx: { width: { xs: '100%', sm: 560 }, display: 'flex', flexDirection: 'column' } } }}
      >
        {peek && draft && (
          <>
            <Box sx={{ p: 2, pb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
              {peek.row.issueTypeIcon && (
                <Box component="img" src={peek.row.issueTypeIcon} alt={peek.row.issueType} sx={{ width: 16, height: 16 }} />
              )}
              <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>{peek.row.issue}</Typography>
              {peek.row.status && (
                <Chip
                  size="small"
                  label={peek.row.status}
                  sx={{
                    height: 20,
                    border: '1px solid',
                    borderColor: CATEGORY_COLOR[peek.row.statusCategory] || 'divider',
                    color: CATEGORY_COLOR[peek.row.statusCategory] || 'text.secondary',
                    bgcolor: 'transparent',
                    '& .MuiChip-label': { fontSize: 11, px: 0.75 }
                  }}
                />
              )}
              <Box sx={{ ml: 'auto', display: 'flex', gap: 0.5 }}>
                <Tooltip title="Open in Jira">
                  <IconButton size="small" component="a" href={peek.row.url} target="_blank" rel="noreferrer">
                    <OpenInNewIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <IconButton size="small" onClick={closePeek}><CloseIcon fontSize="small" /></IconButton>
              </Box>
            </Box>
            <Divider />
            <Box sx={{ flex: 1, overflowY: 'auto', p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <TextField
                label="Summary"
                size="small"
                fullWidth
                multiline
                value={draft.summary}
                onChange={e => setDraft(prev => ({ ...prev, summary: e.target.value }))}
              />
              <Box sx={{ display: 'flex', gap: 1.5 }}>
                <TextField
                  select
                  label="Sprint"
                  size="small"
                  sx={{ flex: 1 }}
                  value={peek.columnId}
                  // Moving is its own call, so it happens on the spot rather than on save
                  onChange={e => moveIssue(peek.row.issue, peek.columnId, e.target.value)}
                >
                  {columns.map(column => (
                    <MenuItem key={column.id} value={column.id}>{column.name}</MenuItem>
                  ))}
                </TextField>
                <TextField
                  label="Points"
                  size="small"
                  type="number"
                  sx={{ width: 100 }}
                  value={draft.storyPoints}
                  onChange={e => setDraft(prev => ({ ...prev, storyPoints: e.target.value }))}
                />
              </Box>
              <Autocomplete
                size="small"
                options={assignees}
                value={draft.assignee ? { key: draft.assignee, name: draft.assigneeName || draft.assignee } : null}
                getOptionLabel={option => (option ? option.name : '')}
                isOptionEqualToValue={(option, value) => option.key === value.key}
                onChange={(e, value) => setDraft(prev => ({
                  ...prev,
                  assignee: value ? value.key : '',
                  assigneeName: value ? value.name : ''
                }))}
                renderInput={params => <TextField {...params} label="Assignee" />}
              />
              <TextField
                label="Labels"
                size="small"
                fullWidth
                value={draft.labels}
                onChange={e => setDraft(prev => ({ ...prev, labels: e.target.value }))}
                helperText="Comma separated"
              />
              {peek.row.epicLink && (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Typography variant="body2" color="text.secondary">Epic</Typography>
                  <Chip size="small" label={peek.row.epicLink} />
                </Box>
              )}
              <Box>
                <Box sx={{ display: 'flex', alignItems: 'center', mb: 0.75 }}>
                  <Typography variant="subtitle2" sx={{ flex: 1 }}>Description</Typography>
                  {/* Jira stores wiki markup, which has no editor of its own — so write it
                      as text and preview it through the same converter the grid uses */}
                  <ToggleButtonGroup
                    exclusive
                    size="small"
                    color="primary"
                    value={descPreview}
                    onChange={(e, value) => value && setDescPreview(value)}
                    sx={{ '& .MuiToggleButton-root': { px: 1, py: 0.25, fontSize: 12 } }}
                  >
                    <ToggleButton value="edit">Write</ToggleButton>
                    <ToggleButton value="preview">Preview</ToggleButton>
                  </ToggleButtonGroup>
                </Box>
                {descPreview === 'edit' ? (
                  <TextField
                    multiline
                    fullWidth
                    minRows={10}
                    size="small"
                    value={draft.description}
                    onChange={e => setDraft(prev => ({ ...prev, description: e.target.value }))}
                    InputProps={{ sx: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 } }}
                  />
                ) : (
                  <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5, minHeight: 200 }}>
                    {draft.description
                      ? <MDEditor.Markdown source={jiraToMarkdown(draft.description)} style={{ backgroundColor: 'transparent' }} />
                      : <Typography variant="body2" color="text.disabled">No description.</Typography>}
                  </Box>
                )}
              </Box>
            </Box>
            <Divider />
            <Box sx={{ p: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>
                {peekDirty ? 'Unsaved changes' : 'Up to date with Jira'}
              </Typography>
              <Button size="small" onClick={() => openPeek(peek.row, peek.columnId)} disabled={!peekDirty || saving}>
                Discard
              </Button>
              <Button
                size="small"
                variant="contained"
                onClick={savePeek}
                disabled={!peekDirty || saving}
                startIcon={saving ? <CircularProgress size={14} /> : null}
              >
                Save to Jira
              </Button>
            </Box>
          </>
        )}
      </Drawer>

      {/* Create a sprint on this board */}
      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Create sprint{selectedBoard ? ` on ${selectedBoard.name}` : ''}</DialogTitle>
        <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 2 }}>
          <TextField
            label="Sprint name"
            size="small"
            fullWidth
            autoFocus
            value={createForm.name}
            onChange={e => setCreateForm(prev => ({ ...prev, name: e.target.value }))}
          />
          <Box sx={{ display: 'flex', gap: 2 }}>
            <TextField
              label="Start"
              type="datetime-local"
              size="small"
              sx={{ flex: 1 }}
              InputLabelProps={{ shrink: true }}
              value={createForm.startDate}
              onChange={e => setCreateStart(e.target.value)}
            />
            <TextField
              label="End"
              type="datetime-local"
              size="small"
              sx={{ flex: 1 }}
              InputLabelProps={{ shrink: true }}
              helperText={sprintLength ? `${sprintLength} days` : ' '}
              value={createForm.endDate}
              onChange={e => setCreateForm(prev => ({ ...prev, endDate: e.target.value }))}
            />
          </Box>
          <TextField
            label="Goal"
            size="small"
            fullWidth
            multiline
            minRows={2}
            value={createForm.goal}
            onChange={e => setCreateForm(prev => ({ ...prev, goal: e.target.value }))}
          />
          <Alert severity="info" icon={<AutoAwesomeIcon fontSize="small" />} sx={{ py: 0.5 }}>
            <Typography variant="caption">
              {planSummary} The sprint is created in the future state — dates are a plan until you
              start it.
            </Typography>
          </Alert>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={submitCreate}
            disabled={!createForm.name.trim() || creating}
            startIcon={creating ? <CircularProgress size={14} /> : null}
          >
            Create
          </Button>
        </DialogActions>
      </Dialog>

      {/* Start or complete a sprint */}
      <Dialog open={Boolean(stateDialog)} onClose={() => setStateDialog(null)} maxWidth="xs" fullWidth>
        {stateDialog && (
          <>
            <DialogTitle>
              {stateDialog.action === 'start' ? 'Start' : 'Complete'} {stateDialog.sprint.name}
            </DialogTitle>
            <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 2 }}>
              {stateDialog.action === 'start' ? (
                <>
                  <Typography variant="body2" color="text.secondary">
                    Jira needs both dates to start a sprint.
                  </Typography>
                  <TextField
                    label="Start"
                    type="datetime-local"
                    size="small"
                    InputLabelProps={{ shrink: true }}
                    value={stateDialog.startDate}
                    onChange={e => setStateDialog(prev => ({ ...prev, startDate: e.target.value }))}
                  />
                  <TextField
                    label="End"
                    type="datetime-local"
                    size="small"
                    InputLabelProps={{ shrink: true }}
                    value={stateDialog.endDate}
                    onChange={e => setStateDialog(prev => ({ ...prev, endDate: e.target.value }))}
                  />
                </>
              ) : (
                <Typography variant="body2">
                  Completing the sprint closes it in Jira. Anything still unfinished goes back to
                  the backlog, where you can plan it into the next one.
                </Typography>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setStateDialog(null)}>Cancel</Button>
              <Button
                variant="contained"
                onClick={submitStateChange}
                disabled={stateBusy}
                startIcon={stateBusy ? <CircularProgress size={14} /> : null}
              >
                {stateDialog.action === 'start' ? 'Start sprint' : 'Complete sprint'}
              </Button>
            </DialogActions>
          </>
        )}
      </Dialog>

      <Snackbar
        open={Boolean(notice)}
        autoHideDuration={notice && notice.severity === 'error' ? 8000 : 3500}
        onClose={() => setNotice(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        {notice ? (
          <Alert severity={notice.severity} onClose={() => setNotice(null)} variant="filled">
            {notice.message}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}
