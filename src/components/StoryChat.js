import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Box, TextField, IconButton, Typography, Button, Alert, CircularProgress, Chip, Tooltip,
  Menu, MenuItem, ListItemIcon, ListItemText, Checkbox
} from '@mui/material';
import {
  Send as SendIcon,
  Close as CloseIcon,
  AutoAwesome as AutoAwesomeIcon,
  ArrowDropDown as ArrowDropDownIcon,
  Check as CheckIcon,
  AddPhotoAlternate as AddPhotoIcon,
  Visibility as VisibilityIcon
} from '@mui/icons-material';
import MDEditor from '@uiw/react-md-editor';
import { API_BASE } from '../hooks/useJiraAuth';

/*
 * A chat rail for refining one story against the canonical template.
 *
 * Two things keep it honest. The agent's reply is never written to the row on its own —
 * it arrives as a proposal with an Apply button, so the format check and the human both
 * sit between the agent and the grid. And the transcript here carries only the agent's
 * prose: the substance of the story travels in `story` on every turn, which is read fresh
 * from the row, so a description the user hand-edited is what the next turn builds on.
 */

// An empty message box does not say what this is good at. These do.
const REFINE_STARTERS = [
  'Add acceptance criteria',
  'Tighten the summary',
  'Check this against the template',
  'Split this into smaller stories'
];

// The page-level assistant starts from an idea, not a story, so its openers are different
const BRAINSTORM_STARTERS = [
  'Break this feature into stories: ',
  'Split this story into smaller ones: ',
  'What stories would an MVP need for '
];

/*
 * Images are sent inline, so they are scaled down first: a phone photo is several
 * megabytes, and a local vision model reads at well under this resolution anyway. A small
 * image is sent as it is, so a crisp screenshot is not re-encoded into a blurry one.
 */
const IMAGE_MAX_EDGE = 1280;
const IMAGE_KEEP_BYTES = 1024 * 1024;
const MAX_PENDING_IMAGES = 4;

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error(`Could not read ${file.name || 'the image'}.`));
  reader.readAsDataURL(file);
});

async function prepareImage(file) {
  const original = await readAsDataUrl(file);
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(`${file.name || 'That file'} is not an image this browser can read.`));
    el.src = original;
  });
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(img.width, img.height));
  const sendable = /^image\/(png|jpeg|webp|gif)$/.test(file.type);
  if (scale === 1 && file.size <= IMAGE_KEEP_BYTES && sendable) {
    return { name: file.name || 'image', url: original };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  // JPEG has no transparency; a transparent screenshot would otherwise come out black
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { name: file.name || 'image', url: canvas.toDataURL('image/jpeg', 0.85) };
}

const imageFiles = (list) => Array.from(list || []).filter(f => f && /^image\//.test(f.type));

function Thumbs({ images, onRemove }) {
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
      {images.map((img, i) => (
        <Box key={i} sx={{ position: 'relative' }}>
          <Tooltip title={img.name || 'image'}>
            <Box
              component="img"
              src={img.url}
              alt={img.name || 'attached image'}
              sx={{ display: 'block', width: 64, height: 64, objectFit: 'cover', borderRadius: 1, border: 1, borderColor: 'divider' }}
            />
          </Tooltip>
          {onRemove && (
            <IconButton
              size="small"
              onClick={() => onRemove(i)}
              sx={{ position: 'absolute', top: -8, right: -8, p: 0.25, bgcolor: 'background.paper', boxShadow: 1, '&:hover': { bgcolor: 'grey.200' } }}
            >
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          )}
        </Box>
      ))}
    </Box>
  );
}

// Only the authored fields are ever proposed; the server drops the rest before we see it.
const PATCH_LABELS = {
  summary: 'Summary',
  description: 'Description',
  issueType: 'Issue type',
  storyPoints: 'Story points',
  labels: 'Labels'
};

const changedFields = (patch, story) =>
  Object.keys(PATCH_LABELS).filter(f => patch[f] !== undefined && String(patch[f] || '') !== String(story[f] || ''));

// Short enough to show as a value; the description gets rendered instead
const SHORT_FIELDS = ['summary', 'issueType', 'storyPoints', 'labels'];

