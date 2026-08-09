import React, { useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Tooltip
} from '@mui/material';
import {
  Person as PersonIcon,
  CloudDone as CloudDoneIcon,
  CloudOff as CloudOffIcon
} from '@mui/icons-material';
import useJiraAuth from '../hooks/useJiraAuth';
import JiraAuth from './JiraAuth';

// Initials for a Jira username, which is usually "first.last" but can be anything
const initialsFor = (user) => {
  const name = String(user || '').trim();
  if (!name) return '';
  const parts = name.split(/[.\-_\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

/**
 * Jira connection status as an app bar avatar. Clicking it opens the authentication
 * form in a dialog, so signing in does not occupy space on every page.
 */
export default function JiraAuthAvatar() {
  const { isAuthenticated, getStoredCredentials } = useJiraAuth();
  const [open, setOpen] = useState(false);

  const storedCreds = getStoredCredentials();
  const user = storedCreds?.jiraUser || '';
  const initials = initialsFor(user);
  const label = isAuthenticated
    ? `Connected to Jira${user ? ` as ${user}` : ''}`
    : 'Not connected to Jira — click to sign in';

  return (
    <>
      <Tooltip title={label}>
        <IconButton
          onClick={() => setOpen(true)}
          aria-label={label}
          sx={{ ml: 1, p: 0.5, gap: 1, borderRadius: 6 }}
        >
          {/* Full-size and beside the avatar rather than a badge on it, which was too
              small to read at a glance against the app bar */}
          {isAuthenticated
            ? <CloudDoneIcon sx={{ fontSize: 24, color: '#79F2C0' }} />
            : <CloudOffIcon sx={{ fontSize: 24, color: '#FFC400' }} />}
          <Avatar
            sx={{
              width: 34,
              height: 34,
              fontSize: 14,
              bgcolor: isAuthenticated ? 'success.main' : 'grey.500',
              color: 'common.white'
            }}
          >
            {initials || <PersonIcon fontSize="small" />}
          </Avatar>
        </IconButton>
      </Tooltip>

      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Jira Connection</DialogTitle>
        <DialogContent dividers>
          <Box sx={{ pt: 1 }}>
            {/* Close once a sign-in succeeds; the form itself stays the single
                implementation used everywhere */}
            <JiraAuth onAuthSuccess={() => setOpen(false)} />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
