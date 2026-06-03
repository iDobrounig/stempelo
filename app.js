import { SyncService } from './syncService.js';
import { t, setLanguage, getLanguage, translateDOM } from './translations.js';

// Resolve Temporal (native or local polyfill)
let Temporal;
if (typeof globalThis.Temporal !== 'undefined') {
  Temporal = globalThis.Temporal;
} else {
  const tempModule = await import('./temporal-polyfill.js');
  Temporal = tempModule.Temporal;
}

// ----------------------------------------------------
// 1. IndexedDB Adapter (Sync-Ready) with iOS / Safari Fix
// ----------------------------------------------------
const DB_NAME = 'stempeluhr_db';
const DB_VERSION = 2;
let idb = null;

/**
 * Work around Safari 14+ IndexedDB open bug.
 * Safari has a bug where IDB requests can hang while the browser is starting up.
 * The solution is to keep checking the database status until it responds.
 */
function idbReady() {
  const isSafari = !navigator.userAgentData &&
    /Safari\//.test(navigator.userAgent) &&
    !/Chrom(e|ium)\//.test(navigator.userAgent);
  if (!isSafari || !indexedDB.databases) {
    return Promise.resolve();
  }
  let intervalId;
  return new Promise((resolve) => {
    const tryIdb = () => indexedDB.databases().finally(resolve);
    intervalId = setInterval(tryIdb, 100);
    tryIdb();
  }).finally(() => clearInterval(intervalId));
}

const dbAdapter = {
  open() {
    return new Promise(async (resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB wird in diesem Browser nicht unterstützt oder ist blockiert (z. B. im privaten Modus).'));
        return;
      }

      let settled = false;
      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Zeitüberschreitung (Timeout) beim Laden der IndexedDB. Das WebKit-Datenbank-Subsystem reagiert nicht.'));
        }
      }, 3000);

      try {
        await idbReady();
        
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        
        request.onerror = (event) => {
          clearTimeout(timeoutId);
          if (!settled) {
            settled = true;
            reject(event.target?.error || request.error || new Error('Datenbank konnte nicht geöffnet werden.'));
          }
        };

        request.onsuccess = () => {
          clearTimeout(timeoutId);
          if (!settled) {
            settled = true;
            idb = request.result;
            resolve(idb);
          }
        };
      
        request.onupgradeneeded = (event) => {
          const db = request.result;
          
          // Users store
          if (!db.objectStoreNames.contains('users')) {
            const store = db.createObjectStore('users', { keyPath: 'id' });
            store.createIndex('updated_at', 'updated_at', { unique: false });
          }
          
          // Punches store
          if (!db.objectStoreNames.contains('punches')) {
            const store = db.createObjectStore('punches', { keyPath: 'id' });
            store.createIndex('user_id', 'user_id', { unique: false });
            store.createIndex('updated_at', 'updated_at', { unique: false });
          }
          
          // Time Off store
          if (!db.objectStoreNames.contains('time_off')) {
            const store = db.createObjectStore('time_off', { keyPath: 'id' });
            store.createIndex('user_id', 'user_id', { unique: false });
            store.createIndex('date', 'date', { unique: false });
            store.createIndex('updated_at', 'updated_at', { unique: false });
          }
          
          // Audit Logs store
          if (!db.objectStoreNames.contains('audit_logs')) {
            db.createObjectStore('audit_logs', { keyPath: 'id' });
          }

          // Config store
          if (!db.objectStoreNames.contains('config')) {
            db.createObjectStore('config', { keyPath: 'key' });
          }
        };
      } catch (err) {
        clearTimeout(timeoutId);
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
  },

  // Load configuration from IndexedDB and sync with localStorage
  async loadConfig() {
    if (!idb) return;
    try {
      const configItems = await new Promise((resolve, reject) => {
        const tx = idb.transaction('config', 'readonly');
        const store = tx.objectStore('config');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });

      configItems.forEach(item => {
        SyncService.configCache[item.key] = item.value;
      });
    } catch (e) {
      console.warn('Failed to load config from IndexedDB:', e);
    }

    // Merge/sync with localStorage for known keys
    const keys = ['sync-server-url', 'sync-last-time', 'last-logged-user-id', 'color-scheme', 'session-expiry', 'active-tab', 'language', 'darkmode-mode', 'darkmode-start', 'darkmode-end'];
    
    // Also sync user-break-* keys if they exist in IndexedDB or localStorage
    Object.keys(SyncService.configCache).forEach(key => {
      if (key.startsWith('user-break-')) {
        if (localStorage.getItem(key) === null) {
          localStorage.setItem(key, SyncService.configCache[key]);
        }
      }
    });

    keys.forEach(key => {
      const localVal = localStorage.getItem(key);
      const dbVal = SyncService.configCache[key];

      if (dbVal !== undefined && localVal === null) {
        localStorage.setItem(key, dbVal);
      } else if (localVal !== null && dbVal === undefined) {
        SyncService.configCache[key] = localVal;
        this.saveConfigItem(key, localVal);
      } else if (localVal !== null && dbVal !== undefined && localVal !== dbVal) {
        SyncService.configCache[key] = localVal;
        this.saveConfigItem(key, localVal);
      }
    });
  },

  saveConfigItem(key, value) {
    if (!idb) return;
    try {
      const tx = idb.transaction('config', 'readwrite');
      const store = tx.objectStore('config');
      store.put({ key, value });
    } catch (e) {
      console.warn(`Failed to save config item ${key} to IndexedDB:`, e);
    }
  },

  deleteConfigItem(key) {
    if (!idb) return;
    try {
      const tx = idb.transaction('config', 'readwrite');
      const store = tx.objectStore('config');
      store.delete(key);
    } catch (e) {
      console.warn(`Failed to delete config item ${key} from IndexedDB:`, e);
    }
  },

  // Generic Helpers
  getAll(storeName) {
    return new Promise((resolve, reject) => {
      if (!idb) {
        reject(new Error('Datenbank-Verbindung ist nicht bereit. Bitte lade die Seite neu.'));
        return;
      }
      const tx = idb.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result.filter(item => !item.deleted));
      request.onerror = () => reject(request.error);
    });
  },

  get(storeName, id) {
    return new Promise((resolve, reject) => {
      if (!idb) {
        reject(new Error('Datenbank-Verbindung ist nicht bereit. Bitte lade die Seite neu.'));
        return;
      }
      const tx = idb.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(id);
      request.onsuccess = () => {
        const res = request.result;
        if (res && !res.deleted) resolve(res);
        else resolve(null);
      };
      request.onerror = () => reject(request.error);
    });
  },

  put(storeName, item) {
    return new Promise((resolve, reject) => {
      if (!idb) {
        reject(new Error('Datenbank-Verbindung ist nicht bereit. Bitte lade die Seite neu.'));
        return;
      }
      const tx = idb.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      item.updated_at = new Date().toISOString();
      const request = store.put(item);
      request.onsuccess = () => resolve(item);
      request.onerror = () => reject(request.error);
    });
  },

  // Soft Delete
  async delete(storeName, id, userId = null) {
    if (!idb) {
      throw new Error('Datenbank-Verbindung ist nicht bereit. Bitte lade die Seite neu.');
    }
    const item = await new Promise((resolve, reject) => {
      const tx = idb.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    if (item) {
      const oldData = { ...item };
      item.deleted = 1;
      item.updated_at = new Date().toISOString();
      await this.put(storeName, item);

      // Audit Log
      if (userId) {
        await this.logAudit(userId, 'delete', storeName, id, oldData, null);
      }
    }
  },

  // Audit Logger
  logAudit(userId, action, tableName, recordId, oldData, newData) {
    if (!idb) {
      return Promise.reject(new Error('Datenbank-Verbindung ist nicht bereit. Bitte lade die Seite neu.'));
    }
    const log = {
      id: crypto.randomUUID(),
      user_id: userId,
      action: action,
      table_name: tableName,
      record_id: recordId,
      old_data: oldData,
      new_data: newData,
      timestamp: new Date().toISOString()
    };
    return new Promise((resolve, reject) => {
      const tx = idb.transaction('audit_logs', 'readwrite');
      const store = tx.objectStore('audit_logs');
      const request = store.put(log);
      request.onsuccess = () => resolve(log);
      request.onerror = () => reject(request.error);
    });
  },

  // Sync Support: get changes
  getUnsyncedChanges(lastSyncTime) {
    return new Promise((resolve, reject) => {
      if (!idb) {
        reject(new Error('Datenbank-Verbindung ist nicht bereit. Bitte lade die Seite neu.'));
        return;
      }
      const cutoff = lastSyncTime ? new Date(lastSyncTime) : new Date(0);
      const changes = { users: [], punches: [], time_off: [], audit_logs: [] };
      const stores = ['users', 'punches', 'time_off', 'audit_logs'];
      let completed = 0;

      stores.forEach(storeName => {
        const tx = idb.transaction(storeName, 'readonly');
        const store = tx.objectStore(storeName);
        const request = store.openCursor();
        
        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            const item = cursor.value;
            const updated = new Date(item.updated_at || item.created_at || item.timestamp);
            if (updated > cutoff) {
              changes[storeName].push(item);
            }
            cursor.continue();
          } else {
            completed++;
            if (completed === stores.length) {
              resolve(changes);
            }
          }
        };
        request.onerror = () => reject(request.error);
      });
    });
  },

  // Sync Support: apply server updates
  async applyServerUpdates(updates) {
    if (!idb) {
      throw new Error('Datenbank-Verbindung ist nicht bereit. Bitte lade die Seite neu.');
    }
    let appliedCount = 0;

    const applyStore = async (storeName, items) => {
      if (!items || items.length === 0) return;
      
      const tx = idb.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);

      for (const item of items) {
        // Read local copy first
        const local = await new Promise(res => {
          const req = store.get(item.id);
          req.onsuccess = () => res(req.result);
          req.onerror = () => res(null);
        });

        // Upsert if server version is newer or local doesn't exist
        if (!local || new Date(item.updated_at || item.created_at || item.timestamp) > new Date(local.updated_at || local.created_at || local.timestamp)) {
          await new Promise((res, rej) => {
            const req = store.put(item);
            req.onsuccess = () => { appliedCount++; res(); };
            req.onerror = () => rej(req.error);
          });
        }
      }
    };

    await applyStore('users', updates.users);
    await applyStore('punches', updates.punches);
    await applyStore('time_off', updates.time_off);
    await applyStore('audit_logs', updates.audit_logs);

    return appliedCount;
  }
};

SyncService.dbAdapter = dbAdapter;

// ----------------------------------------------------
// 1.5 Hybrid Storage Wrappers (localStorage + IndexedDB Config Cache)
// ----------------------------------------------------
function storageGetItem(key) {
  const localVal = localStorage.getItem(key);
  if (localVal !== null) return localVal;
  return SyncService.configCache[key] !== undefined ? SyncService.configCache[key] : null;
}

function storageSetItem(key, value) {
  localStorage.setItem(key, value);
  SyncService.configCache[key] = value;
  dbAdapter.saveConfigItem(key, value);
}

function storageRemoveItem(key) {
  localStorage.removeItem(key);
  delete SyncService.configCache[key];
  dbAdapter.deleteConfigItem(key);
}

