import React, { useState, useEffect, useRef } from "react";
import Timeline from "./components/Timeline";
import JiraAuthAvatar from "./components/JiraAuthAvatar";
import * as XLSX from 'xlsx';
import { DataGrid, GridActionsCellItem } from '@mui/x-data-grid';
import { 
  Button, 
  Box, 
  TextField, 
  MenuItem, 
  Dialog, 
  DialogTitle, 
  DialogContent, 
  DialogActions, 
  Menu, 
  MenuItem as MuiMenuItem,
  Collapse,
  Typography,
  IconButton,
  AppBar,
  Toolbar
} from '@mui/material';
import ColorLensIcon from '@mui/icons-material/ColorLens';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import MenuIcon from '@mui/icons-material/Menu';
import moment from 'moment';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import "react-calendar-timeline/dist/style.css";
import "./styles/Timeline.css";
import { BrowserRouter as Router, Routes, Route, Link, Navigate, useLocation } from 'react-router-dom';
import JiraMinator from './components/JiraMinator';
import PIPlanner from './components/PIPlanner';
import { debug } from './utils/debug';

function parseCsvDate(dateStr) {
  // Expects DD/MM/YYYY, returns YYYY-MM-DD or empty string if invalid
  if (!dateStr) return '';
  // Ensure dateStr is a string
  dateStr = String(dateStr).trim();
  if (!dateStr) return '';

  let parts;
  if (dateStr.includes('/')) {
    parts = dateStr.split('/');
  } else if (dateStr.includes('-')) {
    // Already in YYYY-MM-DD format
    if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
      return dateStr;
    }
    parts = dateStr.split('-');
  } else {
    return '';
  }

  if (parts.length !== 3) return '';

  let [d, m, y] = parts;

  // Check if it's already in YYYY-MM-DD format
  if (parts[0].length === 4) {
    [y, m, d] = parts;
  }

  if (!d || !m || !y) return '';

  // Pad day and month
  const day = d.toString().padStart(2, '0');
  const month = m.toString().padStart(2, '0');
  const year = y.toString();

  // Validate the date
  const date = new Date(`${year}-${month}-${day}`);
  if (isNaN(date.getTime())) return '';

  const result = `${year}-${month}-${day}`;
  debug(`Parsed date: "${dateStr}" -> "${result}"`);
  return result;
}

// Function to generate capabilities from existing data
function generateCapabilitiesFromData(rows) {
  const uniqueCapabilities = [...new Set(rows.map(row => row.capability).filter(Boolean))];
  const colors = [
    '#5D4C82', '#FFE0A0', '#E07A6C', '#6D4C41', '#7BA7D0', 
    '#EA632B', '#F15C75', '#9C27B0', '#FF9800', '#4CAF50', 
    '#2196F3', '#795548', '#607D8B', '#E91E63', '#3F51B5'
  ];
  
  return uniqueCapabilities.map((name, index) => ({
    name,
    color: colors[index % colors.length]
  }));
}

// The bar shows the current page's name, so pages do not need their own heading block.
// `accent` is the tail of the label tinted differently, keeping the JiraMinator wordmark.
const PAGE_TITLES = [
  { path: '/jiraminator', label: 'JiraMinator', accent: 'Minator' },
  { path: '/jira-stories', label: 'JiraMinator', accent: 'Minator' },
  { path: '/pi-planner', label: 'PI Planner' }
];
const HOME_TITLE = { path: '/', label: 'Roadmap Runner' };

