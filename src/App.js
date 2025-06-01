import React, { useState, useEffect } from "react";
import Timeline from "./components/Timeline";
import { DataGrid, GridActionsCellItem } from '@mui/x-data-grid';
import { Button, Box, TextField, MenuItem, Dialog, DialogTitle, DialogContent, DialogActions } from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';
import moment from 'moment';
import "react-calendar-timeline/dist/style.css";
import "./styles/Timeline.css";

function App() {
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
    { name: 'Communication & Engagement', color: '#7BA7D0' }
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

  const columns = [
    { field: 'capability', headerName: 'Capability', width: 200, editable: true },
    { field: 'feature', headerName: 'Feature', width: 250, editable: true },
    { field: 'startDate', headerName: 'Start Date', width: 130, editable: true, type: 'date', valueFormatter: (startDate) => { if (!startDate) return ''; return new Date(startDate).toLocaleDateString(); } },
    { field: 'endDate', headerName: 'End Date', width: 130, editable: true, type: 'date', valueFormatter: (endDate) => { if (!endDate) return ''; return new Date(endDate).toLocaleDateString(); } },
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

  return (
    <div style={{ padding: 20 }}>
      <h2>Product Roadmap Timeline</h2>
      <Box sx={{ height: 400, width: '100%', marginBottom: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
          <Button variant="contained" onClick={() => setOpenDialog(true)}>
            Add New Item
          </Button>
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
      <Button
        variant="contained"
        onClick={() => setVisible(true)}
        sx={{ marginBottom: 2 }}
        disabled={rows.length === 0}
      >
        Generate Timeline
      </Button>
      {visible && (
        <div style={{ border: '1px solid #ddd', padding: '10px', marginTop: '20px' }}>
          <Timeline groups={groups} items={items} options={options} />
        </div>
      )}
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
    </div>
  );
}

export default App;
