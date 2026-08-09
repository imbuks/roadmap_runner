import { useState, useEffect, useCallback } from 'react';

// Shared Jira authentication service
const SESSION_KEY = 'jiraSessionId';
const JIRA_CREDENTIALS_KEY = 'jiraCredentials';
const JIRA_AUTH_METHOD_KEY = 'jiraAuthMethod';

// Supported authentication methods
export const AUTH_METHODS = {
  BASIC: 'basic', // username + password/token (legacy)
  PAT: 'pat'      // Personal Access Token (Jira Data Center/Server, Bearer auth)
};

const DEFAULT_AUTH_METHOD = AUTH_METHODS.BASIC;

// Create a global event emitter for cross-component communication
class JiraAuthEventEmitter {
  constructor() {
    this.listeners = new Map();
  }

  on(event, listener) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(listener);
  }

  off(event, listener) {
    if (this.listeners.has(event)) {
      const eventListeners = this.listeners.get(event);
      const index = eventListeners.indexOf(listener);
      if (index > -1) {
        eventListeners.splice(index, 1);
      }
    }
  }

  emit(event, data) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).forEach(listener => listener(data));
    }
  }
}

const jiraAuthEmitter = new JiraAuthEventEmitter();

// Jira authentication API functions
export const jiraAuthService = {
  // Store session in both localStorage and sessionStorage for persistence
  storeSession: (sessionId) => {
    const currentSession = localStorage.getItem(SESSION_KEY);
    if (currentSession !== sessionId) {
      localStorage.setItem(SESSION_KEY, sessionId);
      sessionStorage.setItem(SESSION_KEY, sessionId);
      jiraAuthEmitter.emit('sessionChanged', sessionId);
    }
  },

  // Get stored session
  getStoredSession: () => {
    return localStorage.getItem(SESSION_KEY) || sessionStorage.getItem(SESSION_KEY);
  },

  // Clear stored session
  clearSession: () => {
    localStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(JIRA_CREDENTIALS_KEY);
    jiraAuthEmitter.emit('sessionChanged', null);
  },

  // Store credentials (optional, for convenience)
  storeCredentials: (credentials) => {
    localStorage.setItem(JIRA_CREDENTIALS_KEY, JSON.stringify(credentials));
  },

  // Get stored credentials
  getStoredCredentials: () => {
    const stored = localStorage.getItem(JIRA_CREDENTIALS_KEY);
    return stored ? JSON.parse(stored) : null;
  },

  // Get the user's preferred (default) authentication method
  getDefaultAuthMethod: () => {
    return localStorage.getItem(JIRA_AUTH_METHOD_KEY) || DEFAULT_AUTH_METHOD;
  },

  // Persist the user's preferred (default) authentication method
  setDefaultAuthMethod: (authType) => {
    if (authType === AUTH_METHODS.BASIC || authType === AUTH_METHODS.PAT) {
      localStorage.setItem(JIRA_AUTH_METHOD_KEY, authType);
    }
  },

  // Authenticate with Jira
  authenticate: async (jiraUrl, jiraUser, jiraToken, authType = DEFAULT_AUTH_METHOD) => {
    const response = await fetch('http://localhost:4000/api/jira/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jiraUrl, jiraUser, jiraToken, authType })
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Jira authentication failed');
    }

    const { sessionId } = await response.json();

    // Store session and credentials (remember which method was used)
    jiraAuthService.storeSession(sessionId);
    jiraAuthService.storeCredentials({ jiraUrl, jiraUser, authType });

    return sessionId;
  },

  // Sign out. The server keeps the session (and the token behind it) on disk so it
  // survives restarts, so ask it to forget the session before clearing local state.
  logout: async () => {
    const sessionId = jiraAuthService.getStoredSession();
    if (sessionId) {
      try {
        await fetch('http://localhost:4000/api/jira/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId })
        });
      } catch (err) {
        // Server unreachable: still sign out locally, the entry expires on its own
        console.warn('Could not reach the server to end the session:', err.message);
      }
    }
    jiraAuthService.clearSession();
  },

  // Check if session is still valid
  validateSession: async (sessionId) => {
    if (!sessionId) return false;
    
    try {
      const response = await fetch('http://localhost:4000/api/jira/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId })
      });
      
      if (response.status === 400) {
        const data = await response.json();
        if (data.error && data.error.includes('Invalid or missing Jira session')) {
          jiraAuthService.clearSession();
          return false;
        }
      }
      
      return response.ok;
    } catch (error) {
      return false;
    }
  },

  // Fetch projects
  fetchProjects: async (sessionId) => {
    const response = await fetch('http://localhost:4000/api/jira/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId })
    });

    if (!response.ok) {
      const errorData = await response.json();
      if (errorData.error && errorData.error.includes('Invalid or missing Jira session')) {
        jiraAuthService.clearSession();
        throw new Error('Session expired. Please authenticate again.');
      }
      throw new Error(errorData.error || 'Failed to fetch projects');
    }

    const data = await response.json();
    return data.projects || [];
  },

  // Generic Jira API call with session handling
  apiCall: async (endpoint, data = {}) => {
    const sessionId = jiraAuthService.getStoredSession();
    if (!sessionId) {
      throw new Error('No active Jira session. Please authenticate first.');
    }

    const response = await fetch(`http://localhost:4000/api/jira/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, ...data })
    });

    if (!response.ok) {
      const errorData = await response.json();
      if (errorData.error && errorData.error.includes('Invalid or missing Jira session')) {
        jiraAuthService.clearSession();
        throw new Error('Session expired. Please authenticate again.');
      }
      throw new Error(errorData.error || `Failed to call ${endpoint}`);
    }

    return await response.json();
  },

  // Attach files to an existing Jira issue (multipart, so it bypasses apiCall's JSON body)
  uploadAttachments: async (issueKey, files) => {
    const sessionId = jiraAuthService.getStoredSession();
    if (!sessionId) {
      throw new Error('No active Jira session. Please authenticate first.');
    }

    const formData = new FormData();
    formData.append('sessionId', sessionId);
    formData.append('issueKey', issueKey);
    files.forEach(file => formData.append('files', file, file.name));

    // Content-Type is intentionally omitted so the browser sets the multipart boundary
    const response = await fetch('http://localhost:4000/api/jira/attach', {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const errorData = await response.json();
      if (errorData.error && errorData.error.includes('Invalid or missing Jira session')) {
        jiraAuthService.clearSession();
        throw new Error('Session expired. Please authenticate again.');
      }
      throw new Error(errorData.error || 'Failed to attach files');
    }

    return await response.json();
  }
};

// Custom React hook for Jira authentication
export const useJiraAuth = () => {
  const [sessionId, setSessionId] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  // Initialize session from storage
  useEffect(() => {
    const storedSession = jiraAuthService.getStoredSession();
    if (storedSession) {
      setSessionId(storedSession);
      // Validate the stored session
      validateStoredSession(storedSession);
    }
  }, []);

  // Listen for session changes from other components
  useEffect(() => {
    const handleSessionChange = (newSessionId) => {
      setSessionId(newSessionId);
      setIsAuthenticated(!!newSessionId);
      if (!newSessionId) {
        setAuthError('');
      }
    };

    jiraAuthEmitter.on('sessionChanged', handleSessionChange);
    return () => jiraAuthEmitter.off('sessionChanged', handleSessionChange);
  }, []);

  const validateStoredSession = async (sessionId) => {
    setIsValidating(true);
    try {
      const isValid = await jiraAuthService.validateSession(sessionId);
      setIsAuthenticated(isValid);
      if (!isValid) {
        setSessionId(null);
        setAuthError('Previous session expired. Please authenticate again.');
      }
    } catch (error) {
      setIsAuthenticated(false);
      setSessionId(null);
      setAuthError('Failed to validate session');
    } finally {
      setIsValidating(false);
    }
  };

  const authenticate = useCallback(async (jiraUrl, jiraUser, jiraToken, authType) => {
    setAuthLoading(true);
    setAuthError('');

    try {
      const newSessionId = await jiraAuthService.authenticate(jiraUrl, jiraUser, jiraToken, authType);
      // Don't set state here - let the sessionChanged event handle it
      // This prevents double updates
      return newSessionId;
    } catch (error) {
      setAuthError(error.message);
      setIsAuthenticated(false);
      setSessionId(null);
      throw error;
    } finally {
      setAuthLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await jiraAuthService.logout();
    setSessionId(null);
    setIsAuthenticated(false);
    setAuthError('');
  }, []);

  const apiCall = useCallback(async (endpoint, data = {}) => {
    try {
      return await jiraAuthService.apiCall(endpoint, data);
    } catch (error) {
      if (error.message.includes('Session expired')) {
        setIsAuthenticated(false);
        setSessionId(null);
        setAuthError(error.message);
      }
      throw error;
    }
  }, []);

  // Memoize convenience methods to prevent unnecessary re-renders
  const fetchProjects = useCallback(async () => {
    const data = await apiCall('projects');
    return data.projects || [];
  }, [apiCall]);

  const fetchVersions = useCallback((projectKey) => 
    apiCall('versions', { projectKey }), [apiCall]);

  const fetchFeatures = useCallback((projectKey, versionId) => 
    apiCall('features', { projectKey, versionId }), [apiCall]);

  const fetchEpics = useCallback((projectKey, versionId, parentEpic) => 
    apiCall('epics', { projectKey, versionId, parentEpic }), [apiCall]);

  const fetchStories = useCallback((projectKey, epicKey, versionId) => 
    apiCall('stories', { projectKey, epicKey, versionId }), [apiCall]);

  return {
    sessionId,
    isAuthenticated,
    isValidating,
    authError,
    authLoading,
    authenticate,
    logout,
    apiCall,
    // Convenience methods
    getStoredCredentials: jiraAuthService.getStoredCredentials,
    getDefaultAuthMethod: jiraAuthService.getDefaultAuthMethod,
    setDefaultAuthMethod: jiraAuthService.setDefaultAuthMethod,
    fetchProjects,
    fetchVersions,
    fetchFeatures,
    fetchEpics,
    fetchStories
  };
};

export default useJiraAuth;