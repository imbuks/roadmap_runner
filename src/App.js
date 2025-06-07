import React, { useState, useEffect, useRef } from "react";
import Timeline from "./components/Timeline";
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
  IconButton
} from '@mui/material';
import ColorLensIcon from '@mui/icons-material/ColorLens';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';
import FileDownloadIcon from '@mui/icons-material/FileDownload';
import FileUploadIcon from '@mui/icons-material/FileUpload';
import ClearAllIcon from '@mui/icons-material/ClearAll';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import moment from 'moment';
import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import "react-calendar-timeline/dist/style.css";
import "./styles/Timeline.css";

function App() {
  const timelineRef = useRef(null);
  const fileInputRef = useRef(null);
  const [anchorEl, setAnchorEl] = useState(null);
  const [visible, setVisible] = useState(false);
  const [rows, setRows] = useState([]);
  const [openDialog, setOpenDialog] = useState(false);
  const [formErrors, setFormErrors] = useState({});
  const [newRow, setNewRow] = useState({
    capability: '',
    feature: '',
    startDate: '',
    endDate: ''
  });
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [tableExpanded, setTableExpanded] = useState(true);

  // Load data from localStorage on component mount
  useEffect(() => {
    const savedData = localStorage.getItem('roadmapData');
    if (savedData) {
      setRows(JSON.parse(savedData));
    }
  }, []);

  const handleSave = () => {
    localStorage.setItem('roadmapData', JSON.stringify(rows));
  };

  const handleDeleteRow = (id) => {
    const updatedRows = rows.filter(row => row.id !== id);
    setRows(updatedRows);
    localStorage.setItem('roadmapData', JSON.stringify(updatedRows));
  };

  // Predefined capabilities and their colors
  const capabilities = [
    { name: 'Roster', color: '#5D4C82' },
    { name: 'Duty Preparation', color: '#FFE0A0' },
    { name: 'Pre-Flight (Day of Ops)', color: '#E07A6C' },
    { name: 'Post-Flight', color: '#6D4C41' },
    { name: 'Communication & Engagement', color: '#7BA7D0' },
    { name: 'Safety & Emegency', color: '#EA632B' },
    { name: 'Performance & HR', color: '#F15C75' }
  ];

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
    .filter(cap => rows.some(row => row.capability === cap.name))
    .map((cap, idx) => ({
      id: idx + 1,
      title: cap.name,
      bgColor: cap.color,
      textColor: getContrastingTextColor(cap.color)
    }));

  // Map features to items for react-calendar-timeline
  const items = rows.map((row, idx) => {
    const groupIdx = groups.findIndex(g => g.title === row.capability);
    if (groupIdx === -1) return null;
    const cap = capabilities.find(c => c.name === row.capability);
    return {
      id: idx + 1,
      group: groups[groupIdx].id,
      title: row.feature,
      start_time: moment(row.startDate),
      end_time: moment(row.endDate),
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
    setNewRow({ capability: '', feature: '', startDate: '', endDate: '' });
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
    fileInputRef.current?.click();
  };

  const handleFileUpload = (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result;
        if (!text) return;

        const lines = text.split('\n');
        const headers = lines[0].split(',');
        const newRows = lines.slice(1)
          .filter(line => line.trim())
          .map((line, index) => {
            const values = line.split(',');
            const row = {};
            headers.forEach((header, i) => {
              row[header.trim()] = values[i]?.trim();
            });
            // Ensure ID is unique if not provided in CSV
            row.id = row.id || Math.max(...rows.map(r => r.id), 0) + index + 1;
            return row;
          });

        setRows(newRows);
        localStorage.setItem('roadmapData', JSON.stringify(newRows));
      } catch (error) {
        console.error('Error parsing CSV:', error);
        alert('Error parsing CSV file. Please ensure the file is properly formatted.');
      }
    };
    reader.readAsText(file);
    event.target.value = ''; // Reset file input
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

  return (
    <div style={{ padding: 20 }}>
      <h1>Roadmap Runner</h1>
    
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
              <Box sx={{ display: 'flex', gap: 2 }}>
                <Button variant="contained" onClick={() => setOpenDialog(true)}>
                  Add New Item
                </Button>
                <Button
                  variant="contained"
                  color="secondary"
                  startIcon={<FileUploadIcon />}
                  onClick={handleImportClick}
                >
                  Import CSV
                </Button>
                <Button
                  variant="contained"
                  color="error"
                  startIcon={<ClearAllIcon />}
                  onClick={handleClearAll}
                  disabled={rows.length === 0}
                >
                  Clear All
                </Button>
                <input
                  type="file"
                  ref={fileInputRef}
                  style={{ display: 'none' }}
                  accept=".csv"
                  onChange={handleFileUpload}
                />
              </Box>
              <Button variant="contained" color="primary" startIcon={<SaveIcon />} onClick={handleSave}>
                Save
              </Button>
            </Box>
            <DataGrid
              rows={rows}
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
          disabled={rows.length === 0}
        >
          Generate Timeline
        </Button>
        <Button
          variant="contained"
          color="primary"
          startIcon={<FileDownloadIcon />}
          onClick={handleExportClick}
          disabled={!visible || rows.length === 0}
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
        <div ref={timelineRef} style={{ border: '1px solid #ddd', padding: '10px'}}>
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
    </div>
  );
}

export default App;
