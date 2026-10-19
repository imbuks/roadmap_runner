import React, { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import {
  Box,
  Button,
  ButtonBase,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  Link,
  TextField,
  Tooltip,
  Typography,
  Alert
} from '@mui/material';
import {
  CheckCircle as CheckCircleIcon,
  OpenInBrowser as OpenInBrowserIcon
} from '@mui/icons-material';
import useJiraAuth, { jiraAuthService, AUTH_METHODS, API_BASE } from '../hooks/useJiraAuth';
import useConfluenceAuth from '../hooks/useConfluenceAuth';
import confluenceService from '../utils/confluenceApi';
import {
  savedTokenStatus,
  forgetSavedToken,
  rememberPreference,
  setRememberPreference
} from '../utils/savedTokens';

/*
 * Jira and Confluence, connected from one place.
 *
 * Each needs its own Personal Access Token, so the dialog has a section for each and one
 * Connect for both. At launch both connections are checked — a stored session is
 * validated, a lost one is replaced from the saved token — and the dialog opens only if
 * one of them is still not connected. "Skip for now" holds it off until the app is next
 * opened (a new tab), not for good: an unconnected product is worth a reminder.
 */

// The dialog is opened from the app bar, from the launch check, and from any page that
// needs a connection it does not have (see openConnections)
let dialogOpen = false;
const dialogListeners = new Set();
const setDialogOpen = value => {
  dialogOpen = value;
  dialogListeners.forEach(listener => listener());
};
const subscribeDialog = listener => {
  dialogListeners.add(listener);
  return () => dialogListeners.delete(listener);
};
export const openConnections = () => setDialogOpen(true);

const DISMISSED_KEY = 'connectionsPromptDismissed'; // sessionStorage: this tab only
const dismissedThisSession = () => {
  try {
    return sessionStorage.getItem(DISMISSED_KEY) === '1';
  } catch (err) {
    return false;
  }
};
const setDismissed = value => {
  try {
    if (value) sessionStorage.setItem(DISMISSED_KEY, '1');
    else sessionStorage.removeItem(DISMISSED_KEY);
  } catch (err) {
    // Only the reminder's timing is affected
  }
};

const PRODUCTS = {
  jira: {
    name: 'Jira',
    defaultUrl: 'https://jiraagile.emirates.com',
    placeholder: 'https://jira.yourcompany.com',
    tokenHelp: 'In Jira: your profile → Personal Access Tokens.',
    stored: () => {
      const creds = jiraAuthService.getStoredCredentials();
      return { url: creds?.jiraUrl, authType: creds?.authType, user: creds?.jiraUser };
    },
    signIn: (url, { authType, user, token, remember, useSaved }) =>
      jiraAuthService.authenticate(url, user, token, authType,
        authType === AUTH_METHODS.PAT ? { remember, useSaved } : undefined),
    signInWithBrowser: (url, token, options) => jiraAuthService.authenticateWithBrowser(url, token, options),
    signOut: () => jiraAuthService.logout()
  },
  confluence: {
    name: 'Confluence',
    defaultUrl: '',
    placeholder: 'https://confluence.yourcompany.com',
    tokenHelp: 'In Confluence: your profile → Settings → Personal Access Tokens.',
    stored: () => {
      const connection = confluenceService.getConnection();
      return { url: connection?.baseUrl, authType: connection?.authType };
    },
    signIn: (url, options) => confluenceService.signIn(url, options),
    signInWithBrowser: (url, token, options) => confluenceService.signInWithBrowser(url, token, options),
    signOut: () => confluenceService.signOut()
  }
};
const KEYS = Object.keys(PRODUCTS);

function initialForm(key) {
  const stored = PRODUCTS[key].stored();
  return {
    url: stored.url || PRODUCTS[key].defaultUrl,
    // Browser sign-in is a button, not a mode, so it opens on the token form
    method: stored.authType === AUTH_METHODS.BASIC ? AUTH_METHODS.BASIC : AUTH_METHODS.PAT,
    user: stored.user || '',
    secret: '',
    saved: { saved: false },
    busy: null,   // 'token' | 'browser'
    error: ''
  };
}

/* --- App bar indicator ------------------------------------------------------------ */

function StatusDot({ state }) {
  const color = state === 'connected' ? '#79F2C0' : state === 'signed-out' ? '#FFC400' : 'rgba(255,255,255,0.4)';
  return <Box component="span" sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: color, flexShrink: 0 }} />;
}