// ----------------------------------------------------
// 1.8 Global Language / Localization Helper
// ----------------------------------------------------
function applyGlobalLanguage(lang) {
  if (!lang) lang = 'de';
  setLanguage(lang);
  storageSetItem('language', lang);
  translateDOM();
  
  // Synchronize lock screen switcher state
  document.querySelectorAll('.btn-lock-lang').forEach(btn => {
    if (btn.getAttribute('data-lang') === lang) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Keep settings language dropdown selector value in sync
  const setLangSelect = document.getElementById('set-user-lang');
  if (setLangSelect) {
    setLangSelect.value = lang;
  }

  // Refresh dynamic parts of the DOM that are populated by JS
  if (currentUser) {
    if (currentTab === 'tab-punch') updatePunchTab();
    else if (currentTab === 'tab-history') updateHistoryTab();
    else if (currentTab === 'tab-reports') updateReportsTab();
    else if (currentTab === 'tab-settings') updateSettingsTab(true);
  }
}

// ----------------------------------------------------
// 2. State & Constants
// ----------------------------------------------------
let users = [];
let currentUser = null;
let currentTab = 'tab-punch';
let timerInterval = null;
let autolockTimerId = null;
let currentPinInput = '';
let tempCustomRules = [];
let tempActivities = [];
let activeViewUserId = null;

// Calendar View State
let historyViewMode = 'calendar'; // 'list' or 'calendar'
let calendarActiveDate = Temporal.Now.plainDateISO();

async function applyUserRoleGating(user) {
  if (!user) return;
  activeViewUserId = user.id;

  const isAdmin = user.role === 'admin';
  const teamNavItem = document.getElementById('nav-item-team');
  if (teamNavItem) {
    teamNavItem.style.display = isAdmin ? '' : 'none';
  }
  
  const adminSelectors = document.querySelectorAll('.admin-selector-container');
  adminSelectors.forEach(el => {
    if (isAdmin) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  });

  const adminSettingGroups = document.querySelectorAll('.admin-only');
  adminSettingGroups.forEach(el => {
    if (isAdmin) {
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  });

  if (isAdmin) {
    await populateAdminUserSelectors();
  }
}

function getViewedUser() {
  if (!currentUser) return null;
  if (!activeViewUserId || activeViewUserId === currentUser.id) return currentUser;
  return users.find(u => u.id === activeViewUserId) || currentUser;
}

async function populateAdminUserSelectors() {
  const selectors = document.querySelectorAll('.admin-user-select');
  if (selectors.length === 0) return;

  const allUsers = await dbAdapter.getAll('users');
  const activeAndInactiveUsers = allUsers.filter(u => !u.deleted);

  selectors.forEach(select => {
    const currentVal = select.value || activeViewUserId || currentUser?.id;
    select.innerHTML = '';
    activeAndInactiveUsers.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.id;
      opt.textContent = u.name + (u.is_active === 0 || u.is_active === false ? ' (Inaktiv)' : '');
      select.appendChild(opt);
    });
    if (activeAndInactiveUsers.some(u => u.id === currentVal)) {
      select.value = currentVal;
    } else if (activeViewUserId && activeAndInactiveUsers.some(u => u.id === activeViewUserId)) {
      select.value = activeViewUserId;
    } else if (currentUser && activeAndInactiveUsers.some(u => u.id === currentUser.id)) {
      select.value = currentUser.id;
    }
  });
}

function handleAdminUserSelectChange(e) {
  const newUserId = e.target.value;
  if (!newUserId) return;
  activeViewUserId = newUserId;
  
  const selectors = document.querySelectorAll('.admin-user-select');
  selectors.forEach(select => {
    select.value = newUserId;
  });

  if (currentTab === 'tab-history') updateHistoryTab();
  else if (currentTab === 'tab-reports') updateReportsTab();
  else if (currentTab === 'tab-settings') updateSettingsTab();
}

function calculateWeeklyActualHours(user, punches, timeOffs) {
  const today = Temporal.Now.plainDateISO();
  const wday = today.dayOfWeek;
  const startOfWeek = today.subtract({ days: wday - 1 });
  const endOfWeek = startOfWeek.add({ days: 6 });
  
  const userPunches = punches.filter(p => p.user_id === user.id);
  const userTimeOff = timeOffs.filter(o => o.user_id === user.id);
  
  const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  let totalIst = 0;
  
  let iter = startOfWeek;
  while (Temporal.PlainDate.compare(iter, endOfWeek) <= 0) {
    const dateStr = iter.toString();
    const dayWday = iter.dayOfWeek;
    const daySoll = user.daily_soll[weekdayKeys[dayWday - 1]] || 0;
    
    const dayPunches = userPunches.filter(p => p.start_time.startsWith(dateStr));
    const dayTimeOff = userTimeOff.find(o => o.date === dateStr);
    
    const stats = calculateDayDetails(daySoll, dayPunches, dayTimeOff);
    totalIst += stats.istHours;
    
    iter = iter.add({ days: 1 });
  }
  
  return totalIst;
}

async function updateTeamTab() {
  if (!currentUser || currentUser.role !== 'admin') return;

  const container = document.getElementById('team-list-container');
  if (!container) return;
  container.innerHTML = '';

  const allUsers = await dbAdapter.getAll('users');
  const allPunches = await dbAdapter.getAll('punches');
  const allTimeOff = await dbAdapter.getAll('time_off');

  const activeAndInactiveUsers = allUsers.filter(u => !u.deleted);

  activeAndInactiveUsers.sort((a, b) => {
    const aActive = a.is_active !== 0 && a.is_active !== false;
    const bActive = b.is_active !== 0 && b.is_active !== false;
    if (aActive !== bActive) {
      return aActive ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  activeAndInactiveUsers.forEach(user => {
    const activePunch = allPunches.find(p => p.user_id === user.id && !p.end_time);
    const isBreakActive = storageGetItem(`user-break-active-${user.id}`) === 'true';
    
    let statusText = '';
    let statusClass = 'status-stopped';
    if (isBreakActive) {
      const breakStart = storageGetItem(`user-break-start-${user.id}`);
      const timeStr = breakStart ? new Date(breakStart).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' }) : '';
      statusText = t('team-status-break', { time: timeStr });
      statusClass = 'status-break';
    } else if (activePunch) {
      const timeStr = new Date(activePunch.start_time).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' });
      const activitySuffix = activePunch.activity ? ` (${escapeHtml(activePunch.activity)})` : '';
      statusText = t('team-status-working', { time: timeStr }) + activitySuffix;
      statusClass = 'status-working';
    } else {
      statusText = t('team-status-stopped');
    }

    const weeklyHours = calculateWeeklyActualHours(user, allPunches, allTimeOff);
    const tr = document.createElement('tr');
    
    const isUserInactive = user.is_active === 0 || user.is_active === false;
    if (isUserInactive) {
      tr.style.opacity = '0.6';
    }

    const tdEmp = document.createElement('td');
    const roleBadge = user.role === 'admin' 
      ? ` <span class="tag-badge vacation" style="font-size: 0.75rem; padding: 2px 6px; margin-left: 6px;">Admin</span>`
      : '';
    tdEmp.innerHTML = `<strong>${escapeHtml(user.name)}</strong>${roleBadge}`;
    tr.appendChild(tdEmp);

    const tdStatus = document.createElement('td');
    tdStatus.innerHTML = `<span class="team-status-dot ${statusClass}"></span> ${statusText}`;
    tr.appendChild(tdStatus);

    const tdHours = document.createElement('td');
    tdHours.textContent = formatHours(weeklyHours);
    tr.appendChild(tdHours);

    const tdActions = document.createElement('td');
    tdActions.style.textAlign = 'right';

    const btnHistory = document.createElement('button');
    btnHistory.className = 'btn secondary small';
    btnHistory.style.marginRight = '6px';
    btnHistory.textContent = t('team-btn-view-history');
    btnHistory.onclick = () => viewTeamUserHistory(user.id);
    tdActions.appendChild(btnHistory);

    const btnReports = document.createElement('button');
    btnReports.className = 'btn secondary small';
    btnReports.textContent = t('team-btn-view-reports');
    btnReports.onclick = () => viewTeamUserReports(user.id);
    tdActions.appendChild(btnReports);

    tr.appendChild(tdActions);
    container.appendChild(tr);
  });
}

function viewTeamUserHistory(userId) {
  activeViewUserId = userId;
  const selectors = document.querySelectorAll('.admin-user-select');
  selectors.forEach(select => {
    select.value = userId;
  });
  switchTab('tab-history');
}

function viewTeamUserReports(userId) {
  activeViewUserId = userId;
  const selectors = document.querySelectorAll('.admin-user-select');
  selectors.forEach(select => {
    select.value = userId;
  });
  switchTab('tab-reports');
}

async function hashPIN(pin) {
  const msgUint8 = new TextEncoder().encode(pin);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

function generateSecureToken() {
  const array = new Uint8Array(16);
  window.crypto.getRandomValues(array);
  return 'stempelo_tkn_' + Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

// ----------------------------------------------------
// 4. Time Calculation & Compliance (AT Rules)
// ----------------------------------------------------
/**
 * Calculates net working hours, break durations, and target comparison.
 */
function calculateDayDetails(targetSoll, punches, timeOffDay) {
  let grossMinutes = 0;
  let manualBreakMinutes = 0;
  let activePunch = null;

  // 1. Calculate active punches duration
  const sortedPunches = [...punches].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  
  for (let i = 0; i < sortedPunches.length; i++) {
    const punch = sortedPunches[i];
    const start = Temporal.Instant.from(punch.start_time);
    
    let end;
    if (punch.end_time) {
      end = Temporal.Instant.from(punch.end_time);
    } else {
      end = Temporal.Now.instant();
      activePunch = punch;
    }

    const duration = start.until(end, { largestUnit: 'minute' });
    grossMinutes += duration.minutes;

    // Calculate manual breaks (gap between this punch and previous punch)
    if (i > 0) {
      const prevEnd = Temporal.Instant.from(sortedPunches[i - 1].end_time);
      const gap = prevEnd.until(start, { largestUnit: 'minute' });
      manualBreakMinutes += gap.minutes;
    }
  }

  const grossHours = grossMinutes / 60;
  
  // 2. Apply automatic break top-up based on user compliance break profile
  let requiredMinBreak = 0;
  const profile = currentUser.break_profile || 'austria';
  if (profile === 'austria') {
    if (grossHours > 6.0) requiredMinBreak = 30;
  } else if (profile === 'germany') {
    if (grossHours > 6.0 && grossHours <= 9.0) requiredMinBreak = 30;
    else if (grossHours > 9.0) requiredMinBreak = 45;
  } else if (profile === 'custom') {
    const rules = currentUser.break_custom_rules || [];
    const sortedRules = [...rules].sort((a, b) => b.threshold - a.threshold);
    const matched = sortedRules.find(r => grossHours > r.threshold);
    if (matched) requiredMinBreak = matched.deduction;
  }

  let autoBreakMinutes = 0;
  let netHours = grossHours;
  let hasBreakAlert = false;

  if (requiredMinBreak > 0) {
    if (manualBreakMinutes < requiredMinBreak) {
      autoBreakMinutes = requiredMinBreak - manualBreakMinutes;
      netHours = grossHours - (autoBreakMinutes / 60);
      hasBreakAlert = true;
    }
  }

  const totalBreakMinutes = manualBreakMinutes + autoBreakMinutes;

  // 3. Handle Time Off
  let sollHours = targetSoll;
  let istHours = netHours;
  let statusText = activePunch ? (activePunch.end_time ? 'Beendet' : 'Aktiv') : 'Keine Arbeit';
  let isCreditedTimeOff = false;

  if (timeOffDay) {
    isCreditedTimeOff = ['vacation', 'sick', 'holiday'].includes(timeOffDay.type);
    if (isCreditedTimeOff) {
      // Credited days (Urlaub, Krank, Feiertag): Ist equals Soll so Saldo is neutral
      istHours = sollHours;
      statusText = timeOffDay.type === 'vacation' ? 'Urlaub' : (timeOffDay.type === 'sick' ? 'Krank' : 'Feiertag');
    } else if (timeOffDay.type === 'compensation') {
      // Zeitausgleich: Soll is required, but Ist is 0. Saldo is -Soll (reduces overtime account)
      istHours = 0;
      statusText = 'Zeitausgleich';
    }
  }

  const saldoHours = istHours - sollHours;

  return {
    grossHours,
    netHours,
    istHours,
    sollHours,
    saldoHours,
    manualBreakMinutes,
    autoBreakMinutes,
    totalBreakMinutes,
    hasBreakAlert,
    statusText,
    activePunch,
    isCreditedTimeOff,
    timeOffType: timeOffDay ? timeOffDay.type : null
  };
}

/**
 * Calculates cumulative overtime starting from the user's overtime baseline date
 */
function calculateCumulativeOvertime(user, punches, timeOff) {
  if (!user.overtime_start_date) return null;

  let startDate;
  try {
    startDate = Temporal.PlainDate.from(user.overtime_start_date);
  } catch (e) {
    console.error('Invalid overtime start date format:', user.overtime_start_date, e);
    return null;
  }

  const today = Temporal.Now.plainDateISO();
  
  if (Temporal.PlainDate.compare(startDate, today) > 0) {
    return {
      startHours: user.overtime_start_hours || 0,
      accumulatedHours: 0,
      totalHours: user.overtime_start_hours || 0,
      startDate: user.overtime_start_date
    };
  }

  const userPunches = punches.filter(p => p.user_id === user.id);
  const userTimeOff = timeOff.filter(o => o.user_id === user.id);

  const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  let accumulatedHours = 0;
  let iter = startDate;

  while (Temporal.PlainDate.compare(iter, today) <= 0) {
    const dateStr = iter.toString();
    const wday = iter.dayOfWeek;
    const daySoll = user.daily_soll[weekdayKeys[wday - 1]] || 0;

    const dayPunches = userPunches.filter(p => p.start_time.startsWith(dateStr));
    const dayTimeOff = userTimeOff.find(o => o.date === dateStr);

    const stats = calculateDayDetails(daySoll, dayPunches, dayTimeOff);
    accumulatedHours += stats.saldoHours;

    iter = iter.add({ days: 1 });
  }

  const startHours = user.overtime_start_hours !== undefined ? parseFloat(user.overtime_start_hours) : 0.0;
  return {
    startHours,
    accumulatedHours,
    totalHours: startHours + accumulatedHours,
    startDate: user.overtime_start_date
  };
}

let workReminderTimeout = null;
let breakReminderTimeout = null;

function clearReminderTimers() {
  if (workReminderTimeout) {
    clearTimeout(workReminderTimeout);
    workReminderTimeout = null;
  }
  if (breakReminderTimeout) {
    clearTimeout(breakReminderTimeout);
    breakReminderTimeout = null;
  }
}

async function requestNotificationPermission() {
  if ('Notification' in window) {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('Notification permission denied or ignored:', permission);
    }
    return permission;
  }
  return 'default';
}

async function scheduleReminderTimers() {
  clearReminderTimers();

  if (!currentUser || !currentUser.notifications_enabled) return;
  if ('Notification' in window && Notification.permission !== 'granted') return;

  const todayStr = Temporal.Now.plainDateISO().toString();
  const allPunches = await dbAdapter.getAll('punches');
  const userPunches = allPunches.filter(p => p.user_id === currentUser.id);
  const todayPunches = userPunches.filter(p => p.start_time.startsWith(todayStr));

  const isBreakActive = storageGetItem(`user-break-active-${currentUser.id}`) === 'true';
  if (isBreakActive) {
    const breakStartStr = storageGetItem(`user-break-start-${currentUser.id}`);
    if (breakStartStr) {
      try {
        const startInstant = Temporal.Instant.from(breakStartStr);
        const now = Temporal.Now.instant();
        const breakLimit = startInstant.add({ minutes: 30 });
        
        if (Temporal.PlainDate.compare(Temporal.PlainDate.from(breakStartStr.split('T')[0]), Temporal.Now.plainDateISO()) === 0) {
          if (Temporal.Instant.compare(now, breakLimit) < 0) {
            const msRemaining = now.until(breakLimit).total({ unit: 'millisecond' });
            breakReminderTimeout = setTimeout(() => {
              sendLocalNotification(
                t('notification-break-reminder-title'),
                t('notification-break-reminder-body')
              );
            }, msRemaining);
            console.log(`Scheduled break completion reminder in ${Math.round(msRemaining/1000)} seconds.`);
          }
        }
      } catch (e) {
        console.error('Error scheduling break reminder:', e);
      }
    }
    return;
  }

  const weekday = Temporal.Now.plainDateISO().dayOfWeek;
  const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const todaySoll = currentUser.daily_soll[weekdayKeys[weekday - 1]] || 0;
  const todayTimeOff = null;
  const stats = calculateDayDetails(todaySoll, todayPunches, todayTimeOff);

  if (stats.activePunch) {
    const currentGrossMinutes = stats.grossHours * 60;
    if (currentGrossMinutes < 360) {
      const msRemaining = (360 - currentGrossMinutes) * 60 * 1000;
      workReminderTimeout = setTimeout(() => {
        sendLocalNotification(
          t('notification-work-reminder-title'),
          t('notification-work-reminder-body')
        );
      }, msRemaining);
      console.log(`Scheduled work break reminder in ${Math.round(msRemaining/1000)} seconds.`);
    }
  }
}

function sendLocalNotification(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const options = {
    body: body,
    icon: 'assets/icon.png',
    badge: 'assets/icon.png',
    vibrate: [200, 100, 200],
    data: { url: window.location.origin }
  };

  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then(registration => {
      registration.showNotification(title, options);
    });
  } else {
    new Notification(title, options);
  }
}

/**
 * Formats a duration in decimal hours (e.g. 7.5h) or human readable (e.g. 7 Std. 30 Min.)
 */
function formatHours(hours, formatType = 'decimal') {
  if (isNaN(hours)) return getLanguage() === 'de' ? '0,0h' : '0.00h';
  
  if (formatType === 'decimal') {
    const sign = hours < 0 ? '-' : '';
    const separator = getLanguage() === 'de' ? ',' : '.';
    return `${sign}${Math.abs(hours).toFixed(2).replace('.', separator)}h`;
  } else {
    const sign = hours < 0 ? '-' : '';
    const absMinutes = Math.round(Math.abs(hours) * 60);
    const hrs = Math.floor(absMinutes / 60);
    const mins = absMinutes % 60;
    
    if (hrs === 0) return `${sign}${mins}m`;
    return `${sign}${hrs}h ${mins}m`;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ----------------------------------------------------
// 5. DOM & Rendering Engines
// ----------------------------------------------------
async function populateUserSelect() {
  const select = document.getElementById('user-select');
  select.innerHTML = '';
  
  try {
    users = await dbAdapter.getAll('users');
  } catch (error) {
    console.error('Fehler beim Laden der Benutzer:', error);
    users = [];
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '-- Fehler beim Laden (Datenbank nicht bereit) --';
    select.appendChild(opt);
    document.getElementById('pin-entry-area').classList.add('hidden');
    return;
  }
  
  const activeUsers = users.filter(user => !user.deleted && user.is_active !== 0 && user.is_active !== false);

  if (activeUsers.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '-- Kein aktiver Benutzer --';
    select.appendChild(opt);
    document.getElementById('pin-entry-area').classList.add('hidden');
  } else {
    activeUsers.forEach(user => {
      const opt = document.createElement('option');
      opt.value = user.id;
      opt.textContent = user.name;
      select.appendChild(opt);
    });
    document.getElementById('pin-entry-area').classList.remove('hidden');
    
    // Select last logged user if they are still active, otherwise default to first active user
    const lastLoggedId = storageGetItem('last-logged-user-id');
    const hasLastLogged = activeUsers.some(u => u.id === lastLoggedId);
    select.value = hasLastLogged ? lastLoggedId : activeUsers[0].id;
    resetPinEntry();

    if (!currentUser) {
      const initialUserId = select.value;
      if (initialUserId) {
        const initialUser = users.find(u => u.id === initialUserId);
        if (initialUser && initialUser.language) {
          applyGlobalLanguage(initialUser.language);
        }
      }
    }
  }
}

function resetPinEntry() {
  currentPinInput = '';
  updatePinDots();
  document.getElementById('pin-error').classList.add('hidden');
}

function updatePinDots() {
  const dots = document.querySelectorAll('#lock-screen .pin-dots .dot');
  dots.forEach((dot, idx) => {
    if (idx < currentPinInput.length) {
      dot.classList.add('filled');
    } else {
      dot.classList.remove('filled');
    }
  });
}

/**
 * Refreshes active timer and dashboard stats for current user
 */
async function updatePunchTab() {
  if (!currentUser) return;

  const todayStr = Temporal.Now.plainDateISO().toString(); // YYYY-MM-DD
  const weekday = Temporal.Now.plainDateISO().dayOfWeek; // 1 = Mon, 7 = Sun
  const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const todaySoll = currentUser.daily_soll[weekdayKeys[weekday - 1]] || 0;

  // Load punches for today
  const allPunches = await dbAdapter.getAll('punches');
  const userPunches = allPunches.filter(p => p.user_id === currentUser.id);
  const todayPunches = userPunches.filter(p => p.start_time.startsWith(todayStr));

  // Load time off for today
  const allTimeOff = await dbAdapter.getAll('time_off');
  const todayTimeOff = allTimeOff.find(o => o.user_id === currentUser.id && o.date === todayStr);

  const stats = calculateDayDetails(todaySoll, todayPunches, todayTimeOff);

  // Update UI Elements
  document.getElementById('stats-soll-today').textContent = formatHours(stats.sollHours);
  document.getElementById('stats-ist-today').textContent = formatHours(stats.istHours);
  document.getElementById('stats-pause-today').textContent = `${stats.totalBreakMinutes} Min`;
  
  const saldoEl = document.getElementById('stats-saldo-today');
  saldoEl.textContent = formatHours(stats.saldoHours);
  saldoEl.className = 'stat-value ' + (stats.saldoHours >= 0 ? 'text-success' : 'text-danger');

  // Cumulative Overtime Account card
  const overtimePanel = document.getElementById('overtime-balance-panel');
  if (currentUser.overtime_start_date) {
    const overtimeResult = calculateCumulativeOvertime(currentUser, allPunches, allTimeOff);
    if (overtimeResult) {
      overtimePanel.classList.remove('hidden');
      const valEl = document.getElementById('overtime-total-balance');
      const sign = overtimeResult.totalHours > 0 ? '+' : '';
      valEl.textContent = `${sign}${formatHours(overtimeResult.totalHours)}`;
      valEl.className = 'stat-value ' + (overtimeResult.totalHours >= 0 ? 'text-success' : 'text-danger');
      
      const detailsEl = document.getElementById('overtime-balance-details');
      const startDt = Temporal.PlainDate.from(overtimeResult.startDate);
      const formattedStartDate = startDt.toLocaleString(getLanguage(), { day: '2-digit', month: '2-digit', year: 'numeric' });
      
      detailsEl.innerHTML = t('punch-overtime-details', {
        date: formattedStartDate,
        startHours: formatHours(overtimeResult.startHours),
        accumulatedHours: formatHours(overtimeResult.accumulatedHours)
      });
      
      overtimePanel.className = 'overtime-card glass ' + (overtimeResult.totalHours >= 0 ? 'border-green' : 'border-red');
    } else {
      overtimePanel.classList.add('hidden');
    }
  } else {
    overtimePanel.classList.add('hidden');
  }

  // --- Weekly Progress ---
  const today = Temporal.Now.plainDateISO();
  const startOfWeek = today.subtract({ days: today.dayOfWeek - 1 });
  
  let weeklySoll = 0;
  let weeklyIst = 0;
  
  for (let i = 0; i < 7; i++) {
    const dayDate = startOfWeek.add({ days: i });
    const dateStr = dayDate.toString();
    const wday = dayDate.dayOfWeek;
    const daySoll = currentUser.daily_soll[weekdayKeys[wday - 1]] || 0;
    weeklySoll += daySoll;
    
    const dayPunches = userPunches.filter(p => p.start_time.startsWith(dateStr));
    const dayTimeOff = allTimeOff.find(o => o.user_id === currentUser.id && o.date === dateStr);
    
    const dayStats = calculateDayDetails(daySoll, dayPunches, dayTimeOff);
    weeklyIst += dayStats.istHours;
  }
  
  const weeklyPercent = weeklySoll > 0 ? Math.min(100, Math.round((weeklyIst / weeklySoll) * 100)) : 0;
  
  const progressStatsEl = document.getElementById('weekly-progress-stats');
  const progressFillEl = document.getElementById('weekly-progress-fill');
  if (progressStatsEl && progressFillEl) {
    progressStatsEl.textContent = t('punch-weekly-progress-subtitle', {
      actual: formatHours(weeklyIst),
      target: formatHours(weeklySoll),
      percent: weeklyPercent
    });
    progressFillEl.style.width = `${weeklyPercent}%`;
  }

  // Break deductions alert
  if (stats.hasBreakAlert) {
    document.getElementById('alert-break-deductions').classList.remove('hidden');
  } else {
    document.getElementById('alert-break-deductions').classList.add('hidden');
  }

  // Set buttons/status
  const statusIndicator = document.getElementById('punch-status-indicator');
  const btnPunchIn = document.getElementById('btn-punch-in');
  const btnPunchOut = document.getElementById('btn-punch-out');
  const btnBreakToggle = document.getElementById('btn-break-toggle');

  // Stop current timer
  if (timerInterval) clearInterval(timerInterval);

  if (stats.activePunch) {
    // Clock is running
    statusIndicator.textContent = t('punch-status-working');
    statusIndicator.className = 'status-badge working';

    btnPunchIn.classList.add('hidden');
    btnPunchOut.classList.remove('hidden');
    btnBreakToggle.classList.remove('hidden');
    btnBreakToggle.textContent = t('punch-btn-break-start');

    // Start Live Timer
    const startInstant = Temporal.Instant.from(stats.activePunch.start_time);
    const updateTimer = () => {
      const now = Temporal.Now.instant();
      const diff = startInstant.until(now, { largestUnit: 'hour' });
      // Add previous punches time to the live timer
      let previousMinutes = 0;
      todayPunches.forEach(p => {
        if (p.id !== stats.activePunch.id && p.end_time) {
          previousMinutes += Temporal.Instant.from(p.start_time).until(Temporal.Instant.from(p.end_time), { largestUnit: 'minute' }).minutes;
        }
      });
      
      const totalSecs = diff.total({ unit: 'second' }) + (previousMinutes * 60);
      const h = Math.floor(totalSecs / 3600);
      const m = Math.floor((totalSecs % 3600) / 60);
      const s = Math.floor(totalSecs % 60);
      
      document.getElementById('live-timer').textContent = 
        `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };
    
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);

  } else if (storageGetItem(`user-break-active-${currentUser.id}`) === 'true') {
    // User is on break (Break timer)
    statusIndicator.textContent = t('punch-status-onbreak');
    statusIndicator.className = 'status-badge onbreak';

    btnPunchIn.classList.add('hidden');
    btnPunchOut.classList.remove('hidden');
    btnBreakToggle.classList.remove('hidden');
    btnBreakToggle.textContent = t('punch-btn-break-end');

    // Live break timer
    const breakStartStr = storageGetItem(`user-break-start-${currentUser.id}`);
    const startInstant = Temporal.Instant.from(breakStartStr);
    
    const updateTimer = () => {
      const now = Temporal.Now.instant();
      const diff = startInstant.until(now, { largestUnit: 'hour' });
      const totalSecs = diff.total({ unit: 'second' });
      const h = Math.floor(totalSecs / 3600);
      const m = Math.floor((totalSecs % 3600) / 60);
      const s = Math.floor(totalSecs % 60);
      
      document.getElementById('live-timer').textContent = 
        `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };
    
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);

  } else {
    // Clock is stopped
    statusIndicator.textContent = t('punch-status-stopped');
    statusIndicator.className = 'status-badge stopped';

    btnPunchIn.classList.remove('hidden');
    btnPunchOut.classList.add('hidden');
    btnBreakToggle.classList.add('hidden');

    document.getElementById('live-timer').textContent = '00:00:00';
  }

  // Populate and toggle punch activity select
  const actSelectContainer = document.getElementById('punch-activity-select-container');
  const actSelect = document.getElementById('punch-activity-select');
  const activeActDisplay = document.getElementById('punch-active-activity');
  const activeActNameEl = document.getElementById('punch-active-activity-name');

  if (actSelectContainer && actSelect && activeActDisplay && activeActNameEl) {
    const activities = currentUser.activities || [];
    if (activities.length === 0) {
      actSelectContainer.classList.add('hidden');
      activeActDisplay.classList.add('hidden');
    } else {
      if (!stats.activePunch && storageGetItem(`user-break-active-${currentUser.id}`) !== 'true') {
        // Stopped: show dropdown
        actSelectContainer.classList.remove('hidden');
        activeActDisplay.classList.add('hidden');
        
        const currentVal = actSelect.value;
        let optHtml = `<option value="">-- ${t('punch-activity-none')} --</option>`;
        activities.forEach(act => {
          optHtml += `<option value="${escapeHtml(act)}">${escapeHtml(act)}</option>`;
        });
        actSelect.innerHTML = optHtml;
        if (activities.includes(currentVal)) {
          actSelect.value = currentVal;
        }
      } else {
        // Active: show active project name
        actSelectContainer.classList.add('hidden');
        activeActDisplay.classList.remove('hidden');
        
        let activeActName = '';
        if (stats.activePunch && stats.activePunch.activity) {
          activeActName = stats.activePunch.activity;
        } else if (storageGetItem(`user-break-active-${currentUser.id}`) === 'true') {
          const sortedToday = [...todayPunches].sort((a,b) => b.start_time.localeCompare(a.start_time));
          if (sortedToday.length > 0 && sortedToday[0].activity) {
            activeActName = sortedToday[0].activity;
          }
        }
        activeActNameEl.textContent = activeActName || t('punch-activity-none');
      }
    }
  }

  // Schedule or clear break notifications
  scheduleReminderTimers();
}

/**
 * Render history table
 */
async function updateHistoryTab() {
  const viewedUser = getViewedUser();
  if (!viewedUser) return;

  const tbody = document.getElementById('history-table-body');
  tbody.innerHTML = '';

  const tfoot = document.getElementById('history-table-footer');
  if (tfoot) tfoot.innerHTML = '';

  const filterPeriod = document.getElementById('filter-period').value;
  const filterStartDateVal = document.getElementById('filter-start-date').value;
  const filterEndDateVal = document.getElementById('filter-end-date').value;
  const filterType = document.getElementById('filter-type').value;
  const filterManualOnly = document.getElementById('filter-manual-only').checked;

  let filterStart = null;
  let filterEnd = null;
  const today = Temporal.Now.plainDateISO();

  if (filterPeriod === 'current-week') {
    const wday = today.dayOfWeek;
    filterStart = today.subtract({ days: wday - 1 });
    filterEnd = filterStart.add({ days: 6 });
  } else if (filterPeriod === 'current-month') {
    filterStart = today.with({ day: 1 });
    filterEnd = today.with({ day: today.daysInMonth });
  } else if (filterPeriod === 'last-month') {
    const prevMonth = today.subtract({ months: 1 });
    filterStart = prevMonth.with({ day: 1 });
    filterEnd = prevMonth.with({ day: prevMonth.daysInMonth });
  } else if (filterPeriod === 'custom') {
    if (filterStartDateVal) filterStart = Temporal.PlainDate.from(filterStartDateVal);
    if (filterEndDateVal) filterEnd = Temporal.PlainDate.from(filterEndDateVal);
  }

  const allPunches = await dbAdapter.getAll('punches');
  const userPunches = allPunches.filter(p => p.user_id === viewedUser.id);

  const allTimeOff = await dbAdapter.getAll('time_off');
  const userTimeOff = allTimeOff.filter(o => o.user_id === viewedUser.id);

  // Group punches by date (YYYY-MM-DD)
  const daysMap = {};

  // Initialize from punches
  userPunches.forEach(punch => {
    const dateStr = punch.start_time.split('T')[0];
    if (!daysMap[dateStr]) daysMap[dateStr] = { punches: [], timeOff: null };
    daysMap[dateStr].punches.push(punch);
  });

  // Add time-off entries
  userTimeOff.forEach(off => {
    if (!daysMap[off.date]) daysMap[off.date] = { punches: [], timeOff: null };
    daysMap[off.date].timeOff = off;
  });

  if (historyViewMode === 'calendar') {
    document.getElementById('history-list-view').style.display = 'none';
    document.getElementById('history-calendar-view').style.display = 'block';
    document.getElementById('filter-period').closest('.filter-group').classList.add('hidden');
    document.getElementById('filter-custom-dates').classList.add('hidden');
    renderHistoryCalendar(daysMap);
    return;
  }

  // Otherwise, list view mode
  document.getElementById('history-list-view').style.display = 'block';
  document.getElementById('history-calendar-view').style.display = 'none';
  document.getElementById('filter-period').closest('.filter-group').classList.remove('hidden');
  const customDatesEl = document.getElementById('filter-custom-dates');
  if (document.getElementById('filter-period').value === 'custom') {
    customDatesEl.classList.remove('hidden');
  }

  // Sort dates descending
  const dates = Object.keys(daysMap).sort((a, b) => b.localeCompare(a));

  const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  let renderedCount = 0;

  // Sum accumulators
  let totalIstHours = 0;
  let totalSollHours = 0;
  let totalManualBreak = 0;
  let totalAutoBreak = 0;
  let totalSaldoHours = 0;

  dates.forEach(dateStr => {
    const dateData = daysMap[dateStr];
    
    // Parse date
    const dateObj = Temporal.PlainDate.from(dateStr);
    const wday = dateObj.dayOfWeek;
    const soll = viewedUser.daily_soll[weekdayKeys[wday - 1]] || 0;

    const stats = calculateDayDetails(soll, dateData.punches, dateData.timeOff);

    // Apply filters
    // 1. Date Filter
    if (filterStart && Temporal.PlainDate.compare(dateObj, filterStart) < 0) return;
    if (filterEnd && Temporal.PlainDate.compare(dateObj, filterEnd) > 0) return;

    // 2. Type Filter
    if (filterType !== 'all') {
      if (filterType === 'work') {
        if (stats.timeOffType) return;
      } else {
        if (stats.timeOffType !== filterType) return;
      }
    }

    // 3. Manual Corrections Filter
    if (filterManualOnly) {
      const hasManual = dateData.punches.some(p => p.manual_edit === 1 || p.manual_edit === true);
      if (!hasManual) return;
    }

    // Accumulate sums
    totalIstHours += stats.istHours;
    totalSollHours += stats.sollHours;
    totalManualBreak += stats.manualBreakMinutes;
    totalAutoBreak += stats.autoBreakMinutes;
    totalSaldoHours += stats.saldoHours;

    renderedCount++;

    const tr = document.createElement('tr');
    
    // Set row styling class based on type
    if (stats.timeOffType) {
      tr.className = `tr-${stats.timeOffType}`;
    } else {
      tr.className = 'tr-work';
    }

    // Date column
    const tdDate = document.createElement('td');
    tdDate.innerHTML = `<strong>${dateObj.toLocaleString(getLanguage(), { weekday: 'short' })}</strong>, ${dateObj.toLocaleString(getLanguage(), { day: '2-digit', month: '2-digit' })}`;
    tr.appendChild(tdDate);

    // Type column
    const tdType = document.createElement('td');
    let typeTagHtml = '';
    if (stats.timeOffType) {
      typeTagHtml = `<span class="tag-badge ${stats.timeOffType}">${t('type-' + stats.timeOffType)}</span>`;
    } else {
      typeTagHtml = `<span class="tag-badge work">${t('type-work')}</span>`;
    }
    tdType.innerHTML = typeTagHtml;
    tr.appendChild(tdType);

    // Punch times column
    const tdTimes = document.createElement('td');
    if (stats.timeOffType && !isCreditedWorkDone(dateData.punches)) {
      tdTimes.textContent = '-';
    } else {
      const punchTimes = dateData.punches.map(p => {
        const start = new Date(p.start_time).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' });
        const end = p.end_time 
          ? new Date(p.end_time).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' })
          : t('history-active-punch');
        return `${start} - ${end}`;
      }).join(', ');
      tdTimes.textContent = punchTimes || '-';
    }
    tr.appendChild(tdTimes);

    // Net hours column
    const tdNet = document.createElement('td');
    tdNet.textContent = formatHours(stats.istHours);
    tr.appendChild(tdNet);

    // Break column
    const tdBreak = document.createElement('td');
    if (stats.timeOffType && dateData.punches.length === 0) {
      tdBreak.textContent = '-';
    } else {
      const autoStr = stats.autoBreakMinutes > 0 ? ` (+${stats.autoBreakMinutes}m ${getLanguage() === 'de' ? 'ges.' : 'ded.'})` : '';
      tdBreak.textContent = `${stats.manualBreakMinutes}m${autoStr}`;
      if (stats.hasBreakAlert) tdBreak.className = 'text-warning';
    }
    tr.appendChild(tdBreak);

    // Soll column
    const tdSoll = document.createElement('td');
    tdSoll.textContent = formatHours(stats.sollHours);
    tr.appendChild(tdSoll);

    // Status / Saldo column
    const tdStatus = document.createElement('td');
    const labelColor = stats.saldoHours >= 0 ? 'text-success' : 'text-danger';
    tdStatus.innerHTML = `<span class="${labelColor}">${formatHours(stats.saldoHours)}</span>`;
    tr.appendChild(tdStatus);

    // Actions column
    const tdActions = document.createElement('td');
    if (stats.timeOffType) {
      // Delete time off
      const btnDel = document.createElement('button');
      btnDel.className = 'btn secondary small text-danger';
      btnDel.innerHTML = t('history-action-delete');
      btnDel.onclick = async () => {
        if (confirm(t('alert-confirm-delete-absence'))) {
          await dbAdapter.delete('time_off', dateData.timeOff.id, viewedUser.id);
          updateHistoryTab();
          triggerSilentSync();
        }
      };
      tdActions.appendChild(btnDel);
    } else if (dateData.punches.length > 0) {
      // Edit punch times
      const btnEdit = document.createElement('button');
      btnEdit.className = 'btn secondary small';
      btnEdit.innerHTML = t('history-action-edit');
      btnEdit.onclick = () => showEditPunchDialog(dateStr, dateData.punches);
      tdActions.appendChild(btnEdit);
    } else {
      tdActions.textContent = '-';
    }
    tr.appendChild(tdActions);

    tbody.appendChild(tr);
  });

  if (renderedCount === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.className = 'empty-filter-row';
    td.textContent = t('history-empty');
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    // Render sums in tfoot
    if (tfoot) {
      const tr = document.createElement('tr');
      
      const tdLabel = document.createElement('td');
      tdLabel.colSpan = 2;
      tdLabel.innerHTML = `<strong>${t('history-total-filtered')}</strong>`;
      tr.appendChild(tdLabel);
      
      const tdTimes = document.createElement('td');
      tdTimes.textContent = '-';
      tr.appendChild(tdTimes);
      
      const tdIst = document.createElement('td');
      tdIst.textContent = formatHours(totalIstHours);
      tr.appendChild(tdIst);
      
      const tdBreak = document.createElement('td');
      const autoBreakStr = totalAutoBreak > 0 ? ` (+${totalAutoBreak}m ${getLanguage() === 'de' ? 'ges.' : 'ded.'})` : '';
      tdBreak.textContent = `${totalManualBreak}m${autoBreakStr}`;
      tr.appendChild(tdBreak);
      
      const tdSoll = document.createElement('td');
      tdSoll.textContent = formatHours(totalSollHours);
      tr.appendChild(tdSoll);
      
      const tdSaldo = document.createElement('td');
      const saldoColor = totalSaldoHours >= 0 ? 'text-success' : 'text-danger';
      tdSaldo.innerHTML = `<span class="${saldoColor}">${formatHours(totalSaldoHours)}</span>`;
      tr.appendChild(tdSaldo);
      
      const tdActions = document.createElement('td');
      tdActions.textContent = '-';
      tr.appendChild(tdActions);
      
      tfoot.appendChild(tr);
    }
  }
}

function renderHistoryCalendar(daysMap) {
  const viewedUser = getViewedUser();
  if (!viewedUser) return;

  const container = document.getElementById('history-calendar-view');
  const gridContainer = container.querySelector('.calendar-grid');
  
  // Clear previous calendar cells (keep weekday headers)
  const cells = gridContainer.querySelectorAll('.calendar-cell');
  cells.forEach(c => c.remove());

  const activeYear = calendarActiveDate.year;
  const activeMonth = calendarActiveDate.month;
  
  const monthName = new Intl.DateTimeFormat(getLanguage(), { month: 'long', year: 'numeric' }).format(
    new Date(activeYear, activeMonth - 1, 1)
  );
  document.getElementById('cal-month-title').textContent = monthName;

  const firstDay = Temporal.PlainDate.from({ year: activeYear, month: activeMonth, day: 1 });
  const startWeekday = firstDay.dayOfWeek; 
  
  const numPlaceholders = startWeekday - 1;
  for (let i = 0; i < numPlaceholders; i++) {
    const placeholder = document.createElement('div');
    placeholder.className = 'calendar-cell empty';
    gridContainer.appendChild(placeholder);
  }

  const daysInMonth = calendarActiveDate.daysInMonth;
  const todayStr = Temporal.Now.plainDateISO().toString();
  const selectedStr = calendarActiveDate.toString();

  const filterType = document.getElementById('filter-type').value;
  const filterManualOnly = document.getElementById('filter-manual-only').checked;

  const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  for (let day = 1; day <= daysInMonth; day++) {
    const cellDate = Temporal.PlainDate.from({ year: activeYear, month: activeMonth, day: day });
    const cellDateStr = cellDate.toString();
    const dateData = daysMap[cellDateStr] || { punches: [], timeOff: null };
    
    const wday = cellDate.dayOfWeek;
    const soll = viewedUser.daily_soll[weekdayKeys[wday - 1]] || 0;
    const stats = calculateDayDetails(soll, dateData.punches, dateData.timeOff);

    const cell = document.createElement('div');
    cell.className = 'calendar-cell';
    cell.dataset.date = cellDateStr;
    
    if (cellDateStr === todayStr) cell.classList.add('today');
    if (cellDateStr === selectedStr) cell.classList.add('selected');

    const dayNum = document.createElement('span');
    dayNum.className = 'cell-day-num';
    dayNum.textContent = day;
    cell.appendChild(dayNum);

    let matchesFilter = true;
    if (filterType !== 'all') {
      if (filterType === 'work') {
        if (stats.timeOffType) matchesFilter = false;
      } else {
        if (stats.timeOffType !== filterType) matchesFilter = false;
      }
    }
    if (filterManualOnly) {
      const hasManual = dateData.punches.some(p => p.manual_edit === 1 || p.manual_edit === true);
      if (!hasManual) matchesFilter = false;
    }

    if (matchesFilter) {
      if (stats.timeOffType) {
        cell.classList.add(`absence-${stats.timeOffType}`);
        const badge = document.createElement('span');
        badge.className = 'cell-absence-badge';
        const shortAbsenceLabel = {
          vacation: 'U',
          sick: 'K',
          holiday: 'F',
          compensation: 'ZA'
        }[stats.timeOffType] || 'A';
        badge.textContent = shortAbsenceLabel;
        cell.appendChild(badge);
      } else if (dateData.punches.length > 0) {
        cell.classList.add('has-punches');
        const badge = document.createElement('span');
        badge.className = 'cell-hours-badge';
        const formatted = formatHours(stats.istHours, 'decimal');
        badge.textContent = formatted;
        cell.appendChild(badge);
      }
    }

    cell.onclick = () => {
      calendarActiveDate = cellDate;
      gridContainer.querySelectorAll('.calendar-cell').forEach(c => c.classList.remove('selected'));
      cell.classList.add('selected');
      renderCalendarDayDetails(cellDateStr, dateData, stats);
    };

    gridContainer.appendChild(cell);
  }

  const selectedData = daysMap[selectedStr] || { punches: [], timeOff: null };
  const wday = calendarActiveDate.dayOfWeek;
  const soll = currentUser.daily_soll[weekdayKeys[wday - 1]] || 0;
  const stats = calculateDayDetails(soll, selectedData.punches, selectedData.timeOff);
  renderCalendarDayDetails(selectedStr, selectedData, stats);
}

function renderCalendarDayDetails(dateStr, dateData, stats) {
  const panel = document.getElementById('calendar-day-details');
  if (!panel) return;

  const dateObj = new Date(dateStr);
  const formattedDate = dateObj.toLocaleDateString(getLanguage(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });

  const titleHtml = `<div class="day-details-header">${t('calendar-details-title', { date: formattedDate })}</div>`;
  
  let contentHtml = '';
  let actionsHtml = '';

  if (stats.timeOffType) {
    const absenceLabel = {
      vacation: t('history-type-vacation'),
      sick: t('history-type-sick'),
      holiday: t('history-type-holiday'),
      compensation: t('history-type-compensation')
    }[stats.timeOffType] || stats.timeOffType;

    contentHtml = `
      <div class="day-details-content">
        <strong>${t('calendar-details-absence')}:</strong> ${absenceLabel}<br>
        <strong>${t('calendar-details-soll')}:</strong> ${formatHours(stats.sollHours)}
      </div>
    `;

    actionsHtml = `
      <button type="button" class="btn secondary text-danger small" id="btn-cal-action-delete-absence">
        ${t('history-action-delete')}
      </button>
    `;
  } else if (dateData.punches.length > 0) {
    const punchLines = dateData.punches.map(p => {
      const sStr = new Date(p.start_time).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' });
      const eStr = p.end_time 
        ? new Date(p.end_time).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' })
        : t('history-active-punch');
      return `${sStr} - ${eStr}`;
    }).join(', ');

    const formattedIst = formatHours(stats.istHours);
    const formattedSoll = formatHours(stats.sollHours);
    const formattedBreak = stats.totalBreakMinutes > 0 ? `${stats.totalBreakMinutes}m` : '0m';

    contentHtml = `
      <div class="day-details-content">
        <strong>${t('calendar-details-punches')}:</strong> ${punchLines}<br>
        <strong>${t('calendar-details-ist')}:</strong> ${formattedIst}<br>
        <strong>${t('calendar-details-soll')}:</strong> ${formattedSoll}<br>
        <strong>${t('calendar-details-break')}:</strong> ${formattedBreak}
      </div>
    `;

    actionsHtml = `
      <button type="button" class="btn primary small" id="btn-cal-action-edit-punches">
        ${t('history-action-edit')}
      </button>
    `;
  } else {
    contentHtml = `
      <div class="day-details-content" style="color: var(--color-text-muted);">
        ${t('calendar-details-empty')}
      </div>
    `;

    actionsHtml = `
      <button type="button" class="btn secondary small" id="btn-cal-action-add-punch">
        ${t('calendar-action-add-punch')}
      </button>
      <button type="button" class="btn secondary small" id="btn-cal-action-add-absence">
        ${t('calendar-action-add-absence')}
      </button>
    `;
  }

  panel.innerHTML = `${titleHtml}${contentHtml}<div class="day-details-actions">${actionsHtml}</div>`;

  const btnDelAbsence = document.getElementById('btn-cal-action-delete-absence');
  if (btnDelAbsence) {
    btnDelAbsence.onclick = async () => {
      if (confirm(t('alert-confirm-delete-absence'))) {
        await dbAdapter.delete('time_off', dateData.timeOff.id, currentUser.id);
        updateHistoryTab();
        triggerSilentSync();
      }
    };
  }

  const btnEditPunches = document.getElementById('btn-cal-action-edit-punches');
  if (btnEditPunches) {
    btnEditPunches.onclick = () => {
      showEditPunchDialog(dateStr, dateData.punches);
    };
  }

  const btnAddPunch = document.getElementById('btn-cal-action-add-punch');
  if (btnAddPunch) {
    btnAddPunch.onclick = () => {
      showAddManualPunchDialog(dateStr);
    };
  }

  const btnAddAbsence = document.getElementById('btn-cal-action-add-absence');
  if (btnAddAbsence) {
    btnAddAbsence.onclick = () => {
      showAddTimeOffDialog(dateStr);
    };
  }
}

/**
 * Exports the currently filtered work hours protocol to a CSV file.
 */
async function exportHistoryToCSV() {
  const viewedUser = getViewedUser();
  if (!viewedUser) return;

  const filterPeriod = document.getElementById('filter-period').value;
  const filterStartDateVal = document.getElementById('filter-start-date').value;
  const filterEndDateVal = document.getElementById('filter-end-date').value;
  const filterType = document.getElementById('filter-type').value;
  const filterManualOnly = document.getElementById('filter-manual-only').checked;

  let filterStart = null;
  let filterEnd = null;
  const today = Temporal.Now.plainDateISO();

  if (filterPeriod === 'current-week') {
    const wday = today.dayOfWeek;
    filterStart = today.subtract({ days: wday - 1 });
    filterEnd = filterStart.add({ days: 6 });
  } else if (filterPeriod === 'current-month') {
    filterStart = today.with({ day: 1 });
    filterEnd = today.with({ day: today.daysInMonth });
  } else if (filterPeriod === 'last-month') {
    const prevMonth = today.subtract({ months: 1 });
    filterStart = prevMonth.with({ day: 1 });
    filterEnd = prevMonth.with({ day: prevMonth.daysInMonth });
  } else if (filterPeriod === 'custom') {
    if (filterStartDateVal) filterStart = Temporal.PlainDate.from(filterStartDateVal);
    if (filterEndDateVal) filterEnd = Temporal.PlainDate.from(filterEndDateVal);
  }

  const allPunches = await dbAdapter.getAll('punches');
  const userPunches = allPunches.filter(p => p.user_id === viewedUser.id);

  const allTimeOff = await dbAdapter.getAll('time_off');
  const userTimeOff = allTimeOff.filter(o => o.user_id === viewedUser.id);

  const daysMap = {};

  userPunches.forEach(punch => {
    const dateStr = punch.start_time.split('T')[0];
    if (!daysMap[dateStr]) daysMap[dateStr] = { punches: [], timeOff: null };
    daysMap[dateStr].punches.push(punch);
  });

  userTimeOff.forEach(off => {
    if (!daysMap[off.date]) daysMap[off.date] = { punches: [], timeOff: null };
    daysMap[off.date].timeOff = off;
  });

  // Sort chronological ascending for CSV export
  const dates = Object.keys(daysMap).sort((a, b) => a.localeCompare(b));
  const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  let totalIstHours = 0;
  let totalSollHours = 0;
  let totalManualBreak = 0;
  let totalAutoBreak = 0;
  let totalSaldoHours = 0;

  const csvRows = [];

  // Headers matching table
  csvRows.push([
    `"${t('history-th-date')}"`,
    `"${t('history-th-type')}"`,
    `"${t('history-th-worktime')}"`,
    `"${t('history-th-actual')}"`,
    `"${t('history-th-break')}"`,
    `"${t('history-th-target')}"`,
    `"${t('history-th-status')}"`
  ].join(';'));

  const escapeCsv = (str) => {
    if (str === null || str === undefined) return '""';
    const val = String(str).replace(/"/g, '""');
    return `"${val}"`;
  };

  let renderedCount = 0;

  dates.forEach(dateStr => {
    const dateData = daysMap[dateStr];
    const dateObj = Temporal.PlainDate.from(dateStr);
    const wday = dateObj.dayOfWeek;
    const soll = viewedUser.daily_soll[weekdayKeys[wday - 1]] || 0;

    const stats = calculateDayDetails(soll, dateData.punches, dateData.timeOff);

    // Apply filters
    if (filterStart && Temporal.PlainDate.compare(dateObj, filterStart) < 0) return;
    if (filterEnd && Temporal.PlainDate.compare(dateObj, filterEnd) > 0) return;

    if (filterType !== 'all') {
      if (filterType === 'work') {
        if (stats.timeOffType) return;
      } else {
        if (stats.timeOffType !== filterType) return;
      }
    }

    if (filterManualOnly) {
      const hasManual = dateData.punches.some(p => p.manual_edit === 1 || p.manual_edit === true);
      if (!hasManual) return;
    }

    // Accumulate sums
    totalIstHours += stats.istHours;
    totalSollHours += stats.sollHours;
    totalManualBreak += stats.manualBreakMinutes;
    totalAutoBreak += stats.autoBreakMinutes;
    totalSaldoHours += stats.saldoHours;

    renderedCount++;

    const dateStrFormatted = `${dateObj.toLocaleString(getLanguage(), { weekday: 'short' })}, ${dateObj.toLocaleString(getLanguage(), { day: '2-digit', month: '2-digit', year: 'numeric' })}`;
    const typeLabel = stats.timeOffType ? t('type-' + stats.timeOffType) : t('type-work');

    let punchTimes = '-';
    if (!(stats.timeOffType && !isCreditedWorkDone(dateData.punches))) {
      punchTimes = dateData.punches.map(p => {
        const start = new Date(p.start_time).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' });
        const end = p.end_time 
          ? new Date(p.end_time).toLocaleTimeString(getLanguage(), { hour: '2-digit', minute: '2-digit' })
          : t('history-active-punch');
        return `${start} - ${end}`;
      }).join(', ');
      if (!punchTimes) punchTimes = '-';
    }

    const istStr = formatHours(stats.istHours);
    const autoBreakStr = stats.autoBreakMinutes > 0 ? ` (+${stats.autoBreakMinutes}m ${getLanguage() === 'de' ? 'ges.' : 'ded.'})` : '';
    const breakStr = `${stats.manualBreakMinutes}m${autoBreakStr}`;
    const sollStr = formatHours(stats.sollHours);
    const saldoStr = formatHours(stats.saldoHours);

    csvRows.push([
      escapeCsv(dateStrFormatted),
      escapeCsv(typeLabel),
      escapeCsv(punchTimes),
      escapeCsv(istStr),
      escapeCsv(breakStr),
      escapeCsv(sollStr),
      escapeCsv(saldoStr)
    ].join(';'));
  });

  if (renderedCount === 0) {
    csvRows.push([
      escapeCsv(t('history-empty')),
      '""', '""', '""', '""', '""', '""'
    ].join(';'));
  } else {
    // Sum footer row
    const autoBreakStr = totalAutoBreak > 0 ? ` (+${totalAutoBreak}m ${getLanguage() === 'de' ? 'ges.' : 'ded.'})` : '';
    const totalBreakStr = `${totalManualBreak}m${autoBreakStr}`;
    csvRows.push([
      escapeCsv(t('history-total-filtered')),
      '""',
      escapeCsv('-'),
      escapeCsv(formatHours(totalIstHours)),
      escapeCsv(totalBreakStr),
      escapeCsv(formatHours(totalSollHours)),
      escapeCsv(formatHours(totalSaldoHours))
    ].join(';'));
  }

  // Generate file with BOM for UTF-8 compatibility in Excel
  const csvContent = '\uFEFF' + csvRows.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  
  const startFileStr = filterStart ? filterStart.toString() : 'gesamt';
  const endFileStr = filterEnd ? filterEnd.toString() : 'heute';
  const sanitizedUserName = viewedUser.name.toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/(^_|_$)/g, '');
    
  link.download = `stempelo_export_${sanitizedUserName}_${startFileStr}_bis_${endFileStr}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function isCreditedWorkDone(punches) {
  return punches && punches.length > 0;
}

/**
 * Update stats dashboard tab
 */
async function updateReportsTab() {
  const viewedUser = getViewedUser();
  if (!viewedUser) return;

  const periodSelect = document.getElementById('report-period-select');
  const period = periodSelect.value;
  
  const today = Temporal.Now.plainDateISO();
  let start, end;

  // Determine date boundaries
  if (period === 'current-week') {
    // Monday is wday 1
    const wday = today.dayOfWeek;
    start = today.subtract({ days: wday - 1 });
    end = start.add({ days: 6 });
  } else if (period === 'current-month') {
    start = today.with({ day: 1 });
    // Get last day of month
    end = today.with({ day: today.daysInMonth });
  } else if (period === 'last-month') {
    const prevMonth = today.subtract({ months: 1 });
    start = prevMonth.with({ day: 1 });
    end = prevMonth.with({ day: prevMonth.daysInMonth });
  } else {
    // All time (from oldest punch to today)
    const allPunches = await dbAdapter.getAll('punches');
    const userPunches = allPunches.filter(p => p.user_id === viewedUser.id);
    if (userPunches.length > 0) {
      const oldestStr = userPunches.reduce((oldest, current) => 
        current.start_time < oldest ? current.start_time : oldest
      , userPunches[0].start_time).split('T')[0];
      start = Temporal.PlainDate.from(oldestStr);
    } else {
      start = today.with({ day: 1 });
    }
    end = today;
  }

  // Load records
  const allPunches = await dbAdapter.getAll('punches');
  const userPunches = allPunches.filter(p => p.user_id === viewedUser.id);

  const allTimeOff = await dbAdapter.getAll('time_off');
  const userTimeOff = allTimeOff.filter(o => o.user_id === viewedUser.id);

  const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  let totalSoll = 0;
  let totalIst = 0;
  let countVacation = 0;
  let countSick = 0;
  let countHoliday = 0;
  let countCompensation = 0;

  const activityHoursMap = {};

  // Iterate over every day in range
  let iter = start;
  while (Temporal.PlainDate.compare(iter, end) <= 0) {
    const dateStr = iter.toString();
    const wday = iter.dayOfWeek;
    const daySoll = viewedUser.daily_soll[weekdayKeys[wday - 1]] || 0;

    const dayPunches = userPunches.filter(p => p.start_time.startsWith(dateStr));
    const dayTimeOff = userTimeOff.find(o => o.date === dateStr);

    const stats = calculateDayDetails(daySoll, dayPunches, dayTimeOff);

    totalSoll += stats.sollHours;
    totalIst += stats.istHours;

    if (stats.timeOffType === 'vacation') countVacation++;
    else if (stats.timeOffType === 'sick') countSick++;
    else if (stats.timeOffType === 'holiday') countHoliday++;
    else if (stats.timeOffType === 'compensation') countCompensation++;

    // Proportional breakdown by activity
    if (dayPunches.length > 0 && stats.netHours > 0) {
      const punchDurations = dayPunches.map(p => {
        const pStart = Temporal.Instant.from(p.start_time);
        const pEnd = p.end_time ? Temporal.Instant.from(p.end_time) : Temporal.Now.instant();
        const pMinutes = pStart.until(pEnd, { largestUnit: 'minute' }).minutes;
        return {
          punch: p,
          grossHours: pMinutes / 60
        };
      });

      const totalDayGross = punchDurations.reduce((sum, item) => sum + item.grossHours, 0);
      if (totalDayGross > 0) {
        punchDurations.forEach(item => {
          const punchNet = (item.grossHours / totalDayGross) * stats.netHours;
          const act = item.punch.activity || '';
          activityHoursMap[act] = (activityHoursMap[act] || 0) + punchNet;
        });
      }
    }

    iter = iter.add({ days: 1 });
  }

  const totalSaldo = totalIst - totalSoll;

  // Render cards
  document.getElementById('rep-soll-hours').textContent = formatHours(totalSoll);
  document.getElementById('rep-ist-hours').textContent = formatHours(totalIst);
  
  const saldoVal = document.getElementById('rep-saldo-hours');
  saldoVal.textContent = formatHours(totalSaldo);
  
  const saldoCard = document.getElementById('rep-saldo-card');
  saldoCard.className = 'report-stat-card glass ' + (totalSaldo >= 0 ? 'border-green' : 'border-red');

  const totalFree = countVacation + countSick + countHoliday + countCompensation;
  const suffix = getLanguage() === 'de' ? (totalFree === 1 ? '' : 'e') : (totalFree === 1 ? '' : 's');
  document.getElementById('rep-free-days').textContent = t('reports-free-days', { count: totalFree, suffix: suffix });
  document.getElementById('rep-free-days-breakdown').textContent = 
    t('reports-free-days-breakdown', {
      vacation: countVacation,
      sick: countSick,
      holiday: countHoliday,
      compensation: countCompensation
    });

  // Audit Logs rendering
  const auditLogs = await dbAdapter.getAll('audit_logs');
  const userLogs = auditLogs.filter(l => l.user_id === viewedUser.id).sort((a,b) => b.timestamp.localeCompare(a.timestamp));

  const logContainer = document.getElementById('audit-log-container');
  logContainer.innerHTML = '';

  if (userLogs.length === 0) {
    logContainer.innerHTML = `<p class="text-muted text-center" style="padding: 20px;">${t('reports-audit-empty')}</p>`;
  } else {
    userLogs.forEach(log => {
      const entry = document.createElement('div');
      entry.className = 'audit-log-entry';

      const time = new Date(log.timestamp).toLocaleString(getLanguage(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      
      let details = '';
      if (log.action === 'insert') {
        details = t('reports-audit-insert', { id: log.record_id });
      } else if (log.action === 'update') {
        details = t('reports-audit-update');
      } else if (log.action === 'delete') {
        details = t('reports-audit-delete', { tableName: log.table_name });
      }

      const actionText = t('reports-audit-action', { action: log.action.toUpperCase() });

      entry.innerHTML = `
        <span class="audit-log-time">${time}</span>
        <p>${details} ${actionText}</p>
      `;
      logContainer.appendChild(entry);
    });
  }

  // Render trend chart for the last 6 months
  await renderTrendChart();

  // Render activity breakdown list
  renderActivityDistribution(activityHoursMap);
}

/**
 * Render horizontal progress bars showing the distribution of work hours across activities
 */
function renderActivityDistribution(activityHoursMap) {
  const container = document.getElementById('reports-activities-list');
  if (!container) return;
  container.innerHTML = '';

  const activities = Object.entries(activityHoursMap)
    .map(([name, hours]) => ({ name, hours }))
    .filter(a => a.hours > 0)
    .sort((a, b) => b.hours - a.hours);

  const totalWorked = activities.reduce((sum, a) => sum + a.hours, 0);

  if (activities.length === 0) {
    container.innerHTML = `
      <p class="text-muted text-center" style="padding: 20px;" data-i18n="reports-activities-empty">
        ${t('reports-activities-empty')}
      </p>
    `;
    return;
  }

  activities.forEach(act => {
    const pct = totalWorked > 0 ? Math.round((act.hours / totalWorked) * 100) : 0;
    const nameText = act.name || t('reports-activity-unassigned');
    const hoursText = formatHours(act.hours);

    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.flexDirection = 'column';
    row.style.gap = '6px';

    row.innerHTML = `
      <div style="display: flex; justify-content: space-between; font-size: 0.9rem; font-weight: 600;">
        <span style="color: var(--color-text-primary);">${escapeHtml(nameText)}</span>
        <span style="color: var(--color-text-secondary);">${hoursText} (${pct}%)</span>
      </div>
      <div class="progress-bar-container" style="background-color: rgba(255,255,255,0.06); height: 8px; border-radius: 4px; overflow: hidden; width: 100%;">
        <div class="progress-bar-fill" style="background-color: var(--color-accent); width: ${pct}%; height: 100%; border-radius: 4px;"></div>
      </div>
    `;

    container.appendChild(row);
  });
}

/**
 * Render visual trend chart (SVG-based) in the reports tab
 */
async function renderTrendChart() {
  const viewedUser = getViewedUser();
  if (!viewedUser) return;
  const svg = document.getElementById('trend-chart-svg');
  if (!svg) return;

  const today = Temporal.Now.plainDateISO();
  const months = [];
  
  // Last 6 months in chronological order
  for (let i = 5; i >= 0; i--) {
    const d = today.subtract({ months: i });
    months.push({
      year: d.year,
      month: d.month,
      start: d.with({ day: 1 }),
      end: d.with({ day: d.daysInMonth })
    });
  }

  const allPunches = await dbAdapter.getAll('punches');
  const userPunches = allPunches.filter(p => p.user_id === viewedUser.id);

  const allTimeOff = await dbAdapter.getAll('time_off');
  const userTimeOff = allTimeOff.filter(o => o.user_id === viewedUser.id);

  const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const chartData = [];

  for (const m of months) {
    let monthlySoll = 0;
    let monthlyIst = 0;

    let iter = m.start;
    while (Temporal.PlainDate.compare(iter, m.end) <= 0) {
      const dateStr = iter.toString();
      const wday = iter.dayOfWeek;
      const daySoll = viewedUser.daily_soll[weekdayKeys[wday - 1]] || 0;

      const dayPunches = userPunches.filter(p => p.start_time.startsWith(dateStr));
      const dayTimeOff = userTimeOff.find(o => o.date === dateStr);

      const stats = calculateDayDetails(daySoll, dayPunches, dayTimeOff);

      monthlySoll += stats.sollHours;
      monthlyIst += stats.istHours;

      iter = iter.add({ days: 1 });
    }

    const monthlySaldo = monthlyIst - monthlySoll;
    const lang = getLanguage();
    const monthLabel = m.start.toLocaleString(lang, { month: 'short' });

    chartData.push({
      label: monthLabel,
      soll: monthlySoll,
      ist: monthlyIst,
      saldo: monthlySaldo
    });
  }

  // Scaling parameters for SVG (width: 600, height: 240)
  // Margins: Left (hours) 45, Right (Zeitsaldo) 45, Top 25, Bottom 30
  // Plotting area: X = 45 to 555 (width 510), Y = 25 to 210 (height 185)
  const drawWidth = 510;
  const drawHeight = 185;
  const startX = 45;
  const baselineY = 210;

  let maxHoursVal = Math.max(...chartData.map(d => Math.max(d.soll, d.ist)));
  if (maxHoursVal < 40) maxHoursVal = 40;
  const roundedMax = Math.ceil(maxHoursVal / 20) * 20;

  let maxSaldoVal = Math.max(...chartData.map(d => Math.abs(d.saldo)));
  if (maxSaldoVal < 10) maxSaldoVal = 10;
  const roundedMaxSaldo = Math.ceil(maxSaldoVal / 5) * 5;

  let svgContent = '';

  // Draw Horizontal Gridlines and Axes values
  const gridSteps = 5;
  for (let j = 0; j < gridSteps; j++) {
    const ratio = j / (gridSteps - 1);
    const y = baselineY - ratio * drawHeight;

    // Gridline
    svgContent += `
      <line x1="45" y1="${y}" x2="555" y2="${y}" stroke="rgba(255, 255, 255, 0.08)" stroke-width="1" ${j === 2 ? 'stroke-dasharray="3,3"' : ''} />
    `;

    // Left Y label (Soll/Ist)
    const hoursLabelVal = Math.round(ratio * roundedMax);
    svgContent += `
      <text x="35" y="${y + 3}" text-anchor="end" font-size="9" fill="var(--color-text-muted)">${hoursLabelVal}h</text>
    `;

    // Right Y label (Zeitsaldo)
    const saldoLabelVal = Math.round((ratio - 0.5) * 2 * roundedMaxSaldo);
    const prefix = saldoLabelVal > 0 ? '+' : '';
    svgContent += `
      <text x="565" y="${y + 3}" text-anchor="start" font-size="9" fill="var(--color-danger)">${prefix}${saldoLabelVal}h</text>
    `;
  }

  // Draw Columns (Bars)
  const barWidth = 18;
  const barGap = 4;
  const colWidth = drawWidth / 6;
  const linePoints = [];

  for (let i = 0; i < 6; i++) {
    const data = chartData[i];
    const xCenter = startX + i * colWidth + colWidth / 2;

    // X-axis label
    svgContent += `
      <text x="${xCenter}" y="230" text-anchor="middle" font-size="10" fill="var(--color-text-secondary)">${data.label}</text>
    `;

    // Soll Bar
    const sollHeight = (data.soll / roundedMax) * drawHeight;
    const sollY = baselineY - sollHeight;
    svgContent += `
      <rect x="${xCenter - barWidth - barGap/2}" y="${sollY}" width="${barWidth}" height="${sollHeight}" fill="rgba(255, 255, 255, 0.08)" stroke="rgba(255, 255, 255, 0.2)" stroke-width="1" rx="3" />
    `;

    // Ist Bar
    const istHeight = (data.ist / roundedMax) * drawHeight;
    const istY = baselineY - istHeight;
    svgContent += `
      <rect x="${xCenter + barGap/2}" y="${istY}" width="${barWidth}" height="${istHeight}" fill="var(--color-accent)" rx="3" />
    `;

    // Zeitsaldo Point
    const saldoY = baselineY - ((data.saldo + roundedMaxSaldo) / (2 * roundedMaxSaldo)) * drawHeight;
    linePoints.push({ x: xCenter, y: saldoY, value: data.saldo });
  }

  // Draw Zeitsaldo trend line path
  const pathD = linePoints.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  svgContent += `
    <path d="${pathD}" fill="none" stroke="var(--color-danger)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
  `;

  // Draw Zeitsaldo Dots & Labels
  for (const p of linePoints) {
    const prefix = p.value > 0 ? '+' : '';
    const valText = `${prefix}${p.value.toFixed(1)}h`;
    svgContent += `
      <circle cx="${p.x}" cy="${p.y}" r="4.5" fill="var(--color-danger)" stroke="var(--color-bg)" stroke-width="2" />
      <text x="${p.x}" y="${p.y - 10}" text-anchor="middle" font-size="9.5" font-weight="bold" fill="var(--color-danger)" style="text-shadow: 0 1px 2px var(--color-bg);">${valText}</text>
    `;
  }

  svg.innerHTML = svgContent;
}

/**
 * Print A4 Portrait Timesheet PDF for the selected month using browser print preview
 */
async function printMonthlyReport() {
  const viewedUser = getViewedUser();
  if (!viewedUser) return;

  const periodSelect = document.getElementById('report-period-select');
  const period = periodSelect.value;
  
  const today = Temporal.Now.plainDateISO();
  let start;

  if (period === 'current-week') {
    const wday = today.dayOfWeek;
    start = today.subtract({ days: wday - 1 });
  } else if (period === 'current-month') {
    start = today.with({ day: 1 });
  } else if (period === 'last-month') {
    const prevMonth = today.subtract({ months: 1 });
    start = prevMonth.with({ day: 1 });
  } else {
    // All time or fallbacks: use oldest punch or current month
    const allPunches = await dbAdapter.getAll('punches');
    const userPunches = allPunches.filter(p => p.user_id === viewedUser.id);
    if (userPunches.length > 0) {
      const oldestStr = userPunches.reduce((oldest, current) => 
        current.start_time < oldest ? current.start_time : oldest
      , userPunches[0].start_time).split('T')[0];
      start = Temporal.PlainDate.from(oldestStr);
    } else {
      start = today.with({ day: 1 });
    }
  }

  const monthStart = start.with({ day: 1 });
  const monthEnd = start.with({ day: start.daysInMonth });
  
  const allPunches = await dbAdapter.getAll('punches');
  const userPunches = allPunches.filter(p => p.user_id === viewedUser.id);

  const allTimeOff = await dbAdapter.getAll('time_off');
  const userTimeOff = allTimeOff.filter(o => o.user_id === viewedUser.id);

  const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const lang = getLanguage();
  
  // Month Names translation
  const monthNamesDe = [
    'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
    'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'
  ];
  const monthNamesEn = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const monthName = lang === 'de' ? monthNamesDe[monthStart.month - 1] : monthNamesEn[monthStart.month - 1];
  const formattedMonthYear = `${monthName} ${monthStart.year}`;

  let totalSoll = 0;
  let totalIst = 0;
  let totalBreakMin = 0;
  let totalSaldo = 0;
  let countVacation = 0;
  let countSick = 0;
  let countHoliday = 0;
  let countCompensation = 0;

  let tableRowsHtml = '';

  let iter = monthStart;
  while (Temporal.PlainDate.compare(iter, monthEnd) <= 0) {
    const dateStr = iter.toString();
    const wday = iter.dayOfWeek;
    const isWeekend = wday === 6 || wday === 7;
    const daySoll = viewedUser.daily_soll[weekdayKeys[wday - 1]] || 0;

    const dayPunches = userPunches.filter(p => p.start_time.startsWith(dateStr));
    const dayTimeOff = userTimeOff.find(o => o.date === dateStr);

    const stats = calculateDayDetails(daySoll, dayPunches, dayTimeOff);

    totalSoll += stats.sollHours;
    totalIst += stats.istHours;
    totalBreakMin += stats.totalBreakMinutes;
    totalSaldo += stats.saldoHours;

    if (stats.timeOffType === 'vacation') countVacation++;
    else if (stats.timeOffType === 'sick') countSick++;
    else if (stats.timeOffType === 'holiday') countHoliday++;
    else if (stats.timeOffType === 'compensation') countCompensation++;

    let detailsText = '';
    if (stats.timeOffType) {
      if (stats.timeOffType === 'vacation') {
        detailsText = lang === 'de' ? 'Urlaub' : 'Vacation';
      } else if (stats.timeOffType === 'sick') {
        detailsText = lang === 'de' ? 'Krank' : 'Sick';
      } else if (stats.timeOffType === 'holiday') {
        detailsText = lang === 'de' ? 'Feiertag' : 'Public Holiday';
      } else if (stats.timeOffType === 'compensation') {
        detailsText = lang === 'de' ? 'Zeitausgleich' : 'Compensation Time';
      }
    } else if (dayPunches.length > 0) {
      detailsText = dayPunches
        .sort((a, b) => a.start_time.localeCompare(b.start_time))
        .map(p => {
          const startPart = p.start_time.split('T')[1]?.substring(0, 5) || '';
          const endPart = p.end_time ? p.end_time.split('T')[1]?.substring(0, 5) : '...';
          return `${startPart}-${endPart}`;
        })
        .join(', ');
    }

    const formattedDate = iter.toLocaleString(lang, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const weekdayName = iter.toLocaleString(lang, { weekday: 'short' });

    const formatH = (val) => val === 0 ? '' : val.toFixed(2);
    const formatM = (min) => min === 0 ? '' : (min / 60).toFixed(2);
    
    let saldoText = '';
    if (stats.saldoHours !== 0) {
      const sign = stats.saldoHours > 0 ? '+' : '';
      saldoText = `${sign}${stats.saldoHours.toFixed(2)}`;
    }

    const rowClass = isWeekend ? 'weekend' : '';

    tableRowsHtml += `
      <tr class="${rowClass}">
        <td>${formattedDate} (${weekdayName})</td>
        <td class="text-right">${formatH(stats.sollHours)}</td>
        <td class="text-right">${formatH(stats.istHours)}</td>
        <td class="text-right">${formatM(stats.totalBreakMinutes)}</td>
        <td class="text-right" style="font-weight: ${stats.saldoHours !== 0 ? '600' : 'normal'};">${saldoText}</td>
        <td>${detailsText}</td>
      </tr>
    `;

    iter = iter.add({ days: 1 });
  }

  const totalFree = countVacation + countSick + countHoliday + countCompensation;
  const freeBreakdown = lang === 'de'
    ? `Urlaub: ${countVacation} | Krank: ${countSick} | Feiertag: ${countHoliday} | ZA: ${countCompensation}`
    : `Vacation: ${countVacation} | Sick: ${countSick} | Holiday: ${countHoliday} | Comp: ${countCompensation}`;

  const formatSaldo = (val) => {
    const sign = val > 0 ? '+' : '';
    return `${sign}${val.toFixed(2)}h`;
  };

  const printTitle = t('print-title');
  const printEmpSig = t('print-signature-employee');
  const printSupSig = t('print-signature-supervisor');
  const printDateLabel = t('print-date');

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert(lang === 'de' ? 'Popup-Blocker verhindert das Drucken des Monatsberichts.' : 'Popup blocker is preventing printing the monthly report.');
    return;
  }

  printWindow.document.write(`
<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <title>${printTitle} - ${viewedUser.name} - ${formattedMonthYear}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #333;
      padding: 20px;
      margin: 0;
      background: white;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      border-bottom: 2px solid #111;
      padding-bottom: 10px;
      margin-bottom: 20px;
    }
    .header h1 {
      margin: 0 0 5px 0;
      font-size: 18pt;
      color: #111;
    }
    .app-logo {
      font-size: 14pt;
      font-weight: bold;
      color: #00b894;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 20px;
      font-size: 10pt;
    }
    .meta-item strong {
      color: #111;
    }
    .stats-summary {
      display: flex;
      gap: 15px;
      background: #f8f9fa;
      border: 1px solid #dee2e6;
      border-radius: 6px;
      padding: 10px 15px;
      margin-bottom: 20px;
    }
    .stats-item {
      flex: 1;
    }
    .stats-item-title {
      font-size: 7.5pt;
      text-transform: uppercase;
      color: #6c757d;
      font-weight: 600;
    }
    .stats-item-val {
      font-size: 12pt;
      font-weight: 700;
      color: #212529;
      margin-top: 2px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 30px;
    }
    tr {
      page-break-inside: avoid;
    }
    thead {
      display: table-header-group;
    }
    th {
      background-color: #f1f3f5;
      border: 1px solid #dee2e6;
      padding: 6px 8px;
      font-weight: 700;
      font-size: 8.5pt;
      text-align: left;
    }
    td {
      border: 1px solid #dee2e6;
      padding: 5px 8px;
      font-size: 8.5pt;
      text-align: left;
    }
    tr.weekend {
      background-color: #f8f9fa;
    }
    tr.total-row {
      font-weight: 700;
      background-color: #e9ecef;
    }
    .signatures {
      display: flex;
      justify-content: space-between;
      margin-top: 50px;
      gap: 50px;
      page-break-inside: avoid;
    }
    .signature-box {
      flex: 1;
      border-top: 1px solid #495057;
      padding-top: 8px;
      text-align: left;
      font-size: 8.5pt;
      color: #495057;
    }
    .signature-line {
      height: 40px;
    }
    .text-right {
      text-align: right;
    }
    .text-center {
      text-align: center;
    }
    @media print {
      body {
        padding: 0;
      }
      @page {
        size: A4 portrait;
        margin: 1.5cm;
      }
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>${printTitle}</h1>
      <div style="font-size: 11pt; color: #495057;">${formattedMonthYear}</div>
    </div>
    <div class="app-logo">Stempelo</div>
  </div>

  <div class="meta-grid">
    <div class="meta-item">
      <strong>${lang === 'de' ? 'Mitarbeiter' : 'Employee'}:</strong> ${viewedUser.name}
    </div>
    <div class="meta-item" style="text-align: right;">
      <strong>${lang === 'de' ? 'Erstellt am' : 'Created on'}:</strong> ${today.toLocaleString(lang, { day: '2-digit', month: '2-digit', year: 'numeric' })}
    </div>
  </div>

  <div class="stats-summary">
    <div class="stats-item">
      <div class="stats-item-title">${lang === 'de' ? 'Soll Stunden' : 'Target Hours'}</div>
      <div class="stats-item-val">${totalSoll.toFixed(2)}h</div>
    </div>
    <div class="stats-item">
      <div class="stats-item-title">${lang === 'de' ? 'Ist Stunden' : 'Actual Hours'}</div>
      <div class="stats-item-val">${totalIst.toFixed(2)}h</div>
    </div>
    <div class="stats-item">
      <div class="stats-item-title">${lang === 'de' ? 'Zeitsaldo' : 'Time Balance'}</div>
      <div class="stats-item-val">${formatSaldo(totalSaldo)}</div>
    </div>
    <div class="stats-item" style="flex: 1.5;">
      <div class="stats-item-title">${lang === 'de' ? 'Urlaub & Absenzen' : 'Vacation & Absences'}</div>
      <div class="stats-item-val" style="font-size: 9pt; font-weight: normal; margin-top: 4px;">
        ${totalFree} ${lang === 'de' ? (totalFree === 1 ? 'Tag' : 'Tage') : (totalFree === 1 ? 'Day' : 'Days')}
        <div style="font-size: 7.5pt; color: #6c757d; margin-top: 1px;">${freeBreakdown}</div>
      </div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width: 25%;">${lang === 'de' ? 'Datum (Wochentag)' : 'Date (Weekday)'}</th>
        <th class="text-right" style="width: 12%;">${lang === 'de' ? 'Soll (h)' : 'Target (h)'}</th>
        <th class="text-right" style="width: 12%;">${lang === 'de' ? 'Ist (h)' : 'Actual (h)'}</th>
        <th class="text-right" style="width: 12%;">${lang === 'de' ? 'Pause (h)' : 'Break (h)'}</th>
        <th class="text-right" style="width: 12%;">${lang === 'de' ? 'Saldo (h)' : 'Saldo (h)'}</th>
        <th style="width: 27%;">${lang === 'de' ? 'Zeiten / Details' : 'Times / Details'}</th>
      </tr>
    </thead>
    <tbody>
      ${tableRowsHtml}
      <tr class="total-row">
        <td>${lang === 'de' ? 'Gesamt' : 'Total'}</td>
        <td class="text-right">${totalSoll.toFixed(2)}</td>
        <td class="text-right">${totalIst.toFixed(2)}</td>
        <td class="text-right">${(totalBreakMin / 60).toFixed(2)}</td>
        <td class="text-right">${formatSaldo(totalSaldo)}</td>
        <td></td>
      </tr>
    </tbody>
  </table>

  <div class="signatures">
    <div class="signature-box">
      <div class="signature-line"></div>
      <div>${printEmpSig} (${printDateLabel} / ${lang === 'de' ? 'Unterschrift' : 'Signature'})</div>
    </div>
    <div class="signature-box">
      <div class="signature-line"></div>
      <div>${printSupSig} (${printDateLabel} / ${lang === 'de' ? 'Unterschrift' : 'Signature'})</div>
    </div>
  </div>

  <script>
    window.onload = function() {
      setTimeout(function() {
        window.print();
      }, 300);
    };
  </script>
</body>
</html>
  `);
  printWindow.document.close();
}

function renderCustomBreakRules(rules) {
  const container = document.getElementById('break-custom-rules-list');
  if (!container) return;
  container.innerHTML = '';
  
  if (!rules || rules.length === 0) {
    container.innerHTML = `<p style="font-size: 0.85rem; color: var(--color-text-secondary);" data-i18n="settings-break-custom-rules-empty">Keine benutzerdefinierten Regeln definiert.</p>`;
    translateDOM();
    return;
  }
  
  rules.forEach((rule, index) => {
    const row = document.createElement('div');
    row.className = 'break-rule-row';
    row.style.display = 'grid';
    row.style.gridTemplateColumns = '1fr 1fr auto';
    row.style.gap = '10px';
    row.style.alignItems = 'end';
    
    row.innerHTML = `
      <div class="form-group" style="margin-bottom: 0;">
        <label data-i18n="settings-break-custom-rule-threshold">Ab Arbeitszeit (Std.)</label>
        <input type="number" class="custom-rule-threshold" min="0" max="24" step="0.1" value="${rule.threshold}" required>
      </div>
      <div class="form-group" style="margin-bottom: 0;">
        <label data-i18n="settings-break-custom-rule-deduction">Abzug Pause (Min.)</label>
        <input type="number" class="custom-rule-deduction" min="0" max="1440" step="1" value="${rule.deduction}" required>
      </div>
      <button type="button" class="btn secondary icon-btn btn-delete-break-rule" data-index="${index}" style="height: 48px; width: 48px; display: flex; align-items: center; justify-content: center;">
        <svg viewBox="0 0 24 24" width="18" height="18" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
    `;
    container.appendChild(row);
  });
  
  // Bind delete handlers
  container.querySelectorAll('.btn-delete-break-rule').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      rules.splice(idx, 1);
      renderCustomBreakRules(rules);
    };
  });
  
  translateDOM();
}

function renderSettingsActivities() {
  const container = document.getElementById('settings-activities-list');
  if (!container) return;
  container.innerHTML = '';

  if (tempActivities.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--color-text-secondary); padding: 15px; font-size: 0.85rem;" data-i18n="settings-activities-empty">
        ${t('settings-activities-empty')}
      </div>
    `;
    return;
  }

  tempActivities.forEach((act, idx) => {
    const item = document.createElement('div');
    item.style.display = 'flex';
    item.style.justifyContent = 'space-between';
    item.style.alignItems = 'center';
    item.style.padding = '8px 12px';
    item.style.borderRadius = '8px';
    item.style.backgroundColor = 'rgba(255,255,255,0.03)';
    item.style.border = '1px solid var(--color-card-border)';

    item.innerHTML = `
      <span style="color: var(--color-text-primary); font-size: 0.95rem; font-weight: 500;">${escapeHtml(act)}</span>
      <button type="button" class="btn secondary icon-btn btn-delete-activity" data-index="${idx}" style="height: 36px; width: 36px; display: flex; align-items: center; justify-content: center;">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
    `;
    container.appendChild(item);
  });

  // Bind delete handlers
  container.querySelectorAll('.btn-delete-activity').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      tempActivities.splice(idx, 1);
      renderSettingsActivities();
    };
  });
}

/**
 * Load user settings fields
 */
function updateSettingsTab(onlyTranslateDynamic = false) {
  if (!currentUser) return;

  const viewedUser = getViewedUser();
  if (!viewedUser) return;

  if (!onlyTranslateDynamic) {
    document.getElementById('set-user-name').value = viewedUser.name;
    document.getElementById('set-user-pin').value = ''; // Don't expose pin

    document.getElementById('soll-mon').value = viewedUser.daily_soll.mon || 0;
    document.getElementById('soll-tue').value = viewedUser.daily_soll.tue || 0;
    document.getElementById('soll-wed').value = viewedUser.daily_soll.wed || 0;
    document.getElementById('soll-thu').value = viewedUser.daily_soll.thu || 0;
    document.getElementById('soll-fri').value = viewedUser.daily_soll.fri || 0;
    document.getElementById('soll-sat').value = viewedUser.daily_soll.sat || 0;
    document.getElementById('soll-sun').value = viewedUser.daily_soll.sun || 0;

    document.getElementById('set-user-lang').value = viewedUser.language || 'de';
    document.getElementById('set-user-theme').value = viewedUser.theme_color || 'cyan';

    document.getElementById('set-overtime-start-date').value = viewedUser.overtime_start_date || '';
    document.getElementById('set-overtime-start-hours').value = viewedUser.overtime_start_hours !== undefined ? viewedUser.overtime_start_hours : 0.0;

    document.getElementById('set-user-notifications').checked = !!viewedUser.notifications_enabled;
    document.getElementById('set-holiday-country').value = viewedUser.holiday_country || '';

    // Load admin fields if admin
    const roleSelect = document.getElementById('set-user-role');
    if (roleSelect) {
      roleSelect.value = viewedUser.role || 'user';
    }
    const statusSelect = document.getElementById('set-user-status');
    if (statusSelect) {
      statusSelect.value = viewedUser.is_active !== undefined ? String(viewedUser.is_active) : '1';
    }

    const serverUrl = SyncService.getServerUrl();
    document.getElementById('sync-server-url').value = serverUrl;

    // Load Auto-Lock settings
    const autolockTime = storageGetItem('autolock-time') || 'disabled';
    const autolockSelect = document.getElementById('set-autolock-time');
    if (autolockSelect) {
      autolockSelect.value = autolockTime;
    }

    // Load Dark Mode Scheduler settings
    const dmMode = storageGetItem('darkmode-mode') || 'disabled';
    const dmStart = storageGetItem('darkmode-start') || '20:00';
    const dmEnd = storageGetItem('darkmode-end') || '07:00';
    
    document.getElementById('set-darkmode-mode').value = dmMode;
    document.getElementById('set-darkmode-start').value = dmStart;
    document.getElementById('set-darkmode-end').value = dmEnd;

    const customTimesEl = document.getElementById('darkmode-custom-times');
    if (customTimesEl) {
      if (dmMode === 'custom') {
        customTimesEl.classList.remove('hidden');
      } else {
        customTimesEl.classList.add('hidden');
      }
    }

    // Load Compliance and Break Profiles settings
    const breakProfile = viewedUser.break_profile || 'austria';
    tempCustomRules = viewedUser.break_custom_rules ? [...viewedUser.break_custom_rules] : [];
    
    document.getElementById('set-break-profile').value = breakProfile;
    
    const breakRulesSection = document.getElementById('break-custom-rules-section');
    if (breakProfile === 'custom') {
      breakRulesSection.classList.remove('hidden');
      renderCustomBreakRules(tempCustomRules);
    } else {
      breakRulesSection.classList.add('hidden');
    }

    // Load Automatic Holiday Sync settings
    document.getElementById('set-holiday-sync-active').checked = !!viewedUser.holiday_sync_active;

    // Load Activities
    tempActivities = viewedUser.activities ? [...viewedUser.activities] : [];
    renderSettingsActivities();

    // Load API token settings
    const token = viewedUser.api_token || '';
    const tokenInput = document.getElementById('settings-api-token');
    const apiInfoSection = document.getElementById('settings-api-info-section');
    const endpointUrlEl = document.getElementById('settings-api-endpoint-url');
    
    if (tokenInput && apiInfoSection && endpointUrlEl) {
      tokenInput.value = token;
      if (token) {
        apiInfoSection.classList.remove('hidden');
        let currentServerUrl = SyncService.getServerUrl() || window.location.origin;
        if (currentServerUrl.endsWith('/')) {
          currentServerUrl = currentServerUrl.slice(0, -1);
        }
        endpointUrlEl.textContent = `${currentServerUrl}/api/v1/punches`;
      } else {
        apiInfoSection.classList.add('hidden');
        endpointUrlEl.textContent = '';
      }
    }
  }

  // Sync Info
  const serverUrl = SyncService.getServerUrl();
  const lastSync = SyncService.getLastSyncTime();
  const lastSyncTimeEl = document.getElementById('sync-last-time');
  if (lastSyncTimeEl) {
    lastSyncTimeEl.textContent = lastSync 
      ? new Date(lastSync).toLocaleString(getLanguage()) 
      : t('settings-sync-never');
  }
  const syncStatusTextEl = document.getElementById('sync-status-text');
  if (syncStatusTextEl) {
    syncStatusTextEl.textContent = serverUrl ? t('settings-sync-status-connected') : t('settings-sync-status-disconnected');
  }

  updateStorageAudit();
}

/**
 * Updates the storage usage and quota estimates using the StorageManager API.
 */
async function updateStorageAudit() {
  const usageTextEl = document.getElementById('storage-usage-text');
  const quotaTextEl = document.getElementById('storage-quota-text');
  const barFillEl = document.getElementById('storage-bar-fill');

  if (!usageTextEl || !quotaTextEl || !barFillEl) return;

  if (navigator.storage && navigator.storage.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      
      const usageMB = (estimate.usage / (1024 * 1024)).toFixed(2);
      const quotaMB = (estimate.quota / (1024 * 1024)).toFixed(0);
      const percent = estimate.quota > 0 ? ((estimate.usage / estimate.quota) * 100).toFixed(2) : '0.00';
      
      usageTextEl.textContent = `${usageMB} MB (${percent}%)`;
      quotaTextEl.textContent = `${quotaMB} MB`;
      barFillEl.style.width = estimate.usage > 0 ? `${Math.max(1, parseFloat(percent))}%` : '0%';
    } catch (err) {
      console.error('Error fetching storage estimate:', err);
      usageTextEl.textContent = 'Error';
      quotaTextEl.textContent = 'Error';
      barFillEl.style.width = '0%';
    }
  } else {
    usageTextEl.textContent = t('settings-storage-unsupported');
    quotaTextEl.textContent = '–';
    barFillEl.style.width = '0%';
  }
}