// Split out so it can read the active route, which needs to happen inside the Router
function AppHeader() {
  const [navMenuAnchorEl, setNavMenuAnchorEl] = useState(null);
  const { pathname } = useLocation();
  const page = PAGE_TITLES.find(p => pathname.startsWith(p.path)) || HOME_TITLE;
  const closeMenu = () => setNavMenuAnchorEl(null);

  return (
    <AppBar position="sticky" color="primary">
      <Toolbar>
        <IconButton
          size="large"
          edge="start"
          color="inherit"
          aria-label="menu"
          onClick={(e) => setNavMenuAnchorEl(e.currentTarget)}
          sx={{ mr: 1.5 }}
        >
          <MenuIcon />
        </IconButton>
        <Typography variant="h6" component="div" sx={{ flexGrow: 1, fontWeight: 700 }}>
          {page.accent ? (
            <>
              {page.label.slice(0, page.label.length - page.accent.length)}
              <Box component="span" sx={{ color: 'rgba(255, 255, 255, 0.68)' }}>{page.accent}</Box>
            </>
          ) : page.label}
        </Typography>
        <Menu anchorEl={navMenuAnchorEl} open={Boolean(navMenuAnchorEl)} onClose={closeMenu}>
          <MuiMenuItem component={Link} to="/" onClick={closeMenu}>Roadmap Runner</MuiMenuItem>
          <MuiMenuItem component={Link} to="/jiraminator" onClick={closeMenu}>JiraMinator</MuiMenuItem>
          <MuiMenuItem component={Link} to="/pi-planner" onClick={closeMenu}>PI Planner</MuiMenuItem>
        </Menu>
        {/* Jira connection state and sign-in live here rather than on each page */}
        <JiraAuthAvatar />
      </Toolbar>
    </AppBar>
  );
}

