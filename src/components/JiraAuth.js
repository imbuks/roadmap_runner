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
  Divider
} from '@mui/material';
import { CheckCircle as CheckCircleIcon } from '@mui/icons-material';
import useJiraAuth, { AUTH_METHODS } from '../hooks/useJiraAuth';

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

  // Load stored credentials (and preferred method) on component mount
  useEffect(() => {
    const storedCreds = getStoredCredentials();
    // Prefill non-secret fields; secrets (password / PAT) are never restored
    setFormData(prev => ({
      ...prev,
      jiraUrl: storedCreds?.jiraUrl || 'https://jiraagile.emirates.com',
      jiraUser: storedCreds?.jiraUser || ''
    }));
    // Start on the last-used method if present, else the saved default
    if (storedCreds?.authType) {
      setAuthMethod(storedCreds.authType);
    }
  }, [getStoredCredentials]);

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
        disabled={authLoading}
        startIcon={authLoading ? <CircularProgress size={20} /> : null}
      >
        {authLoading ? 'Authenticating...' : 'Authenticate'}
      </Button>
    </Box>
  );
}