// ----------------------------------------------------
// 6. Navigation Controls
// ----------------------------------------------------
function refreshSession() {
  if (currentUser) {
    const expiry = Date.now() + 12 * 60 * 60 * 1000; // 12 hours session
    storageSetItem('session-expiry', expiry.toString());
  }
}

function switchTab(tabId) {
  currentTab = tabId;
  storageSetItem('active-tab', tabId);
  refreshSession();
  
  // Update nav buttons
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => {
    if (item.getAttribute('data-tab') === tabId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Switch sections
  const sections = document.querySelectorAll('.tab-content');
  sections.forEach(sec => {
    if (sec.id === tabId) {
      sec.classList.add('active');
    } else {
      sec.classList.remove('active');
    }
  });

  // Fetch data depending on tab
  if (tabId === 'tab-punch') updatePunchTab();
  else if (tabId === 'tab-history') updateHistoryTab();
  else if (tabId === 'tab-reports') updateReportsTab();
  else if (tabId === 'tab-settings') updateSettingsTab();
  else if (tabId === 'tab-team') updateTeamTab();
}

let activeSettingsSubTab = 'settings-panel-general';

function switchSettingsSubTab(subTabId) {
  activeSettingsSubTab = subTabId;
  storageSetItem('settings-active-sub-tab', subTabId);
  refreshSession();

  // Update sub-nav buttons
  const subNavItems = document.querySelectorAll('.settings-sub-nav .sub-nav-item');
  subNavItems.forEach(item => {
    if (item.getAttribute('data-sub-tab') === subTabId) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Switch panels
  const panels = document.querySelectorAll('.settings-sub-panel');
  panels.forEach(panel => {
    if (panel.id === subTabId) {
      panel.classList.add('active');
    } else {
      panel.classList.remove('active');
    }
  });
}

function lockApp() {
  if (autolockTimerId) {
    clearTimeout(autolockTimerId);
    autolockTimerId = null;
  }
  currentUser = null;
  activeViewUserId = null;
  storageRemoveItem('session-expiry');
  applyThemeColor('cyan');
  document.getElementById('main-screen').classList.add('hidden');
  document.getElementById('lock-screen').classList.add('active');
  populateUserSelect();
}

function resetAutolockTimer() {
  if (autolockTimerId) {
    clearTimeout(autolockTimerId);
    autolockTimerId = null;
  }

  if (!currentUser) return;

  const autolockTime = storageGetItem('autolock-time') || 'disabled';
  if (autolockTime === 'disabled') return;

  const minutes = parseInt(autolockTime, 10);
  if (isNaN(minutes)) return;

  autolockTimerId = setTimeout(() => {
    console.log(`Auto-lock triggered after ${minutes} minutes of inactivity.`);
    lockApp();
  }, minutes * 60 * 1000);
}

// ----------------------------------------------------
// 7. Event Handlers & Submissions
// ----------------------------------------------------

function addPunchRow(startVal = '', endVal = '', activityVal = '') {
  const container = document.getElementById('punches-list-container');
  const row = document.createElement('div');
  row.className = 'punch-row';
  row.style.display = 'flex';
  row.style.flexDirection = 'column';
  row.style.gap = '8px';
  
  const activities = currentUser.activities || [];
  let optionsHtml = `<option value="">-- ${t('punch-activity-none')} --</option>`;
  activities.forEach(act => {
    const selected = act === activityVal ? 'selected' : '';
    optionsHtml += `<option value="${escapeHtml(act)}" ${selected}>${escapeHtml(act)}</option>`;
  });

  const displayStyle = activities.length === 0 ? 'display: none;' : 'width: 100%; display: flex; align-items: center; gap: 8px;';

  row.innerHTML = `
    <div style="display: flex; width: 100%; align-items: center; gap: 10px;">
      <div class="punch-row-inputs">
        <input type="time" class="punch-row-start" value="${startVal}" required>
        <span>bis</span>
        <input type="time" class="punch-row-end" value="${endVal}">
      </div>
      <button type="button" class="btn-remove-punch-row" title="Stempelung löschen">🗑️</button>
    </div>
    <div class="punch-row-activity-container" style="${displayStyle}">
      <span style="font-size: 0.8rem; font-weight: 600; color: var(--color-text-muted);">${t('history-edit-punch-activity')}</span>
      <select class="punch-row-activity custom-select small" style="flex: 1;">
        ${optionsHtml}
      </select>
    </div>
  `;
  
  const startInput = row.querySelector('.punch-row-start');
  const endInput = row.querySelector('.punch-row-end');
  
  startInput.oninput = updateEditPunchesSummary;
  endInput.oninput = updateEditPunchesSummary;
  
  row.querySelector('.btn-remove-punch-row').onclick = () => {
    row.remove();
    updateEditPunchesSummary();
  };
  
  container.appendChild(row);
  updateEditPunchesSummary();
}

function updateEditPunchesSummary() {
  const summaryEl = document.getElementById('edit-punches-summary');
  if (!summaryEl) return;

  const rows = document.querySelectorAll('.punch-row');
  const parsed = [];
  
  for (const row of rows) {
    const startVal = row.querySelector('.punch-row-start').value;
    const endVal = row.querySelector('.punch-row-end').value;
    if (startVal) {
      parsed.push({ startVal, endVal });
    }
  }

  if (parsed.length === 0) {
    summaryEl.innerHTML = '<span style="color: var(--color-text-muted);">Keine Stempelungen eingetragen.</span>';
    return;
  }

  // Sort chronologically by start time
  parsed.sort((a, b) => a.startVal.localeCompare(b.startVal));

  let grossMinutes = 0;
  let manualBreakMinutes = 0;
  let hasOverlap = false;
  let invalidTimeOrder = false;

  for (let i = 0; i < parsed.length; i++) {
    const current = parsed[i];
    
    // Parse start and end as minutes from midnight
    const startParts = current.startVal.split(':').map(Number);
    const startMin = startParts[0] * 60 + startParts[1];
    
    if (current.endVal) {
      const endParts = current.endVal.split(':').map(Number);
      const endMin = endParts[0] * 60 + endParts[1];
      
      if (endMin < startMin) {
        invalidTimeOrder = true;
      } else {
        grossMinutes += (endMin - startMin);
      }
    } else {
      // Active punch
      const dateStr = document.getElementById('manual-date').value;
      const todayStr = Temporal.Now.plainDateISO().toString();
      if (dateStr === todayStr) {
        const nowLocal = new Date();
        const nowMin = nowLocal.getHours() * 60 + nowLocal.getMinutes();
        if (nowMin > startMin) {
          grossMinutes += (nowMin - startMin);
        }
      }
    }

    if (i > 0) {
      const prev = parsed[i - 1];
      if (prev.endVal) {
        const prevEndParts = prev.endVal.split(':').map(Number);
        const prevEndMin = prevEndParts[0] * 60 + prevEndParts[1];
        
        if (startMin < prevEndMin) {
          hasOverlap = true;
        } else {
          manualBreakMinutes += (startMin - prevEndMin);
        }
      } else {
        hasOverlap = true;
      }
    }
  }

  if (invalidTimeOrder) {
    summaryEl.innerHTML = '<span style="color: #ef4444;">⚠️ Eine Endzeit liegt vor der Startzeit.</span>';
    return;
  }
  if (hasOverlap) {
    summaryEl.innerHTML = '<span style="color: #ef4444;">⚠️ Arbeitszeiten überlappen oder Reihenfolge ungültig.</span>';
    return;
  }

  // Austrian automatic break (AZG § 11)
  const grossHours = grossMinutes / 60;
  let autoBreakMinutes = 0;
  if (grossHours > 6.0 && manualBreakMinutes < 30) {
    autoBreakMinutes = 30 - manualBreakMinutes;
  }
  const totalBreakMinutes = manualBreakMinutes + autoBreakMinutes;
  const netMinutes = Math.max(0, grossMinutes - autoBreakMinutes);

  const formatMins = (totalMins) => {
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hrs === 0) return `${mins}m`;
    return `${hrs}h ${mins}m`;
  };

  let html = `
    <div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 12px;">
      <span style="color: var(--color-text-muted);">Arbeitszeit (brutto):</span>
      <strong>${formatMins(grossMinutes)}</strong>
      <span style="color: var(--color-text-muted);">Pause gestempelt:</span>
      <strong>${manualBreakMinutes} Min.</strong>
  `;

  if (autoBreakMinutes > 0) {
    html += `
      <span style="color: var(--color-text-muted);">Gesetzl. Pausenabzug:</span>
      <strong class="text-warning">+${autoBreakMinutes} Min. (AZG § 11)</strong>
    `;
  }

  html += `
      <span style="color: var(--color-text-muted);">Pause gesamt:</span>
      <strong>${totalBreakMinutes} Min.</strong>
      <span style="color: var(--color-text-muted); border-top: 1px solid rgba(255,255,255,0.08); padding-top: 4px; margin-top: 4px;">Netto-Arbeitszeit:</span>
      <strong class="text-success" style="border-top: 1px solid rgba(255,255,255,0.08); padding-top: 4px; margin-top: 4px;">${formatMins(netMinutes)}</strong>
    </div>
  `;

  summaryEl.innerHTML = html;
}


function updateSinglePunchSummary() {
  const summaryEl = document.getElementById('single-punch-summary');
  if (!summaryEl) return;

  const startVal = document.getElementById('manual-start-time').value;
  const endVal = document.getElementById('manual-end-time').value;
  const breakMinutes = parseInt(document.getElementById('manual-break').value) || 0;

  if (!startVal || !endVal) {
    summaryEl.innerHTML = '<span style="color: var(--color-text-muted);">Bitte Kommen- und Gehen-Zeiten eingeben.</span>';
    summaryEl.style.display = 'block';
    return;
  }

  // Parse start and end as minutes from midnight
  const startParts = startVal.split(':').map(Number);
  const startMin = startParts[0] * 60 + startParts[1];
  const endParts = endVal.split(':').map(Number);
  const endMin = endParts[0] * 60 + endParts[1];

  if (endMin < startMin) {
    summaryEl.innerHTML = '<span style="color: #ef4444;">⚠️ Die Endzeit liegt vor der Startzeit.</span>';
    summaryEl.style.display = 'block';
    return;
  }

  const durationMinutes = endMin - startMin;
  if (breakMinutes > durationMinutes) {
    summaryEl.innerHTML = '<span style="color: #ef4444;">⚠️ Die Pause ist länger als die Arbeitszeit.</span>';
    summaryEl.style.display = 'block';
    return;
  }

  const grossWorkMinutes = durationMinutes - breakMinutes;
  const grossWorkHours = grossWorkMinutes / 60;

  // Dynamic automatic break calculation
  let requiredMinBreak = 0;
  const profile = currentUser.break_profile || 'austria';
  if (profile === 'austria') {
    if (grossWorkHours > 6.0) requiredMinBreak = 30;
  } else if (profile === 'germany') {
    if (grossWorkHours > 6.0 && grossWorkHours <= 9.0) requiredMinBreak = 30;
    else if (grossWorkHours > 9.0) requiredMinBreak = 45;
  } else if (profile === 'custom') {
    const rules = currentUser.break_custom_rules || [];
    const sortedRules = [...rules].sort((a, b) => b.threshold - a.threshold);
    const matched = sortedRules.find(r => grossWorkHours > r.threshold);
    if (matched) requiredMinBreak = matched.deduction;
  }

  let autoBreakMinutes = 0;
  if (requiredMinBreak > 0 && breakMinutes < requiredMinBreak) {
    autoBreakMinutes = requiredMinBreak - breakMinutes;
  }
  const totalBreakMinutes = breakMinutes + autoBreakMinutes;
  const netMinutes = Math.max(0, durationMinutes - totalBreakMinutes);

  const formatMins = (totalMins) => {
    const hrs = Math.floor(totalMins / 60);
    const mins = totalMins % 60;
    if (hrs === 0) return `${mins}m`;
    return `${hrs}h ${mins}m`;
  };

  let html = `
    <div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 12px;">
      <span style="color: var(--color-text-muted);">Arbeitszeit (brutto):</span>
      <strong>${formatMins(durationMinutes)}</strong>
      <span style="color: var(--color-text-muted);">Pause gestempelt:</span>
      <strong>${breakMinutes} Min.</strong>
  `;

  if (autoBreakMinutes > 0) {
    let lawLabel = 'AZG § 11';
    if (profile === 'germany') lawLabel = 'ArbZG § 4';
    else if (profile === 'custom') lawLabel = 'Custom';
    html += `
      <span style="color: var(--color-text-muted);">Gesetzl. Pausenabzug:</span>
      <strong class="text-warning">+${autoBreakMinutes} Min. (${lawLabel})</strong>
    `;
  }

  html += `
      <span style="color: var(--color-text-muted);">Pause gesamt:</span>
      <strong>${totalBreakMinutes} Min.</strong>
      <span style="color: var(--color-text-muted); border-top: 1px solid rgba(255,255,255,0.08); padding-top: 4px; margin-top: 4px;">Netto-Arbeitszeit:</span>
      <strong class="text-success" style="border-top: 1px solid rgba(255,255,255,0.08); padding-top: 4px; margin-top: 4px;">${formatMins(netMinutes)}</strong>
    </div>
  `;

  summaryEl.innerHTML = html;
  summaryEl.style.display = 'block';
}


function showEditPunchDialog(dateStr, punches) {
  const dlg = document.getElementById('dlg-manual-punch');
  document.getElementById('manual-punch-title').textContent = `Arbeitszeit bearbeiten (${dateStr})`;
  document.getElementById('manual-date').value = dateStr;
  
  // Hide single punch fields and show multi-punch list
  document.getElementById('single-punch-fields').style.display = 'none';
  document.getElementById('multi-punch-fields').style.display = 'block';
  document.getElementById('manual-start-time').required = false;
  document.getElementById('manual-end-time').required = false;
  document.getElementById('manual-break').required = false;

  // Clear punches list container
  const container = document.getElementById('punches-list-container');
  container.innerHTML = '';

  if (!punches || punches.length === 0) {
    document.getElementById('edit-punch-id').value = '';
    document.getElementById('btn-delete-punch').classList.add('hidden');
    dlg.showModal();
    document.getElementById('btn-cancel-manual-punch')?.focus({ preventScroll: true });
    return;
  }

  // Sort punches chronologically
  const sortedPunches = [...punches].sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  
  // Set ID to first punch ID to indicate we are editing
  document.getElementById('edit-punch-id').value = sortedPunches[0].id;
  
  // Add rows for existing punches
  sortedPunches.forEach(p => {
    const startT = new Date(p.start_time).toTimeString().slice(0, 5);
    const endT = p.end_time ? new Date(p.end_time).toTimeString().slice(0, 5) : '';
    addPunchRow(startT, endT, p.activity || '');
  });

  document.getElementById('btn-delete-punch').classList.remove('hidden');
  dlg.showModal();
  document.getElementById('btn-cancel-manual-punch')?.focus({ preventScroll: true });
}

// Create User
document.getElementById('form-create-user').onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('new-user-name').value;
  const pin = document.getElementById('new-user-pin').value;
  const hashedPin = await hashPIN(pin);

  const allUsers = await dbAdapter.getAll('users');
  const nonDeletedUsers = allUsers.filter(u => !u.deleted);
  const isFirstUser = nonDeletedUsers.length === 0;

  const newUser = {
    id: crypto.randomUUID(),
    name: name,
    pin: hashedPin,
    language: getLanguage() || 'de',
    theme_color: 'cyan',
    weekly_hours: parseFloat(document.getElementById('new-soll-mon').value) * 5, // approximation or summary
    daily_soll: {
      mon: parseFloat(document.getElementById('new-soll-mon').value) || 0,
      tue: parseFloat(document.getElementById('new-soll-tue').value) || 0,
      wed: parseFloat(document.getElementById('new-soll-wed').value) || 0,
      thu: parseFloat(document.getElementById('new-soll-thu').value) || 0,
      fri: parseFloat(document.getElementById('new-soll-fri').value) || 0,
      sat: parseFloat(document.getElementById('new-soll-sat').value) || 0,
      sun: parseFloat(document.getElementById('new-soll-sun').value) || 0
    },
    role: isFirstUser ? 'admin' : 'user',
    is_active: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    deleted: 0
  };

  await dbAdapter.put('users', newUser);
  document.getElementById('dlg-create-user').close();
  populateUserSelect();
};

// PIN Keyboard Input
const pinBtns = document.querySelectorAll('.pin-btn:not(.action-clear):not(.action-ok)');
pinBtns.forEach(btn => {
  btn.onclick = () => {
    if (currentPinInput.length < 4) {
      currentPinInput += btn.getAttribute('data-val');
      updatePinDots();
    }
  };
});

document.getElementById('pin-clear').onclick = () => {
  resetPinEntry();
};

document.getElementById('pin-ok').onclick = async () => {
  try {
    const userId = document.getElementById('user-select').value;
    if (!userId) return;

    const user = await dbAdapter.get('users', userId);
    if (!user) return;

    if (user.is_active === 0 || user.is_active === false) {
      alert(t('settings-status-inactive-error'));
      resetPinEntry();
      return;
    }

    const hashed = await hashPIN(currentPinInput);
    if (hashed === user.pin) {
      currentUser = user;
      storageSetItem('last-logged-user-id', user.id);
      refreshSession();
      
      if (user.language) {
        applyGlobalLanguage(user.language);
      } else {
        applyGlobalLanguage(getLanguage() || 'de');
      }

      if (user.theme_color) {
        applyThemeColor(user.theme_color);
      } else {
        applyThemeColor('cyan');
      }

      updateConnectionBadge();
      
      await applyUserRoleGating(user);

      // Switch screen
      document.getElementById('lock-screen').classList.remove('active');
      document.getElementById('main-screen').classList.remove('hidden');
      document.getElementById('current-user-name').textContent = user.name;
      
      const savedTab = storageGetItem('active-tab') || 'tab-punch';
      switchTab(savedTab);
      resetAutolockTimer();
      syncHolidaysSilently();
    } else {
      resetPinEntry();
      const err = document.getElementById('pin-error');
      err.classList.remove('hidden');
      // shake animation trigger
      err.style.animation = 'none';
      err.offsetHeight; // trigger reflow
      err.style.animation = null;
    }
  } catch (error) {
    console.error('Anmeldefehler:', error);
    alert(t('alert-login-failed', { message: error.message }));
  }
};

// Punch Clock Actions
document.getElementById('btn-punch-in').onclick = async () => {
  if (!currentUser) return;
  
  const activityEl = document.getElementById('punch-activity-select');
  const activityVal = activityEl ? activityEl.value : '';
  
  const punch = {
    id: crypto.randomUUID(),
    user_id: currentUser.id,
    start_time: new Date().toISOString(),
    end_time: null,
    manual_edit: 0,
    activity: activityVal || null,
    created_at: new Date().toISOString(),
    deleted: 0
  };

  await dbAdapter.put('punches', punch);
  updatePunchTab();
  triggerSilentSync();
};

document.getElementById('btn-punch-out').onclick = async () => {
  if (!currentUser) return;

  const allPunches = await dbAdapter.getAll('punches');
  const active = allPunches.find(p => p.user_id === currentUser.id && !p.end_time);

  if (active) {
    active.end_time = new Date().toISOString();
    active.updated_at = new Date().toISOString();
    await dbAdapter.put('punches', active);
  }

  // Clear break timer if running
  storageRemoveItem(`user-break-active-${currentUser.id}`);
  storageRemoveItem(`user-break-start-${currentUser.id}`);

  updatePunchTab();
  triggerSilentSync();
};

document.getElementById('btn-break-toggle').onclick = async () => {
  if (!currentUser) return;

  const isBreakActive = storageGetItem(`user-break-active-${currentUser.id}`) === 'true';
  const allPunches = await dbAdapter.getAll('punches');
  const active = allPunches.find(p => p.user_id === currentUser.id && !p.end_time);

  if (!isBreakActive && active) {
    // Start Break: End the current punch session, set break state
    active.end_time = new Date().toISOString();
    await dbAdapter.put('punches', active);

    storageSetItem(`user-break-active-${currentUser.id}`, 'true');
    storageSetItem(`user-break-start-${currentUser.id}`, new Date().toISOString());
  } else if (isBreakActive) {
    // End Break: Start a new punch session, clear break state
    storageRemoveItem(`user-break-active-${currentUser.id}`);
    storageRemoveItem(`user-break-start-${currentUser.id}`);

    const newPunch = {
      id: crypto.randomUUID(),
      user_id: currentUser.id,
      start_time: new Date().toISOString(),
      end_time: null,
      manual_edit: 0,
      created_at: new Date().toISOString(),
      deleted: 0
    };
    await dbAdapter.put('punches', newPunch);
  }

  updatePunchTab();
  triggerSilentSync();
};

function showAddManualPunchDialog(dateStr) {
  const dlg = document.getElementById('dlg-manual-punch');
  document.getElementById('manual-punch-title').textContent = t('manual-title-add');
  document.getElementById('edit-punch-id').value = '';
  document.getElementById('manual-date').value = dateStr;
  
  // Set required attributes and show single punch fields
  document.getElementById('single-punch-fields').style.display = 'block';
  document.getElementById('multi-punch-fields').style.display = 'none';
  document.getElementById('manual-start-time').required = true;
  document.getElementById('manual-end-time').required = true;
  document.getElementById('manual-break').required = true;
  
  document.getElementById('manual-start-time').value = '08:00';
  document.getElementById('manual-end-time').value = '16:00';
  document.getElementById('manual-break').value = '30';
  document.getElementById('btn-delete-punch').classList.add('hidden');

  // Populate manual activity select dropdown
  const manualActContainer = document.getElementById('manual-activity-select-container');
  const manualActSelect = document.getElementById('manual-activity-select');
  if (manualActContainer && manualActSelect) {
    const activities = currentUser.activities || [];
    if (activities.length === 0) {
      manualActContainer.classList.add('hidden');
    } else {
      manualActContainer.classList.remove('hidden');
      let optHtml = `<option value="">-- ${t('punch-activity-none')} --</option>`;
      activities.forEach(act => {
        optHtml += `<option value="${escapeHtml(act)}">${escapeHtml(act)}</option>`;
      });
      manualActSelect.innerHTML = optHtml;
      manualActSelect.value = '';
    }
  }

  updateSinglePunchSummary();
  dlg.showModal();
  document.getElementById('btn-cancel-manual-punch')?.focus({ preventScroll: true });
}

// Add Manual Time Entry
document.getElementById('btn-add-manual-punch').onclick = () => {
  showAddManualPunchDialog(Temporal.Now.plainDateISO().toString());
};

document.getElementById('form-manual-punch').onsubmit = async (e) => {
  e.preventDefault();
  if (!currentUser) return;

  const id = document.getElementById('edit-punch-id').value;
  const dateStr = document.getElementById('manual-date').value;

  // Load existing punches for this user on this day
  const allPunches = await dbAdapter.getAll('punches');
  const userPunches = allPunches.filter(p => p.user_id === currentUser.id && p.start_time.startsWith(dateStr));
  const oldPunches = [...userPunches];

  if (id) {
    // Editing: Read all punch rows
    const rows = document.querySelectorAll('.punch-row');
    const parsedRows = [];
    
    for (const row of rows) {
      const startVal = row.querySelector('.punch-row-start').value;
      const endVal = row.querySelector('.punch-row-end').value;
      if (!startVal) continue;
      
      const activityVal = row.querySelector('.punch-row-activity')?.value || '';
      
      parsedRows.push({ startVal, endVal, activityVal });
    }
    
    // Sort rows chronologically by start time
    parsedRows.sort((a, b) => a.startVal.localeCompare(b.startVal));

    if (parsedRows.length === 0) {
      if (confirm(t('alert-confirm-delete-all-punches'))) {
        for (const p of oldPunches) {
          await dbAdapter.delete('punches', p.id, currentUser.id);
        }
        document.getElementById('dlg-manual-punch').close();
        updateHistoryTab();
        triggerSilentSync();
      }
      return;
    }
    
    // Validation
    let hasError = false;
    let activeCount = 0;
    
    for (let i = 0; i < parsedRows.length; i++) {
      const current = parsedRows[i];
      
      // 1. Check end time after start time
      if (current.endVal && current.endVal <= current.startVal) {
        alert(t('alert-invalid-punch-times', { endVal: current.endVal, startVal: current.startVal }));
        hasError = true;
        break;
      }
      
      // 2. Count active punches
      if (!current.endVal) {
        activeCount++;
        // Active punch must be the last one
        if (i !== parsedRows.length - 1) {
          alert(t('alert-active-punch-must-be-last'));
          hasError = true;
          break;
        }
      }
      
      // 3. Check overlap with previous punch
      if (i > 0) {
        const prev = parsedRows[i - 1];
        if (!prev.endVal) {
          alert(t('alert-previous-punch-active'));
          hasError = true;
          break;
        }
        if (current.startVal < prev.endVal) {
          alert(t('alert-overlapping-punches', { startVal: current.startVal, endVal: current.endVal || t('history-active-punch'), prevEndVal: prev.endVal }));
          hasError = true;
          break;
        }
      }
    }
    
    if (activeCount > 1) {
      alert(t('alert-max-one-active'));
      hasError = true;
    }
    
    if (hasError) return;

    // Convert local times to UTC ISO strings using Temporal for timezone correctness
    const tz = Temporal.Now.timeZoneId();
    const newPunches = [];
    
    for (const item of parsedRows) {
      try {
        const startIso = Temporal.PlainDateTime.from(`${dateStr}T${item.startVal}:00`).toZonedDateTime(tz).toInstant().toString();
        const endIso = item.endVal ? Temporal.PlainDateTime.from(`${dateStr}T${item.endVal}:00`).toZonedDateTime(tz).toInstant().toString() : null;
        
        newPunches.push({
          id: crypto.randomUUID(),
          user_id: currentUser.id,
          start_time: startIso,
          end_time: endIso,
          manual_edit: 1,
          activity: item.activityVal || null,
          created_at: new Date().toISOString(),
          deleted: 0
        });
      } catch (err) {
        console.error('Failed to parse date/time with Temporal:', err);
        alert(t('alert-time-conversion-error'));
        return;
      }
    }

    // Soft delete all old punches
    for (const p of oldPunches) {
      await dbAdapter.delete('punches', p.id, currentUser.id);
    }

    // Insert new punches
    for (const p of newPunches) {
      await dbAdapter.put('punches', p);
    }
    
    await dbAdapter.logAudit(currentUser.id, 'update', 'punches', dateStr, oldPunches, newPunches);
  } else {
    // Creating manual entry
    const startStr = document.getElementById('manual-start-time').value;
    const endStr = document.getElementById('manual-end-time').value;
    const breakMinutes = parseInt(document.getElementById('manual-break').value) || 0;
    
    const activityEl = document.getElementById('manual-activity-select');
    const activityVal = activityEl ? activityEl.value : '';

    const startIso = new Date(`${dateStr}T${startStr}:00`).toISOString();
    const endIso = endStr ? new Date(`${dateStr}T${endStr}:00`).toISOString() : null;

    let createdPunches = [];
    if (breakMinutes > 0 && endIso) {
      // Split into two punches to reflect gap
      const startMs = new Date(startIso).getTime();
      const endMs = new Date(endIso).getTime();
      const midPoint = startMs + ((endMs - startMs) / 2);

      const p1End = new Date(midPoint - (breakMinutes * 30000)).toISOString();
      const p1 = {
        id: crypto.randomUUID(),
        user_id: currentUser.id,
        start_time: startIso,
        end_time: p1End,
        manual_edit: 1,
        activity: activityVal || null,
        created_at: new Date().toISOString(),
        deleted: 0
      };
      await dbAdapter.put('punches', p1);
      createdPunches.push(p1);

      const p2Start = new Date(midPoint + (breakMinutes * 30000)).toISOString();
      const p2 = {
        id: crypto.randomUUID(),
        user_id: currentUser.id,
        start_time: p2Start,
        end_time: endIso,
        manual_edit: 1,
        activity: activityVal || null,
        created_at: new Date().toISOString(),
        deleted: 0
      };
      await dbAdapter.put('punches', p2);
      createdPunches.push(p2);

      await dbAdapter.logAudit(currentUser.id, 'insert', 'punches', dateStr, null, createdPunches);
    } else {
      const p = {
        id: crypto.randomUUID(),
        user_id: currentUser.id,
        start_time: startIso,
        end_time: endIso,
        manual_edit: 1,
        activity: activityVal || null,
        created_at: new Date().toISOString(),
        deleted: 0
      };
      await dbAdapter.put('punches', p);
      createdPunches.push(p);

      await dbAdapter.logAudit(currentUser.id, 'insert', 'punches', dateStr, null, createdPunches);
    }
  }

  document.getElementById('dlg-manual-punch').close();
  updateHistoryTab();
  triggerSilentSync();
};

document.getElementById('btn-delete-punch').onclick = async () => {
  const id = document.getElementById('edit-punch-id').value;
  const dateStr = document.getElementById('manual-date').value;
  if (id && confirm(t('alert-confirm-delete-day'))) {
    // Delete all punches for this user on this day
    const allPunches = await dbAdapter.getAll('punches');
    const todayPunches = allPunches.filter(p => p.user_id === currentUser.id && p.start_time.startsWith(dateStr));
    
    for (const p of todayPunches) {
      await dbAdapter.delete('punches', p.id, currentUser.id);
    }
    
    document.getElementById('dlg-manual-punch').close();
    updateHistoryTab();
    triggerSilentSync();
  }
};

function showAddTimeOffDialog(dateStr) {
  const dlg = document.getElementById('dlg-timeoff');
  document.getElementById('timeoff-date').value = dateStr;
  dlg.showModal();
  document.getElementById('btn-cancel-timeoff')?.focus({ preventScroll: true });
}

// Add Time Off (Abwesenheit)
document.getElementById('btn-add-timeoff').onclick = () => {
  showAddTimeOffDialog(Temporal.Now.plainDateISO().toString());
};

document.getElementById('form-timeoff').onsubmit = async (e) => {
  e.preventDefault();
  if (!currentUser) return;

  const dateStr = document.getElementById('timeoff-date').value;
  const type = document.getElementById('timeoff-type').value;

  // Check if time-off already exists for this day
  const allTimeOff = await dbAdapter.getAll('time_off');
  const existing = allTimeOff.find(o => o.user_id === currentUser.id && o.date === dateStr);

  if (existing) {
    existing.type = type;
    existing.updated_at = new Date().toISOString();
    await dbAdapter.put('time_off', existing);
    await dbAdapter.logAudit(currentUser.id, 'update', 'time_off', existing.id, null, existing);
  } else {
    const off = {
      id: crypto.randomUUID(),
      user_id: currentUser.id,
      date: dateStr,
      type: type,
      created_at: new Date().toISOString(),
      deleted: 0
    };
    await dbAdapter.put('time_off', off);
    await dbAdapter.logAudit(currentUser.id, 'insert', 'time_off', off.id, null, off);
  }

  document.getElementById('dlg-timeoff').close();
  updateHistoryTab();
  triggerSilentSync();
};

// User Profile settings submit
document.getElementById('form-user-settings').onsubmit = async (e) => {
  e.preventDefault();
  if (!currentUser) return;

  const viewedUser = getViewedUser();
  if (!viewedUser) return;

  let newRole = viewedUser.role || 'user';
  let newActive = viewedUser.is_active !== undefined ? viewedUser.is_active : 1;

  if (currentUser.role === 'admin') {
    newRole = document.getElementById('set-user-role').value;
    newActive = parseInt(document.getElementById('set-user-status').value, 10);

    // Guard: Prevent deactivating or demoting the last admin
    if (viewedUser.role === 'admin' && (newRole !== 'admin' || newActive === 0)) {
      const allUsers = await dbAdapter.getAll('users');
      const activeAdmins = allUsers.filter(u => !u.deleted && u.role === 'admin' && u.is_active !== 0 && u.is_active !== false);
      if (activeAdmins.length <= 1) {
        alert(t('settings-admin-demote-error'));
        return;
      }
    }
  }

  const name = document.getElementById('set-user-name').value;
  const pin = document.getElementById('set-user-pin').value;
  const lang = document.getElementById('set-user-lang').value;
  const theme = document.getElementById('set-user-theme').value;

  viewedUser.name = name;
  viewedUser.language = lang;
  viewedUser.theme_color = theme;
  viewedUser.role = newRole;
  viewedUser.is_active = newActive;

  if (pin && pin.length === 4) {
    viewedUser.pin = await hashPIN(pin);
  }

  viewedUser.daily_soll = {
    mon: parseFloat(document.getElementById('soll-mon').value) || 0,
    tue: parseFloat(document.getElementById('soll-tue').value) || 0,
    wed: parseFloat(document.getElementById('soll-wed').value) || 0,
    thu: parseFloat(document.getElementById('soll-thu').value) || 0,
    fri: parseFloat(document.getElementById('soll-fri').value) || 0,
    sat: parseFloat(document.getElementById('soll-sat').value) || 0,
    sun: parseFloat(document.getElementById('soll-sun').value) || 0
  };

  viewedUser.weekly_hours = Object.values(viewedUser.daily_soll).reduce((a, b) => a + b, 0);

  const overtimeStartDate = document.getElementById('set-overtime-start-date').value;
  const overtimeStartHours = parseFloat(document.getElementById('set-overtime-start-hours').value) || 0.0;

  viewedUser.overtime_start_date = overtimeStartDate || null;
  viewedUser.overtime_start_hours = overtimeStartHours;

  const notificationsEnabled = document.getElementById('set-user-notifications').checked;
  viewedUser.notifications_enabled = notificationsEnabled;

  const holidayCountry = document.getElementById('set-holiday-country').value;
  viewedUser.holiday_country = holidayCountry || null;

  // Save compliance and break profiles settings
  const breakProfile = document.getElementById('set-break-profile').value;
  viewedUser.break_profile = breakProfile;

  const customRules = [];
  const ruleRows = document.querySelectorAll('.break-rule-row');
  ruleRows.forEach(row => {
    const threshold = parseFloat(row.querySelector('.custom-rule-threshold').value) || 0;
    const deduction = parseInt(row.querySelector('.custom-rule-deduction').value) || 0;
    customRules.push({ threshold, deduction });
  });
  customRules.sort((a, b) => a.threshold - b.threshold);
  viewedUser.break_custom_rules = customRules;

  // Save automatic holiday sync checkbox
  viewedUser.holiday_sync_active = document.getElementById('set-holiday-sync-active').checked;

  // Save Activities
  viewedUser.activities = [...tempActivities];

  if (viewedUser.id === currentUser.id) {
    if (notificationsEnabled && ('Notification' in window) && Notification.permission !== 'granted') {
      await requestNotificationPermission();
    } else if (!notificationsEnabled) {
      clearReminderTimers();
    }
  }

  await dbAdapter.put('users', viewedUser);

  if (viewedUser.id === currentUser.id) {
    currentUser = viewedUser;
    document.getElementById('current-user-name').textContent = name;
    // Set the selected language globally
    applyGlobalLanguage(lang);
    // Apply theme color
    applyThemeColor(theme);
  }

  alert(t('alert-settings-saved'));
  await populateUserSelect();
  await populateAdminUserSelectors();
  updateSettingsTab();
  triggerSilentSync();
};

// Cancel modal handlers
document.getElementById('btn-cancel-create-user').onclick = () => document.getElementById('dlg-create-user').close();
document.getElementById('btn-cancel-manual-punch').onclick = () => document.getElementById('dlg-manual-punch').close();
document.getElementById('btn-cancel-timeoff').onclick = () => document.getElementById('dlg-timeoff').close();
document.getElementById('btn-close-backup').onclick = () => document.getElementById('dlg-backup').close();
document.getElementById('btn-close-server-settings').onclick = () => document.getElementById('dlg-server-settings').close();

// Wire up multi-punch row add button
document.getElementById('btn-add-punch-row').onclick = () => addPunchRow();

// Wire up single-punch fields real-time calculations
document.getElementById('manual-start-time').oninput = updateSinglePunchSummary;
document.getElementById('manual-end-time').oninput = updateSinglePunchSummary;
document.getElementById('manual-break').oninput = updateSinglePunchSummary;

document.getElementById('btn-show-create-user').onclick = () => {
  document.getElementById('new-user-name').value = '';
  document.getElementById('new-user-pin').value = '';
  document.getElementById('dlg-create-user').showModal();
  document.getElementById('btn-cancel-create-user')?.focus({ preventScroll: true });
};

document.getElementById('btn-show-server-settings').onclick = () => {
  document.getElementById('lock-sync-server-url').value = SyncService.getServerUrl();
  document.getElementById('dlg-server-settings').showModal();
  document.getElementById('btn-close-server-settings')?.focus({ preventScroll: true });
};

// Lock screen language switcher toggles
document.querySelectorAll('.btn-lock-lang').forEach(btn => {
  btn.onclick = () => {
    const lang = btn.getAttribute('data-lang');
    applyGlobalLanguage(lang);
  };
});

// History Tab View Switcher Event Handlers
document.getElementById('btn-view-list').onclick = () => {
  historyViewMode = 'list';
  document.getElementById('btn-view-list').classList.add('active');
  document.getElementById('btn-view-calendar').classList.remove('active');
  document.getElementById('filter-period').closest('.filter-group').classList.remove('hidden');
  const customDatesEl = document.getElementById('filter-custom-dates');
  if (document.getElementById('filter-period').value === 'custom') {
    customDatesEl.classList.remove('hidden');
  }
  updateHistoryTab();
};

document.getElementById('btn-view-calendar').onclick = () => {
  historyViewMode = 'calendar';
  document.getElementById('btn-view-calendar').classList.add('active');
  document.getElementById('btn-view-list').classList.remove('active');
  document.getElementById('filter-period').closest('.filter-group').classList.add('hidden');
  document.getElementById('filter-custom-dates').classList.add('hidden');
  updateHistoryTab();
};

// Calendar Navigation
document.getElementById('btn-cal-prev').onclick = () => {
  calendarActiveDate = calendarActiveDate.subtract({ months: 1 });
  updateHistoryTab();
};

document.getElementById('btn-cal-next').onclick = () => {
  calendarActiveDate = calendarActiveDate.add({ months: 1 });
  updateHistoryTab();
};

// Dropdown user select changer language auto-apply
document.getElementById('user-select').onchange = async () => {
  resetPinEntry();
  const userId = document.getElementById('user-select').value;
  if (!userId) return;
  const user = await dbAdapter.get('users', userId);
  if (user && user.language) {
    applyGlobalLanguage(user.language);
  }
};

// Settings Break Profile select change preview
document.getElementById('set-break-profile').onchange = () => {
  const profile = document.getElementById('set-break-profile').value;
  const breakRulesSection = document.getElementById('break-custom-rules-section');
  if (profile === 'custom') {
    breakRulesSection.classList.remove('hidden');
    renderCustomBreakRules(tempCustomRules);
  } else {
    breakRulesSection.classList.add('hidden');
  }
};

// Add custom break rule button click
document.getElementById('btn-add-break-rule').onclick = () => {
  tempCustomRules.push({ threshold: 6.0, deduction: 30 });
  renderCustomBreakRules(tempCustomRules);
};

// Add activity button click
document.getElementById('settings-activity-add').onclick = () => {
  const input = document.getElementById('settings-activity-input');
  if (!input) return;
  const val = input.value.trim();
  if (val) {
    if (tempActivities.includes(val)) {
      alert(t('alert-activity-duplicate'));
      return;
    }
    tempActivities.push(val);
    input.value = '';
    renderSettingsActivities();
  }
};

// REST API Token actions
document.getElementById('btn-api-generate').onclick = async () => {
  if (!currentUser) return;
  const token = generateSecureToken();
  currentUser.api_token = token;
  await dbAdapter.put('users', currentUser);
  
  const tokenInput = document.getElementById('settings-api-token');
  const apiInfoSection = document.getElementById('settings-api-info-section');
  const endpointUrlEl = document.getElementById('settings-api-endpoint-url');
  
  if (tokenInput && apiInfoSection && endpointUrlEl) {
    tokenInput.value = token;
    apiInfoSection.classList.remove('hidden');
    let currentServerUrl = SyncService.getServerUrl() || window.location.origin;
    if (currentServerUrl.endsWith('/')) {
      currentServerUrl = currentServerUrl.slice(0, -1);
    }
    endpointUrlEl.textContent = `${currentServerUrl}/api/v1/punches`;
  }
  
  triggerSilentSync();
};

document.getElementById('btn-api-revoke').onclick = async () => {
  if (!currentUser) return;
  if (confirm(t('alert-api-token-revoke-confirm'))) {
    currentUser.api_token = null;
    await dbAdapter.put('users', currentUser);
    
    const tokenInput = document.getElementById('settings-api-token');
    const apiInfoSection = document.getElementById('settings-api-info-section');
    const endpointUrlEl = document.getElementById('settings-api-endpoint-url');
    
    if (tokenInput && apiInfoSection && endpointUrlEl) {
      tokenInput.value = '';
      apiInfoSection.classList.add('hidden');
      endpointUrlEl.textContent = '';
    }
    
    triggerSilentSync();
  }
};

document.getElementById('btn-api-copy').onclick = () => {
  const tokenInput = document.getElementById('settings-api-token');
  if (tokenInput && tokenInput.value) {
    navigator.clipboard.writeText(tokenInput.value).then(() => {
      alert(t('alert-api-token-copied'));
    }).catch(err => {
      console.error('Failed to copy token:', err);
    });
  }
};

// Settings language selection change preview
document.getElementById('set-user-lang').onchange = () => {
  const lang = document.getElementById('set-user-lang').value;
  applyGlobalLanguage(lang);
};

// Settings theme selection change preview
document.getElementById('set-user-theme').onchange = () => {
  const theme = document.getElementById('set-user-theme').value;
  applyThemeColor(theme);
};

// Settings Dark Mode Scheduler change preview
document.getElementById('set-darkmode-mode').onchange = () => {
  const mode = document.getElementById('set-darkmode-mode').value;
  storageSetItem('darkmode-mode', mode);
  
  const customTimesEl = document.getElementById('darkmode-custom-times');
  if (customTimesEl) {
    if (mode === 'custom') {
      customTimesEl.classList.remove('hidden');
    } else {
      customTimesEl.classList.add('hidden');
    }
  }
  
  applyDarkModeSettings();
};

document.getElementById('set-darkmode-start').onchange = () => {
  const start = document.getElementById('set-darkmode-start').value;
  storageSetItem('darkmode-start', start);
  applyDarkModeSettings();
};

document.getElementById('set-darkmode-end').onchange = () => {
  const end = document.getElementById('set-darkmode-end').value;
  storageSetItem('darkmode-end', end);
  applyDarkModeSettings();
};

document.getElementById('btn-save-server-settings').onclick = async () => {
  if (isSyncing) return;
  const saveBtn = document.getElementById('btn-save-server-settings');
  const serverUrl = document.getElementById('lock-sync-server-url').value.trim();
  
  if (!serverUrl) {
    alert(t('alert-valid-url-required'));
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = getLanguage() === 'de' ? 'Verbinde...' : 'Connecting...';

  SyncService.setServerUrl(serverUrl);

  isSyncing = true;
  updateConnectionBadge();

  try {
    if (!idb) {
      console.log('IndexedDB is null, trying to open now...');
      await dbAdapter.open();
    }
    const res = await SyncService.sync(dbAdapter);
    await populateUserSelect();
    alert(t('alert-connection-success', { count: res.appliedCount }));
    document.getElementById('dlg-server-settings').close();
  } catch (error) {
    console.error(error);
    alert(t('alert-connection-failed', { message: error.message }));
  } finally {
    isSyncing = false;
    saveBtn.disabled = false;
    saveBtn.textContent = t('server-btn-save');
    updateConnectionBadge();
  }
};

// Periodic Selection update reports
document.getElementById('report-period-select').onchange = () => {
  updateReportsTab();
};

document.getElementById('btn-print-report').onclick = () => {
  printMonthlyReport();
};

// Filter Bar event listeners for History tab
document.getElementById('filter-period').onchange = () => {
  const customDates = document.getElementById('filter-custom-dates');
  if (document.getElementById('filter-period').value === 'custom') {
    customDates.classList.remove('hidden');
  } else {
    customDates.classList.add('hidden');
    // Clear inputs when hiding
    document.getElementById('filter-start-date').value = '';
    document.getElementById('filter-end-date').value = '';
  }
  updateHistoryTab();
};

document.getElementById('filter-start-date').onchange = () => updateHistoryTab();
document.getElementById('filter-end-date').onchange = () => updateHistoryTab();
document.getElementById('filter-type').onchange = () => updateHistoryTab();
document.getElementById('filter-manual-only').onchange = () => updateHistoryTab();
document.getElementById('btn-export-csv').onclick = () => exportHistoryToCSV();

document.getElementById('admin-user-select-history').onchange = handleAdminUserSelectChange;
document.getElementById('admin-user-select-reports').onchange = handleAdminUserSelectChange;
document.getElementById('admin-user-select-settings').onchange = handleAdminUserSelectChange;


// Sync triggers
document.getElementById('btn-sync-now').onclick = async () => {
  if (isSyncing) return;
  const syncBtn = document.getElementById('btn-sync-now');
  syncBtn.disabled = true;
  syncBtn.textContent = getLanguage() === 'de' ? 'Synchronisiere...' : 'Syncing...';

  const serverUrl = document.getElementById('sync-server-url').value;
  SyncService.setServerUrl(serverUrl);

  isSyncing = true;
  updateConnectionBadge();

  try {
    const res = await SyncService.sync(dbAdapter);
    document.getElementById('sync-last-time').textContent = new Date(res.serverTime).toLocaleString(getLanguage());
    
    if (currentUser) {
      const latestUser = await dbAdapter.get('users', currentUser.id);
      if (latestUser) {
        currentUser = latestUser;
        const userNameEl = document.getElementById('current-user-name');
        if (userNameEl) userNameEl.textContent = currentUser.name;
        if (currentUser.theme_color) {
          applyThemeColor(currentUser.theme_color);
        } else {
          applyThemeColor('cyan');
        }
        await applyUserRoleGating(currentUser);
      }
    }

    alert(t('alert-sync-success', { count: res.appliedCount }));
  } catch (error) {
    console.error(error);
    alert(t('alert-sync-failed', { message: error.message }));
  } finally {
    isSyncing = false;
    syncBtn.disabled = false;
    syncBtn.textContent = t('settings-sync-btn-now');
    updateSettingsTab();
    updateConnectionBadge();
  }
};

async function syncHolidaysSilently() {
  if (!currentUser || !currentUser.holiday_country || !currentUser.holiday_sync_active) return;
  
  const countryCode = currentUser.holiday_country;
  const year = Temporal.Now.plainDateISO().year;
  const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`;
  
  console.log(`Automatic background holiday sync started for ${countryCode} for year ${year}`);
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const holidays = await response.json();
    
    const allTimeOff = await dbAdapter.getAll('time_off');
    const userTimeOff = allTimeOff.filter(o => o.user_id === currentUser.id && !o.deleted);
    
    let count = 0;
    for (const hol of holidays) {
      if (hol.types && !hol.types.includes('Public')) {
        continue;
      }
      const holDate = hol.date;
      const exists = userTimeOff.some(o => o.date === holDate);
      if (!exists) {
        const off = {
          id: crypto.randomUUID(),
          user_id: currentUser.id,
          date: holDate,
          type: 'holiday',
          created_at: new Date().toISOString(),
          deleted: 0
        };
        await dbAdapter.put('time_off', off);
        await dbAdapter.logAudit(currentUser.id, 'insert', 'time_off', off.id, null, off);
        count++;
      }
    }
    
    if (count > 0) {
      console.log(`Successfully auto-imported ${count} new public holidays for ${year}`);
      updateHistoryTab();
      if (currentTab === 'tab-punch') updatePunchTab();
      triggerSilentSync();
    } else {
      console.log(`No new holidays to auto-import for ${year}`);
    }
  } catch (error) {
    console.warn('Failed to auto-import holidays in background:', error);
  }
}

document.getElementById('btn-import-holidays').onclick = async () => {
  if (!currentUser) return;
  const countryCode = document.getElementById('set-holiday-country').value;
  if (!countryCode) {
    alert(t('alert-select-country'));
    return;
  }

  const btnImport = document.getElementById('btn-import-holidays');
  btnImport.disabled = true;
  const originalText = btnImport.textContent;
  btnImport.textContent = getLanguage() === 'de' ? 'Lädt...' : 'Loading...';

  const year = Temporal.Now.plainDateISO().year;
  const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`;

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const holidays = await response.json();

    const allTimeOff = await dbAdapter.getAll('time_off');
    const userTimeOff = allTimeOff.filter(o => o.user_id === currentUser.id && !o.deleted);

    let count = 0;
    for (const hol of holidays) {
      // Only import actual public holidays (ignore school holidays, etc.)
      if (hol.types && !hol.types.includes('Public')) {
        continue;
      }
      const holDate = hol.date; // YYYY-MM-DD
      const exists = userTimeOff.some(o => o.date === holDate);
      if (!exists) {
        const off = {
          id: crypto.randomUUID(),
          user_id: currentUser.id,
          date: holDate,
          type: 'holiday',
          created_at: new Date().toISOString(),
          deleted: 0
        };
        await dbAdapter.put('time_off', off);
        await dbAdapter.logAudit(currentUser.id, 'insert', 'time_off', off.id, null, off);
        count++;
      }
    }

    alert(t('alert-holidays-imported', { count, year }));

    currentUser.holiday_country = countryCode;
    await dbAdapter.put('users', currentUser);

    updateHistoryTab();
    if (currentTab === 'tab-punch') updatePunchTab();
    triggerSilentSync();
  } catch (error) {
    console.error('Failed to import holidays:', error);
    alert(t('alert-holidays-failed', { error: error.message }));
  } finally {
    btnImport.disabled = false;
    btnImport.textContent = originalText;
  }
};



// Backup Dialog Trigger
document.getElementById('btn-export-backup').onclick = async () => {
  const users = await dbAdapter.getAll('users');
  const punches = await dbAdapter.getAll('punches');
  const time_off = await dbAdapter.getAll('time_off');
  const audit_logs = await dbAdapter.getAll('audit_logs');

  const backupData = {
    users,
    punches,
    time_off,
    audit_logs
  };

  document.getElementById('backup-json-text').value = JSON.stringify(backupData, null, 2);
  document.getElementById('dlg-backup').showModal();
  document.getElementById('btn-close-backup')?.focus({ preventScroll: true });
};

document.getElementById('btn-import-backup-action').onclick = async () => {
  const jsonText = document.getElementById('backup-json-text').value;
  try {
    const data = JSON.parse(jsonText);
    if (!data.users || !data.punches || !data.time_off) {
      throw new Error(getLanguage() === 'de' ? 'Ungültiges Backup-Format.' : 'Invalid backup format.');
    }

    if (confirm(t('alert-backup-import-confirm'))) {
      await dbAdapter.applyServerUpdates(data);
      alert(t('alert-backup-import-success'));
      document.getElementById('dlg-backup').close();
      populateUserSelect();
    }
  } catch (error) {
    alert(t('alert-backup-import-failed', { message: error.message }));
  }
};

document.getElementById('btn-copy-backup-action').onclick = () => {
  const copyText = document.getElementById('backup-json-text');
  copyText.select();
  copyText.setSelectionRange(0, 99999);
  navigator.clipboard.writeText(copyText.value);
  alert(t('alert-backup-copied'));
};

function applyDarkModeSettings() {
  const mode = storageGetItem('darkmode-mode') || 'disabled';
  
  if (mode === 'system') {
    const isSystemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const targetTheme = isSystemDark ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', targetTheme);
    document.documentElement.style.colorScheme = targetTheme;
    storageSetItem('color-scheme', targetTheme);
  } else if (mode === 'custom') {
    const startStr = storageGetItem('darkmode-start') || '20:00';
    const endStr = storageGetItem('darkmode-end') || '07:00';
    
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    
    const [startH, startM] = startStr.split(':').map(Number);
    const [endH, endM] = endStr.split(':').map(Number);
    
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;
    
    let isDark = false;
    if (startMinutes < endMinutes) {
      isDark = currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
      isDark = currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
    
    const targetTheme = isDark ? 'dark' : 'light';
    const currentTheme = document.documentElement.getAttribute('data-theme');
    if (targetTheme !== currentTheme) {
      document.documentElement.setAttribute('data-theme', targetTheme);
      document.documentElement.style.colorScheme = targetTheme;
      storageSetItem('color-scheme', targetTheme);
    }
  } else {
    // manual mode, apply the saved color-scheme preference
    const staticTheme = storageGetItem('color-scheme') || 'dark';
    const currentTheme = document.documentElement.getAttribute('data-theme');
    if (staticTheme !== currentTheme) {
      document.documentElement.setAttribute('data-theme', staticTheme);
      document.documentElement.style.colorScheme = staticTheme;
    }
  }
}

// Theme Toggle
document.getElementById('btn-theme-toggle').onclick = () => {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  
  // If automatic scheduler is active, manual toggle resets it to disabled
  const mode = storageGetItem('darkmode-mode') || 'disabled';
  if (mode !== 'disabled') {
    storageSetItem('darkmode-mode', 'disabled');
    const selectEl = document.getElementById('set-darkmode-mode');
    if (selectEl) selectEl.value = 'disabled';
    const customTimesEl = document.getElementById('darkmode-custom-times');
    if (customTimesEl) customTimesEl.classList.add('hidden');
  }

  document.documentElement.setAttribute('data-theme', newTheme);
  document.documentElement.style.colorScheme = newTheme;
  storageSetItem('color-scheme', newTheme);
};

document.getElementById('btn-lock-app').onclick = () => {
  lockApp();
};

// Tab Switch Click Handlers
const navItems = document.querySelectorAll('.nav-item');
navItems.forEach(item => {
  item.onclick = () => {
    switchTab(item.getAttribute('data-tab'));
  };
});

// Settings Sub-Tab Click Handlers
const subNavItems = document.querySelectorAll('.settings-sub-nav .sub-nav-item');
subNavItems.forEach(item => {
  item.onclick = () => {
    switchSettingsSubTab(item.getAttribute('data-sub-tab'));
  };
});

// Theme Hue Mapping:
// - cyan: 185 (default)
// - emerald: 145
// - cobalt: 215
// - amethyst: 275
// - amber: 35
const THEME_HUES = {
  cyan: 185,
  emerald: 145,
  cobalt: 215,
  amethyst: 275,
  amber: 35
};

function applyThemeColor(colorName) {
  const hue = THEME_HUES[colorName] || THEME_HUES.cyan;
  document.documentElement.style.setProperty('--hue-primary', hue);
}

// Get the count of pending (unsynced) changes
async function getPendingSyncCount() {
  if (!idb) return 0;
  try {
    const lastSync = SyncService.getLastSyncTime();
    const changes = await dbAdapter.getUnsyncedChanges(lastSync);
    return (changes.users?.length || 0) + (changes.punches?.length || 0) + (changes.time_off?.length || 0) + (changes.audit_logs?.length || 0);
  } catch (err) {
    console.error('Failed to get pending sync count:', err);
    return 0;
  }
}

// Update Connection Status Badge
async function updateConnectionBadge() {
  const badgeEl = document.getElementById('conn-status-badge');
  const textEl = document.getElementById('conn-status-text');
  if (!badgeEl || !textEl) return;

  const serverUrl = SyncService.getServerUrl();
  const isOnline = navigator.onLine;

  // Reset classes
  badgeEl.className = 'conn-status-badge';

  if (isSyncing) {
    badgeEl.classList.add('syncing');
    textEl.textContent = t('conn-status-syncing');
    badgeEl.setAttribute('title', t('conn-status-syncing'));
    return;
  }

  if (!serverUrl) {
    badgeEl.classList.add('offline');
    textEl.textContent = t('conn-status-no-server');
    badgeEl.setAttribute('title', t('conn-title-offline'));
    return;
  }

  if (!isOnline) {
    badgeEl.classList.add('offline');
    textEl.textContent = t('conn-status-offline');
    badgeEl.setAttribute('title', t('conn-title-offline-no-conn'));
    return;
  }

  const pendingCount = await getPendingSyncCount();
  if (pendingCount > 0) {
    badgeEl.classList.add('unsynced');
    const pendingText = t('conn-status-pending');
    textEl.textContent = `${pendingCount} ${pendingText}`;
    badgeEl.setAttribute('title', t('conn-title-unsynced', { pending: pendingCount }));
  } else {
    badgeEl.classList.add('online');
    textEl.textContent = t('conn-status-online');
    badgeEl.setAttribute('title', t('conn-title-online'));
  }
}

// ----------------------------------------------------
// 7.5 Background Sync Functions
// ----------------------------------------------------
let isSyncing = false;

/**
 * Run synchronization silently in the background
 */
async function triggerSilentSync() {
  if (isSyncing) return;
  
  const serverUrl = SyncService.getServerUrl();
  if (!serverUrl) {
    updateConnectionBadge();
    return;
  }

  isSyncing = true;
  updateConnectionBadge();

  try {
    const res = await SyncService.sync(dbAdapter);
    console.log(`Silent background sync success: ${res.appliedCount} updates imported.`);
    
    // Repopulate user select if lock screen is active and we're not actively typing
    const lockScreen = document.getElementById('lock-screen');
    if (lockScreen && lockScreen.classList.contains('active') && currentPinInput === '') {
      await populateUserSelect();
    }

    if (currentUser && res.appliedCount > 0) {
      console.log('Background sync updated data, refreshing current tab:', currentTab);
      // Fetch latest currentUser object in case it was updated
      const latestUser = await dbAdapter.get('users', currentUser.id);
      if (latestUser) {
        currentUser = latestUser;
        const userNameEl = document.getElementById('current-user-name');
        if (userNameEl) userNameEl.textContent = currentUser.name;

        // Apply theme color in case it was updated on another device
        if (currentUser.theme_color) {
          applyThemeColor(currentUser.theme_color);
        } else {
          applyThemeColor('cyan');
        }
      }
      
      if (currentTab === 'tab-punch') {
        updatePunchTab();
      } else if (currentTab === 'tab-history') {
        updateHistoryTab();
      } else if (currentTab === 'tab-reports') {
        updateReportsTab();
      } else if (currentTab === 'tab-settings') {
        updateSettingsTab();
      }
    } else if (currentUser && currentTab === 'tab-settings') {
      updateSettingsTab();
    }
  } catch (error) {
    console.warn('Silent background sync failed:', error.message);
  } finally {
    isSyncing = false;
    updateConnectionBadge();
  }
}

// Online reconnection trigger
window.addEventListener('online', () => {
  console.log('Browser back online. Running background sync...');
  triggerSilentSync();
});

// Offline trigger
window.addEventListener('offline', () => {
  console.log('Browser went offline. Updating badge...');
  updateConnectionBadge();
});

// Periodic sync (every 5 minutes)
setInterval(() => {
  console.log('Running periodic background sync...');
  triggerSilentSync();
}, 5 * 60 * 1000);

// Sync when app comes to foreground (e.g., opened from Home Screen or tab switched)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    console.log('App became visible. Running background sync...');
    triggerSilentSync();
  }
});