function App() {
  const timelineRef = useRef(null);
  const csvInputRef = useRef(null);
  const excelInputRef = useRef(null);
  const [anchorEl, setAnchorEl] = useState(null);
  const [visible, setVisible] = useState(false);
  const [rows, setRows] = useState([]);
  const [applicationFilter, setApplicationFilter] = useState('All');
  const [fundingFilter, setFundingFilter] = useState('All');
  const [openDialog, setOpenDialog] = useState(false);
  const [formErrors, setFormErrors] = useState({});
  const [newRow, setNewRow] = useState({
    capability: '',
    feature: '',
    startDate: '',
    endDate: '',
    funding: ''
  });
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [tableExpanded, setTableExpanded] = useState(true);
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [csvRowsRaw, setCsvRowsRaw] = useState([]);
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false);
  const [columnMapping, setColumnMapping] = useState({ capability: '', feature: '', startDate: '', endDate: '', funding: '' });
  const requiredFields = [
    { key: 'capability', label: 'Capability' },
    { key: 'feature', label: 'Feature' },
    { key: 'startDate', label: 'Start Date' },
    { key: 'endDate', label: 'End Date' },
    { key: 'funding', label: 'Funding' }
  ];

  // Load data from localStorage on component mount
  useEffect(() => {
    const savedData = localStorage.getItem('roadmapData');
    if (savedData) {
      setRows(JSON.parse(savedData));
    }
  }, []);

  // Generate capabilities dynamically from data, with fallback to predefined ones
  const predefinedCapabilities = [
    { name: 'Immigration', color: '#5D4C82' },
    { name: 'Briefing Pack Manager', color: '#FFE0A0' },
    { name: 'Monitoring & Admin', color: '#E07A6C' },
    { name: 'Briefing', color: '#6D4C41' },
    { name: 'Roster', color: '#7BA7D0' },
    { name: 'Duty Preparation', color: '#EA632B' },
    { name: 'Pre-Flight (Day of Ops)', color: '#F15C75' },
    { name: 'Post-Flight', color: '#9C27B0' },
    { name: 'Communication & Engagement', color: '#FF9800' },
    { name: 'Safety & Emergency', color: '#4CAF50' },
    { name: 'Performance & HR', color: '#2196F3' }
  ];

  // Extract unique applications and funding sources for dropdowns
  const applicationList = ['All', ...Array.from(new Set(rows.map(r => r.application).filter(app => app)))];
  const fundingList = ['All', ...Array.from(new Set(rows.map(r => r.funding).filter(funding => funding)))];

  // Filter rows by application and funding
  let filteredRows = rows;
  if (applicationFilter !== 'All') {
    filteredRows = filteredRows.filter(r => r.application === applicationFilter);
  }
  if (fundingFilter !== 'All') {
    filteredRows = filteredRows.filter(r => r.funding === fundingFilter);
  }

  const capabilities = filteredRows.length > 0 ? generateCapabilitiesFromData(filteredRows) : predefinedCapabilities;

  const handleSave = () => {
    localStorage.setItem('roadmapData', JSON.stringify(rows));
  };

  const handleDeleteRow = (id) => {
    const updatedRows = rows.filter(row => row.id !== id);
    setRows(updatedRows);
    localStorage.setItem('roadmapData', JSON.stringify(updatedRows));
  };

  const getContrastingTextColor = (hexColor) => {
    if (!hexColor || hexColor.length < 7) return '#000000';
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? '#000000' : '#FFFFFF';
  };

  const validateDates = (startDate, endDate) => {
    if (!startDate || !endDate) return "Both dates are required";
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return "Invalid date format";
    }
    if (start >= end) {
      return "End date must be after start date";
    }
    return null;
  };

  // Add a new ColorPicker component
  function CustomColorPicker({ capability, onColorChange }) {
    const [open, setOpen] = useState(false);
    const cap = capabilities.find(c => c.name === capability);
    const defaultColor = cap ? cap.color : '#000000';

    const handleChange = (event) => {
      onColorChange(event.target.value);
    };

    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <Box
          sx={{
            width: 24,
            height: 24,
            borderRadius: '4px',
            bgcolor: defaultColor,
            border: '1px solid #ccc'
          }}
        />
        <input
          type="color"
          value={defaultColor}
          onChange={handleChange}
          style={{ 
            opacity: 0,
            width: 0,
            height: 0,
            position: 'absolute'
          }}
        />
        <IconButton
          size="small"
          onClick={() => document.querySelector('input[type="color"]').click()}
        >
          <ColorLensIcon fontSize="small" />
        </IconButton>
      </Box>
    );
  }

  const columns = [
    { field: 'capability', headerName: 'Capability', width: 200, editable: true },
    { field: 'feature', headerName: 'Feature', width: 250, editable: true },
    { field: 'startDate', headerName: 'Start Date', width: 130, editable: true, type: 'date', valueFormatter: (startDate) => { if (!startDate) return ''; return new Date(startDate).toLocaleDateString(); } },
    { field: 'endDate', headerName: 'End Date', width: 130, editable: true, type: 'date', valueFormatter: (endDate) => { if (!endDate) return ''; return new Date(endDate).toLocaleDateString(); } },
    { field: 'funding', headerName: 'Funding', width: 120, editable: true },
    {
      field: 'color',
      headerName: 'Color',
      width: 100,
      renderCell: (params) => (
        <CustomColorPicker
          capability={params.row.capability}
          onColorChange={(newColor) => {
            const updatedCapabilities = capabilities.map(cap => 
              cap.name === params.row.capability ? { ...cap, color: newColor } : cap
            );
            // Update capabilities array
            capabilities.splice(0, capabilities.length, ...updatedCapabilities);
            // Force a re-render of the timeline
            const updatedRows = [...rows];
            setRows(updatedRows);
          }}
        />
      )
    },
    {
      field: 'actions',
      type: 'actions',
      headerName: 'Delete',
      width: 80,
      getActions: (params) => [
        <GridActionsCellItem
          icon={<DeleteIcon />}
          label="Delete"
          onClick={() => handleDeleteRow(params.id)}
          color="error"
        />,
      ],
    },
  ];

  // Map capabilities to groups for react-calendar-timeline
  const groups = capabilities
    .filter(cap => filteredRows.some(row => row.capability === cap.name))
    .map((cap, idx) => ({
      id: idx + 1,
      title: cap.name,
      bgColor: cap.color,
      textColor: getContrastingTextColor(cap.color)
    }));

  // Map features to items for react-calendar-timeline
  const items = filteredRows.map((row, idx) => {
    const groupIdx = groups.findIndex(g => g.title === row.capability);
    if (groupIdx === -1) return null;
    const cap = capabilities.find(c => c.name === row.capability);
    
    const startDate = moment(row.startDate);
    const endDate = moment(row.endDate);
    
    // Skip items with invalid dates or where end date is before start date
    if (!startDate.isValid() || !endDate.isValid() || endDate.isBefore(startDate)) {
      console.warn(`Invalid date range for item "${row.feature}": ${row.startDate} to ${row.endDate}`);
      return null;
    }
    
    return {
      id: idx + 1,
      group: groups[groupIdx].id,
      title: row.feature,
      start_time: startDate,
      end_time: endDate,
      style: {
        background: cap.color,
        color: getContrastingTextColor(cap.color),
        border: 'none',
      }
    };
  }).filter(Boolean);

  const options = {
    min: items.length ? items.reduce((min, item) => item.start_time < min ? item.start_time : min, items[0].start_time) : moment().startOf('month'),
    max: items.length ? items.reduce((max, item) => item.end_time > max ? item.end_time : max, items[0].end_time) : moment().add(1, 'month'),
  };

  const handleRowUpdate = (newRow, oldRow) => {
    if (!newRow.startDate || !newRow.endDate) {
      return oldRow;
    }
    const dateError = validateDates(newRow.startDate, newRow.endDate);
    if (dateError) {
      return oldRow;
    }
    const updatedRow = {
      ...newRow,
      startDate: newRow.startDate instanceof Date ? newRow.startDate.toISOString().split('T')[0] : newRow.startDate,
      endDate: newRow.endDate instanceof Date ? newRow.endDate.toISOString().split('T')[0] : newRow.endDate
    };
    const updatedRows = rows.map(row => (row.id === updatedRow.id ? updatedRow : row));
    setRows(updatedRows);
    localStorage.setItem('roadmapData', JSON.stringify(updatedRows));
    return updatedRow;
  };

  const handleAddRow = () => {
    const errors = {};
    if (!newRow.capability) errors.capability = "Capability is required";
    if (!newRow.feature) errors.feature = "Feature is required";
    if (!newRow.startDate) errors.startDate = "Start date is required";
    if (!newRow.endDate) errors.endDate = "End date is required";
    const dateError = validateDates(newRow.startDate, newRow.endDate);
    if (dateError) {
      errors.dates = dateError;
    }
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }
    const rowToAdd = {
      id: rows.length > 0 ? Math.max(...rows.map(r => r.id)) + 1 : 1,
      capability: newRow.capability,
      feature: newRow.feature,
      startDate: newRow.startDate,
      endDate: newRow.endDate
    };
    const updatedRows = [...rows, rowToAdd];
    setRows(updatedRows);
    localStorage.setItem('roadmapData', JSON.stringify(updatedRows));
    setNewRow({ capability: '', feature: '', startDate: '', endDate: '', funding: '' });
    setFormErrors({});
    setOpenDialog(false);
  };

  const handleExportClick = (event) => {
    setAnchorEl(event.currentTarget);
  };

  const handleExportClose = () => {
    setAnchorEl(null);
  };

  const handleExportPNG = async () => {
    if (timelineRef.current) {
      try {
        const canvas = await html2canvas(timelineRef.current, {
          scale: 2,
          backgroundColor: '#ffffff',
          logging: false
        });
        
        const link = document.createElement('a');
        link.download = 'roadmap.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
      } catch (error) {
        console.error('Error exporting PNG:', error);
      }
    }
    handleExportClose();
  };

  const handleExportPDF = async () => {
    if (timelineRef.current) {
      try {
        const canvas = await html2canvas(timelineRef.current, {
          scale: 2,
          backgroundColor: '#ffffff',
          logging: false
        });
        
        const imgData = canvas.toDataURL('image/png');
        const pdf = new jsPDF({
          orientation: 'landscape',
          unit: 'px',
          format: [canvas.width, canvas.height]
        });
        
        pdf.addImage(imgData, 'PNG', 0, 0, canvas.width, canvas.height);
        pdf.save('roadmap.pdf');
      } catch (error) {
        console.error('Error exporting PDF:', error);
      }
    }
    handleExportClose();
  };

  const handleExportCSV = () => {
    if (rows.length === 0) return;

    const headers = ['id', 'capability', 'feature', 'startDate', 'endDate'];
    const csvContent = [
      headers.join(','),
      ...rows.map(row => headers.map(header => row[header]).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'roadmap_data.csv';
    link.click();
    handleExportClose();
  };

  const handleImportClick = () => {
    // fileInputRef removed; use csvInputRef or excelInputRef instead
  };

  const handleCsvUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.csv')) {
      alert('Please upload a CSV file.');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result;
        if (!text) return;
        const lines = text.split('\n').filter(line => line.trim());
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        const dataRows = lines.slice(1).map(line => line.split(','));

        // Normalize each row and extract columns
        const newRows = dataRows.map((values, idx) => {
          // Build normalized row object
          const rowObj = {};
          headers.forEach((header, i) => {
            rowObj[header] = (values[i] || '').trim();
          });
          return {
            capability: rowObj['capability'] || 'General',
            feature: rowObj['feature'] || '',
            application: rowObj['application'] || '',
            startDate: parseCsvDate(rowObj['start date'] || rowObj['startdate'] || rowObj['start_date'] || ''),
            endDate: parseCsvDate(rowObj['end date'] || rowObj['enddate'] || rowObj['end_date'] || ''),
            id: idx + 1
          };
        }).filter(r => r.feature && (r.startDate || r.endDate));

        setRows(newRows);
        localStorage.setItem('roadmapData', JSON.stringify(newRows));
        alert(`Successfully imported ${newRows.length} rows from CSV file.`);
      } catch (error) {
        console.error('Error parsing CSV:', error);
        alert('Error parsing CSV file. Please ensure the file is properly formatted.');
      }
    };
    reader.readAsText(file);
    event.target.value = '';
  };

  const handleExcelUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!(file.name.endsWith('.xlsx') || file.name.endsWith('.xls'))) {
      alert('Please upload an Excel file (.xlsx or .xls).');
      event.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      // Use 'master' sheet or first sheet if not found
      const sheetName = workbook.SheetNames.find(n => n.toLowerCase().includes('master')) || workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      // Normalize column names and values
      const normalize = obj => {
        const out = {};
        Object.keys(obj).forEach(key => {
          let val = obj[key];
          // Handle Excel date serials
          if (typeof val === 'number' && key.toLowerCase().includes('date')) {
            // Excel date serial to JS date
            const jsDate = XLSX.SSF.parse_date_code(val);
            if (jsDate) {
              val = `${jsDate.y}-${String(jsDate.m).padStart(2,'0')}-${String(jsDate.d).padStart(2,'0')}`;
            }
          }
          out[key.trim().toLowerCase()] = String(val).trim();
        });
        return out;
      };
      const normalizedRows = json.map(normalize);
      // Debug popup removed
      const newRows = normalizedRows.map((r, idx) => ({
        capability: r.capability || 'General',
        feature: r.feature || '',
        application: r.application || '',
        funding: r.funding || '',
        startDate: parseCsvDate(r['start date'] || r['startdate'] || r.startdate || r['start_date'] || ''),
        endDate: parseCsvDate(r['end date'] || r['enddate'] || r.enddate || r['end_date'] || ''),
        id: idx + 1
      })).filter(r => r.feature && (r.startDate || r.endDate));
      // Debug popup removed
      setRows(newRows);
      localStorage.setItem('roadmapData', JSON.stringify(newRows));
      alert(`Successfully imported ${newRows.length} rows from Excel file.`);
    };
    reader.readAsArrayBuffer(file);
    event.target.value = '';
  };

  const handleClearAll = () => {
    setClearDialogOpen(true);
  };

  const handleConfirmClear = () => {
    setRows([]);
    setVisible(false);
    localStorage.removeItem('roadmapData');
    setClearDialogOpen(false);
  };

  const toggleTable = () => {
    setTableExpanded(!tableExpanded);
  };

  const handleMappingImport = () => {
    // Validate mapping
    if (!columnMapping.capability || !columnMapping.feature || !columnMapping.startDate || !columnMapping.endDate) {
      alert('Please map all required fields.');
      return;
    }
    const newRows = csvRowsRaw.map((values, index) => {
      const row = {
        capability: values[csvHeaders.indexOf(columnMapping.capability)]?.trim() || '',
        feature: values[csvHeaders.indexOf(columnMapping.feature)]?.trim() || '',
        funding: values[csvHeaders.indexOf(columnMapping.funding)]?.trim() || '',
        startDate: parseCsvDate(values[csvHeaders.indexOf(columnMapping.startDate)]?.trim() || ''),
        endDate: parseCsvDate(values[csvHeaders.indexOf(columnMapping.endDate)]?.trim() || ''),
      };
      row.id = Math.max(...rows.map(r => r.id), 0) + index + 1;
      return row;
    });
    setRows(newRows);
    localStorage.setItem('roadmapData', JSON.stringify(newRows));
    setMappingDialogOpen(false);
  };

  return (
    <Router>
      <AppHeader />
      <div style={{ padding: 20 }}>
        <Routes>
          <Route path="/jiraminator" element={<JiraMinator />} />
          {/* Keep old bookmarks working after the rename */}
          <Route path="/jira-stories" element={<Navigate to="/jiraminator" replace />} />
          <Route path="/pi-planner" element={<PIPlanner />} />
          <Route path="/" element={
            <>
              <Box sx={{ width: '100%' }}>
                <Box 
                  sx={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    marginBottom: 2,
                    backgroundColor: '#f5f5f5',
                    padding: '8px 16px',
                    borderRadius: '4px'
                  }}
                  onClick={toggleTable}
                  style={{ cursor: 'pointer' }}
                >
                  <Typography variant="h6" component="div">
                    Data Table
                  </Typography>
                  {tableExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                </Box>

                <Collapse in={tableExpanded}>
        <Box sx={{ height: 400, width: '100%', marginBottom: 2 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
            <Box sx={{ mb: 3, display: 'flex', gap: 2 }}>
              <Button
                variant="outlined"
                startIcon={<FileUploadIcon />}
                onClick={() => csvInputRef.current?.click()}
              >
                Upload CSV
              </Button>
              <input
                type="file"
                accept=".csv"
                ref={csvInputRef}
                style={{ display: 'none' }}
                onChange={handleCsvUpload}
              />
              <Button
                variant="outlined"
                startIcon={<FileUploadIcon />}
                onClick={() => excelInputRef.current?.click()}
              >
                Upload Excel
              </Button>
              <input
                type="file"
                accept=".xlsx,.xls"
                ref={excelInputRef}
                style={{ display: 'none' }}
                onChange={handleExcelUpload}
              />
              <Button
                variant="outlined"
                startIcon={<ClearAllIcon />}
                onClick={handleClearAll}
              >
                Clear All
              </Button>
              <Button variant="contained" color="primary" startIcon={<SaveIcon />} onClick={handleSave}>
                Save
              </Button>
            </Box>
          </Box>

          {/* Filter Dropdowns - Only visible when data exists */}
          {rows.length > 0 && (
            <Box sx={{ mb: 2, display: 'flex', gap: 2, flexWrap: 'wrap' }}>
              <TextField
                select
                label="Filter by Application"
                value={applicationFilter}
                onChange={e => setApplicationFilter(e.target.value)}
                size="small"
                sx={{ minWidth: 200 }}
              >
                {applicationList.map(app => (
                  <MenuItem key={app} value={app}>{app}</MenuItem>
                ))}
              </TextField>
              
              <TextField
                select
                label="Filter by Funding"
                value={fundingFilter}
                onChange={e => setFundingFilter(e.target.value)}
                size="small"
                sx={{ minWidth: 200 }}
              >
                {fundingList.map(funding => (
                  <MenuItem key={funding} value={funding}>{funding}</MenuItem>
                ))}
              </TextField>
            </Box>
          )}

                    <DataGrid
                      rows={filteredRows}
                      columns={columns}
                      processRowUpdate={handleRowUpdate}
                      experimentalFeatures={{ newEditingApi: true }}
                    />
                  </Box>
                </Collapse>
              </Box>

              <Box sx={{ display: 'flex', gap: 2, pt:8, pb:1}}>
                <Button
                  variant="contained"
                  onClick={() => setVisible(true)}
                  disabled={filteredRows.length === 0}
                >
                  Generate Timeline
                </Button>
                <Button
                  variant="contained"
                  color="primary"
                  startIcon={<FileDownloadIcon />}
                  onClick={handleExportClick}
                  disabled={!visible || filteredRows.length === 0}
                >
                  Export
                </Button>
                <Menu
                  anchorEl={anchorEl}
                  open={Boolean(anchorEl)}
                  onClose={handleExportClose}
                >
                  <MuiMenuItem onClick={handleExportPNG}>Export as PNG</MuiMenuItem>
                  <MuiMenuItem onClick={handleExportPDF}>Export as PDF</MuiMenuItem>
                  <MuiMenuItem onClick={handleExportCSV}>Export as CSV</MuiMenuItem>
                </Menu>
              </Box>

              <Box>
                {visible && (
                  <div ref={timelineRef} style={{ border: '1px solid #ddd', padding: '10px', overflowX: 'auto', width: '100%' }}>
                    <Timeline groups={groups} items={items} options={options} />
                  </div>
                )}
              </Box>

              <Dialog open={openDialog} onClose={() => { setOpenDialog(false); setFormErrors({}); }}>
                <DialogTitle>Add New Item</DialogTitle>
                <DialogContent>
                  <TextField
                    select
                    label="Capability"
                    value={newRow.capability}
                    onChange={(e) => setNewRow({ ...newRow, capability: e.target.value })}
                    fullWidth
                    margin="normal"
                    error={!!formErrors.capability}
                    helperText={formErrors.capability}
                  >
                    {capabilities.map((option) => (
                      <MenuItem key={option.name} value={option.name}>
                        {option.name}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField
                    label="Feature"
                    value={newRow.feature}
                    onChange={(e) => setNewRow({ ...newRow, feature: e.target.value })}
                    fullWidth
                    margin="normal"
                    error={!!formErrors.feature}
                    helperText={formErrors.feature}
                  />
                  <TextField
                    label="Start Date"
                    type="date"
                    value={newRow.startDate}
                    onChange={(e) => setNewRow({ ...newRow, startDate: e.target.value })}
                    fullWidth
                    margin="normal"
                    InputLabelProps={{ shrink: true }}
                    error={!!formErrors.dates}
                    helperText={formErrors.dates}
                  />
                  <TextField
                    label="End Date"
                    type="date"
                    value={newRow.endDate}
                    onChange={(e) => setNewRow({ ...newRow, endDate: e.target.value })}
                    fullWidth
                    margin="normal"
                    InputLabelProps={{ shrink: true }}
                    error={!!formErrors.dates}
                  />
                  <TextField
                    label="Funding"
                    value={newRow.funding}
                    onChange={(e) => setNewRow({ ...newRow, funding: e.target.value })}
                    fullWidth
                    margin="normal"
                    error={!!formErrors.funding}
                    helperText={formErrors.funding}
                  />
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => { setOpenDialog(false); setFormErrors({}); }}>Cancel</Button>
                  <Button onClick={handleAddRow} variant="contained">Add</Button>
                </DialogActions>
              </Dialog>
              <Dialog
                open={clearDialogOpen}
                onClose={() => setClearDialogOpen(false)}
              >
                <DialogTitle>Clear All Data?</DialogTitle>
                <DialogContent>
                  Are you sure you want to clear all data? This action cannot be undone.
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => setClearDialogOpen(false)}>Cancel</Button>
                  <Button onClick={handleConfirmClear} color="error" variant="contained">
                    Clear All
                  </Button>
                </DialogActions>
              </Dialog>
              <Dialog open={mappingDialogOpen} onClose={() => setMappingDialogOpen(false)}>
                <DialogTitle>Map CSV Columns</DialogTitle>
                <DialogContent>
                  <Typography gutterBottom>
                    Please map each required field to a column from your CSV file:
                  </Typography>
                  {requiredFields.map(field => (
                    <TextField
                      key={field.key}
                      select
                      label={field.label}
                      value={columnMapping[field.key]}
                      onChange={e => setColumnMapping({ ...columnMapping, [field.key]: e.target.value })}
                      fullWidth
                      margin="normal"
                    >
                      {csvHeaders.map(header => (
                        <MenuItem key={header} value={header}>{header}</MenuItem>
                      ))}
                    </TextField>
                  ))}
                </DialogContent>
                <DialogActions>
                  <Button onClick={() => setMappingDialogOpen(false)}>Cancel</Button>
                  <Button onClick={handleMappingImport} variant="contained">Import</Button>
                </DialogActions>
              </Dialog>
            </>
          } />
        </Routes>
      </div>
    </Router>
  );
}

export default App;
