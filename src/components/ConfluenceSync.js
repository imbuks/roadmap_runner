import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Autocomplete,
  Box,
  Paper,
  Typography,
  Button,
  TextField,
  FormControlLabel,
  Checkbox,
  Chip,
  Alert,
  CircularProgress,
  Tooltip,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions,
  Drawer,
  IconButton,
  Menu,
  MenuItem,
  Divider,
  Switch,
  Link
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  FolderOpen as FolderOpenIcon,
  Visibility as PreviewIcon,
  CloudUpload as PublishIcon,
  Stop as StopIcon,
  Close as CloseIcon,
  NavigateBefore as PrevIcon,
  NavigateNext as NextIcon,
  ArrowDropDown as ArrowDropDownIcon
} from '@mui/icons-material';
import { DataGrid } from '@mui/x-data-grid';
import confluenceService, { parsePageId } from '../utils/confluenceApi';
import useConfluenceAuth from '../hooks/useConfluenceAuth';
import { openConnections } from './Connections';
import { readLocalBundle, renderStorage, descendantsOf } from '../utils/confluenceBundle';

/*
 * Publish a Confluence page bundle — the same bundle cst-confluence-sync's
 * push_to_confluence.py publishes, with the same safety rules: preview first, never take
 * over a page this sync did not create unless told to, and only write what changed.
 */

const POLL_MS = 800;

// What a page's result is called before and after the fact
const ACTIONS = {
  create: { preview: 'Will create', done: 'Created', color: 'success' },
  update: { preview: 'Will update', done: 'Updated', color: 'info' },
  unchanged: { preview: 'Unchanged', done: 'Unchanged', color: 'default' },
  clash: { preview: 'Clash', done: 'Clash', color: 'error' },
  failed: { preview: 'Failed', done: 'Failed', color: 'error' },
  blocked: { preview: 'Needs its parent', done: 'Needs its parent', color: 'warning' }
};

const LOG_COLORS = { error: 'error.main', warn: 'warning.main', change: 'text.primary', info: 'text.secondary' };

const formatBytes = n => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

function selectedKeys(model, rows) {
  if (!model) return [];
  const ids = model.ids || new Set();
  if (model.type === 'exclude') return rows.filter(r => !ids.has(r.id)).map(r => r.id);
  return rows.filter(r => ids.has(r.id)).map(r => r.id);
}

function Section({ title, children, action }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center' }}>
        <Typography variant="subtitle2" sx={{ flex: 1 }}>{title}</Typography>
        {action}
      </Box>
      {children}
    </Paper>
  );
}

/* --- Parent page picker ------------------------------------------------------------ */

const SEARCH_DELAY_MS = 250;

/*
 * Search the space for the page to publish under, rather than typing its title exactly.
 * Choosing a result sets the parent by ID, so the title never has to match. Anything else
 * typed in — an ID, a link, a title — still goes through as before, resolved by the
 * server when the field is left.
 */
function ParentPagePicker({ target, connected, onChange, onCommit }) {
  const space = target.space.trim();
  const shown = target.parentTitle || target.parentId;
  const [input, setInput] = useState(shown);
  const [options, setOptions] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState('');

  // Follow changes made elsewhere (a restored target, a cleared field)
  useEffect(() => { setInput(shown); }, [shown]);

  // With a chosen page showing, opening the list shows the space's recent pages rather
  // than searching for the chosen page's own title
  const query = input === target.parentTitle ? '' : input;
  const canSearch = connected && /^[A-Za-z0-9~_-]+$/.test(space);

  useEffect(() => {
    if (!open || !canSearch) {
      setOptions([]);
      return undefined;
    }
    let stale = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const pages = await confluenceService.searchPages(space, query.trim());
        if (!stale) {
          setOptions(pages);
          setSearchError('');
        }
      } catch (err) {
        if (!stale) {
          setOptions([]);
          setSearchError(err.message);
        }
      } finally {
        if (!stale) setLoading(false);
      }
    }, SEARCH_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, canSearch, space, query]);

  // freeSolo (which lets an ID or a link be pasted) never shows the list's own "no
  // options" or "loading" text, so with nothing to offer the list carries one greyed-out
  // line saying why
  const message = loading ? 'Searching…'
    : !connected ? 'Connect to Confluence to search its pages.'
      : !space ? 'Enter the space key first.'
        : searchError || (query.trim() ? `No pages in ${space} match "${query.trim()}".` : `No pages in ${space}.`);
  const listed = options.length ? options : [{ id: '__message', title: '', message }];

  const choose = page => {
    setInput(page.title);
    onCommit(onChange({ parentId: page.id, parentTitle: page.title }));
  };

  return (
    <Autocomplete
      freeSolo
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      options={listed}
      getOptionDisabled={option => !!option.message}
      // The server has already matched; filtering again here would hide results whose
      // match was not on the visible title, like a page found by its ID
      filterOptions={x => x}
      getOptionLabel={option => (typeof option === 'string' ? option : option.title)}
      isOptionEqualToValue={(option, value) => option.id === value.id}
      value={null}
      inputValue={input}
      onInputChange={(event, value, reason) => {
        // 'reset' is the component echoing a choice back; choose() has already set it
        if (reason === 'input') {
          setInput(value);
          onChange({ parentId: value, parentTitle: '' });
        } else if (reason === 'clear') {
          setInput('');
          onCommit(onChange({ parentId: '', parentTitle: '' }));
        }
      }}
      onChange={(event, option) => {
        if (option && typeof option === 'object' && !option.message) choose(option);
        // Enter on typed text: take it as it is (an ID, a link or a title)
        else if (typeof option === 'string') onCommit(onChange({ parentId: parsePageId(option), parentTitle: '' }));
      }}
      renderOption={(props, option) => {
        const { key, ...rest } = props;
        if (option.message) {
          return (
            <li key={option.id} {...rest}>
              <Typography variant="body2" color="text.secondary">{option.message}</Typography>
            </li>
          );
        }
        return (
          <li key={option.id} {...rest}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" noWrap>{option.title}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap component="div">
                {option.path.length ? option.path.slice(-3).join(' › ') : 'Top of the space'}
              </Typography>
            </Box>
          </li>
        );
      }}
      renderInput={params => (
        <TextField
          {...params}
          label="Parent page (optional)"
          size="small"
          placeholder={canSearch ? 'Search this space…' : 'Page title, ID, or link'}
          helperText="The bundle's home page sits under this page. Search for it, or paste its ID or link. Leave blank for the top of the space."
          // The input calls the Autocomplete's own blur handler as well as this one
          onBlur={() => {
            // Typed rather than chosen: resolve what is there
            if (!target.parentTitle) onCommit(onChange({ parentId: parsePageId(input), parentTitle: '' }));
          }}
          InputProps={{
            ...params.InputProps,
            endAdornment: (
              <>
                {loading && open ? <CircularProgress size={16} /> : null}
                {params.InputProps.endAdornment}
              </>
            )
          }}
        />
      )}
    />
  );
}