window.addEventListener('focus', () => {
  console.log('Window gained focus. Running background sync...');
  triggerSilentSync();
});

// System prefers-color-scheme listener for Auto-Dark Mode
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (storageGetItem('darkmode-mode') === 'system') {
    applyDarkModeSettings();
  }
});

// Periodic check for Custom Dark Mode Scheduler (every 60 seconds)
setInterval(() => {
  if (storageGetItem('darkmode-mode') === 'custom') {
    applyDarkModeSettings();
  }
}, 60 * 1000);

// Settings Auto-Lock change handler
document.getElementById('set-autolock-time').onchange = () => {
  const autolockTime = document.getElementById('set-autolock-time').value;
  storageSetItem('autolock-time', autolockTime);
  resetAutolockTimer();
};

// Activity listeners for Auto-Lock
const activityEvents = ['mousemove', 'mousedown', 'keypress', 'touchstart', 'click', 'scroll'];
activityEvents.forEach(eventName => {
  window.addEventListener(eventName, resetAutolockTimer, { passive: true });
});

// ----------------------------------------------------
// 8. Initialization & Service Worker
// ----------------------------------------------------
async function initApp() {
  // Initialize Database with automatic retries for cold start on WebKit
  let dbSuccess = false;
  let dbError = null;
  
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`Database open attempt ${attempt}...`);
      await dbAdapter.open();
      console.log('IndexedDB opened successfully.');
      dbSuccess = true;
      break;
    } catch (e) {
      dbError = e;
      console.warn(`Database open attempt ${attempt} failed:`, e.message || e);
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 800));
      }
    }
  }

  if (!dbSuccess && dbError) {
    console.error('Failed to open database after 3 attempts:', dbError);
    alert('Datenbankfehler beim Starten: ' + (dbError.message || dbError.name || dbError));
  }

  if (dbSuccess) {
    // Load config from IndexedDB config store and merge with localStorage
    await dbAdapter.loadConfig();

    // Apply color theme and scheduler settings
    applyDarkModeSettings();
  }

  // Apply language setting
  const savedLang = storageGetItem('language') || 'de';
  applyGlobalLanguage(savedLang);

  // Populate profiles initially
  await populateUserSelect();

  // Restore session if valid
  const expiryVal = storageGetItem('session-expiry');
  const lastUserId = storageGetItem('last-logged-user-id');
  let autoLoggedIn = false;
  if (expiryVal && lastUserId) {
    const expiry = parseInt(expiryVal, 10);
    if (expiry > Date.now()) {
      const user = users.find(u => u.id === lastUserId);
      if (user) {
        currentUser = user;
        if (user.theme_color) {
          applyThemeColor(user.theme_color);
        } else {
          applyThemeColor('cyan');
        }
        updateConnectionBadge();
        
        await applyUserRoleGating(user);

        document.getElementById('lock-screen').classList.remove('active');
        document.getElementById('main-screen').classList.remove('hidden');
        document.getElementById('current-user-name').textContent = user.name;
        
        const savedTab = storageGetItem('active-tab') || 'tab-punch';
        switchTab(savedTab);
        resetAutolockTimer();
        autoLoggedIn = true;
        console.log(`Auto-logged in user: ${user.name}`);
        syncHolidaysSilently();
      }
    }
  }

  if (!autoLoggedIn) {
    document.getElementById('lock-screen').classList.add('active');
    document.getElementById('main-screen').classList.add('hidden');
  }

  // Startup sync retry loop (especially useful on iOS when launching PWA and network is offline for the first few seconds)
  let syncSuccess = false;
  const maxSyncAttempts = 5;
  for (let attempt = 1; attempt <= maxSyncAttempts; attempt++) {
    const serverUrl = SyncService.getServerUrl();
    if (!serverUrl) break; // Don't try to sync if no server URL is set/defaulted

    try {
      if (isSyncing) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      isSyncing = true;
      console.log(`Startup sync attempt ${attempt} starting...`);
      const res = await SyncService.sync(dbAdapter);
      console.log(`Startup sync success on attempt ${attempt}: ${res.appliedCount} updates imported.`);
      
      // Update last sync time display on settings tab if active
      const lastSyncTimeEl = document.getElementById('sync-last-time');
      if (lastSyncTimeEl) {
        lastSyncTimeEl.textContent = new Date(res.serverTime).toLocaleString(getLanguage());
      }

      await populateUserSelect();

      // Refresh current tab if logged in and changes were applied
      if (currentUser && res.appliedCount > 0) {
        if (currentTab === 'tab-punch') updatePunchTab();
        else if (currentTab === 'tab-history') updateHistoryTab();
        else if (currentTab === 'tab-reports') updateReportsTab();
        else if (currentTab === 'tab-settings') updateSettingsTab();
      }

      syncSuccess = true;
      isSyncing = false;
      break;
    } catch (err) {
      isSyncing = false;
      console.warn(`Startup sync attempt ${attempt} failed:`, err.message || err);
      
      // If we already have users locally, we don't need to be aggressive about retrying on cold start
      const currentUsers = await dbAdapter.getAll('users');
      if (currentUsers && currentUsers.length > 0) {
        console.log('We already have cached users, stopping startup sync retry loop.');
        break;
      }
      
      if (attempt < maxSyncAttempts) {
        const delay = 1000 + attempt * 1000;
        console.log(`Retrying startup sync in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // If the retry loop didn't run or didn't succeed, trigger a standard silent sync as a fallback
  if (!syncSuccess) {
    triggerSilentSync();
  }

  // Initialize connection badge
  updateConnectionBadge();

  // Restore active settings sub-tab
  const savedSubTab = storageGetItem('settings-active-sub-tab') || 'settings-panel-general';
  switchSettingsSubTab(savedSubTab);

  // Register Service Worker for PWA
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      console.log('Service Worker registered with scope:', reg.scope);
    } catch (err) {
      console.error('Service Worker registration failed:', err);
    }
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}
