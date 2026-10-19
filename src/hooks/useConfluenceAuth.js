import { useSyncExternalStore } from 'react';
import { confluenceStatus } from '../utils/confluenceApi';

// Confluence's connection state — { state: 'unknown' | 'connected' | 'signed-out', user,
// baseUrl, authType } — shared by every component that shows or needs it
export default function useConfluenceAuth() {
  return useSyncExternalStore(confluenceStatus.subscribe, confluenceStatus.get);
}