function ConnectionsButton({ jiraState, jiraUser, confluence }) {
  const describe = (name, state, user) => (state === 'connected'
    ? `${name}: connected${user ? ` as ${user}` : ''}`
    : state === 'signed-out' ? `${name}: not connected` : `${name}: checking…`);
  const label = `${describe('Jira', jiraState, jiraUser)} · ${describe('Confluence', confluence.state, confluence.user)}. Click to manage connections.`;

  return (
    <Tooltip title={label}>
      <ButtonBase
        onClick={openConnections}
        aria-label={label}
        sx={{
          ml: 1,
          px: 1.5,
          py: 0.75,
          gap: 1.5,
          borderRadius: 5,
          border: '1px solid rgba(255,255,255,0.35)',
          color: 'common.white',
          fontSize: 13,
          fontWeight: 600,
          '&:hover': { bgcolor: 'rgba(255,255,255,0.12)' }
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}><StatusDot state={jiraState} />Jira</Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}><StatusDot state={confluence.state} />Confluence</Box>
      </ButtonBase>
    </Tooltip>
  );
}

/* --- One product's section of the dialog ------------------------------------------ */

function ProductSection({ productKey, form, patch, connected, checking, connectedAs, connectedUrl, onBrowser, onForget, onSignOut, signInViewer }) {
  const product = PRODUCTS[productKey];
  const isPat = form.method === AUTH_METHODS.PAT;
  const busy = !!form.busy;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="subtitle2" sx={{ flex: 1 }}>{product.name}</Typography>
        {connected && <Button size="small" onClick={onSignOut}>Sign out</Button>}
      </Box>

      {checking ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={16} />
          <Typography variant="body2" color="text.secondary">Checking your {product.name} connection…</Typography>
        </Box>
      ) : connected ? (
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <CheckCircleIcon color="success" fontSize="small" />
            <Typography variant="body2">
              Connected{connectedAs ? <> as <strong>{connectedAs}</strong></> : ''}
            </Typography>
          </Box>
          {connectedUrl && (
            <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all', pl: 3.5 }}>
              {connectedUrl}
            </Typography>
          )}
        </Box>
      ) : (
        <>
          <TextField
            label={`${product.name} URL`}
            size="small"
            value={form.url}
            onChange={e => patch({ url: e.target.value, error: '' })}
            onBlur={() => patch({ checkSaved: true })}
            placeholder={product.placeholder}
            disabled={busy}
          />
          {isPat ? (
            <TextField
              label={`${product.name} Personal Access Token`}
              type="password"
              size="small"
              value={form.secret}
              onChange={e => patch({ secret: e.target.value, error: '' })}
              placeholder={form.saved.saved ? `Saved token ••••${form.saved.hint}` : undefined}
              InputLabelProps={form.saved.saved ? { shrink: true } : undefined}
              disabled={busy}
              helperText={form.saved.saved ? (
                <>
                  Leave blank to use your saved token, or paste a new one.{' '}
                  <Link component="button" type="button" variant="caption" onClick={onForget}>Forget it</Link>
                </>
              ) : product.tokenHelp}
            />
          ) : (
            <>
              <TextField
                label="Username"
                size="small"
                value={form.user}
                onChange={e => patch({ user: e.target.value, error: '' })}
                disabled={busy}
              />
              <TextField
                label="Password"
                type="password"
                size="small"
                value={form.secret}
                onChange={e => patch({ secret: e.target.value, error: '' })}
                disabled={busy}
              />
            </>
          )}
          {form.error && <Alert severity="error" sx={{ whiteSpace: 'pre-line' }}>{form.error}</Alert>}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Button
              size="small"
              variant="text"
              startIcon={form.busy === 'browser' ? <CircularProgress size={14} /> : <OpenInBrowserIcon fontSize="small" />}
              onClick={onBrowser}
              disabled={busy}
            >
              {form.busy === 'browser' ? 'Waiting for browser sign-in…' : 'Sign in with browser'}
            </Button>
            <Link
              component="button"
              type="button"
              variant="caption"
              disabled={busy}
              onClick={() => patch({ method: isPat ? AUTH_METHODS.BASIC : AUTH_METHODS.PAT, secret: '', error: '' })}
            >
              {isPat ? 'Use username & password instead' : 'Use a Personal Access Token instead'}
            </Link>
          </Box>
          {form.busy === 'browser' && (
            <Typography variant="caption" color="text.secondary">
              Complete the sign-in in the window that opened, including any MFA prompt. It closes by itself.
              {signInViewer && <> <Link href={signInViewer} target="_blank" rel="noopener noreferrer">Open it here</Link> if it does not appear.</>}
            </Typography>
          )}
        </>
      )}
    </Box>
  );
}