/* --- Page preview ------------------------------------------------------------------ */

// How Confluence's macros look in the preview (see renderStorage for what each one is)
const previewStyles = {
  fontSize: 14,
  lineHeight: 1.6,
  color: 'text.primary',
  '& h1, & h2, & h3, & h4': { mt: 2.5, mb: 1, lineHeight: 1.3 },
  '& h1': { fontSize: 22 }, '& h2': { fontSize: 19 }, '& h3': { fontSize: 16 }, '& h4': { fontSize: 14 },
  '& p': { my: 1 },
  '& ul, & ol': { pl: 3, my: 1 },
  '& table': { borderCollapse: 'collapse', width: '100%', my: 1.5, fontSize: 13 },
  '& th, & td': { border: '1px solid', borderColor: 'divider', p: '6px 8px', verticalAlign: 'top', textAlign: 'left' },
  '& th': { bgcolor: 'background.default', fontWeight: 600, width: { md: 170 } },
  '& .cf-callout': { borderLeft: '4px solid', borderRadius: 1, p: 1.5, my: 1.5, '& > :first-of-type': { mt: 0 }, '& > :last-child': { mb: 0 } },
  '& .cf-callout-title': { display: 'block', mb: 0.5 },
  '& .cf-info': { borderColor: 'info.main', bgcolor: 'rgba(11, 102, 228, 0.06)' },
  '& .cf-note': { borderColor: 'warning.main', bgcolor: 'rgba(229, 105, 16, 0.07)' },
  '& .cf-tip': { borderColor: 'success.main', bgcolor: 'rgba(34, 160, 107, 0.07)' },
  '& .cf-warning': { borderColor: 'error.main', bgcolor: 'rgba(201, 55, 44, 0.06)' },
  '& .cf-panel': { borderColor: 'divider' },
  '& .cf-properties': { my: 1.5 },
  '& details.cf-expand': { border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1, my: 1.5 },
  '& details.cf-expand > summary': { cursor: 'pointer', fontWeight: 600, color: 'primary.main' },
  '& pre': { bgcolor: 'background.default', borderRadius: 1, p: 1.5, overflow: 'auto', fontSize: 12 },
  '& .cf-image': { maxWidth: '100%', border: '1px solid', borderColor: 'divider', borderRadius: 1, my: 1 },
  '& .cf-macro': { border: '1px dashed', borderColor: 'divider', borderRadius: 1, p: 1.25, my: 1.5 },
  '& .cf-macro-name': { display: 'block', fontSize: 12, color: 'text.secondary', fontStyle: 'italic' },
  '& .cf-link': { color: 'primary.main', textDecoration: 'none', '&:hover': { textDecoration: 'underline' } },
  '& .cf-link-outside': { borderBottom: '1px dotted', borderColor: 'text.secondary' },
  '& .cf-status': { display: 'inline-block', px: 0.75, borderRadius: 0.5, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', bgcolor: 'rgba(9, 30, 66, 0.08)' },
  '& .cf-status-green': { bgcolor: 'rgba(34, 160, 107, 0.15)' },
  '& .cf-status-red': { bgcolor: 'rgba(201, 55, 44, 0.15)' },
  '& .cf-status-yellow': { bgcolor: 'rgba(229, 105, 16, 0.15)' },
  '& .cf-status-blue': { bgcolor: 'rgba(11, 102, 228, 0.15)' }
};

/*
 * One page of the bundle, roughly as Confluence will draw it, read straight from the
 * chosen folder. Links to other pages in the bundle open those pages here, so the bundle
 * can be read through before any of it is sent.
 */
function PagePreview({ bundle, pageKey, titleIndex, imageUrl, selected, locked, onToggle, onNavigate, onClose }) {
  const index = pageKey ? bundle.pages.findIndex(p => p.key === pageKey) : -1;
  const page = index >= 0 ? bundle.pages[index] : null;
  const [html, setHtml] = useState(null);
  const [error, setError] = useState('');
  const scroller = useRef(null);

  useEffect(() => {
    if (!page) return undefined;
    let stale = false;
    setHtml(null);
    setError('');
    const file = bundle.files.get(page.body);
    if (!file) {
      setError(`${page.body} is not in the folder.`);
      return undefined;
    }
    file.text()
      .then(storage => {
        if (stale) return;
        setHtml(renderStorage(storage, {
          imageUrl: name => imageUrl(page, name),
          pageKeyForTitle: title => titleIndex.get(title) || null
        }));
        if (scroller.current) scroller.current.scrollTop = 0;
      })
      .catch(err => { if (!stale) setError(`Could not read ${page.body}: ${err.message}`); });
    return () => { stale = true; };
  }, [page, bundle, titleIndex, imageUrl]);

  if (!page) return <Drawer anchor="right" open={false} onClose={onClose} />;

  const byKey = new Map(bundle.pages.map(p => [p.key, p]));
  const trail = [];
  for (let up = page.parent && byKey.get(page.parent); up; up = up.parent && byKey.get(up.parent)) trail.unshift(up);
  const prev = bundle.pages[index - 1];
  const next = bundle.pages[index + 1];

  return (
    <Drawer anchor="right" open onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', md: 780 }, display: 'flex', flexDirection: 'column' } }}>
      <Box sx={{ px: 2.5, pt: 2, pb: 1.5, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1, minWidth: 0 }} noWrap>
            {trail.length ? trail.map((t, i) => (
              <React.Fragment key={t.key}>
                {i > 0 && ' › '}
                <Link component="button" type="button" variant="caption" color="inherit" onClick={() => onNavigate(t.key)}>{t.title}</Link>
              </React.Fragment>
            )) : 'Top of the bundle'}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ mx: 1 }}>{index + 1} of {bundle.pages.length}</Typography>
          <Tooltip title={prev ? prev.title : ''}><span><IconButton size="small" disabled={!prev} onClick={() => onNavigate(prev.key)} aria-label="Previous page"><PrevIcon /></IconButton></span></Tooltip>
          <Tooltip title={next ? next.title : ''}><span><IconButton size="small" disabled={!next} onClick={() => onNavigate(next.key)} aria-label="Next page"><NextIcon /></IconButton></span></Tooltip>
          <IconButton size="small" onClick={onClose} aria-label="Close preview"><CloseIcon /></IconButton>
        </Box>
        <Typography variant="h6" sx={{ lineHeight: 1.3 }}>{page.title}</Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap', mt: 1 }}>
          <FormControlLabel
            sx={{ mr: 1 }}
            control={<Switch size="small" checked={selected} disabled={locked} onChange={e => onToggle(page.key, e.target.checked)} />}
            label={<Typography variant="body2">{selected ? 'Included in the sync' : 'Left out of the sync'}</Typography>}
          />
          <Chip size="small" variant="outlined" label={page.key} />
          {page.labels.map(l => <Chip key={l} size="small" label={l} />)}
        </Box>
      </Box>
      <Box ref={scroller} sx={{ flex: 1, overflow: 'auto', px: 2.5, py: 2 }}>
        {error && <Alert severity="error">{error}</Alert>}
        {!error && html === null && <CircularProgress size={20} />}
        {html !== null && (
          <Box
            sx={previewStyles}
            // Built by renderStorage from an allowlist of tags, attributes and URLs
            dangerouslySetInnerHTML={{ __html: html }}
            onClick={event => {
              const target = event.target.closest('[data-page-key]');
              if (target) {
                event.preventDefault();
                onNavigate(target.getAttribute('data-page-key'));
              }
            }}
          />
        )}
      </Box>
    </Drawer>
  );
}

