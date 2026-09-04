import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  Box, TextField, IconButton, Typography, Button, Alert, CircularProgress, Chip, Tooltip,
  Menu, MenuItem, ListItemIcon, ListItemText
} from '@mui/material';
import {
  Send as SendIcon,
  Close as CloseIcon,
  AutoAwesome as AutoAwesomeIcon,
  ArrowDropDown as ArrowDropDownIcon,
  Check as CheckIcon
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
const STARTERS = [
  'Add acceptance criteria',
  'Tighten the summary',
  'Check this against the template',
  'Split this into smaller stories'
];

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

export default function StoryChat({ story, context, mode, model, models = [], template, onModelChange, onApply, onClose }) {
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

  const send = useCallback(async (preset) => {
    const text = (typeof preset === 'string' ? preset : input).trim();
    if (!text || sending) return;
    setError('');
    setInput('');
    const turn = { role: 'user', content: text };
    const history = [...messages, turn];
    setMessages(history);
    setSending(true);
    try {
      const response = await fetch(`${API_BASE}/api/agent/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // Prose only — the story itself is sent whole, below, and read fresh each turn
          messages: history.map(m => ({ role: m.role, content: m.content })),
          story,
          context,
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
        violations: data.violations || []
      }]);
    } catch (err) {
      setError(err.message);
      // Put the message back so a failed turn is not lost
      setInput(text);
      setMessages(messages);
    } finally {
      setSending(false);
    }
  }, [input, sending, messages, story, context, model, template]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider' }}>
        <AutoAwesomeIcon fontSize="small" color="primary" />
        <Typography variant="subtitle2" sx={{ flex: 1 }}>Story assistant</Typography>
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
            </MenuItem>
          ))}
        </Menu>
        <IconButton size="small" onClick={onClose}><CloseIcon fontSize="small" /></IconButton>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 1.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        {messages.length === 0 && (
          <>
            <Typography variant="body2" color="text.secondary">
              Replies are harmonized to the canonical story format, and land as a proposal you
              apply yourself. Somewhere to start:
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {STARTERS.map(text => (
                <Chip
                  key={text}
                  size="small"
                  variant="outlined"
                  clickable
                  label={text}
                  onClick={() => send(text)}
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
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{m.content}</Typography>
            {/* Say when the format had to be corrected, rather than quietly fixing it */}
            {m.violations && m.violations.length > 0 && (
              <Typography variant="caption" color="warning.dark" sx={{ display: 'block', mt: 0.75 }}>
                {m.violations.join(' ')}
              </Typography>
            )}
            {m.patch && <ProposedChanges patch={m.patch} story={story} onApply={onApply} />}
          </Box>
        ))}
        {sending && <CircularProgress size={18} sx={{ alignSelf: 'flex-start' }} />}
        <div ref={endRef} />
      </Box>

      {error && <Alert severity="error" sx={{ mx: 1.5, mb: 1 }} onClose={() => setError('')}>{error}</Alert>}

      <Box sx={{ display: 'flex', gap: 1, p: 1.5, borderTop: 1, borderColor: 'divider' }}>
        <TextField
          size="small"
          fullWidth
          multiline
          maxRows={5}
          placeholder="Refine this story…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <IconButton color="primary" onClick={send} disabled={!input.trim() || sending}>
          <SendIcon />
        </IconButton>
      </Box>
    </Box>
  );
}
