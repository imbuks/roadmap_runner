import React from 'react';
import Timeline from 'react-calendar-timeline';
import 'react-calendar-timeline/dist/style.css';

// groups: [{ id, title, ... }]
// items: [{ id, group, title, start_time, end_time, style }]
// options: { min, max, ... }

export default function TimelineWrapper({ groups, items, options }) {
  // react-calendar-timeline expects moment or Date objects for start_time/end_time
  // and group.id/item.id must be unique
  return (
    <Timeline
      groups={groups}
      items={items}
      defaultTimeStart={options?.min || new Date()}
      defaultTimeEnd={options?.max || new Date(Date.now() + 1000 * 60 * 60 * 24 * 30)}
      canMove={false}
      canResize={false}
      stackItems
      itemHeightRatio={0.6}
      lineHeight={100}
      sidebarWidth={80}
      headerLabelGroupHeight={40}
      headerLabelHeight={40}
      minZoom={24 * 60 * 60 * 1000}
      maxZoom={365.24 * 86400 * 1000}
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
          <div style={{ transform: 'rotate(-90deg)', whiteSpace: 'nowrap' }}>
            {group.title}
          </div>
        </div>
      )}
    />
  );
} 