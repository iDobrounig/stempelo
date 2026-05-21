import { SyncService } from './syncService.js';

// Resolve Temporal (native or local polyfill)
let Temporal;
if (typeof globalThis.Temporal !== 'undefined') {
  Temporal = globalThis.Temporal;
} else {
  const tempModule = await import('./temporal-polyfill.js');
  Temporal = tempModule.Temporal;
}

// ----------------------------------------------------
// 1. IndexedDB Adapter (Sync-Ready)
// ----------------------------------------------------
const DB_NAME = 'stempeluhr_db';
const DB_VERSION = 1;
let idb = null;

const dbAdapter = {
  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        idb = request.result;
        resolve(idb);
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
      };
    });
  },

  // Generic Helpers
  getAll(storeName) {
    return new Promise((resolve, reject) => {
      const tx = idb.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result.filter(item => !item.deleted));
      request.onerror = () => reject(request.error);
    });
  },

  get(storeName, id) {
    return new Promise((resolve, reject) => {
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
            const updated = new Date(item.updated_at || item.timestamp);
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
        if (!local || new Date(item.updated_at || item.timestamp) > new Date(local.updated_at || local.timestamp)) {
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

// ----------------------------------------------------
// 2. State & Constants
// ----------------------------------------------------
let users = [];
let currentUser = null;
let currentTab = 'tab-punch';
let timerInterval = null;
let currentPinInput = '';

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
 * Formats a duration in decimal hours (e.g. 7.5h) or human readable (e.g. 7 Std. 30 Min.)
 */
function formatHours(hours, formatType = 'decimal') {
  if (isNaN(hours)) return '0,0h';
  
  if (formatType === 'decimal') {
    const sign = hours < 0 ? '-' : '';
    return `${sign}${Math.abs(hours).toFixed(2).replace('.', ',')}h`;
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
  
  users = await dbAdapter.getAll('users');
  
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
    select.value = localStorage.getItem('last-logged-user-id') || users[0].id;
    resetPinEntry();
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
    statusIndicator.textContent = 'Arbeitszeit läuft';
    statusIndicator.className = 'status-badge working';

    btnPunchIn.classList.add('hidden');
    btnPunchOut.classList.remove('hidden');
    btnBreakToggle.classList.remove('hidden');
    btnBreakToggle.textContent = 'Pause starten';

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

  } else if (localStorage.getItem(`user-break-active-${currentUser.id}`) === 'true') {
    // User is on break (Break timer)
    statusIndicator.textContent = 'In der Pause';
    statusIndicator.className = 'status-badge onbreak';

    btnPunchIn.classList.add('hidden');
    btnPunchOut.classList.remove('hidden');
    btnBreakToggle.classList.remove('hidden');
    btnBreakToggle.textContent = 'Pause beenden';

    // Live break timer
    const breakStartStr = localStorage.getItem(`user-break-start-${currentUser.id}`);
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
    statusIndicator.textContent = 'Nicht eingestempelt';
    statusIndicator.className = 'status-badge stopped';

    btnPunchIn.classList.remove('hidden');
    btnPunchOut.classList.add('hidden');
    btnBreakToggle.classList.add('hidden');

    document.getElementById('live-timer').textContent = '00:00:00';
  }
}

/**
 * Render history table
 */
async function updateHistoryTab() {
  if (!currentUser) return;

  const tbody = document.getElementById('history-table-body');
  tbody.innerHTML = '';

  const filterPeriod = document.getElementById('filter-period').value;
  const filterStartDateVal = document.getElementById('filter-start-date').value;
  const filterEndDateVal = document.getElementById('filter-end-date').value;
  const filterType = document.getElementById('filter-type').value;
  const filterManualOnly = document.getElementById('filter-manual-only').checked;
  const filterAutobreakOnly = document.getElementById('filter-autobreak-only').checked;

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

  // Sort dates descending
  const dates = Object.keys(daysMap).sort((a, b) => b.localeCompare(a));

  const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  let renderedCount = 0;

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

    // 4. Automatic Break Filter
    if (filterAutobreakOnly) {
      if (stats.autoBreakMinutes <= 0) return;
    }

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
    tdDate.innerHTML = `<strong>${dateObj.toLocaleString('de', { weekday: 'short' })}</strong>, ${dateObj.toLocaleString('de', { day: '2-digit', month: '2-digit' })}`;
    tr.appendChild(tdDate);

    // Type column
    const tdType = document.createElement('td');
    let typeTagHtml = '';
    if (stats.timeOffType) {
      typeTagHtml = `<span class="tag-badge ${stats.timeOffType}">${stats.statusText}</span>`;
    } else {
      typeTagHtml = `<span class="tag-badge work">Arbeit</span>`;
    }
    tdType.innerHTML = typeTagHtml;
    tr.appendChild(tdType);

    // Punch times column
    const tdTimes = document.createElement('td');
    if (stats.timeOffType && !isCreditedWorkDone(dateData.punches)) {
      tdTimes.textContent = '-';
    } else {
      const punchTimes = dateData.punches.map(p => {
        const start = new Date(p.start_time).toLocaleTimeString('de', { hour: '2-digit', minute: '2-digit' });
        const end = p.end_time 
          ? new Date(p.end_time).toLocaleTimeString('de', { hour: '2-digit', minute: '2-digit' })
          : 'Aktiv...';
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
      const autoStr = stats.autoBreakMinutes > 0 ? ` (+${stats.autoBreakMinutes}m ges.)` : '';
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
      btnDel.innerHTML = 'Löschen';
      btnDel.onclick = async () => {
        if (confirm('Möchtest du diese Abwesenheit löschen?')) {
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
      btnEdit.innerHTML = 'Bearbeiten';
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
    td.textContent = 'Keine Einträge für die gewählten Filter gefunden.';
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
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
  document.getElementById('rep-free-days').textContent = `${totalFree} Tag${totalFree === 1 ? '' : 'e'}`;
  document.getElementById('rep-free-days-breakdown').textContent = 
    `Urlaub: ${countVacation} | Krank: ${countSick} | Feiertag: ${countHoliday} | ZA: ${countCompensation}`;

  // Audit Logs rendering
  const auditLogs = await dbAdapter.getAll('audit_logs');
  const userLogs = auditLogs.filter(l => l.user_id === currentUser.id).sort((a,b) => b.timestamp.localeCompare(a.timestamp));

  const logContainer = document.getElementById('audit-log-container');
  logContainer.innerHTML = '';

  if (userLogs.length === 0) {
    logContainer.innerHTML = '<p class="text-muted text-center" style="padding: 20px;">Keine Änderungen protokolliert.</p>';
  } else {
    userLogs.forEach(log => {
      const entry = document.createElement('div');
      entry.className = 'audit-log-entry';

      const time = new Date(log.timestamp).toLocaleString('de', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
      
      let details = '';
      if (log.action === 'insert') {
        details = `Zeit manuell hinzugefügt für ${log.record_id}`;
      } else if (log.action === 'update') {
        details = `Eintrag bearbeitet.`;
      } else if (log.action === 'delete') {
        details = `Eintrag gelöscht (${log.table_name}).`;
      }

      entry.innerHTML = `
        <span class="audit-log-time">${time}</span>
        <p>${details} (Aktion: <strong>${log.action.toUpperCase()}</strong>)</p>
      `;
      logContainer.appendChild(entry);
    });
  }
}

/**
 * Load user settings fields
 */
function updateSettingsTab() {
  if (!currentUser) return;

  document.getElementById('set-user-name').value = currentUser.name;
  document.getElementById('set-user-pin').value = ''; // Don't expose pin

  document.getElementById('soll-mon').value = currentUser.daily_soll.mon || 0;
  document.getElementById('soll-tue').value = currentUser.daily_soll.tue || 0;
  document.getElementById('soll-wed').value = currentUser.daily_soll.wed || 0;
  document.getElementById('soll-thu').value = currentUser.daily_soll.thu || 0;
  document.getElementById('soll-fri').value = currentUser.daily_soll.fri || 0;
  document.getElementById('soll-sat').value = currentUser.daily_soll.sat || 0;
  document.getElementById('soll-sun').value = currentUser.daily_soll.sun || 0;

  // Sync Info
  const serverUrl = SyncService.getServerUrl();
  document.getElementById('sync-server-url').value = serverUrl;
  
  const lastSync = SyncService.getLastSyncTime();
  document.getElementById('sync-last-time').textContent = lastSync 
    ? new Date(lastSync).toLocaleString('de') 
    : 'Nie';
  document.getElementById('sync-status-text').textContent = serverUrl ? 'Verbindungsbereit' : 'Nicht konfiguriert';
}

// ----------------------------------------------------
// 6. Navigation Controls
// ----------------------------------------------------
function switchTab(tabId) {
  currentTab = tabId;
  
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
  document.getElementById('main-screen').classList.add('hidden');
  document.getElementById('lock-screen').classList.add('active');
  populateUserSelect();
}

// ----------------------------------------------------
// 7. Event Handlers & Submissions
// ----------------------------------------------------

// Modals display helpers
function showEditPunchDialog(dateStr, punches) {
  const dlg = document.getElementById('dlg-manual-punch');
  document.getElementById('manual-punch-title').textContent = `Arbeitszeit bearbeiten (${dateStr})`;
  document.getElementById('manual-date').value = dateStr;
  
  // Set times from the first punch
  const firstPunch = punches[0];
  document.getElementById('edit-punch-id').value = firstPunch.id;
  
  const startLocal = new Date(firstPunch.start_time);
  document.getElementById('manual-start-time').value = startLocal.toTimeString().slice(0, 5);
  
  if (firstPunch.end_time) {
    const endLocal = new Date(firstPunch.end_time);
    document.getElementById('manual-end-time').value = endLocal.toTimeString().slice(0, 5);
  } else {
    document.getElementById('manual-end-time').value = '';
  }

  // Gaps calculate total manual breaks
  let totalManualBreakMinutes = 0;
  for (let i = 1; i < punches.length; i++) {
    const prevEnd = new Date(punches[i - 1].end_time);
    const currStart = new Date(punches[i].start_time);
    totalManualBreakMinutes += Math.round((currStart - prevEnd) / 60000);
  }
  document.getElementById('manual-break').value = totalManualBreakMinutes;

  document.getElementById('btn-delete-punch').classList.remove('hidden');
  dlg.showModal();
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
  const userId = document.getElementById('user-select').value;
  if (!userId) return;

  const user = await dbAdapter.get('users', userId);
  if (!user) return;

  const hashed = await hashPIN(currentPinInput);
  if (hashed === user.pin) {
    currentUser = user;
    localStorage.setItem('last-logged-user-id', user.id);
    
    // Switch screen
    document.getElementById('lock-screen').classList.remove('active');
    document.getElementById('main-screen').classList.remove('hidden');
    document.getElementById('current-user-name').textContent = user.name;
    
    switchTab('tab-punch');
  } else {
    resetPinEntry();
    const err = document.getElementById('pin-error');
    err.classList.remove('hidden');
    // shake animation trigger
    err.style.animation = 'none';
    err.offsetHeight; // trigger reflow
    err.style.animation = null;
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
  localStorage.removeItem(`user-break-active-${currentUser.id}`);
  localStorage.removeItem(`user-break-start-${currentUser.id}`);

  updatePunchTab();
  triggerSilentSync();
};

document.getElementById('btn-break-toggle').onclick = async () => {
  if (!currentUser) return;

  const isBreakActive = localStorage.getItem(`user-break-active-${currentUser.id}`) === 'true';
  const allPunches = await dbAdapter.getAll('punches');
  const active = allPunches.find(p => p.user_id === currentUser.id && !p.end_time);

  if (!isBreakActive && active) {
    // Start Break: End the current punch session, set break state
    active.end_time = new Date().toISOString();
    await dbAdapter.put('punches', active);

    localStorage.setItem(`user-break-active-${currentUser.id}`, 'true');
    localStorage.setItem(`user-break-start-${currentUser.id}`, new Date().toISOString());
  } else if (isBreakActive) {
    // End Break: Start a new punch session, clear break state
    localStorage.removeItem(`user-break-active-${currentUser.id}`);
    localStorage.removeItem(`user-break-start-${currentUser.id}`);

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

// Add Manual Time Entry
document.getElementById('btn-add-manual-punch').onclick = () => {
  const dlg = document.getElementById('dlg-manual-punch');
  document.getElementById('manual-punch-title').textContent = 'Arbeitszeit manuell eintragen';
  document.getElementById('edit-punch-id').value = '';
  document.getElementById('manual-date').value = Temporal.Now.plainDateISO().toString();
  document.getElementById('manual-start-time').value = '08:00';
  document.getElementById('manual-end-time').value = '16:00';
  document.getElementById('manual-break').value = '30';
  document.getElementById('btn-delete-punch').classList.add('hidden');
  dlg.showModal();
};

document.getElementById('form-manual-punch').onsubmit = async (e) => {
  e.preventDefault();
  if (!currentUser) return;

  const id = document.getElementById('edit-punch-id').value;
  const dateStr = document.getElementById('manual-date').value;
  const startStr = document.getElementById('manual-start-time').value;
  const endStr = document.getElementById('manual-end-time').value;
  const breakMinutes = parseInt(document.getElementById('manual-break').value) || 0;

  // Build timestamps
  const startIso = new Date(`${dateStr}T${startStr}:00`).toISOString();
  const endIso = new Date(`${dateStr}T${endStr}:00`).toISOString();

  // Load existing punches for this user on this day
  const allPunches = await dbAdapter.getAll('punches');
  const userPunches = allPunches.filter(p => p.user_id === currentUser.id && p.start_time.startsWith(dateStr));

  // Determine if it is editing or creating
  if (id) {
    // Editing: Delete old punches for this day, create new ones reflecting manual edits
    const oldPunches = [...userPunches];
    
    // soft delete all old punches for this day
    for (const p of oldPunches) {
      await dbAdapter.delete('punches', p.id);
    }

    // Insert new punch reflecting the manual entry
    if (breakMinutes > 0) {
      // Split into two punches if there is a manual break
      const startMs = new Date(startIso).getTime();
      const endMs = new Date(endIso).getTime();
      const midPoint = startMs + ((endMs - startMs) / 2);

      // Punch 1
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

      // Punch 2
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
      
      await dbAdapter.logAudit(currentUser.id, 'update', 'punches', dateStr, oldPunches, [p1, p2]);
    } else {
      // Single punch
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
      await dbAdapter.logAudit(currentUser.id, 'update', 'punches', dateStr, oldPunches, p);
    }
  } else {
    // Creating manual entry
    let createdPunches = [];
    if (breakMinutes > 0) {
      // Split into two punches to reflect gap
      const startMs = new Date(startIso).getTime();
      const endMs = new Date(endIso).getTime();
      const midPoint = startMs + ((endMs - startMs) / 2);

      // Punch 1
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

      // Punch 2
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
    }

    await dbAdapter.logAudit(currentUser.id, 'insert', 'punches', dateStr, null, createdPunches);
  }

  document.getElementById('dlg-manual-punch').close();
  updateHistoryTab();
  triggerSilentSync();
};

document.getElementById('btn-delete-punch').onclick = async () => {
  const id = document.getElementById('edit-punch-id').value;
  const dateStr = document.getElementById('manual-date').value;
  if (id && confirm('Möchtest du die Arbeitszeiten für diesen Tag wirklich löschen?')) {
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

// Add Time Off (Abwesenheit)
document.getElementById('btn-add-timeoff').onclick = () => {
  const dlg = document.getElementById('dlg-timeoff');
  document.getElementById('timeoff-date').value = Temporal.Now.plainDateISO().toString();
  dlg.showModal();
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

  currentUser.name = name;
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

  await dbAdapter.put('users', currentUser);
  document.getElementById('current-user-name').textContent = name;
  alert('Einstellungen gespeichert!');
  updateSettingsTab();
  triggerSilentSync();
};

// Cancel modal handlers
document.getElementById('btn-cancel-create-user').onclick = () => document.getElementById('dlg-create-user').close();
document.getElementById('btn-cancel-manual-punch').onclick = () => document.getElementById('dlg-manual-punch').close();
document.getElementById('btn-cancel-timeoff').onclick = () => document.getElementById('dlg-timeoff').close();
document.getElementById('btn-close-backup').onclick = () => document.getElementById('dlg-backup').close();
document.getElementById('btn-show-create-user').onclick = () => {
  document.getElementById('new-user-name').value = '';
  document.getElementById('new-user-pin').value = '';
  document.getElementById('dlg-create-user').showModal();
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
document.getElementById('filter-autobreak-only').onchange = () => updateHistoryTab();


// Sync triggers
document.getElementById('btn-sync-now').onclick = async () => {
  const syncBtn = document.getElementById('btn-sync-now');
  syncBtn.disabled = true;
  syncBtn.textContent = 'Synchronisiere...';

  const serverUrl = document.getElementById('sync-server-url').value;
  SyncService.setServerUrl(serverUrl);

  try {
    const res = await SyncService.sync(dbAdapter);
    document.getElementById('sync-last-time').textContent = new Date(res.serverTime).toLocaleString('de');
    alert(`Synchronisation erfolgreich! ${res.appliedCount} Änderungen importiert.`);
  } catch (error) {
    console.error(error);
    alert(`Fehler beim Synchronisieren: ${error.message}`);
  } finally {
    syncBtn.disabled = false;
    syncBtn.textContent = 'Jetzt abgleichen';
    updateSettingsTab();
  }
};

// CSV Export
document.getElementById('btn-export-csv').onclick = async () => {
  if (!currentUser) return;

  const allPunches = await dbAdapter.getAll('punches');
  const userPunches = allPunches.filter(p => p.user_id === currentUser.id);

  let csvContent = 'data:text/csv;charset=utf-8,';
  csvContent += 'Datum;Kommen;Gehen;Pause (Minuten);Ist-Stunden;Soll-Stunden\n';

  // Group punches by date
  const daysMap = {};
  userPunches.forEach(p => {
    const dateStr = p.start_time.split('T')[0];
    if (!daysMap[dateStr]) daysMap[dateStr] = [];
    daysMap[dateStr].push(p);
  });

  const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  Object.keys(daysMap).sort().forEach(dateStr => {
    const dayPunches = daysMap[dateStr];
    const dateObj = Temporal.PlainDate.from(dateStr);
    const wday = dateObj.dayOfWeek;
    const soll = currentUser.daily_soll[weekdayKeys[wday - 1]] || 0;

    const stats = calculateDayDetails(soll, dayPunches, null);

    const firstPunch = dayPunches[0];
    const lastPunch = dayPunches[dayPunches.length - 1];

    const startLocal = new Date(firstPunch.start_time).toLocaleTimeString('de', { hour: '2-digit', minute: '2-digit' });
    const endLocal = lastPunch.end_time 
      ? new Date(lastPunch.end_time).toLocaleTimeString('de', { hour: '2-digit', minute: '2-digit' })
      : 'Aktiv';

    csvContent += `${dateStr};${startLocal};${endLocal};${stats.totalBreakMinutes};${stats.istHours.toFixed(2).replace('.', ',')};${stats.sollHours.toFixed(2).replace('.', ',')}\n`;
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `Stempelo_Export_${currentUser.name}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
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
};

document.getElementById('btn-import-backup-action').onclick = async () => {
  const jsonText = document.getElementById('backup-json-text').value;
  try {
    const data = JSON.parse(jsonText);
    if (!data.users || !data.punches || !data.time_off) {
      throw new Error('Ungültiges Backup-Format.');
    }

    if (confirm('Achtung: Dies importiert alle Daten. Möchtest du fortfahren?')) {
      await dbAdapter.applyServerUpdates(data);
      alert('Backup erfolgreich importiert!');
      document.getElementById('dlg-backup').close();
      populateUserSelect();
    }
  } catch (error) {
    alert(`Fehler beim Import: ${error.message}`);
  }
};

document.getElementById('btn-copy-backup-action').onclick = () => {
  const copyText = document.getElementById('backup-json-text');
  copyText.select();
  copyText.setSelectionRange(0, 99999);
  navigator.clipboard.writeText(copyText.value);
  alert('Backup in Zwischenablage kopiert!');
};

// Theme Toggle
document.getElementById('btn-theme-toggle').onclick = () => {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  
  document.documentElement.setAttribute('data-theme', newTheme);
  document.documentElement.style.colorScheme = newTheme;
  localStorage.setItem('color-scheme', newTheme);
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

// ----------------------------------------------------
// 7.5 Background Sync Functions
// ----------------------------------------------------
/**
 * Run synchronization silently in the background
 */
async function triggerSilentSync() {
  const serverUrl = SyncService.getServerUrl();
  if (!serverUrl) return;

  try {
    const res = await SyncService.sync(dbAdapter);
    console.log(`Silent background sync success: ${res.appliedCount} updates imported.`);
    if (currentUser && currentTab === 'tab-settings') {
      updateSettingsTab();
    }
  } catch (error) {
    console.warn('Silent background sync failed:', error.message);
  }
}

// Online reconnection trigger
window.addEventListener('online', () => {
  console.log('Browser back online. Running background sync...');
  triggerSilentSync();
});

// Periodic sync (every 5 minutes)
setInterval(() => {
  console.log('Running periodic background sync...');
  triggerSilentSync();
}, 5 * 60 * 1000);

// ----------------------------------------------------
// 8. Initialization & Service Worker
// ----------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  // Initialize Database
  try {
    await dbAdapter.open();
    console.log('IndexedDB opened successfully.');
  } catch (e) {
    console.error('Failed to open database:', e);
  }

  // Populate profiles
  await populateUserSelect();

  // Initial silent background sync
  triggerSilentSync();

  // Register Service Worker for PWA
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('sw.js');
      console.log('Service Worker registered with scope:', reg.scope);
    } catch (err) {
      console.error('Service Worker registration failed:', err);
    }
  }
});
