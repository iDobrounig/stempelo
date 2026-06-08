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
   * Generate a secure random token/UUID
   */
  generateUuid() {
    if (typeof self !== 'undefined' && self.crypto && self.crypto.randomUUID) {
      return self.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  },

  /**
   * Run synchronization process
   */
  async sync(dbAdapter, currentUser = null) {
    const serverUrl = this.getServerUrl();
    if (!serverUrl) {
      throw new Error('Keine Server-URL konfiguriert.');
    }

    const connectionMode = localStorage.getItem('sync-connection-mode') || this.configCache['sync-connection-mode'] || 'standalone';
    const lastSyncTime = this.getLastSyncTime();
    
    const payload = {
      lastSyncTime: lastSyncTime
    };

    if (connectionMode === 'kiosk' || connectionMode === 'create') {
      const companyCode = localStorage.getItem('sync-company-code') || this.configCache['sync-company-code'];
      const companyKey = localStorage.getItem('sync-company-key') || this.configCache['sync-company-key'];
      if (!companyCode || !companyKey) {
        throw new Error('Unternehmens-Zugangsdaten fehlen. Bitte Server-Verbindung neu konfigurieren.');
      }
      payload.company_code = companyCode;
      payload.company_key = companyKey;
    } else {
      // Personal / Standalone mode
      if (!currentUser) {
        const activeUserId = localStorage.getItem('last-logged-user-id') || this.configCache['last-logged-user-id'];
        if (activeUserId && dbAdapter) {
          currentUser = await dbAdapter.getUser(activeUserId);
        }
      }

      if (!currentUser) {
        throw new Error('Kein aktiver Benutzer zur persönlichen Synchronisation angemeldet.');
      }

      // Automatically generate a personal sync token for standalone users or employees if missing
      if (!currentUser.sync_token) {
        currentUser.sync_token = this.generateUuid();
        currentUser.updated_at = new Date().toISOString();
        if (dbAdapter) {
          await dbAdapter.saveUser(currentUser);
        }
      }

      payload.user_id = currentUser.id;
      payload.sync_token = currentUser.sync_token;
    }

    // 1. Gather local changes since last sync
    const changes = await dbAdapter.getUnsyncedChanges(lastSyncTime);
    
    // Filter changes in personal mode to only allow sending the active user's own data
    if (payload.user_id) {
      if (changes.users) changes.users = changes.users.filter(u => u.id === payload.user_id);
      if (changes.punches) changes.punches = changes.punches.filter(p => p.user_id === payload.user_id);
      if (changes.time_off) changes.time_off = changes.time_off.filter(o => o.user_id === payload.user_id);
      if (changes.audit_logs) changes.audit_logs = changes.audit_logs.filter(l => l.user_id === payload.user_id);
    }

    console.log('Sending changes to server:', changes);
    payload.changes = changes;

    // 2. Post changes to server
    const response = await fetch(`${serverUrl}/api/sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Sync-Server Fehler: ${response.statusText}`);
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
