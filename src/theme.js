import { createTheme } from '@mui/material/styles';

/**
 * App-wide theme. Colours follow Atlassian's palette so the tool sits comfortably
 * alongside Jira, with softer corners, a flatter surface treatment and sentence-case
 * buttons for a more current feel.
 */
const theme = createTheme({
  palette: {
    primary: { main: '#0052CC', dark: '#0747A6', light: '#4C9AFF' },
    secondary: { main: '#6554C0' },
    success: { main: '#22A06B' },
    warning: { main: '#E56910' },
    error: { main: '#C9372C' },
    info: { main: '#0B66E4' },
    background: { default: '#F7F8FA', paper: '#FFFFFF' },
    text: { primary: '#172B4D', secondary: '#626F86' },
    divider: 'rgba(9, 30, 66, 0.14)'
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    h4: { fontWeight: 700, letterSpacing: '-0.02em' },
    h6: { fontWeight: 600, letterSpacing: '-0.01em' },
    subtitle2: { fontWeight: 600 },
    button: { textTransform: 'none', fontWeight: 600 }
  },
  components: {
    // Flat bar with a hairline rule reads cleaner than a drop shadow
    MuiAppBar: {
      defaultProps: { elevation: 0 },
      styleOverrides: {
        root: { borderBottom: '1px solid rgba(9, 30, 66, 0.14)' }
      }
    },
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiChip: { styleOverrides: { root: { fontWeight: 500 } } },
    MuiTooltip: {
      styleOverrides: {
        tooltip: { fontSize: 12, backgroundColor: 'rgba(23, 43, 77, 0.92)' }
      }
    },
    MuiDialog: {
      styleOverrides: { paper: { borderRadius: 14 } }
    },
    MuiDataGrid: {
      styleOverrides: {
        root: {
          backgroundColor: '#FFFFFF',
          border: '1px solid rgba(9, 30, 66, 0.14)'
        },
        columnHeaders: { backgroundColor: '#F7F8FA' }
      }
    }
  }
});

export default theme;
