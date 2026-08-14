import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Paper,
  Typography,
  Tabs,
  Tab,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  MenuItem,
  Chip,
  IconButton,
  Alert,
  FormControl,
  InputLabel,
  Select,
  CircularProgress,
  Autocomplete
} from '@mui/material';
import { DataGrid } from '@mui/x-data-grid';
import {
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  FileCopy as CloneIcon,
  ArrowDownward as ImportIcon,
  ArrowUpward as ExportIcon,
  Refresh as RefreshIcon
} from '@mui/icons-material';
import * as XLSX from 'xlsx';
import useJiraAuth, { jiraAuthService } from '../hooks/useJiraAuth';
import { debug } from '../utils/debug';

function TabPanel(props) {
  const { children, value, index, ...other } = props;
  return (
    <div
      role="tabpanel"
      hidden={value !== index}
      id={`pi-tabpanel-${index}`}
      aria-labelledby={`pi-tab-${index}`}
      {...other}
    >
      {value === index && (
        <Box sx={{ p: 3 }}>
          {children}
        </Box>
      )}
    </div>
  );
}

export default function PIPlanner() {
  const [currentTab, setCurrentTab] = useState(0);
  const [piData, setPiData] = useState({
    currentPI: 'PI 2025.3',
    nextPI: 'PI 2025.4',
    features: [],
    epics: [],
    stories: [],
    activities: []
  });

  // Use shared Jira authentication
  const {
    sessionId: jiraSessionId,
    isAuthenticated: jiraAuthenticated,
    authError: jiraError,
    fetchProjects: fetchJiraProjectsList,
  } = useJiraAuth();

  // Jira integration state
  const [jiraProjects, setJiraProjects] = useState([]);
  // Multi-selection for epic projects and versions
  const [selectedEpicProjects, setSelectedEpicProjects] = useState([]);
  const [selectedEpicVersions, setSelectedEpicVersions] = useState([]);
  const [availableVersionsMap, setAvailableVersionsMap] = useState({}); // projectKey -> versions
  const [jiraLoading, setJiraLoading] = useState(false);
  const [jiraImportDialogOpen, setJiraImportDialogOpen] = useState(false);

  // Dialog states
  const [featureDialogOpen, setFeatureDialogOpen] = useState(false);
  const [epicDialogOpen, setEpicDialogOpen] = useState(false);
  const [storyDialogOpen, setStoryDialogOpen] = useState(false);
  const [activityDialogOpen, setActivityDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState(null);

  // Form states
  const [currentFeature, setCurrentFeature] = useState({
    id: '',
    title: '',
    status: 'In Progress',
    owner: '',
    targetPI: '',
    priority: 'Medium',
    notes: ''
  });

  const [currentEpic, setCurrentEpic] = useState({
    id: '',
    title: '',
    feature: '',
    status: 'Planned',
    owner: '',
    targetPI: '',
    storyPoints: 0,
    notes: ''
  });

  const [currentStory, setCurrentStory] = useState({
    id: '',
    title: '',
    epic: '',
    status: 'Draft',
    owner: '',
    storyPoints: 0,
    isPlaceholder: true,
    notes: ''
  });

  const [currentActivity, setCurrentActivity] = useState({
    id: '',
    type: 'Feature Closeout',
    title: '',
    assignee: '',
    dueDate: '',
    status: 'Not Started',
    priority: 'Medium',
    notes: ''
  });

  // Load data from localStorage
  useEffect(() => {
    const savedData = localStorage.getItem('piPlannerData');
    if (savedData) {
      setPiData(JSON.parse(savedData));
    } else {
      // Initialize with sample data
      initializeSampleData();
    }
  }, []);

  // Save data to localStorage
  useEffect(() => {
    localStorage.setItem('piPlannerData', JSON.stringify(piData));
  }, [piData]);

  const initializeSampleData = () => {
    const sampleData = {
      currentPI: 'PI 2025.3',
      nextPI: 'PI 2025.4',
      features: [
        {
          id: 'F001',
          title: 'Enhanced User Authentication',
          status: 'In Progress',
          owner: 'John Doe',
          targetPI: 'PI 2025.3',
          priority: 'High',
          notes: 'Need to close out remaining authentication stories'
        },
        {
          id: 'F002',
          title: 'Dashboard Analytics',
          status: 'Complete',
          owner: 'Jane Smith',
          targetPI: 'PI 2025.3',
          priority: 'Medium',
          notes: 'All analytics features completed successfully'
        }
      ],
      epics: [
        {
          id: 'E001',
          title: 'Multi-factor Authentication',
          feature: 'F001',
          status: 'In Progress',
          owner: 'John Doe',
          targetPI: 'PI 2025.3',
          storyPoints: 21,
          notes: 'Clone for next PI with SMS integration'
        }
      ],
      stories: [
        {
          id: 'S001',
          title: 'Email 2FA Implementation',
          epic: 'E001',
          status: 'Draft',
          owner: 'Dev Team A',
          storyPoints: 8,
          isPlaceholder: true,
          notes: 'Placeholder for next PI planning'
        }
      ],
      activities: [
        {
          id: 'A001',
          type: 'Feature Closeout',
          title: 'Review F001 completion criteria',
          assignee: 'John Doe',
          dueDate: '2025-09-30',
          status: 'In Progress',
          priority: 'High',
          notes: 'Need to verify all acceptance criteria met'
        }
      ]
    };
    setPiData(sampleData);
  };

  const generateId = (prefix, items) => {
    const maxId = items.reduce((max, item) => {
      const num = parseInt(item.id.replace(prefix, ''));
      return num > max ? num : max;
    }, 0);
    return `${prefix}${String(maxId + 1).padStart(3, '0')}`;
  };

  // Jira Integration Functions
  const fetchJiraProjects = useCallback(async () => {
    if (!jiraSessionId) {
      return;
    }

    setJiraLoading(true);
    try {
      const projects = await fetchJiraProjectsList();
      setJiraProjects(projects);
    } catch (error) {
      console.error('Failed to fetch Jira projects:', error);
      setJiraProjects([]);
    } finally {
      setJiraLoading(false);
    }
  }, [jiraSessionId, fetchJiraProjectsList]);

  // Debug function to inspect complete Epic payload
  const debugEpicPayload = async (epicKey) => {
    try {
      debug(`Debugging Epic payload for: ${epicKey}`);
      const response = await jiraAuthService.apiCall('debug-epic', { epicKey });
      debug('Complete Epic payload:', response.epic);
      debug('All custom fields:');
      Object.keys(response.epic.fields).forEach(fieldKey => {
        if (fieldKey.startsWith('customfield_')) {
          const value = response.epic.fields[fieldKey];
          debug(`${fieldKey}:`, value);
        }
      });
      return response.epic;
    } catch (error) {
      console.error('Error fetching Epic payload:', error);
    }
  };

  // Make debugEpicPayload available globally for console debugging
  useEffect(() => {
    window.debugEpicPayload = debugEpicPayload;
  }, []);

  const importFromJira = async () => {
    debug('Import function called');
    debug('jiraSessionId:', jiraSessionId);
    debug('selectedEpicProjects:', selectedEpicProjects);
    
    if (!jiraSessionId) {
      console.warn('Please authenticate with Jira first');
      alert('Please authenticate with Jira first');
      return;
    }
    
    if (selectedEpicProjects.length === 0) {
      console.warn('Please select at least one epic project');
      alert('Please select at least one epic project');
      return;
    }
    
    debug('Starting Epic-centric import...');
    setJiraLoading(true);
    try {
      let allFeatures = [];
      let allEpics = [];
      let allStories = [];
      const processedFeatures = new Set(); // Track processed features to avoid duplicates
      const processedEpics = new Set(); // Track processed epics to avoid duplicates
      
      // STEP 1: Fetch Epics first (Epic-centric approach)
      for (const project of selectedEpicProjects) {
        // Get versions for this project (either selected ones or all)
        const projectVersions = selectedEpicVersions.filter(v => v.projectKey === project.key);
        const versionsToProcess = projectVersions.length > 0 
          ? projectVersions 
          : [{ name: 'all', id: 'all', projectKey: project.key }];
        
        for (const version of versionsToProcess) {
          debug(`Fetching Epics for project ${project.key}, version ${version.name}`, version);
          
          // Fetch Epics for this project/version
          try {
            debug('About to call epics API with:', { 
              projectKey: project.key,
              versionId: version.id
            });
            
            const epicsData = await jiraAuthService.apiCall('epics', { 
              projectKey: project.key,
              versionId: version.id  // Use actual selected version instead of 'all'
            });
            
            debug('Raw epics API response:', epicsData);
            const epics = epicsData.epics || [];
            debug(`Found ${epics.length} epics in ${project.key}/${version.name}`);
            
            // STEP 2: For each Epic, fetch its parent Feature (if any) and its Stories
            for (const epic of epics) {
              debug('Processing epic:', epic);
              debug('Epic feature field:', epic.feature);
              const epicId = `${project.key}-${epic.id}`;
              debug('Epic ID for tracking:', epicId);
              
              // Add epic to collection (avoid duplicates)
              if (!processedEpics.has(epicId)) {
                processedEpics.add(epicId);
                allEpics.push(epic);
                
                // STEP 2A: Fetch parent Feature for this Epic (if it has an Epic Link/parent)
                debug('Epic feature field value:', epic.feature, 'Type:', typeof epic.feature);
                if (epic.feature && typeof epic.feature === 'string' && epic.feature.trim()) {
                  const featureKey = epic.feature.trim();
                  // Use the actual feature key for tracking (don't add project prefix if it's already there)
                  const featureId = featureKey.includes('-') ? featureKey : `${project.key}-${featureKey}`;
                  debug(`Epic ${epic.id}: Attempting to fetch parent feature with key:`, featureKey, 'Using featureId for tracking:', featureId);
                  
                  if (!processedFeatures.has(featureId)) {
                    processedFeatures.add(featureId);
                    try {
                      // Fetch the parent Feature/Initiative (don't pass projectKey since we're fetching by specific key)
                      debug('Calling features API with issueKey:', featureKey);
                      const featureData = await jiraAuthService.apiCall('features', { 
                        issueKey: featureKey // Pass only specific issue key to get the parent from any project
                      });
                      
                      debug('Feature API response for', featureKey, ':', featureData);
                      if (featureData.features && featureData.features.length > 0) {
                        allFeatures.push(...featureData.features);
                        debug(`✅ Found parent feature ${featureKey} for epic ${epic.id}:`, featureData.features[0]);
                      } else {
                        debug(`❌ No features found for key ${featureKey}`);
                      }
                    } catch (error) {
                      console.warn(`Failed to fetch parent feature ${featureKey} for epic ${epic.id}:`, error);
                    }
                  }
                } else {
                  if (epic.feature) {
                    debug(`⚠️ Epic ${epic.id} has non-string feature field:`, epic.feature, 'Type:', typeof epic.feature);
                  } else {
                    debug(`ℹ️ Epic ${epic.id} has no parent feature (feature field is empty)`);
                  }
                }
                
                // STEP 2B: Fetch Stories for this Epic
                try {
                  const storiesData = await jiraAuthService.apiCall('stories', { 
                    projectKey: project.key,
                    epicKey: epic.id
                    // No version filter - get all stories linked to this epic
                  });
                  const stories = storiesData.stories || [];
                  allStories.push(...stories);
                  debug(`Found ${stories.length} stories for epic ${epic.id}`);
                } catch (error) {
                  console.warn(`Failed to fetch stories for epic ${epic.id}:`, error);
                }
              }
            }
          } catch (error) {
            console.warn(`Failed to fetch epics for ${project.key}/${version.name}:`, error);
          }
        }
      }

      debug(`Epic-centric import completed: ${allEpics.length} epics, ${allFeatures.length} features, ${allStories.length} stories`);

      // Smart merge: avoid duplicates based on ID
      const mergeData = (existingData, newData) => {
        const existingIds = new Set(existingData.map(item => item.id || item.key));
        const uniqueNewData = newData.filter(item => !existingIds.has(item.id || item.key));
        const duplicatesCount = newData.length - uniqueNewData.length;
        
        return {
          mergedData: [...existingData, ...uniqueNewData],
          addedCount: uniqueNewData.length,
          duplicatesCount
        };
      };

      const featuresResult = mergeData(piData.features, allFeatures);
      const epicsResult = mergeData(piData.epics, allEpics);  
      const storiesResult = mergeData(piData.stories, allStories);

      // Update PI data with imported data
      setPiData(prev => ({
        ...prev,
        features: featuresResult.mergedData,
        epics: epicsResult.mergedData,
        stories: storiesResult.mergedData
      }));

      setJiraImportDialogOpen(false);
      
      // Show detailed import summary
      const duplicatesMessage = 
        (featuresResult.duplicatesCount + epicsResult.duplicatesCount + storiesResult.duplicatesCount) > 0 
          ? ` (${featuresResult.duplicatesCount + epicsResult.duplicatesCount + storiesResult.duplicatesCount} duplicates skipped)` 
          : '';
      
      alert(`Successfully imported: ${featuresResult.addedCount} features, ${epicsResult.addedCount} epics, ${storiesResult.addedCount} stories${duplicatesMessage}`);
      
    } catch (error) {
      console.error('Import failed:', error.message);
      alert('Import failed: ' + error.message);
    } finally {
      setJiraLoading(false);
    }
  };

  const handleEpicProjectsChange = async (projects) => {
    setSelectedEpicProjects(projects);
    setSelectedEpicVersions([]); // Reset version selections when projects change
    
    // Fetch versions for all selected projects
    const versionsMap = {};
    for (const project of projects) {
      try {
        const data = await jiraAuthService.apiCall('versions', { projectKey: project.key });
        versionsMap[project.key] = data.versions || [];
      } catch (error) {
        console.error(`Failed to fetch versions for project ${project.key}:`, error);
        versionsMap[project.key] = [];
      }
    }
    setAvailableVersionsMap(versionsMap);
  };

  const getAllAvailableVersions = () => {
    const allVersions = [];
    selectedEpicProjects.forEach(project => {
      const projectVersions = availableVersionsMap[project.key] || [];
      projectVersions.forEach(version => {
        allVersions.push({
          ...version,
          projectKey: project.key,
          projectName: project.name,
          displayName: `${version.name} (${project.key})`
        });
      });
    });
    return allVersions.filter(v => !v.archived);
  };

  // Fetch projects when session is available
  useEffect(() => {
    if (jiraSessionId) {
      fetchJiraProjects();
    } else {
      setJiraProjects([]);
      setSelectedEpicProjects([]);
      setSelectedEpicVersions([]);
    }
  }, [jiraSessionId, fetchJiraProjects]);

  // Feature management functions
  const handleFeatureSubmit = () => {
    const newFeature = {
      ...currentFeature,
      id: editingItem ? currentFeature.id : generateId('F', piData.features)
    };

    if (editingItem) {
      setPiData(prev => ({
        ...prev,
        features: prev.features.map(f => f.id === editingItem.id ? newFeature : f)
      }));
    } else {
      setPiData(prev => ({
        ...prev,
        features: [...prev.features, newFeature]
      }));
    }

    resetFeatureForm();
    setFeatureDialogOpen(false);
  };

  const resetFeatureForm = () => {
    setCurrentFeature({
      id: '',
      title: '',
      status: 'In Progress',
      owner: '',
      targetPI: '',
      priority: 'Medium',
      notes: ''
    });
    setEditingItem(null);
  };

  const handleEditFeature = (feature) => {
    setCurrentFeature(feature);
    setEditingItem(feature);
    setFeatureDialogOpen(true);
  };

  const handleDeleteFeature = (featureId) => {
    setPiData(prev => ({
      ...prev,
      features: prev.features.filter(f => f.id !== featureId)
    }));
  };

  // Epic management functions
  const handleEpicSubmit = () => {
    const newEpic = {
      ...currentEpic,
      id: editingItem ? currentEpic.id : generateId('E', piData.epics)
    };

    if (editingItem) {
      setPiData(prev => ({
        ...prev,
        epics: prev.epics.map(e => e.id === editingItem.id ? newEpic : e)
      }));
    } else {
      setPiData(prev => ({
        ...prev,
        epics: [...prev.epics, newEpic]
      }));
    }

    resetEpicForm();
    setEpicDialogOpen(false);
  };

  const resetEpicForm = () => {
    setCurrentEpic({
      id: '',
      title: '',
      feature: '',
      status: 'Planned',
      owner: '',
      targetPI: '',
      storyPoints: 0,
      notes: ''
    });
    setEditingItem(null);
  };

  const handleEditEpic = (epic) => {
    setCurrentEpic(epic);
    setEditingItem(epic);
    setEpicDialogOpen(true);
  };

  const handleCloneEpic = (epic) => {
    const clonedEpic = {
      ...epic,
      id: generateId('E', piData.epics),
      title: `${epic.title} (Clone)`,
      status: 'Planned',
      targetPI: piData.nextPI,
      notes: `Cloned from ${epic.id} for ${piData.nextPI}`
    };
    
    setPiData(prev => ({
      ...prev,
      epics: [...prev.epics, clonedEpic]
    }));
  };

  const handleDeleteEpic = (epicId) => {
    setPiData(prev => ({
      ...prev,
      epics: prev.epics.filter(e => e.id !== epicId)
    }));
  };

  // Story management functions
  const handleStorySubmit = () => {
    const newStory = {
      ...currentStory,
      id: editingItem ? currentStory.id : generateId('S', piData.stories)
    };

    if (editingItem) {
      setPiData(prev => ({
        ...prev,
        stories: prev.stories.map(s => s.id === editingItem.id ? newStory : s)
      }));
    } else {
      setPiData(prev => ({
        ...prev,
        stories: [...prev.stories, newStory]
      }));
    }

    resetStoryForm();
    setStoryDialogOpen(false);
  };

  const resetStoryForm = () => {
    setCurrentStory({
      id: '',
      title: '',
      epic: '',
      status: 'Draft',
      owner: '',
      storyPoints: 0,
      isPlaceholder: true,
      notes: ''
    });
    setEditingItem(null);
  };

  const handleEditStory = (story) => {
    setCurrentStory(story);
    setEditingItem(story);
    setStoryDialogOpen(true);
  };

  const handleDeleteStory = (storyId) => {
    setPiData(prev => ({
      ...prev,
      stories: prev.stories.filter(s => s.id !== storyId)
    }));
  };

  // Activity management functions
  const handleActivitySubmit = () => {
    const newActivity = {
      ...currentActivity,
      id: editingItem ? currentActivity.id : generateId('A', piData.activities)
    };

    if (editingItem) {
      setPiData(prev => ({
        ...prev,
        activities: prev.activities.map(a => a.id === editingItem.id ? newActivity : a)
      }));
    } else {
      setPiData(prev => ({
        ...prev,
        activities: [...prev.activities, newActivity]
      }));
    }

    resetActivityForm();
    setActivityDialogOpen(false);
  };

  const resetActivityForm = () => {
    setCurrentActivity({
      id: '',
      type: 'Feature Closeout',
      title: '',
      assignee: '',
      dueDate: '',
      status: 'Not Started',
      priority: 'Medium',
      notes: ''
    });
    setEditingItem(null);
  };

  const handleEditActivity = (activity) => {
    setCurrentActivity(activity);
    setEditingItem(activity);
    setActivityDialogOpen(true);
  };

  const handleDeleteActivity = (activityId) => {
    setPiData(prev => ({
      ...prev,
      activities: prev.activities.filter(a => a.id !== activityId)
    }));
  };

  // Export to Excel
  const handleExportToExcel = () => {
    const wb = XLSX.utils.book_new();
    
    // Features sheet
    const featuresWS = XLSX.utils.json_to_sheet(piData.features);
    XLSX.utils.book_append_sheet(wb, featuresWS, 'Features');
    
    // Epics sheet
    const epicsWS = XLSX.utils.json_to_sheet(piData.epics);
    XLSX.utils.book_append_sheet(wb, epicsWS, 'Epics');
    
    // Stories sheet
    const storiesWS = XLSX.utils.json_to_sheet(piData.stories);
    XLSX.utils.book_append_sheet(wb, storiesWS, 'Stories');
    
    // Activities sheet
    const activitiesWS = XLSX.utils.json_to_sheet(piData.activities);
    XLSX.utils.book_append_sheet(wb, activitiesWS, 'Activities');
    
    XLSX.writeFile(wb, `PI_Planning_${piData.currentPI}_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'Complete':
      case 'Done':
        return 'success';
      case 'In Progress':
        return 'primary';
      case 'Planned':
      case 'Draft':
        return 'secondary';
      case 'Blocked':
        return 'error';
      default:
        return 'default';
    }
  };

  const getPriorityColor = (priority) => {
    switch (priority) {
      case 'High':
        return 'error';
      case 'Medium':
        return 'warning';
      case 'Low':
        return 'success';
      default:
        return 'default';
    }
  };

  // Feature columns for DataGrid
  const featureColumns = [
    { field: 'id', headerName: 'ID', width: 80 },
    { field: 'title', headerName: 'Feature Title', width: 300, editable: true },
    { 
      field: 'status', 
      headerName: 'Status', 
      width: 120,
      renderCell: (params) => (
        <Chip 
          label={params.value} 
          color={getStatusColor(params.value)} 
          size="small" 
        />
      )
    },
    { field: 'owner', headerName: 'Owner', width: 150, editable: true },
    { field: 'targetPI', headerName: 'Target PI', width: 100, editable: true },
    { 
      field: 'priority', 
      headerName: 'Priority', 
      width: 100,
      renderCell: (params) => (
        <Chip 
          label={params.value} 
          color={getPriorityColor(params.value)} 
          size="small" 
        />
      )
    },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 150,
      renderCell: (params) => (
        <Box>
          <IconButton size="small" onClick={() => handleEditFeature(params.row)}>
            <EditIcon />
          </IconButton>
          <IconButton size="small" onClick={() => handleDeleteFeature(params.row.id)}>
            <DeleteIcon />
          </IconButton>
        </Box>
      )
    }
  ];

  // Epic columns for DataGrid
  const epicColumns = [
    { field: 'id', headerName: 'ID', width: 80 },
    { field: 'title', headerName: 'Epic Title', width: 250, editable: true },
    { field: 'feature', headerName: 'Feature', width: 100 },
    { 
      field: 'status', 
      headerName: 'Status', 
      width: 120,
      renderCell: (params) => (
        <Chip 
          label={params.value} 
          color={getStatusColor(params.value)} 
          size="small" 
        />
      )
    },
    { field: 'owner', headerName: 'Owner', width: 150, editable: true },
    { field: 'targetPI', headerName: 'Target PI', width: 100 },
    { field: 'storyPoints', headerName: 'Story Points', width: 120, type: 'number' },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 180,
      renderCell: (params) => (
        <Box>
          <IconButton size="small" onClick={() => handleEditEpic(params.row)}>
            <EditIcon />
          </IconButton>
          <IconButton size="small" onClick={() => handleCloneEpic(params.row)}>
            <CloneIcon />
          </IconButton>
          <IconButton size="small" onClick={() => handleDeleteEpic(params.row.id)}>
            <DeleteIcon />
          </IconButton>
        </Box>
      )
    }
  ];

  // Story columns for DataGrid
  const storyColumns = [
    { field: 'id', headerName: 'ID', width: 80 },
    { field: 'title', headerName: 'Story Title', width: 250, editable: true },
    { field: 'epic', headerName: 'Epic', width: 100 },
    { 
      field: 'status', 
      headerName: 'Status', 
      width: 120,
      renderCell: (params) => (
        <Chip 
          label={params.value} 
          color={getStatusColor(params.value)} 
          size="small" 
        />
      )
    },
    { field: 'owner', headerName: 'Owner', width: 150, editable: true },
    { field: 'storyPoints', headerName: 'Story Points', width: 120, type: 'number' },
    { 
      field: 'isPlaceholder', 
      headerName: 'Placeholder', 
      width: 120,
      renderCell: (params) => (
        params.value ? <Chip label="Yes" color="secondary" size="small" /> : <Chip label="No" color="default" size="small" />
      )
    },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 150,
      renderCell: (params) => (
        <Box>
          <IconButton size="small" onClick={() => handleEditStory(params.row)}>
            <EditIcon />
          </IconButton>
          <IconButton size="small" onClick={() => handleDeleteStory(params.row.id)}>
            <DeleteIcon />
          </IconButton>
        </Box>
      )
    }
  ];

  // Activity columns for DataGrid
  const activityColumns = [
    { field: 'id', headerName: 'ID', width: 80 },
    { field: 'type', headerName: 'Type', width: 150 },
    { field: 'title', headerName: 'Activity Title', width: 250, editable: true },
    { field: 'assignee', headerName: 'Assignee', width: 150, editable: true },
    { field: 'dueDate', headerName: 'Due Date', width: 120, type: 'date' },
    { 
      field: 'status', 
      headerName: 'Status', 
      width: 120,
      renderCell: (params) => (
        <Chip 
          label={params.value} 
          color={getStatusColor(params.value)} 
          size="small" 
        />
      )
    },
    { 
      field: 'priority', 
      headerName: 'Priority', 
      width: 100,
      renderCell: (params) => (
        <Chip 
          label={params.value} 
          color={getPriorityColor(params.value)} 
          size="small" 
        />
      )
    },
    {
      field: 'actions',
      headerName: 'Actions',
      width: 150,
      renderCell: (params) => (
        <Box>
          <IconButton size="small" onClick={() => handleEditActivity(params.row)}>
            <EditIcon />
          </IconButton>
          <IconButton size="small" onClick={() => handleDeleteActivity(params.row.id)}>
            <DeleteIcon />
          </IconButton>
        </Box>
      )
    }
  ];

  return (
    <Box sx={{ width: '100%' }}>
      {/* Header */}
      <Paper sx={{ p: 2, mb: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="h4" component="h1">
            PI Planner
          </Typography>
          <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            <Typography variant="h6">
              Current PI: <Chip label={piData.currentPI} color="primary" />
            </Typography>
            <Typography variant="h6">
              Next PI: <Chip label={piData.nextPI} color="secondary" />
            </Typography>
            <Button
              startIcon={<ImportIcon />}
              onClick={() => setJiraImportDialogOpen(true)}
              variant="contained"
              color="secondary"
              disabled={!jiraAuthenticated}
            >
              Import from Jira
            </Button>
            <Button
              startIcon={<RefreshIcon />}
              onClick={() => {
                if (selectedEpicProjects.length > 0) {
                  debug('Refreshing data for projects:', selectedEpicProjects.map(p => p.key).join(', '), 'versions:', selectedEpicVersions.map(v => v.name).join(', '));
                  importFromJira();
                }
              }}
              variant="outlined"
              color="secondary"
              disabled={!jiraAuthenticated || selectedEpicProjects.length === 0 || jiraLoading}
              title={selectedEpicProjects.length === 0 ? 'Please select epic projects first' : 'Refresh data for selected projects and versions'}
            >
              Refresh
            </Button>
            <Button
              startIcon={<ExportIcon />}
              onClick={handleExportToExcel}
              variant="outlined"
            >
              Export to Excel
            </Button>
          </Box>
        </Box>
        
        {/* Show error if any */}
        {jiraError && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {jiraError}
          </Alert>
        )}
      </Paper>

      {/* Jira sign-in is in the app bar avatar */}

      {/* Tabs */}
      <Paper sx={{ width: '100%' }}>
        <Tabs 
          value={currentTab} 
          onChange={(e, newValue) => setCurrentTab(newValue)}
          aria-label="PI planner tabs"
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          <Tab label={`Features (${piData.features.length})`} />
          <Tab label={`Epics (${piData.epics.length})`} />
          <Tab label={`Stories (${piData.stories.length})`} />
          <Tab label={`Activities (${piData.activities.length})`} />
        </Tabs>

        {/* Features Tab */}
        <TabPanel value={currentTab} index={0}>
          <Box sx={{ mb: 2, display: 'flex', justifyContent: 'space-between' }}>
            <Typography variant="h6">Feature Management</Typography>
            <Button
              startIcon={<AddIcon />}
              variant="contained"
              onClick={() => setFeatureDialogOpen(true)}
            >
              Add Feature
            </Button>
          </Box>
          <DataGrid
            rows={piData.features}
            columns={featureColumns}
            getRowId={(row) => row.id || row.key}
            pageSize={10}
            rowsPerPageOptions={[10, 25, 50]}
            autoHeight
            disableSelectionOnClick
          />
        </TabPanel>

        {/* Epics Tab */}
        <TabPanel value={currentTab} index={1}>
          <Box sx={{ mb: 2, display: 'flex', justifyContent: 'space-between' }}>
            <Typography variant="h6">Epic Management</Typography>
            <Button
              startIcon={<AddIcon />}
              variant="contained"
              onClick={() => setEpicDialogOpen(true)}
            >
              Add Epic
            </Button>
          </Box>
          <DataGrid
            rows={piData.epics}
            columns={epicColumns}
            getRowId={(row) => row.id || row.key}
            pageSize={10}
            rowsPerPageOptions={[10, 25, 50]}
            autoHeight
            disableSelectionOnClick
          />
        </TabPanel>

        {/* Stories Tab */}
        <TabPanel value={currentTab} index={2}>
          <Box sx={{ mb: 2, display: 'flex', justifyContent: 'space-between' }}>
            <Typography variant="h6">Story Management</Typography>
            <Button
              startIcon={<AddIcon />}
              variant="contained"
              onClick={() => setStoryDialogOpen(true)}
            >
              Add Placeholder Story
            </Button>
          </Box>
          <DataGrid
            rows={piData.stories}
            columns={storyColumns}
            getRowId={(row) => row.id || row.key}
            pageSize={10}
            rowsPerPageOptions={[10, 25, 50]}
            autoHeight
            disableSelectionOnClick
          />
        </TabPanel>

        {/* Activities Tab */}
        <TabPanel value={currentTab} index={3}>
          <Box sx={{ mb: 2, display: 'flex', justifyContent: 'space-between' }}>
            <Typography variant="h6">PI Transition Activities</Typography>
            <Button
              startIcon={<AddIcon />}
              variant="contained"
              onClick={() => setActivityDialogOpen(true)}
            >
              Add Activity
            </Button>
          </Box>
          <DataGrid
            rows={piData.activities}
            columns={activityColumns}
            getRowId={(row) => row.id || row.key}
            pageSize={10}
            rowsPerPageOptions={[10, 25, 50]}
            autoHeight
            disableSelectionOnClick
          />
        </TabPanel>
      </Paper>

      {/* Feature Dialog */}
      <Dialog open={featureDialogOpen} onClose={() => setFeatureDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingItem ? 'Edit Feature' : 'Add New Feature'}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Feature Title"
            fullWidth
            value={currentFeature.title}
            onChange={(e) => setCurrentFeature({ ...currentFeature, title: e.target.value })}
          />
          <FormControl fullWidth margin="dense">
            <InputLabel>Status</InputLabel>
            <Select
              value={currentFeature.status}
              onChange={(e) => setCurrentFeature({ ...currentFeature, status: e.target.value })}
            >
              <MenuItem value="Planned">Planned</MenuItem>
              <MenuItem value="In Progress">In Progress</MenuItem>
              <MenuItem value="Complete">Complete</MenuItem>
              <MenuItem value="Blocked">Blocked</MenuItem>
            </Select>
          </FormControl>
          <TextField
            margin="dense"
            label="Owner"
            fullWidth
            value={currentFeature.owner}
            onChange={(e) => setCurrentFeature({ ...currentFeature, owner: e.target.value })}
          />
          <TextField
            margin="dense"
            label="Target PI"
            fullWidth
            value={currentFeature.targetPI}
            onChange={(e) => setCurrentFeature({ ...currentFeature, targetPI: e.target.value })}
          />
          <FormControl fullWidth margin="dense">
            <InputLabel>Priority</InputLabel>
            <Select
              value={currentFeature.priority}
              onChange={(e) => setCurrentFeature({ ...currentFeature, priority: e.target.value })}
            >
              <MenuItem value="High">High</MenuItem>
              <MenuItem value="Medium">Medium</MenuItem>
              <MenuItem value="Low">Low</MenuItem>
            </Select>
          </FormControl>
          <TextField
            margin="dense"
            label="Notes"
            fullWidth
            multiline
            rows={3}
            value={currentFeature.notes}
            onChange={(e) => setCurrentFeature({ ...currentFeature, notes: e.target.value })}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setFeatureDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleFeatureSubmit} variant="contained">
            {editingItem ? 'Update' : 'Add'} Feature
          </Button>
        </DialogActions>
      </Dialog>

      {/* Epic Dialog */}
      <Dialog open={epicDialogOpen} onClose={() => setEpicDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingItem ? 'Edit Epic' : 'Add New Epic'}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Epic Title"
            fullWidth
            value={currentEpic.title}
            onChange={(e) => setCurrentEpic({ ...currentEpic, title: e.target.value })}
          />
          <FormControl fullWidth margin="dense">
            <InputLabel>Feature</InputLabel>
            <Select
              value={currentEpic.feature}
              onChange={(e) => setCurrentEpic({ ...currentEpic, feature: e.target.value })}
            >
              {piData.features.map((feature) => (
                <MenuItem key={feature.id} value={feature.id}>
                  {feature.id} - {feature.title}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl fullWidth margin="dense">
            <InputLabel>Status</InputLabel>
            <Select
              value={currentEpic.status}
              onChange={(e) => setCurrentEpic({ ...currentEpic, status: e.target.value })}
            >
              <MenuItem value="Planned">Planned</MenuItem>
              <MenuItem value="In Progress">In Progress</MenuItem>
              <MenuItem value="Complete">Complete</MenuItem>
              <MenuItem value="Blocked">Blocked</MenuItem>
            </Select>
          </FormControl>
          <TextField
            margin="dense"
            label="Owner"
            fullWidth
            value={currentEpic.owner}
            onChange={(e) => setCurrentEpic({ ...currentEpic, owner: e.target.value })}
          />
          <TextField
            margin="dense"
            label="Target PI"
            fullWidth
            value={currentEpic.targetPI}
            onChange={(e) => setCurrentEpic({ ...currentEpic, targetPI: e.target.value })}
          />
          <TextField
            margin="dense"
            label="Story Points"
            type="number"
            fullWidth
            value={currentEpic.storyPoints}
            onChange={(e) => setCurrentEpic({ ...currentEpic, storyPoints: parseInt(e.target.value) || 0 })}
          />
          <TextField
            margin="dense"
            label="Notes"
            fullWidth
            multiline
            rows={3}
            value={currentEpic.notes}
            onChange={(e) => setCurrentEpic({ ...currentEpic, notes: e.target.value })}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEpicDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleEpicSubmit} variant="contained">
            {editingItem ? 'Update' : 'Add'} Epic
          </Button>
        </DialogActions>
      </Dialog>

      {/* Story Dialog */}
      <Dialog open={storyDialogOpen} onClose={() => setStoryDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingItem ? 'Edit Story' : 'Add New Placeholder Story'}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Story Title"
            fullWidth
            value={currentStory.title}
            onChange={(e) => setCurrentStory({ ...currentStory, title: e.target.value })}
          />
          <FormControl fullWidth margin="dense">
            <InputLabel>Epic</InputLabel>
            <Select
              value={currentStory.epic}
              onChange={(e) => setCurrentStory({ ...currentStory, epic: e.target.value })}
            >
              {piData.epics.map((epic) => (
                <MenuItem key={epic.id} value={epic.id}>
                  {epic.id} - {epic.title}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl fullWidth margin="dense">
            <InputLabel>Status</InputLabel>
            <Select
              value={currentStory.status}
              onChange={(e) => setCurrentStory({ ...currentStory, status: e.target.value })}
            >
              <MenuItem value="Draft">Draft</MenuItem>
              <MenuItem value="Ready">Ready</MenuItem>
              <MenuItem value="In Progress">In Progress</MenuItem>
              <MenuItem value="Done">Done</MenuItem>
            </Select>
          </FormControl>
          <TextField
            margin="dense"
            label="Owner"
            fullWidth
            value={currentStory.owner}
            onChange={(e) => setCurrentStory({ ...currentStory, owner: e.target.value })}
          />
          <TextField
            margin="dense"
            label="Story Points"
            type="number"
            fullWidth
            value={currentStory.storyPoints}
            onChange={(e) => setCurrentStory({ ...currentStory, storyPoints: parseInt(e.target.value) || 0 })}
          />
          <FormControl fullWidth margin="dense">
            <InputLabel>Is Placeholder</InputLabel>
            <Select
              value={currentStory.isPlaceholder}
              onChange={(e) => setCurrentStory({ ...currentStory, isPlaceholder: e.target.value })}
            >
              <MenuItem value={true}>Yes</MenuItem>
              <MenuItem value={false}>No</MenuItem>
            </Select>
          </FormControl>
          <TextField
            margin="dense"
            label="Notes"
            fullWidth
            multiline
            rows={3}
            value={currentStory.notes}
            onChange={(e) => setCurrentStory({ ...currentStory, notes: e.target.value })}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setStoryDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleStorySubmit} variant="contained">
            {editingItem ? 'Update' : 'Add'} Story
          </Button>
        </DialogActions>
      </Dialog>

      {/* Activity Dialog */}
      <Dialog open={activityDialogOpen} onClose={() => setActivityDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editingItem ? 'Edit Activity' : 'Add New Activity'}</DialogTitle>
        <DialogContent>
          <FormControl fullWidth margin="dense">
            <InputLabel>Activity Type</InputLabel>
            <Select
              value={currentActivity.type}
              onChange={(e) => setCurrentActivity({ ...currentActivity, type: e.target.value })}
            >
              <MenuItem value="Feature Closeout">Feature Closeout</MenuItem>
              <MenuItem value="Epic Creation">Epic Creation</MenuItem>
              <MenuItem value="Story Planning">Story Planning</MenuItem>
              <MenuItem value="PI Planning">PI Planning</MenuItem>
              <MenuItem value="Review">Review</MenuItem>
              <MenuItem value="Documentation">Documentation</MenuItem>
            </Select>
          </FormControl>
          <TextField
            margin="dense"
            label="Activity Title"
            fullWidth
            value={currentActivity.title}
            onChange={(e) => setCurrentActivity({ ...currentActivity, title: e.target.value })}
          />
          <TextField
            margin="dense"
            label="Assignee"
            fullWidth
            value={currentActivity.assignee}
            onChange={(e) => setCurrentActivity({ ...currentActivity, assignee: e.target.value })}
          />
          <TextField
            margin="dense"
            label="Due Date"
            type="date"
            fullWidth
            InputLabelProps={{ shrink: true }}
            value={currentActivity.dueDate}
            onChange={(e) => setCurrentActivity({ ...currentActivity, dueDate: e.target.value })}
          />
          <FormControl fullWidth margin="dense">
            <InputLabel>Status</InputLabel>
            <Select
              value={currentActivity.status}
              onChange={(e) => setCurrentActivity({ ...currentActivity, status: e.target.value })}
            >
              <MenuItem value="Not Started">Not Started</MenuItem>
              <MenuItem value="In Progress">In Progress</MenuItem>
              <MenuItem value="Complete">Complete</MenuItem>
              <MenuItem value="Blocked">Blocked</MenuItem>
            </Select>
          </FormControl>
          <FormControl fullWidth margin="dense">
            <InputLabel>Priority</InputLabel>
            <Select
              value={currentActivity.priority}
              onChange={(e) => setCurrentActivity({ ...currentActivity, priority: e.target.value })}
            >
              <MenuItem value="High">High</MenuItem>
              <MenuItem value="Medium">Medium</MenuItem>
              <MenuItem value="Low">Low</MenuItem>
            </Select>
          </FormControl>
          <TextField
            margin="dense"
            label="Notes"
            fullWidth
            multiline
            rows={3}
            value={currentActivity.notes}
            onChange={(e) => setCurrentActivity({ ...currentActivity, notes: e.target.value })}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setActivityDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleActivitySubmit} variant="contained">
            {editingItem ? 'Update' : 'Add'} Activity
          </Button>
        </DialogActions>
      </Dialog>

      {/* Jira Import Dialog */}
      <Dialog open={jiraImportDialogOpen} onClose={() => setJiraImportDialogOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>Import from Jira</DialogTitle>
        <DialogContent>
          {!jiraSessionId ? (
            <Alert severity="warning" sx={{ mb: 2 }}>
              Please authenticate with Jira first using the JiraMinator section.
            </Alert>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, mt: 1 }}>
              <Alert severity="info" sx={{ mb: 2 }}>
                Select Epic projects and versions. Features and Stories will be automatically imported based on Epic relationships.
              </Alert>
              
              {/* Epic Projects Selection */}
              <Box>
                <Typography variant="h6" gutterBottom color="primary">
                  Epic Projects
                </Typography>
                <Autocomplete
                  multiple
                  options={jiraProjects}
                  getOptionLabel={(option) => `${option.key} - ${option.name}`}
                  value={selectedEpicProjects}
                  onChange={(event, newValue) => {
                    handleEpicProjectsChange(newValue);
                  }}
                  disabled={jiraLoading}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      label="Select Epic Projects/Boards"
                      placeholder="Type to search for epic projects..."
                      variant="outlined"
                      fullWidth
                      helperText="Select one or more projects containing your epics"
                    />
                  )}
                  renderTags={(tagValue, getTagProps) =>
                    tagValue.map((option, index) => (
                      <Chip
                        label={`${option.key} - ${option.name}`}
                        {...getTagProps({ index })}
                        color="primary"
                        variant="outlined"
                      />
                    ))
                  }
                  renderOption={(props, option) => (
                    <li {...props}>
                      <Box>
                        <Typography variant="body2" fontWeight="bold">
                          {option.key}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {option.name}
                        </Typography>
                      </Box>
                    </li>
                  )}
                  filterOptions={(options, params) => {
                    const { inputValue } = params;
                    if (!inputValue) return options;
                    
                    return options.filter((option) =>
                      option.key.toLowerCase().includes(inputValue.toLowerCase()) ||
                      option.name.toLowerCase().includes(inputValue.toLowerCase())
                    );
                  }}
                  noOptionsText="No projects found"
                  clearOnEscape
                />
              </Box>

              {/* Versions Selection */}
              {selectedEpicProjects.length > 0 && (
                <Box>
                  <Typography variant="h6" gutterBottom color="secondary">
                    Versions (Optional)
                  </Typography>
                  <Autocomplete
                    multiple
                    options={getAllAvailableVersions()}
                    getOptionLabel={(option) => option.displayName}
                    value={selectedEpicVersions}
                    onChange={(event, newValue) => {
                      setSelectedEpicVersions(newValue);
                    }}
                    disabled={jiraLoading}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label="Select Versions/PIs (Optional)"
                        placeholder="Leave empty to import all versions..."
                        variant="outlined"
                        fullWidth
                        helperText="If no versions selected, all versions from selected projects will be imported"
                      />
                    )}
                    renderTags={(tagValue, getTagProps) =>
                      tagValue.map((option, index) => (
                        <Chip
                          label={option.displayName}
                          {...getTagProps({ index })}
                          color="secondary"
                          variant="outlined"
                        />
                      ))
                    }
                    renderOption={(props, option) => (
                      <li {...props}>
                        <Box>
                          <Typography variant="body2" fontWeight="bold">
                            {option.name}
                          </Typography>
                          <Typography variant="body2" color="text.secondary">
                            {option.projectName} • {option.released ? 'Released' : 'Unreleased'}
                            {option.description && ` • ${option.description}`}
                          </Typography>
                        </Box>
                      </li>
                    )}
                    groupBy={(option) => option.projectName}
                    isOptionEqualToValue={(option, value) => 
                      option.id === value.id && option.projectKey === value.projectKey
                    }
                    noOptionsText="No versions found for selected projects"
                    clearOnEscape
                  />
                </Box>
              )}

              {/* Import Preview */}
              {selectedEpicProjects.length > 0 && (
                <Paper elevation={1} sx={{ p: 2, bgcolor: 'grey.50' }}>
                  <Typography variant="h6" gutterBottom>
                    Import Preview:
                  </Typography>
                  <Typography variant="body2" sx={{ mb: 1 }}>
                    <strong>Selected Epic Projects:</strong> {selectedEpicProjects.map(p => p.key).join(', ')}
                  </Typography>
                  {selectedEpicVersions.length > 0 && (
                    <Typography variant="body2" sx={{ mb: 1 }}>
                      <strong>Selected Versions:</strong> {selectedEpicVersions.map(v => v.displayName).join(', ')}
                    </Typography>
                  )}
                  {selectedEpicVersions.length === 0 && selectedEpicProjects.length > 0 && (
                    <Typography variant="body2" sx={{ mb: 1 }}>
                      <strong>Versions:</strong> All versions from selected projects
                    </Typography>
                  )}
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
                    The following will be imported automatically:
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    • <strong>Epics</strong> from the selected projects/versions
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    • <strong>Features</strong> associated with those epics
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    • <strong>Stories</strong> linked to those epics
                  </Typography>
                </Paper>
              )}

              {jiraLoading && (
                <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                  <CircularProgress />
                  <Typography sx={{ ml: 2 }}>Loading Jira data...</Typography>
                </Box>
              )}
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setJiraImportDialogOpen(false)}>Cancel</Button>
          <Button 
            onClick={importFromJira}
            variant="contained"
            disabled={!jiraSessionId || selectedEpicProjects.length === 0 || jiraLoading}
            startIcon={jiraLoading ? <CircularProgress size={20} /> : <ImportIcon />}
          >
            {jiraLoading ? 'Importing...' : 'Import Data'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}