function ShortField({ field, from, to }) {
  return (
    <Box sx={{ mb: 0.75 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {PATCH_LABELS[field]}
      </Typography>
      <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
        {/* Only worth showing what it replaces when there was something there */}
        {from ? (
          <>
            <Box component="span" sx={{ color: 'text.disabled', textDecoration: 'line-through' }}>{from}</Box>
            <Box component="span" sx={{ mx: 0.5, color: 'text.disabled' }}>→</Box>
          </>
        ) : null}
        {to || <Box component="span" sx={{ color: 'text.disabled' }}>(cleared)</Box>}
      </Typography>
    </Box>
  );
}

function ProposedChanges({ patch, story, onApply }) {
  const [applied, setApplied] = useState(false);
  const fields = changedFields(patch, story);

  if (applied) {
    return (
      <Typography variant="caption" color="success.main" sx={{ display: 'block', mt: 1 }}>
        Applied to the story — undo it from the dialog footer.
      </Typography>
    );
  }

  if (fields.length === 0) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        Nothing here differs from the story as it stands.
      </Typography>
    );
  }

  return (
    <Box sx={{ mt: 1, p: 1, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.paper' }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
        Proposed changes
      </Typography>

      {/* The values themselves, so Apply is never a blind press */}
      {fields.filter(f => SHORT_FIELDS.includes(f)).map(f => (
        <ShortField key={f} field={f} from={story[f]} to={patch[f]} />
      ))}

      {fields.includes('description') && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {PATCH_LABELS.description}
          </Typography>
          {/* Capped and scrollable: a whole story document would otherwise push the
              message box off the bottom of the rail */}
          <Box
            data-color-mode="light"
            sx={{
              mt: 0.5,
              maxHeight: 280,
              overflowY: 'auto',
              p: 1,
              border: 1,
              borderColor: 'divider',
              borderRadius: 1,
              '& h2': { fontSize: 14, mt: 1.5, mb: 0.5 },
              '& h3': { fontSize: 13, mt: 1, mb: 0.25 },
              '& p, & li': { fontSize: 13 }
            }}
          >
            <MDEditor.Markdown source={patch.description} style={{ backgroundColor: 'transparent' }} />
          </Box>
        </Box>
      )}

      <Button size="small" variant="contained" onClick={() => { onApply(patch); setApplied(true); }}>
        Apply
      </Button>
    </Box>
  );
}

/*
 * A split comes back as several whole stories rather than a change to this one, so it
 * cannot be a patch: it lands in the table as new rows. Replacing turns this story into
 * the first of them — which is how a split of an existing Jira issue usually goes, the
 * issue keeping its key and history — and adds the rest beside it.
 */
function ProposedSplit({ stories, onApply, onAddStories }) {
  const [done, setDone] = useState('');
  const [open, setOpen] = useState(null);
  // Every story starts ticked; a brainstorm usually proposes one or two that are not wanted
  const [picked, setPicked] = useState(() => stories.map(() => true));
  const chosen = stories.filter((_, i) => picked[i]);
  const toggle = (i) => setPicked(prev => prev.map((p, j) => (j === i ? !p : p)));

  if (done) {
    return (
      <Typography variant="caption" color="success.main" sx={{ display: 'block', mt: 1 }}>
        {done}
      </Typography>
    );
  }

  return (
    <Box sx={{ mt: 1, p: 1, border: 1, borderColor: 'divider', borderRadius: 1, bgcolor: 'background.paper' }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
        {onApply ? `Split into ${stories.length} stories` : `${stories.length} proposed ${stories.length === 1 ? 'story' : 'stories'}`}
        {' '}· click a title to read it
      </Typography>

      {stories.map((s, i) => (
        <Box key={i} sx={{ mb: 0.75 }}>
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
            <Checkbox size="small" checked={picked[i]} onChange={() => toggle(i)} sx={{ p: 0.25 }} />
            <Typography
              variant="body2"
              onClick={() => setOpen(open === i ? null : i)}
              sx={{
                pt: 0.25, cursor: 'pointer', wordBreak: 'break-word',
                color: picked[i] ? 'text.primary' : 'text.disabled',
                '&:hover': { textDecoration: 'underline' }
              }}
            >
              {s.summary || '(untitled)'}
              {s.storyPoints ? (
                <Box component="span" sx={{ color: 'text.secondary' }}> · {s.storyPoints} pts</Box>
              ) : null}
            </Typography>
          </Box>
          {open === i && (
            <Box
              data-color-mode="light"
              sx={{
                mt: 0.5, maxHeight: 240, overflowY: 'auto', p: 1,
                border: 1, borderColor: 'divider', borderRadius: 1,
                '& h2': { fontSize: 14, mt: 1.5, mb: 0.5 },
                '& h3': { fontSize: 13, mt: 1, mb: 0.25 },
                '& p, & li': { fontSize: 13 }
              }}
            >
              <MDEditor.Markdown source={s.description} style={{ backgroundColor: 'transparent' }} />
            </Box>
          )}
        </Box>
      ))}

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
        {/* Only the story editor has a story to replace; the page-level assistant just adds */}
        {onApply && (
          <Tooltip title="This story becomes the first one ticked; the others are added to the table as new rows">
            <span>
              <Button
                size="small"
                variant="contained"
                disabled={chosen.length === 0}
                onClick={() => {
                  onApply(chosen[0]);
                  onAddStories(chosen.slice(1));
                  setDone(`Replaced this story with the first; added ${chosen.length - 1} more to the table.`);
                }}
              >
                Replace + add {Math.max(0, chosen.length - 1)}
              </Button>
            </span>
          </Tooltip>
        )}
        <Tooltip title={onApply
          ? 'This story is left as it is; the ones ticked are added to the table as new rows'
          : 'Added as draft rows, to refine and publish from the table'}>
          <span>
            <Button
              size="small"
              variant={onApply ? 'outlined' : 'contained'}
              disabled={chosen.length === 0}
              onClick={() => {
                onAddStories(chosen);
                setDone(`Added ${chosen.length} ${chosen.length === 1 ? 'story' : 'stories'} to the table.`);
              }}
            >
              Add {chosen.length} to table
            </Button>
          </span>
        </Tooltip>
      </Box>
    </Box>
  );
}

/*
 * `intent` picks the job. 'refine' is the story editor's rail, working on the one row it
 * was opened on. 'brainstorm' is the page-level assistant: there is no story yet, only an
 * idea, and everything it proposes is added to the table as new rows.
 */
export default function StoryChat({
  story, context, mode, model, models = [], template, intent = 'refine',
  allowImages = false, visionModels = null,
  onModelChange, onApply, onAddStories, onClose
}) {
  const brainstorm = intent === 'brainstorm';
  // Images waiting to go with the next message
  const [pending, setPending] = useState([]);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef(null);
  // Only Ollama says model by model; any other mode that allows images takes them whole
  const sees = (name) => !visionModels || visionModels.includes(name);
  const modelSeesImages = sees(model);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [modelMenu, setModelMenu] = useState(null);
  const endRef = useRef(null);

  // Only worth offering a choice when the server reported more than one model installed;
  // every other mode has a single agent behind it and nothing to pick between.
  const canPickModel = Boolean(onModelChange) && models.length > 1;

  useEffect(() => {
    if (endRef.current) endRef.current.scrollIntoView({ block: 'end' });
  }, [messages, sending]);

  const addImages = useCallback(async (files) => {
    const wanted = imageFiles(files);
    if (!allowImages || wanted.length === 0) return;
    const room = MAX_PENDING_IMAGES - pending.length;
    if (room <= 0) {
      setError(`Up to ${MAX_PENDING_IMAGES} images per message.`);
      return;
    }
    try {
      const prepared = await Promise.all(wanted.slice(0, room).map(prepareImage));
      setPending(prev => [...prev, ...prepared].slice(0, MAX_PENDING_IMAGES));
      if (wanted.length > room) setError(`Up to ${MAX_PENDING_IMAGES} images per message; the rest were left out.`);
    } catch (err) {
      setError(err.message);
    }
  }, [allowImages, pending.length]);

  const send = useCallback(async (preset) => {
    const typed = (typeof preset === 'string' ? preset : input).trim();
    const images = typeof preset === 'string' ? [] : pending;
    if ((!typed && images.length === 0) || sending) return;
    // An image on its own still needs saying what to do with it
    const text = typed || 'Turn what is in these images into stories.';
    setError('');
    setInput('');
    setPending([]);
    const turn = { role: 'user', content: text, ...(images.length ? { images } : {}) };
    const history = [...messages, turn];
    setMessages(history);
    setSending(true);
    try {
      const response = await fetch(`${API_BASE}/api/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Prose only — the story itself is sent whole, below, and read fresh each turn
          messages: history.map(m => ({
            role: m.role,
            content: m.content,
            ...(m.images ? { images: m.images.map(img => img.url) } : {}),
            // What it proposed, so "make the second one smaller" has a second one to mean
            ...(m.stories ? { stories: m.stories } : {})
          })),
          story: story || {},
          context,
          intent,
          // Ignored by the modes that have no model to choose between
          model,
          // Which shape to answer in: the row's issue type and the variant chosen for it
          ...(template || {})
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `The agent returned ${response.status}`);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: data.reply || '',
        patch: data.patch || null,
        stories: Array.isArray(data.stories) && data.stories.length > 0 ? data.stories : null,
        violations: data.violations || []
      }]);
    } catch (err) {
      setError(err.message);
      // Put the message back so a failed turn is not lost
      setInput(typed);
      setPending(images);
      setMessages(messages);
    } finally {
      setSending(false);
    }
  }, [input, pending, sending, messages, story, context, model, template, intent]);

  // Dropping images anywhere on the rail attaches them; anything else is left alone
  const dropProps = allowImages ? {
    onDragOver: (e) => {
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false); },
    onDrop: (e) => {
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      setDragging(false);
      addImages(e.dataTransfer.files);
    }
  } : {};

  return (
    <Box
      {...dropProps}
      sx={{
        display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0,
        outline: dragging ? '2px dashed' : 'none', outlineColor: 'primary.main', outlineOffset: -4
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider' }}>
        <AutoAwesomeIcon fontSize="small" color="primary" />
        <Typography variant="subtitle2" sx={{ flex: 1 }}>{brainstorm ? 'Brainstorm stories' : 'Story assistant'}</Typography>
        {(model || mode) && (
          <Tooltip title={mode === 'mock'
            ? 'No agent is configured, so replies come from a local stand-in'
            : canPickModel
              ? `Replies come from ${model}. Click to use a different installed model.`
              : `Replies come from ${model || mode}`}>
            <Chip
              size="small"
              label={model || mode}
              variant="outlined"
              clickable={canPickModel}
              onClick={canPickModel ? (e) => setModelMenu(e.currentTarget) : undefined}
              deleteIcon={canPickModel ? <ArrowDropDownIcon /> : undefined}
              onDelete={canPickModel ? (e) => setModelMenu(e.currentTarget) : undefined}
              sx={{ maxWidth: 180 }}
            />
          </Tooltip>
        )}
        {/* The model is switchable mid-conversation: the whole transcript is resent each
            turn, so the next reply simply comes from the other model. */}
        <Menu anchorEl={modelMenu} open={Boolean(modelMenu)} onClose={() => setModelMenu(null)}>
          <Typography variant="caption" color="text.secondary" sx={{ px: 2, py: 0.5, display: 'block' }}>
            Installed models
          </Typography>
          {models.map(name => (
            <MenuItem
              key={name}
              selected={name === model}
              onClick={() => { onModelChange(name); setModelMenu(null); }}
            >
              <ListItemIcon sx={{ minWidth: 32 }}>
                {name === model ? <CheckIcon fontSize="small" /> : null}
              </ListItemIcon>
              <ListItemText primaryTypographyProps={{ variant: 'body2' }}>{name}</ListItemText>
              {allowImages && visionModels && visionModels.includes(name) && (
                <Tooltip title="Can read images">
                  <VisibilityIcon fontSize="small" color="action" sx={{ ml: 1 }} />
                </Tooltip>
              )}
            </MenuItem>
          ))}
        </Menu>
        <IconButton size="small" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {messages.length === 0 && (
          <>
            <Typography variant="body2" color="text.secondary">
              {brainstorm
                ? 'Describe a feature, paste a requirement, or paste a story that is too big. The '
                  + 'stories that come back are in the canonical format, and the ones you tick are '
                  + 'added to the table as drafts to refine there. Somewhere to start:'
                : 'Replies are harmonized to the canonical story format, and land as a proposal you '
                  + 'apply yourself. Somewhere to start:'}
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {(brainstorm ? BRAINSTORM_STARTERS : REFINE_STARTERS).map(text => (
                <Chip
                  key={text}
                  size="small"
                  variant="outlined"
                  clickable
                  label={text.trim()}
                  // A brainstorm opener is half a sentence: it goes in the box to be finished,
                  // not sent as it is
                  onClick={() => (brainstorm ? setInput(text) : send(text))}
                  sx={{ '& .MuiChip-label': { fontSize: 12 } }}
                />
              ))}
            </Box>
          </>
        )}
        {messages.map((m, i) => (
          <Box
            key={i}
            sx={{
              alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '95%',
              px: 1.25, py: 1,
              borderRadius: 1.5,
              bgcolor: m.role === 'user' ? 'primary.main' : 'grey.100',
              color: m.role === 'user' ? 'primary.contrastText' : 'text.primary'
            }}
          >
            {m.images && m.images.length > 0 && (
              <Box sx={{ mb: 0.75 }}><Thumbs images={m.images} /></Box>
            )}
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{m.content}</Typography>
            {/* Say when the format had to be corrected, rather than quietly fixing it */}
            {m.violations && m.violations.length > 0 && (
              <Typography variant="caption" color="warning.dark" sx={{ display: 'block', mt: 0.75 }}>
                {m.violations.join(' ')}
              </Typography>
            )}
            {m.patch && story && <ProposedChanges patch={m.patch} story={story} onApply={onApply} />}
            {m.stories && onAddStories && (
              <ProposedSplit stories={m.stories} onApply={onApply} onAddStories={onAddStories} />
            )}
          </Box>
        ))}
        {sending && <CircularProgress size={18} sx={{ alignSelf: 'flex-start' }} />}
        <div ref={endRef} />
      </Box>

      {error && <Alert severity="error" sx={{ mx: 1.5, mb: 1 }} onClose={() => setError('')}>{error}</Alert>}

      {pending.length > 0 && (
        <Box sx={{ px: 1.5, pt: 1.5, borderTop: 1, borderColor: 'divider' }}>
          <Thumbs images={pending} onRemove={i => setPending(prev => prev.filter((_, j) => j !== i))} />
          {/* Said before sending, not after a wait: a model without vision fails the turn */}
          {!modelSeesImages && (
            <Typography variant="caption" color="warning.dark" sx={{ display: 'block', mt: 0.75 }}>
              {model} cannot read images.
              {visionModels && visionModels.length > 0
                ? ` Switch to ${visionModels.join(' or ')} from the model picker above.`
                : ' Pull a vision model such as gemma3 to use them.'}
            </Typography>
          )}
        </Box>
      )}

      <Box sx={{ display: 'flex', gap: 1, p: 1.5, borderTop: pending.length ? 0 : 1, borderColor: 'divider' }}>
        {allowImages && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => { addImages(e.target.files); e.target.value = ''; }}
            />
            <Tooltip title="Attach images (or paste, or drop them here)">
              <span style={{ alignSelf: 'flex-end' }}>
                <IconButton
                  onClick={() => fileRef.current && fileRef.current.click()}
                  disabled={sending || pending.length >= MAX_PENDING_IMAGES}
                >
                  <AddPhotoIcon />
                </IconButton>
              </span>
            </Tooltip>
          </>
        )}
        <TextField
          size="small"
          fullWidth
          multiline
          maxRows={5}
          placeholder={brainstorm ? 'Describe an idea or paste a story to split…' : 'Refine this story…'}
          value={input}
          onChange={e => setInput(e.target.value)}
          onPaste={(e) => {
            // A pasted screenshot arrives as a file; pasted text goes on as normal
            const files = imageFiles(e.clipboardData && e.clipboardData.files);
            if (allowImages && files.length) {
              e.preventDefault();
              addImages(files);
            }
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <IconButton color="primary" onClick={send} disabled={(!input.trim() && pending.length === 0) || sending}>
          <SendIcon />
        </IconButton>
      </Box>
    </Box>
  );
}
