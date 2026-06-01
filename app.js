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
    const keys = ['sync-server-url', 'sync-last-time', 'last-logged-user-id', 'color-scheme', 'session-expiry', 'active-tab', 'language'];
    
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
let currentPinInput = '';

// Calendar View State
let historyViewMode = 'calendar'; // 'list' or 'calendar'
let calendarActiveDate = Temporal.Now.plainDateISO();

// ----------------------------------------------------
// 3. Hashing & Security
// ----------------------------------------------------
async function hashPIN(pin) {
  const msgUint8 = new TextEncoder().encode(pin);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
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
  
  // 2. Apply Austrian automatic break top-up (AZG § 11)
  // If work hours > 6, total break must be at least 30 minutes.
  let autoBreakMinutes = 0;
  let netHours = grossHours;
  let hasBreakAlert = false;

  if (grossHours > 6.0) {
    if (manualBreakMinutes < 30) {
      autoBreakMinutes = 30 - manualBreakMinutes;
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
  
  if (users.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '-- Kein Benutzer vorhanden --';
    select.appendChild(opt);
    document.getElementById('pin-entry-area').classList.add('hidden');
  } else {
    users.forEach(user => {
      const opt = document.createElement('option');
      opt.value = user.id;
      opt.textContent = user.name;
      select.appendChild(opt);
    });
    document.getElementById('pin-entry-area').classList.remove('hidden');
    select.value = storageGetItem('last-logged-user-id') || users[0].id;
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

  // Schedule or clear break notifications
  scheduleReminderTimers();
}

/**
 * Render history table
 */
async function updateHistoryTab() {
  if (!currentUser) return;

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
  const userPunches = allPunches.filter(p => p.user_id === currentUser.id);

  const allTimeOff = await dbAdapter.getAll('time_off');
  const userTimeOff = allTimeOff.filter(o => o.user_id === currentUser.id);

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
    const soll = currentUser.daily_soll[weekdayKeys[wday - 1]] || 0;

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
          await dbAdapter.delete('time_off', dateData.timeOff.id, currentUser.id);
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
    const soll = currentUser.daily_soll[weekdayKeys[wday - 1]] || 0;
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
  if (!currentUser) return;

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
  const userPunches = allPunches.filter(p => p.user_id === currentUser.id);

  const allTimeOff = await dbAdapter.getAll('time_off');
  const userTimeOff = allTimeOff.filter(o => o.user_id === currentUser.id);

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
    const soll = currentUser.daily_soll[weekdayKeys[wday - 1]] || 0;

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
  const sanitizedUserName = currentUser.name.toLowerCase()
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
  if (!currentUser) return;

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
    const userPunches = allPunches.filter(p => p.user_id === currentUser.id);
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
  const userPunches = allPunches.filter(p => p.user_id === currentUser.id);

  const allTimeOff = await dbAdapter.getAll('time_off');
  const userTimeOff = allTimeOff.filter(o => o.user_id === currentUser.id);

  const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  let totalSoll = 0;
  let totalIst = 0;
  let countVacation = 0;
  let countSick = 0;
  let countHoliday = 0;
  let countCompensation = 0;

  // Iterate over every day in range
  let iter = start;
  while (Temporal.PlainDate.compare(iter, end) <= 0) {
    const dateStr = iter.toString();
    const wday = iter.dayOfWeek;
    const daySoll = currentUser.daily_soll[weekdayKeys[wday - 1]] || 0;

    const dayPunches = userPunches.filter(p => p.start_time.startsWith(dateStr));
    const dayTimeOff = userTimeOff.find(o => o.date === dateStr);

    const stats = calculateDayDetails(daySoll, dayPunches, dayTimeOff);

    totalSoll += stats.sollHours;
    totalIst += stats.istHours;

    if (stats.timeOffType === 'vacation') countVacation++;
    else if (stats.timeOffType === 'sick') countSick++;
    else if (stats.timeOffType === 'holiday') countHoliday++;
    else if (stats.timeOffType === 'compensation') countCompensation++;

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
  const userLogs = auditLogs.filter(l => l.user_id === currentUser.id).sort((a,b) => b.timestamp.localeCompare(a.timestamp));

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
}

/**
 * Load user settings fields
 */
function updateSettingsTab(onlyTranslateDynamic = false) {
  if (!currentUser) return;

  if (!onlyTranslateDynamic) {
    document.getElementById('set-user-name').value = currentUser.name;
    document.getElementById('set-user-pin').value = ''; // Don't expose pin

    document.getElementById('soll-mon').value = currentUser.daily_soll.mon || 0;
    document.getElementById('soll-tue').value = currentUser.daily_soll.tue || 0;
    document.getElementById('soll-wed').value = currentUser.daily_soll.wed || 0;
    document.getElementById('soll-thu').value = currentUser.daily_soll.thu || 0;
    document.getElementById('soll-fri').value = currentUser.daily_soll.fri || 0;
    document.getElementById('soll-sat').value = currentUser.daily_soll.sat || 0;
    document.getElementById('soll-sun').value = currentUser.daily_soll.sun || 0;

    document.getElementById('set-user-lang').value = currentUser.language || 'de';
    document.getElementById('set-user-theme').value = currentUser.theme_color || 'cyan';

    document.getElementById('set-overtime-start-date').value = currentUser.overtime_start_date || '';
    document.getElementById('set-overtime-start-hours').value = currentUser.overtime_start_hours !== undefined ? currentUser.overtime_start_hours : 0.0;

    document.getElementById('set-user-notifications').checked = !!currentUser.notifications_enabled;
    document.getElementById('set-holiday-country').value = currentUser.holiday_country || '';

    const serverUrl = SyncService.getServerUrl();
    document.getElementById('sync-server-url').value = serverUrl;
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
}

function lockApp() {
  currentUser = null;
  storageRemoveItem('session-expiry');
  applyThemeColor('cyan');
  document.getElementById('main-screen').classList.add('hidden');
  document.getElementById('lock-screen').classList.add('active');
  populateUserSelect();
}

// ----------------------------------------------------
// 7. Event Handlers & Submissions
// ----------------------------------------------------

function addPunchRow(startVal = '', endVal = '') {
  const container = document.getElementById('punches-list-container');
  const row = document.createElement('div');
  row.className = 'punch-row';
  
  row.innerHTML = `
    <div class="punch-row-inputs">
      <input type="time" class="punch-row-start" value="${startVal}" required>
      <span>bis</span>
      <input type="time" class="punch-row-end" value="${endVal}">
    </div>
    <button type="button" class="btn-remove-punch-row" title="Stempelung löschen">🗑️</button>
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

  // Austrian automatic break (AZG § 11)
  let autoBreakMinutes = 0;
  if (grossWorkHours > 6.0 && breakMinutes < 30) {
    autoBreakMinutes = 30 - breakMinutes;
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
    addPunchRow(startT, endT);
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
      
      // Switch screen
      document.getElementById('lock-screen').classList.remove('active');
      document.getElementById('main-screen').classList.remove('hidden');
      document.getElementById('current-user-name').textContent = user.name;
      
      const savedTab = storageGetItem('active-tab') || 'tab-punch';
      switchTab(savedTab);
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
  
  const punch = {
    id: crypto.randomUUID(),
    user_id: currentUser.id,
    start_time: new Date().toISOString(),
    end_time: null,
    manual_edit: 0,
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
      
      parsedRows.push({ startVal, endVal });
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

  const name = document.getElementById('set-user-name').value;
  const pin = document.getElementById('set-user-pin').value;
  const lang = document.getElementById('set-user-lang').value;
  const theme = document.getElementById('set-user-theme').value;

  currentUser.name = name;
  currentUser.language = lang;
  currentUser.theme_color = theme;
  if (pin && pin.length === 4) {
    currentUser.pin = await hashPIN(pin);
  }

  currentUser.daily_soll = {
    mon: parseFloat(document.getElementById('soll-mon').value) || 0,
    tue: parseFloat(document.getElementById('soll-tue').value) || 0,
    wed: parseFloat(document.getElementById('soll-wed').value) || 0,
    thu: parseFloat(document.getElementById('soll-thu').value) || 0,
    fri: parseFloat(document.getElementById('soll-fri').value) || 0,
    sat: parseFloat(document.getElementById('soll-sat').value) || 0,
    sun: parseFloat(document.getElementById('soll-sun').value) || 0
  };

  currentUser.weekly_hours = Object.values(currentUser.daily_soll).reduce((a, b) => a + b, 0);

  const overtimeStartDate = document.getElementById('set-overtime-start-date').value;
  const overtimeStartHours = parseFloat(document.getElementById('set-overtime-start-hours').value) || 0.0;

  currentUser.overtime_start_date = overtimeStartDate || null;
  currentUser.overtime_start_hours = overtimeStartHours;

  const notificationsEnabled = document.getElementById('set-user-notifications').checked;
  currentUser.notifications_enabled = notificationsEnabled;

  const holidayCountry = document.getElementById('set-holiday-country').value;
  currentUser.holiday_country = holidayCountry || null;

  if (notificationsEnabled && ('Notification' in window) && Notification.permission !== 'granted') {
    await requestNotificationPermission();
  } else if (!notificationsEnabled) {
    clearReminderTimers();
  }

  await dbAdapter.put('users', currentUser);
  document.getElementById('current-user-name').textContent = name;
  
  // Set the selected language globally
  applyGlobalLanguage(lang);

  // Apply theme color
  applyThemeColor(theme);

  alert(t('alert-settings-saved'));
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
    const userTimeOff = allTimeOff.filter(o => o.user_id === currentUser.id && o.deleted === 0);

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

// Theme Toggle
document.getElementById('btn-theme-toggle').onclick = () => {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  
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

    // Apply color theme (in case it was restored from IndexedDB)
    const colorScheme = storageGetItem('color-scheme') || 'dark';
    document.documentElement.setAttribute('data-theme', colorScheme);
    document.documentElement.style.colorScheme = colorScheme;
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
        
        document.getElementById('lock-screen').classList.remove('active');
        document.getElementById('main-screen').classList.remove('hidden');
        document.getElementById('current-user-name').textContent = user.name;
        
        const savedTab = storageGetItem('active-tab') || 'tab-punch';
        switchTab(savedTab);
        autoLoggedIn = true;
        console.log(`Auto-logged in user: ${user.name}`);
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
