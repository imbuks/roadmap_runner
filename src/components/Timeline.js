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
      itemHeightRatio={0.75}
      lineHeight={60}
      groupHeight={80}
      sidebarWidth={220}
      itemRenderer={({ item, getItemProps, getResizeProps }) => (
        <div {...getItemProps({
          style: {
            ...item.style,
            borderRadius: 6,
            boxShadow: '0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 'bold',
            fontSize: 15,
            padding: '0 12px',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            height: '100%'
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
          display: 'flex',
          alignItems: 'center',
          fontWeight: 'bold',
          fontSize: 16,
          paddingLeft: 12,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {group.title}
        </div>
      )}
    />
  );
} 