/* --- The whole thing: indicator, dialog, launch check ------------------------------ */

export default function Connections() {
  const { isAuthenticated, apiCall } = useJiraAuth();
  const confluence = useConfluenceAuth();
  const open = useSyncExternalStore(subscribeDialog, () => dialogOpen);

  const [jiraChecked, setJiraChecked] = useState(false);
  const [jiraUser, setJiraUser] = useState(null);
  const [forms, setForms] = useState(() => ({ jira: initialForm('jira'), confluence: initialForm('confluence') }));
  const [remember, setRemember] = useState(rememberPreference('jira') && rememberPreference('confluence'));
  const [connecting, setConnecting] = useState(false);
  const [signInViewer, setSignInViewer] = useState(null);

  const jiraState = !jiraChecked ? 'unknown' : isAuthenticated ? 'connected' : 'signed-out';
  const isConnected = { jira: jiraState === 'connected', confluence: confluence.state === 'connected' };
  const isChecking = { jira: jiraState === 'unknown', confluence: confluence.state === 'unknown' };

  const patchForm = useCallback((key, changes) => {
    setForms(prev => ({ ...prev, [key]: { ...prev[key], ...changes } }));
  }, []);

  const refreshSaved = useCallback(async (key, url) => {
    const saved = await savedTokenStatus(key, (url || '').trim().replace(/\/+$/, ''));
    patchForm(key, { saved });
  }, [patchForm]);

  // Launch: settle both connections, then ask only for what is still missing
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      jiraAuthService.check().catch(() => false),
      confluenceService.check()
    ]).then(([jiraOk, conf]) => {
      if (cancelled) return;
      setJiraChecked(true);
      if ((!jiraOk || conf.state !== 'connected') && !dismissedThisSession()) setDialogOpen(true);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/sign-in-viewer`)
      .then(r => r.json())
      .then(({ url }) => { if (!cancelled && url) setSignInViewer(url); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // A PAT carries no username, so ask Jira whose it is
  useEffect(() => {
    if (!isAuthenticated) {
      setJiraUser(null);
      return;
    }
    apiCall('current-user').then(r => setJiraUser(r.user && r.user.name)).catch(() => {});
  }, [isAuthenticated, apiCall]);

  // Opening the dialog starts each unconnected section from where it last connected,
  // with whatever token is saved for that site
  useEffect(() => {
    if (!open) return;
    KEYS.forEach(key => {
      if (isConnected[key]) return;
      const fresh = initialForm(key);
      setForms(prev => ({
        ...prev,
        [key]: prev[key].busy ? prev[key] : { ...prev[key], url: prev[key].url || fresh.url }
      }));
      refreshSaved(key, forms[key].url || fresh.url);
    });
    // Only on opening; edits are picked up as the URL field is left
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The URL field's blur asks for the saved token of the URL now in it
  const patchFrom = key => changes => {
    if (changes.checkSaved) {
      refreshSaved(key, forms[key].url);
      return;
    }
    patchForm(key, changes);
  };

  const signIn = async (key, how) => {
    const form = forms[key];
    const product = PRODUCTS[key];
    const url = form.url.trim();
    const isPat = form.method === AUTH_METHODS.PAT;
    const typed = form.secret.trim();
    const useSaved = isPat && !typed && form.saved.saved;
    patchForm(key, { busy: how, error: '' });
    try {
      if (how === 'browser') {
        // The token is optional here: with one, the product itself does not ask again
        const token = isPat ? typed : '';
        await product.signInWithBrowser(url, token || undefined, token || useSaved ? { remember, useSaved } : undefined);
      } else {
        await product.signIn(url, {
          authType: form.method,
          user: form.user.trim(),
          token: typed,
          ...(isPat ? { remember, useSaved } : {})
        });
      }
      if (isPat && (typed || useSaved)) setRememberPreference(key, remember);
      patchForm(key, { busy: null, secret: '' });
      refreshSaved(key, url);
      return true;
    } catch (err) {
      patchForm(key, { busy: null, error: err.message || `${product.name} sign-in failed` });
      return false;
    }
  };

  // What a section can sign in with right now, or why not
  const readiness = key => {
    const form = forms[key];
    const name = PRODUCTS[key].name;
    if (!form.url.trim()) return `Enter the ${name} URL.`;
    if (form.method === AUTH_METHODS.PAT) {
      return form.secret.trim() || form.saved.saved ? null : `Enter your ${name} Personal Access Token.`;
    }
    return form.user.trim() && form.secret.trim() ? null : 'Enter your username and password.';
  };

  // One button for both: sign in to every section that is filled in, side by side
  const connectAll = async () => {
    const pending = KEYS.filter(key => !isConnected[key] && !forms[key].busy);
    const ready = pending.filter(key => !readiness(key));
    if (!ready.length) {
      pending.forEach(key => patchForm(key, { error: readiness(key) }));
      return;
    }
    setConnecting(true);
    const results = await Promise.all(ready.map(key => signIn(key, 'token')));
    setConnecting(false);
    const nowConnected = key => isConnected[key] || (ready.includes(key) && results[ready.indexOf(key)]);
    if (KEYS.every(nowConnected)) {
      setDismissed(false);
      setDialogOpen(false);
    }
  };

  const forget = async key => {
    await forgetSavedToken(key, forms[key].url.trim().replace(/\/+$/, ''));
    patchForm(key, { saved: { saved: false } });
  };

  const signOut = async key => {
    await PRODUCTS[key].signOut();
    patchForm(key, { ...initialForm(key), saved: forms[key].saved });
    refreshSaved(key, PRODUCTS[key].stored().url);
  };

  const close = () => {
    // Closing with something unconnected is a "not now": no reminder until next launch
    if (!KEYS.every(key => isConnected[key])) setDismissed(true);
    setDialogOpen(false);
  };

  const anyBusy = connecting || KEYS.some(key => forms[key].busy);
  const allConnected = KEYS.every(key => isConnected[key]);
  const pendingCount = KEYS.filter(key => !isConnected[key] && !isChecking[key]).length;

  return (
    <>
      <ConnectionsButton jiraState={jiraState} jiraUser={jiraUser} confluence={confluence} />

      <Dialog open={open} onClose={anyBusy ? undefined : close} maxWidth="md" fullWidth>
        <DialogTitle>Connections</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Jira and Confluence each need their own Personal Access Token.
          </Typography>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: '1fr auto 1fr' },
              gap: 3
            }}
          >
            {KEYS.map((key, i) => (
              <React.Fragment key={key}>
                {i > 0 && <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', md: 'block' } }} />}
                <ProductSection
                  productKey={key}
                  form={forms[key]}
                  patch={patchFrom(key)}
                  connected={isConnected[key]}
                  checking={isChecking[key]}
                  connectedAs={key === 'jira' ? jiraUser : confluence.user}
                  connectedUrl={key === 'jira' ? PRODUCTS.jira.stored().url : confluence.baseUrl}
                  onBrowser={() => signIn(key, 'browser')}
                  onForget={() => forget(key)}
                  onSignOut={() => signOut(key)}
                  signInViewer={signInViewer}
                />
              </React.Fragment>
            ))}
          </Box>
          {!allConnected && (
            <Tooltip
              placement="bottom-start"
              title="Kept encrypted on this computer; the key stays in this browser. Used to sign you back in when a session ends."
            >
              <FormControlLabel
                sx={{ mt: 2 }}
                control={<Checkbox size="small" checked={remember} onChange={e => setRemember(e.target.checked)} />}
                label="Remember my tokens on this computer"
              />
            </Tooltip>
          )}
        </DialogContent>
        <DialogActions>
          {allConnected ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button onClick={close} disabled={anyBusy}>Skip for now</Button>
              <Button
                variant="contained"
                onClick={connectAll}
                disabled={anyBusy || pendingCount === 0}
                startIcon={connecting ? <CircularProgress size={16} color="inherit" /> : null}
              >
                {connecting ? 'Connecting…' : pendingCount > 1 ? 'Connect both' : 'Connect'}
              </Button>
            </>
          )}
        </DialogActions>
      </Dialog>
    </>
  );
}
