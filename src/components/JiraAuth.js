import React, { useState, useEffect } from 'react';
import {
  Box,
  TextField,
  Button,
  Typography,
  Alert,
  CircularProgress,
  ToggleButton,
  ToggleButtonGroup,
  FormControlLabel,
  Checkbox,
  Tooltip,
  Chip,
  Divider,
  Link
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  OpenInBrowser as OpenInBrowserIcon
} from '@mui/icons-material';
import useJiraAuth, { AUTH_METHODS, API_BASE } from '../hooks/useJiraAuth';

/**
 * Jira authentication form. Rendered inside the app bar's connection dialog, which owns
 * the heading and the close action, so this is just the form and the current status.
 */
export default function JiraAuth({ onAuthSuccess, onAuthFailure }) {
  const {
    sessionId,
    isAuthenticated,
    authError,
    authLoading,
    authenticate,
    authenticateWithBrowser,
    logout,
    getStoredCredentials,
    getDefaultAuthMethod,
    setDefaultAuthMethod
  } = useJiraAuth();

  // Local state for form inputs
  const [authMethod, setAuthMethod] = useState(getDefaultAuthMethod());
  const [formData, setFormData] = useState({
    jiraUrl: '',
    jiraUser: '',
    jiraPassword: '', // password / API token (Basic auth)
    pat: ''           // Personal Access Token (Bearer auth)
  });
  const [makeDefault, setMakeDefault] = useState(false);
  const [defaultMethod, setDefaultMethodState] = useState(getDefaultAuthMethod());
  const [localError, setLocalError] = useState('');
  // Tracked separately from authLoading so only the browser button shows its own progress
  const [browserSignIn, setBrowserSignIn] = useState(false);
  // Set only where the sign-in window opens somewhere the user cannot see — a container's
  // virtual screen. Null when the server runs natively and the window is on their desk.
  const [signInViewer, setSignInViewer] = useState(null);

  // Load stored credentials (and preferred method) on component mount
  useEffect(() => {
    const storedCreds = getStoredCredentials();
    // Prefill non-secret fields; secrets (password / PAT) are never restored
    setFormData(prev => ({
      ...prev,
      jiraUrl: storedCreds?.jiraUrl || 'https://jiraagile.emirates.com',
      jiraUser: storedCreds?.jiraUser || ''
    }));
    // Start on the last-used method if present, else the saved default. Browser sign-in
    // is not one of the toggle options, so it must not be restored into the selector.
    if (storedCreds?.authType && storedCreds.authType !== AUTH_METHODS.SSO) {
      setAuthMethod(storedCreds.authType);
    }
  }, [getStoredCredentials]);

  // Asked up front rather than when the button is pressed: the sign-in call blocks until
  // the user finishes, so by then there is no reply left to carry this.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/sign-in-viewer`)
      .then(response => response.json())
      .then(({ url }) => { if (!cancelled && url) setSignInViewer(url); })
      .catch(() => {}); // an older server without this route just means no link
    return () => { cancelled = true; };
  }, []);

  const handleInputChange = (field) => (event) => {
    setFormData(prev => ({
      ...prev,
      [field]: event.target.value
    }));
    // Clear errors when user starts typing
    setLocalError('');
  };

  const handleMethodChange = (event, newMethod) => {
    // ToggleButtonGroup passes null when the active button is re-clicked; ignore that
    if (newMethod) {
      setAuthMethod(newMethod);
      setLocalError('');
    }
  };

  const handleAuthenticate = async () => {
    const { jiraUrl, jiraUser, jiraPassword, pat } = formData;
    const isPatMethod = authMethod === AUTH_METHODS.PAT;

    // The secret differs per method: PAT uses the token, Basic uses the password
    const secret = isPatMethod ? pat : jiraPassword;

    // Validation — PAT does not require a username (the token identifies the user)
    if (!jiraUrl?.trim() || !secret?.trim() || (!isPatMethod && !jiraUser?.trim())) {
      setLocalError(isPatMethod
        ? 'Please provide the Jira URL and your Personal Access Token'
        : 'Please fill in all fields');
      return;
    }

    try {
      setLocalError('');
      await authenticate(jiraUrl.trim(), jiraUser.trim(), secret.trim(), authMethod);

      // Remember this method as the default if the user asked us to
      if (makeDefault) {
        setDefaultAuthMethod(authMethod);
        setDefaultMethodState(authMethod);
        setMakeDefault(false);
      }

      if (onAuthSuccess) {
        onAuthSuccess(sessionId);
      }
    } catch (error) {
      const errorMessage = error.message || 'Authentication failed';
      setLocalError(errorMessage);

      if (onAuthFailure) {
        onAuthFailure(error);
      }
    }
  };

  // Browser sign-in: the server opens a window, the user completes SSO there, and the
  // resulting session is captured. No credentials are typed into this form at all.
  const handleBrowserSignIn = async () => {
    const { jiraUrl, pat } = formData;
    if (!jiraUrl?.trim()) {
      setLocalError('Please provide the Jira URL');
      return;
    }

    try {
      setLocalError('');
      setBrowserSignIn(true);
      // A token is optional here, but supplying one means Jira never asks you to log in
      // a second time — the browser only has to satisfy the gateway.
      const { sessionId: newSessionId } = await authenticateWithBrowser(jiraUrl.trim(), pat?.trim() || undefined);

      if (onAuthSuccess) {
        onAuthSuccess(newSessionId);
      }
    } catch (error) {
      setLocalError(error.message || 'Browser sign-in failed');

      if (onAuthFailure) {
        onAuthFailure(error);
      }
    } finally {
      setBrowserSignIn(false);
    }
  };

  const handleLogout = async () => {
    try {
      await logout();
      setFormData(prev => ({
        ...prev,
        jiraPassword: '', // Clear secrets on logout
        pat: ''
      }));
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  const isPat = authMethod === AUTH_METHODS.PAT;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {isAuthenticated && (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CheckCircleIcon color="success" />
            <Typography color="success.main">Authenticated to Jira</Typography>
            <Button size="small" onClick={handleLogout} sx={{ ml: 'auto' }}>
              Logout
            </Button>
          </Box>
          <Divider />
          <Typography variant="body2" color="text.secondary">
            Sign in again to switch account or Jira instance.
          </Typography>
        </>
      )}

      {/* Authentication method selector */}
      <Box>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Authentication method
        </Typography>
        <ToggleButtonGroup
          value={authMethod}
          exclusive
          onChange={handleMethodChange}
          size="small"
          color="primary"
          fullWidth
        >
          <ToggleButton value={AUTH_METHODS.BASIC}>
            Username &amp; Password
            {defaultMethod === AUTH_METHODS.BASIC && (
              <Chip label="Default" size="small" color="primary" sx={{ ml: 1 }} />
            )}
          </ToggleButton>
          <ToggleButton value={AUTH_METHODS.PAT}>
            Personal Access Token
            {defaultMethod === AUTH_METHODS.PAT && (
              <Chip label="Default" size="small" color="primary" sx={{ ml: 1 }} />
            )}
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      <TextField
        label="Jira URL"
        value={formData.jiraUrl}
        onChange={handleInputChange('jiraUrl')}
        fullWidth
        size="small"
        placeholder="https://your-jira-instance.com"
      />

      {/* Username is only required for Basic auth; PAT identifies the user by the token */}
      {!isPat && (
        <TextField
          label="Username"
          value={formData.jiraUser}
          onChange={handleInputChange('jiraUser')}
          fullWidth
          size="small"
          placeholder="your-username"
        />
      )}

      {isPat ? (
        <TextField
          label="Personal Access Token"
          type="password"
          value={formData.pat}
          onChange={handleInputChange('pat')}
          fullWidth
          size="small"
          placeholder="Paste your Jira PAT"
          helperText="Generate one in Jira under Profile → Personal Access Tokens"
        />
      ) : (
        <TextField
          label="Password"
          type="password"
          value={formData.jiraPassword}
          onChange={handleInputChange('jiraPassword')}
          fullWidth
          size="small"
          placeholder="your-password"
          helperText="Enter your Jira password"
        />
      )}

      {/* Let the user pin the currently selected method as their default */}
      <Tooltip title="Preselect this method next time you authenticate">
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
            />
          }
          label={`Set ${isPat ? 'Personal Access Token' : 'Username & Password'} as my default method`}
          disabled={authMethod === defaultMethod}
        />
      </Tooltip>

      {(localError || authError) && (
        <Alert severity="error">
          {localError || authError}
        </Alert>
      )}

      <Button
        variant="contained"
        onClick={handleAuthenticate}
        disabled={authLoading || browserSignIn}
        startIcon={authLoading && !browserSignIn ? <CircularProgress size={20} /> : null}
      >
        {authLoading && !browserSignIn ? 'Authenticating...' : 'Authenticate'}
      </Button>

      {/* For a Jira published through a gateway that insists on interactive SSO, no token
          can get through — the sign-in has to happen in a real browser. */}
      <Divider>
        <Typography variant="caption" color="text.secondary">or</Typography>
      </Divider>

      <Button
        variant="outlined"
        onClick={handleBrowserSignIn}
        disabled={authLoading || browserSignIn}
        startIcon={browserSignIn ? <CircularProgress size={20} /> : <OpenInBrowserIcon />}
      >
        {browserSignIn ? 'Waiting for browser sign-in...' : 'Sign in with browser'}
      </Button>

      {/* The window is on a screen the user cannot see, so hand them the way in. An
          instruction to "complete the sign-in in the window that opened" is worse than
          useless when no window ever appears on their desk. */}
      {browserSignIn && signInViewer && (
        <Alert severity="info" icon={<OpenInBrowserIcon fontSize="inherit" />}>
          The sign-in window is running on the server, so nothing opens on your desktop.
          {' '}
          <Link href={signInViewer} target="_blank" rel="noopener noreferrer">
            Open it here
          </Link>
          {' '}and complete the sign-in — including any MFA prompt.
        </Alert>
      )}

      <Typography variant="caption" color="text.secondary">
        {browserSignIn
          ? signInViewer
            ? 'This finishes on its own once the sign-in lands on Jira.'
            : 'A browser window has opened. Complete the sign-in there — including any MFA prompt — and it will close by itself.'
          : isPat && formData.pat?.trim()
            ? 'Opens a browser for your SSO gateway. Your token above will be used for Jira itself, so you will not be asked to log in to Jira a second time.'
            : 'Use this when your Jira sits behind a corporate SSO gateway. Opens a browser window. Tip: fill in a Personal Access Token above and you will only have to sign in once, to your organisation — Jira will not ask again.'}
      </Typography>
    </Box>
  );
}