/* --- Connection status ----------------------------------------------------------- */

// Signing in happens in the app-wide Connections dialog; this only says where things stand
function ConnectionPanel({ confluence }) {
  const { state, user, baseUrl, authType } = confluence;
  return (
    <Section
      title="Confluence"
      action={<Button size="small" onClick={openConnections}>{state === 'connected' ? 'Manage' : 'Connect'}</Button>}
    >
      {state === 'unknown' ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={18} />
          <Typography variant="body2" color="text.secondary">Checking your Confluence connection…</Typography>
        </Box>
      ) : state === 'connected' ? (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CheckCircleIcon color="success" fontSize="small" />
            <Typography variant="body2">
              {user ? <>Signed in as <strong>{user}</strong></> : 'Signed in'}
            </Typography>
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
            {baseUrl}
            {authType === 'sso' ? ' · browser sign-in' : authType === 'basic' ? ' · username & password' : ' · personal access token'}
          </Typography>
        </>
      ) : (
        <Typography variant="body2" color="text.secondary">
          Not connected. Connect with your Confluence Personal Access Token to publish.
        </Typography>
      )}
    </Section>
  );
}

/* --- The page ------------------------------------------------------------------------ */

export default function ConfluenceSync() {
  const confluence = useConfluenceAuth();
  const connected = confluence.state === 'connected';
  const validating = confluence.state === 'unknown';

  const [target, setTarget] = useState(confluenceService.getTarget());
  const [targetInfo, setTargetInfo] = useState(null);
  const [targetError, setTargetError] = useState('');
  const [checkingTarget, setCheckingTarget] = useState(false);

  // The bundle as read in the browser (readLocalBundle). It reaches the server only when
  // a preview or publish needs it; `sent` remembers which bundle the server has, and as
  // what id, so it goes once per folder rather than once per run.
  const [bundle, setBundle] = useState(null);
  const [bundleError, setBundleError] = useState('');
  const [reading, setReading] = useState(false);
  const [sending, setSending] = useState(false);
  const sent = useRef(null); // { bundle, bundleId }
  const folderInput = useRef(null);
  const [previewKey, setPreviewKey] = useState(null);
  const [selectMenu, setSelectMenu] = useState(null);
  // The images a preview shows, as object URLs made once per file and let go with the bundle
  const imageUrls = useRef(new Map());

  const [options, setOptions] = useState({ force: false, adoptExisting: false, trashOrphans: false });
  const [selection, setSelection] = useState({ type: 'include', ids: new Set() });

  const [job, setJob] = useState(null);       // the latest status snapshot
  const [log, setLog] = useState([]);
  const [startError, setStartError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  // What the last finished preview covered, so Publish can say whether it is up to date
  const [lastPreview, setLastPreview] = useState(null);
  const logBox = useRef(null);
  const logLength = useRef(0);

  // The folder picker attribute is non-standard, so React does not pass it through
  useEffect(() => {
    if (folderInput.current) {
      folderInput.current.setAttribute('webkitdirectory', '');
      folderInput.current.setAttribute('directory', '');
    }
  }, []);

  // What the summary below the fields describes, so leaving a field without changing it
  // does not ask again
  const checkedTarget = useRef(null);

  const checkTarget = useCallback(async (next = target) => {
    if (!next.space.trim()) {
      checkedTarget.current = null;
      setTargetInfo(null);
      setTargetError('');
      return;
    }
    const key = `${next.space.trim()}|${next.parentId.trim()}`;
    if (key === checkedTarget.current) return;
    checkedTarget.current = key;
    setCheckingTarget(true);
    setTargetError('');
    try {
      const info = await confluenceService.checkTarget(next.space.trim(), next.parentId.trim());
      setTargetInfo(info);
      // Whatever was typed — an ID, a link, a title — is from now on the page it named:
      // kept by ID, shown by its real title, as if it had been picked from the list. Only
      // if the field has not moved on while Confluence was being asked.
      const { parent } = info;
      if (parent && (next.parentId.trim() !== parent.id || next.parentTitle !== parent.title)) {
        setTarget(prev => {
          if (prev.space !== next.space || prev.parentId !== next.parentId) return prev;
          const resolved = { ...prev, parentId: parent.id, parentTitle: parent.title };
          confluenceService.setTarget(resolved);
          return resolved;
        });
        checkedTarget.current = `${next.space.trim()}|${parent.id}`;
      }
    } catch (err) {
      checkedTarget.current = null; // worth asking again
      setTargetInfo(null);
      setTargetError(err.message);
    } finally {
      setCheckingTarget(false);
    }
  }, [target]);

  // Check where the bundle would go as soon as there is a session to ask with
  useEffect(() => {
    if (connected && target.space) checkTarget();
    // Only on connecting; edits are checked as each field is left
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const updateTarget = patch => {
    const next = { ...target, ...patch };
    setTarget(next);
    confluenceService.setTarget(next);
    return next;
  };

  const pickFolder = async event => {
    // Copied out first: the FileList is live, and clearing the input empties it
    const files = Array.from(event.target.files || []);
    event.target.value = ''; // so picking the same folder again still fires
    if (!files.length) return;
    setReading(true);
    setBundleError('');
    try {
      const local = await readLocalBundle(files);
      imageUrls.current.forEach(url => URL.revokeObjectURL(url));
      imageUrls.current = new Map();
      sent.current = null;
      setBundle({ ...local, version: Date.now() });
      // Everything to start with; the selection is what gets published
      setSelection({ type: 'include', ids: new Set(local.pages.map(p => p.key)) });
      setPreviewKey(null);
      setLastPreview(null);
      setJob(null);
      setLog([]);
    } catch (err) {
      setBundleError(err.message);
    } finally {
      setReading(false);
    }
  };

  useEffect(() => () => imageUrls.current.forEach(url => URL.revokeObjectURL(url)), []);

  // A page's image, by the attachment name its body uses. Confluence looks among the
  // page's own attachments, so that is where this looks first.
  const imageUrl = useCallback((page, name) => {
    if (!bundle) return null;
    const path = page.attachments.find(a => a.split('/').pop() === name)
      || [...bundle.files.keys()].find(k => k.split('/').pop() === name);
    const file = path && bundle.files.get(path);
    if (!file) return null;
    if (!imageUrls.current.has(path)) imageUrls.current.set(path, URL.createObjectURL(file));
    return imageUrls.current.get(path);
  }, [bundle]);

  const titleIndex = useMemo(() => new Map((bundle ? bundle.pages : []).map(p => [p.title, p.key])), [bundle]);

  // --- Running a sync

  const running = job && job.status === 'running';

  const poll = useCallback(async jobId => {
    try {
      const status = await confluenceService.syncStatus(jobId, logLength.current);
      logLength.current = status.logLength;
      if (status.log.length) setLog(prev => [...prev, ...status.log]);
      setJob(status);
      if (status.status !== 'running') {
        confluenceService.setJob(null);
        if (status.dryRun && status.status === 'done') setLastPreview(p => (p && p.jobId === jobId ? { ...p, stats: status.stats } : p));
      }
      return status.status === 'running';
    } catch (err) {
      confluenceService.setJob(null);
      setJob(j => (j ? { ...j, status: 'failed', error: err.message } : j));
      return false;
    }
  }, []);

  // One poll at a time, each scheduled when the last has answered: two in flight would
  // both ask for the log from the same point and show every line twice.
  const jobId = job && job.id;
  const jobRunning = !!job && job.status === 'running';
  useEffect(() => {
    if (!jobRunning) return undefined;
    let cancelled = false;
    let timer;
    const tick = async () => {
      const more = await poll(jobId);
      if (more && !cancelled) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [jobId, jobRunning, poll]);

  // A sync carries on in the server when the page reloads; pick it back up
  useEffect(() => {
    const jobId = confluenceService.getJob();
    if (!jobId) return;
    logLength.current = 0;
    setLog([]);
    setJob({ id: jobId, status: 'running', pages: {} });
  }, []);

  // Follow the log by scrolling its own box; scrollIntoView would drag the page along too
  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [log]);

  const rows = useMemo(() => (bundle
    ? bundle.pages.map(p => ({ id: p.key, key: p.key, title: p.title, parent: p.parent, attachments: p.attachments.length }))
    : []), [bundle]);
  const chosen = useMemo(() => selectedKeys(selection, rows), [selection, rows]);
  const chosenSet = useMemo(() => new Set(chosen), [chosen]);
  const allChosen = rows.length > 0 && chosen.length === rows.length;
  // Everything selected publishes the bundle whole, exactly as the script would
  const only = allChosen ? [] : chosen;
  const runKey = JSON.stringify({ bundle: bundle?.version, target, options, only });

  const setChosen = keys => setSelection({ type: 'include', ids: new Set(keys) });
  const togglePage = (key, include) => {
    const next = new Set(chosen);
    if (include) next.add(key);
    else next.delete(key);
    setChosen([...next]);
  };

  // The pages with pages under them, for "select this section"
  const sections = useMemo(() => (bundle ? bundle.pages
    .map(p => ({ page: p, below: descendantsOf(bundle.pages, p.key) }))
    // A section that is the whole bundle is just "All" again
    .filter(s => s.below.length > 0 && s.below.length + 1 < bundle.pages.length) : []), [bundle]);

  // The server gets the bundle once per folder; a server restarted since has lost it, so
  // that is answered by sending it again rather than by an error
  const sendBundle = async () => {
    if (sent.current && sent.current.bundle === bundle) return sent.current.bundleId;
    setSending(true);
    try {
      const { bundleId } = await confluenceService.uploadBundle(bundle.entries);
      sent.current = { bundle, bundleId };
      return bundleId;
    } finally {
      setSending(false);
    }
  };

  const start = async dryRun => {
    setConfirmOpen(false);
    setStartError('');
    try {
      const request = async () => confluenceService.startSync({
        bundleId: await sendBundle(),
        space: target.space.trim(),
        parentId: target.parentId.trim(),
        dryRun,
        only: only.length ? only : null,
        ...options
      });
      let started;
      try {
        started = await request();
      } catch (err) {
        if (!/no longer on the server/.test(err.message)) throw err;
        sent.current = null;
        started = await request();
      }
      const { jobId } = started;
      confluenceService.setJob(jobId);
      logLength.current = 0;
      setLog([]);
      setJob({ id: jobId, status: 'running', dryRun, pages: {} });
      if (dryRun) setLastPreview({ jobId, runKey, stats: null });
    } catch (err) {
      // Already running on this space (another tab, say): show that one instead
      if (err.status === 409 && err.data && err.data.jobId) {
        confluenceService.setJob(err.data.jobId);
        logLength.current = 0;
        setLog([]);
        setJob({ id: err.data.jobId, status: 'running', pages: {} });
      }
      setStartError(err.message);
    }
  };

  // Signed out (from the Connections dialog): what the summary said no longer holds
  useEffect(() => {
    if (connected) return;
    checkedTarget.current = null;
    setTargetInfo(null);
  }, [connected]);

  const previewIsCurrent = lastPreview && lastPreview.runKey === runKey && lastPreview.stats;
  const problems = bundle ? bundle.problems : [];
  // Not gated on the target check: leaving a field to click a button runs that check, and
  // a button disabled for its duration swallows the click. The sync checks the space and
  // parent itself before it writes anything.
  const canRun = connected && bundle && target.space.trim() && chosen.length > 0 && !running && !sending;

  const columns = useMemo(() => [
    { field: 'key', headerName: 'Key', width: 150 },
    { field: 'title', headerName: 'Title', flex: 1, minWidth: 220 },
    { field: 'parent', headerName: 'Parent', width: 130, valueFormatter: value => value || '(top)' },
    { field: 'attachments', headerName: 'Images', width: 80, type: 'number' },
    {
      field: 'result',
      headerName: 'Result',
      width: 130,
      valueGetter: (value, row) => job?.pages?.[row.id]?.action || '',
      renderCell: ({ row }) => {
        const result = job?.pages?.[row.id];
        if (!result) return null;
        const meta = ACTIONS[result.action] || { preview: result.action, done: result.action, color: 'default' };
        const chip = (
          <Chip
            size="small"
            color={meta.color}
            variant={result.action === 'unchanged' ? 'outlined' : 'filled'}
            label={job.dryRun ? meta.preview : meta.done}
          />
        );
        return result.detail ? <Tooltip title={result.detail}>{chip}</Tooltip> : chip;
      }
    }
  ], [job]);

  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: { xs: 'wrap', lg: 'nowrap' } }}>
      {/* Left: where from, where to, and what to do */}
      <Box sx={{ width: { xs: '100%', lg: 400 }, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <ConnectionPanel confluence={confluence} />

        <Section title="Where the pages go">
          <TextField
            label="Space key"
            size="small"
            value={target.space}
            onChange={e => updateTarget({ space: e.target.value.toUpperCase() })}
            onBlur={() => connected && checkTarget()}
            placeholder="CST"
          />
          <ParentPagePicker
            target={target}
            connected={connected}
            onChange={updateTarget}
            onCommit={next => { if (connected) checkTarget(next); }}
          />
          {/* The old summary stays, dimmed, while the new one is fetched. Swapping it for a
              shorter "Checking…" moves everything below — including the button the user was
              clicking when the field lost focus, which then never receives the click. */}
          {checkingTarget && !targetInfo && <Typography variant="caption" color="text.secondary">Checking…</Typography>}
          {targetError && !checkingTarget && <Alert severity="error">{targetError}</Alert>}
          {targetInfo && (
            <Typography variant="body2" color="text.secondary" sx={{ opacity: checkingTarget ? 0.5 : 1 }}>
              <strong>{targetInfo.space.name}</strong> ({targetInfo.space.key})
              {targetInfo.parent ? <>, under “{targetInfo.parent.title}”</> : ', at the top of the space'}.
              {' '}{targetInfo.tracked
                ? `${targetInfo.tracked} page${targetInfo.tracked === 1 ? '' : 's'} remembered from earlier syncs.`
                : 'Nothing published here from this app yet.'}
            </Typography>
          )}
          {!connected && !validating && (
            <Typography variant="caption" color="text.secondary">Sign in to check the space.</Typography>
          )}
        </Section>

        <Section title="Bundle">
          <input ref={folderInput} type="file" multiple hidden onChange={pickFolder} />
          <Button
            variant="outlined"
            startIcon={reading ? <CircularProgress size={18} /> : <FolderOpenIcon />}
            onClick={() => folderInput.current && folderInput.current.click()}
            disabled={reading || sending || running}
          >
            {reading ? 'Reading…' : bundle ? 'Choose a different folder' : 'Choose bundle folder'}
          </Button>
          <Typography variant="caption" color="text.secondary">
            The folder holding manifest.json, pages/ and images/. It is read here, in your browser:
            nothing is sent until you preview changes or publish. Choosing the folder around it also
            brings along the page ids push_to_confluence.py has been keeping.
          </Typography>
          {bundleError && <Alert severity="error">{bundleError}</Alert>}
          {bundle && (
            <>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                <Chip size="small" label={`${bundle.pages.length} pages`} />
                <Chip size="small" label={`${bundle.attachmentCount} images`} />
                <Chip size="small" label={formatBytes(bundle.bytes)} />
              </Box>
              <Typography variant="body2" color="text.secondary">
                {bundle.folder && <><strong>{bundle.folder}</strong> · </>}
                {bundle.source || 'Unknown source'}
                {bundle.generated && <>, built {new Date(bundle.generated).toLocaleString()}</>}
              </Typography>
              {bundle.stateFileSpaces.length > 0 && (
                <Typography variant="caption" color="text.secondary">
                  Found the script's page ids for {bundle.stateFileSpaces.join(', ')}. They are used for a space this app has not published to yet.
                </Typography>
              )}
              {problems.length > 0 && (
                <Alert severity="warning">
                  {problems.length} problem{problems.length === 1 ? '' : 's'} in the bundle. Preview still works; publishing waits until they are fixed.
                  <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                    {problems.slice(0, 8).map(p => <li key={p}>{p}</li>)}
                    {problems.length > 8 && <li>…and {problems.length - 8} more</li>}
                  </Box>
                </Alert>
              )}
            </>
          )}
        </Section>

        <Section title="Publish">
          <Box sx={{ display: 'flex', flexDirection: 'column' }}>
            <Tooltip placement="right" title="Write every page again, even unchanged ones. Use it after someone has edited the pages in Confluence.">
              <FormControlLabel
                control={<Checkbox size="small" checked={options.force} onChange={e => setOptions(o => ({ ...o, force: e.target.checked }))} />}
                label="Re-publish unchanged pages"
              />
            </Tooltip>
            <Tooltip placement="right" title="A page with the same title already in the space, not created by this sync, is normally a reason to stop. This takes it over instead.">
              <FormControlLabel
                control={<Checkbox size="small" checked={options.adoptExisting} onChange={e => setOptions(o => ({ ...o, adoptExisting: e.target.checked }))} />}
                label="Take over same-titled pages"
              />
            </Tooltip>
            <Tooltip placement="right" title="Pages an earlier sync created that are no longer in the bundle go to the space trash. Otherwise they are only reported.">
              <FormControlLabel
                control={<Checkbox size="small" checked={options.trashOrphans} onChange={e => setOptions(o => ({ ...o, trashOrphans: e.target.checked }))} />}
                label="Trash pages no longer in the bundle"
              />
            </Tooltip>
          </Box>
          {bundle && (
            <Typography variant="caption" color={chosen.length ? 'text.secondary' : 'warning.main'}>
              {!chosen.length ? 'No pages selected. Tick the pages to sync in the list.'
                : allChosen ? `All ${rows.length} pages.`
                  : `Only the ${chosen.length} selected page${chosen.length === 1 ? '' : 's'}; the rest are left as they are in Confluence.`}
            </Typography>
          )}
          {sending && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <CircularProgress size={14} />
              <Typography variant="caption" color="text.secondary">Sending the bundle to the app server…</Typography>
            </Box>
          )}
          {startError && <Alert severity="error">{startError}</Alert>}
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              variant="outlined"
              startIcon={<PreviewIcon />}
              disabled={!canRun}
              onClick={() => start(true)}
              sx={{ flex: 1 }}
            >
              Preview changes
            </Button>
            <Button
              variant="contained"
              startIcon={<PublishIcon />}
              disabled={!canRun || problems.length > 0}
              onClick={() => setConfirmOpen(true)}
              sx={{ flex: 1 }}
            >
              Publish
            </Button>
          </Box>
          {running && (
            <Button color="warning" startIcon={<StopIcon />} onClick={() => confluenceService.stopSync(job.id)}>
              Stop after the current page
            </Button>
          )}
        </Section>
      </Box>

      {/* Right: the pages and what happened to them */}
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2, width: '100%' }}>
        <Paper variant="outlined" sx={{ height: 540, display: 'flex', flexDirection: 'column' }}>
          {bundle ? (
            <>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, px: 2, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
                <Typography variant="body2" sx={{ flex: 1 }}>
                  <strong>{chosen.length}</strong> of {rows.length} pages selected
                  <Typography component="span" variant="body2" color="text.secondary"> · click a page to preview it</Typography>
                </Typography>
                <Button
                  size="small"
                  endIcon={<ArrowDropDownIcon />}
                  onClick={e => setSelectMenu(e.currentTarget)}
                  disabled={running}
                >
                  Select
                </Button>
                <Menu anchorEl={selectMenu} open={!!selectMenu} onClose={() => setSelectMenu(null)}>
                  <MenuItem onClick={() => { setChosen(rows.map(r => r.id)); setSelectMenu(null); }}>All {rows.length} pages</MenuItem>
                  <MenuItem onClick={() => { setChosen([]); setSelectMenu(null); }}>None</MenuItem>
                  {sections.length > 0 && <Divider />}
                  {sections.map(({ page, below }) => (
                    <MenuItem key={page.key} onClick={() => { setChosen([page.key, ...below]); setSelectMenu(null); }}>
                      Only “{page.title}” and the {below.length} page{below.length === 1 ? '' : 's'} under it
                    </MenuItem>
                  ))}
                </Menu>
              </Box>
              <DataGrid
                rows={rows}
                columns={columns}
                density="compact"
                checkboxSelection
                disableRowSelectionOnClick
                hideFooterSelectedRowCount
                rowSelectionModel={selection}
                onRowSelectionModelChange={model => setSelection(model)}
                isRowSelectable={() => !running}
                onCellClick={params => { if (params.field !== '__check__') setPreviewKey(params.id); }}
                getRowClassName={params => (chosenSet.has(params.id) ? '' : 'row-left-out')}
                initialState={{ pagination: { paginationModel: { pageSize: 100 } } }}
                pageSizeOptions={[25, 50, 100]}
                sx={{
                  border: 0,
                  '& .MuiDataGrid-row': { cursor: 'pointer' },
                  '& .row-left-out': { color: 'text.secondary' }
                }}
              />
            </>
          ) : (
            <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3 }}>
              <Typography color="text.secondary" align="center">
                Choose a bundle folder to see its pages here.
              </Typography>
            </Box>
          )}
        </Paper>

        {job && (
          <Paper variant="outlined" sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              {running && <CircularProgress size={16} />}
              <Typography variant="subtitle2" sx={{ mr: 1 }}>
                {job.dryRun ? 'Preview' : 'Publish'}
                {' · '}
                {{ running: 'running', done: 'finished', failed: 'stopped with an error', stopped: 'stopped' }[job.status] || job.status}
              </Typography>
              {job.stats && (
                <>
                  <Chip size="small" color="success" label={`${job.stats.created} ${job.dryRun ? 'to create' : 'created'}`} />
                  <Chip size="small" color="info" label={`${job.stats.updated} ${job.dryRun ? 'to update' : 'updated'}`} />
                  <Chip size="small" variant="outlined" label={`${job.stats.unchanged} unchanged`} />
                  {!job.dryRun && <Chip size="small" variant="outlined" label={`${job.stats.attachments} images uploaded`} />}
                </>
              )}
            </Box>
            {job.error && job.status !== 'stopped' && (
              <Alert severity="error" sx={{ whiteSpace: 'pre-line' }}>{job.error}</Alert>
            )}
            {job.orphans && job.orphans.length > 0 && (
              <Alert severity="warning">
                {job.orphans.length} page{job.orphans.length === 1 ? '' : 's'} published earlier {job.orphans.length === 1 ? 'is' : 'are'} no longer in the bundle
                ({job.orphans.map(o => o.key).join(', ')}).
                {' '}{options.trashOrphans && !job.dryRun ? 'Moved to the space trash.' : 'Left in place.'}
              </Alert>
            )}
            <Box
              ref={logBox}
              sx={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 12,
                lineHeight: 1.6,
                maxHeight: 280,
                overflow: 'auto',
                bgcolor: 'background.default',
                borderRadius: 1,
                p: 1.5,
                whiteSpace: 'pre-wrap'
              }}
            >
              {log.map((line, i) => (
                <Box key={i} sx={{ color: LOG_COLORS[line.level] || 'text.primary' }}>{line.text}</Box>
              ))}
              {!log.length && <Box sx={{ color: 'text.secondary' }}>Starting…</Box>}
            </Box>
          </Paper>
        )}
      </Box>

      {bundle && (
        <PagePreview
          bundle={bundle}
          pageKey={previewKey}
          titleIndex={titleIndex}
          imageUrl={imageUrl}
          selected={!!previewKey && chosenSet.has(previewKey)}
          locked={running}
          onToggle={togglePage}
          onNavigate={setPreviewKey}
          onClose={() => setPreviewKey(null)}
        />
      )}

      <Dialog open={confirmOpen} onClose={() => setConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Publish to Confluence?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div" sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <span>
              {only.length ? `${only.length} selected page${only.length === 1 ? '' : 's'}` : `All ${rows.length} pages`} into
              {' '}<strong>{targetInfo ? targetInfo.space.name : target.space}</strong>
              {targetInfo && targetInfo.parent ? <>, under “{targetInfo.parent.title}”</> : ', at the top of the space'}.
            </span>
            {previewIsCurrent ? (
              <span>
                The preview found {lastPreview.stats.created} to create and {lastPreview.stats.updated} to update.
              </span>
            ) : (
              <Alert severity="info">Nothing has been previewed with these settings. A preview shows what would change and writes nothing.</Alert>
            )}
            {options.trashOrphans && <Alert severity="warning">Pages no longer in the bundle will be moved to the space trash.</Alert>}
            {options.adoptExisting && <Alert severity="warning">Same-titled pages this sync did not create will be overwritten.</Alert>}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
          {!previewIsCurrent && <Button onClick={() => start(true)}>Preview first</Button>}
          <Button variant="contained" onClick={() => start(false)}>Publish</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
