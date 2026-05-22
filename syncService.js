/**
 * SyncService - Handles synchronization between local IndexedDB and Express/SQLite server.
 */
export const SyncService = {
  configCache: {},
  dbAdapter: null,

  /**
   * Get server URL from localStorage/cache or default to current host
   */
  getServerUrl() {
    let savedUrl = localStorage.getItem('sync-server-url') || this.configCache['sync-server-url'];
    if (!savedUrl && typeof window !== 'undefined' && window.location) {
      if (window.location.origin && window.location.protocol.startsWith('http')) {
        savedUrl = window.location.origin;
      }
    }
    return savedUrl || '';
  },

  /**
   * Set server URL in localStorage, cache and IndexedDB
   */
  setServerUrl(url) {
    localStorage.setItem('sync-server-url', url);
    this.configCache['sync-server-url'] = url;
    if (this.dbAdapter && this.dbAdapter.saveConfigItem) {
      this.dbAdapter.saveConfigItem('sync-server-url', url);
    }
  },

  /**
   * Get last sync time
   */
  getLastSyncTime() {
    return localStorage.getItem('sync-last-time') || this.configCache['sync-last-time'] || null;
  },

  /**
   * Set last sync time
   */
  setLastSyncTime(time) {
    localStorage.setItem('sync-last-time', time);
    this.configCache['sync-last-time'] = time;
    if (this.dbAdapter && this.dbAdapter.saveConfigItem) {
      this.dbAdapter.saveConfigItem('sync-last-time', time);
    }
  },

  /**
   * Run synchronization process
   */
  async sync(dbAdapter) {
    const serverUrl = this.getServerUrl();
    if (!serverUrl) {
      throw new Error('Keine Server-URL konfiguriert.');
    }

    const lastSyncTime = this.getLastSyncTime();
    
    // 1. Gather local changes since last sync
    const changes = await dbAdapter.getUnsyncedChanges(lastSyncTime);
    
    console.log('Sending changes to server:', changes);

    // 2. Post changes to server
    const response = await fetch(`${serverUrl}/api/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        lastSyncTime: lastSyncTime,
        changes: changes
      })
    });

    if (!response.ok) {
      throw new Error(`Sync-Server Fehler: ${response.statusText}`);
    }

    const data = await response.json();
    console.log('Received updates from server:', data);

    // 3. Apply server updates locally
    const stats = await dbAdapter.applyServerUpdates(data.updates);

    // 4. Update last sync time
    this.setLastSyncTime(data.serverTime);

    return {
      success: true,
      serverTime: data.serverTime,
      appliedCount: stats
    };
  }
};
