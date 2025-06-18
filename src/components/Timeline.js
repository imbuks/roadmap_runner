import React, { useState } from 'react';
import Timeline from 'react-calendar-timeline';
import 'react-calendar-timeline/dist/style.css';
import { Box, ButtonGroup, Button } from '@mui/material';

// groups: [{ id, title, ... }]
// items: [{ id, group, title, start_time, end_time, style }]
// options: { min, max, ... }

const ZOOM_LEVELS = {
  ONE_MONTH: 30 * 24 * 60 * 60 * 1000,
  THREE_MONTHS: 90 * 24 * 60 * 60 * 1000,
  SIX_MONTHS: 180 * 24 * 60 * 60 * 1000,
  NINE_MONTHS: 270 * 24 * 60 * 60 * 1000,
  ONE_YEAR: 365 * 24 * 60 * 60 * 1000
};

export default function TimelineWrapper({ groups, items, options }) {
  const [zoom, setZoom] = useState(ZOOM_LEVELS.ONE_MONTH);

  // react-calendar-timeline expects moment or Date objects for start_time/end_time
  // and group.id/item.id must be unique
  return (
    <div>
      <Box 
        sx={{ 
          display: 'flex',
          justifyContent: 'flex-end',
          marginBottom: 2
        }}
      >
        <ButtonGroup size="small" variant="outlined">
          <Button 
            onClick={() => setZoom(ZOOM_LEVELS.ONE_MONTH)}
            variant={zoom === ZOOM_LEVELS.ONE_MONTH ? 'contained' : 'outlined'}
          >
            1M
          </Button>
          <Button 
            onClick={() => setZoom(ZOOM_LEVELS.THREE_MONTHS)}
            variant={zoom === ZOOM_LEVELS.THREE_MONTHS ? 'contained' : 'outlined'}
          >
            3M
          </Button>
          <Button 
            onClick={() => setZoom(ZOOM_LEVELS.SIX_MONTHS)}
            variant={zoom === ZOOM_LEVELS.SIX_MONTHS ? 'contained' : 'outlined'}
          >
            6M
          </Button>
          <Button 
            onClick={() => setZoom(ZOOM_LEVELS.NINE_MONTHS)}
            variant={zoom === ZOOM_LEVELS.NINE_MONTHS ? 'contained' : 'outlined'}
          >
            9M
          </Button>
          <Button 
            onClick={() => setZoom(ZOOM_LEVELS.ONE_YEAR)}
            variant={zoom === ZOOM_LEVELS.ONE_YEAR ? 'contained' : 'outlined'}
          >
            1Y
          </Button>
        </ButtonGroup>
      </Box>
      <Timeline
        groups={groups}
        items={items}
        defaultTimeStart={options?.min || new Date()}
        defaultTimeEnd={options?.max || new Date(Date.now() + zoom)}
        canMove={false}
        canResize={false}
        stackItems
        itemHeightRatio={0.6}
        lineHeight={100}
        sidebarWidth={130}
        headerLabelGroupHeight={40}
        headerLabelHeight={40}
        minZoom={ZOOM_LEVELS.ONE_MONTH}
        maxZoom={ZOOM_LEVELS.ONE_YEAR}
        visibleTimeStart={options?.min?.valueOf()}
        visibleTimeEnd={options?.min?.valueOf() + zoom}
        itemRenderer={({ item, getItemProps }) => (
          <div {...getItemProps({
            style: {
              ...item.style,
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 500,
              fontSize: 14,
              padding: '0 16px',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              height: '100%',
              cursor: 'default'
            }
          })}>
            {item.title}
          </div>
        )}
        groupRenderer={({ group }) => (
          <div style={{
            background: group.bgColor,
            color: group.textColor,
            height: '100%',
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 500,
            fontSize: 14
          }}>
            <div>
              {group.title}
            </div>
          </div>
        )}
      />
    </div>
  );
} 