
    // Firebase is optional. Its SDK is only downloaded when a config is provided (config.js or host globals),
    // so the app loads and runs fully offline with everything saved on this device.
    const FIREBASE_VERSION = '11.6.1';
    let fb = null; // { initializeApp, getAuth, ..., getFirestore, doc, setDoc, onSnapshot } once loaded
    async function loadFirebase() {
      const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/`;
      const [appMod, authMod, fsMod] = await Promise.all([
        import(base + 'firebase-app.js'),
        import(base + 'firebase-auth.js'),
        import(base + 'firebase-firestore.js')
      ]);
      return { ...appMod, ...authMod, ...fsMod };
    }

    // Environment globals provided by host runtime
    const appId = typeof __app_id !== 'undefined' ? __app_id : 'daily-pulse-app';
    const firebaseConfig = typeof __firebase_config !== 'undefined'
      ? JSON.parse(__firebase_config)
      : (window.DAILY_PULSE_FIREBASE_CONFIG || null);
    const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

    let app = null;
    let auth = null;
    let db = null;
    let currentUser = null;
    let unsubscribeSnapshot = null;
    let isRemoteUpdating = false;

    // Schedule tab defaults (declared early: the starter state uses them)
    const DEFAULT_DAY_PARTS = [
      { id: 'morning', name: 'Morning', icon: '🌅', start: '07:00', end: '10:00', remind: '07:30' },
      { id: 'midday', name: 'Midday', icon: '☀️', start: '11:00', end: '13:00', remind: '11:30' },
      { id: 'afternoon', name: 'Afternoon', icon: '🌤️', start: '13:00', end: '17:00', remind: '14:00' },
      { id: 'evening', name: 'Evening', icon: '🌙', start: '18:00', end: '21:00', remind: '19:00' }
    ];
    const DEFAULT_CATEGORIES = [
      { id: 'tasks', name: 'Tasks', color: 'indigo', builtin: true },
      { id: 'followups', name: 'Follow-ups', color: 'amber', builtin: true },
      { id: 'checklists', name: 'Checklists', color: 'emerald', builtin: true }
    ];
    // Literal class strings so the Tailwind build keeps them
    const CATEGORY_COLORS = {
      indigo: { dot: 'bg-indigo-500', chip: 'bg-indigo-50 text-indigo-700 border-indigo-200', label: 'Indigo' },
      amber: { dot: 'bg-amber-500', chip: 'bg-amber-50 text-amber-700 border-amber-200', label: 'Amber' },
      emerald: { dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'Green' },
      sky: { dot: 'bg-sky-500', chip: 'bg-sky-50 text-sky-700 border-sky-200', label: 'Blue' },
      rose: { dot: 'bg-rose-500', chip: 'bg-rose-50 text-rose-700 border-rose-200', label: 'Red' },
      violet: { dot: 'bg-violet-500', chip: 'bg-violet-50 text-violet-700 border-violet-200', label: 'Purple' },
      slate: { dot: 'bg-slate-500', chip: 'bg-slate-100 text-slate-700 border-slate-200', label: 'Gray' }
    };
    const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const ICS_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

    function localISODate(d) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function getDaysAgoISO(daysAgo) {
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      return localISODate(d);
    }

    function createStarterState() {
      return {
        masterEnabled: true,
        soundEnabled: true,
        scheduleTimes: ['09:00', '13:00', '17:00'],
        sectionReminders: {
          tasks: true,
          outreach: true,
          todos: true
        },
        tasks: [
          {
            id: 't-sample-1',
            title: 'Review top 3 priorities for today',
            priority: 'High',
            time: '09:00',
            remind: true,
            completed: false,
            isSample: true
          },
          {
            id: 't-sample-2',
            title: 'Send afternoon client & project follow-ups',
            priority: 'Medium',
            time: '',
            remind: true,
            completed: false,
            isSample: true
          }
        ],
        outreach: [
          {
            id: 'o-sample-1',
            name: 'Alex Morgan',
            note: 'Quick check-in call on upcoming project',
            frequencyDays: 7,
            lastContacted: getDaysAgoISO(8),
            remind: true,
            isSample: true
          },
          {
            id: 'o-sample-2',
            name: 'Samira Patel',
            note: 'Follow up on coffee catch-up',
            frequencyDays: 3,
            lastContacted: getDaysAgoISO(3),
            remind: true,
            isSample: true
          }
        ],
        todoLists: [
          {
            id: 'l-sample-1',
            title: 'Daily Essentials',
            remind: true,
            isSample: true,
            items: [
              { id: 'li-1', text: 'Clear priority inbox messages', done: false },
              { id: 'li-2', text: 'Drink 2L of water', done: false },
              { id: 'li-3', text: 'Prep tomorrow’s top task', done: false }
            ]
          }
        ],
        // Schedule tab
        dayParts: DEFAULT_DAY_PARTS.map(p => ({ ...p })),
        categories: DEFAULT_CATEGORIES.map(c => ({ ...c })),
        partRemindersEnabled: true,
        scheduleItems: [
          { id: 's-sample-1', title: 'Review top 3 priorities for today', linkType: 'task', linkId: 't-sample-1', categoryId: 'tasks', partId: 'morning', repeat: { type: 'weekdays' }, time: '', remind: true, startDate: getDaysAgoISO(0), isSample: true },
          { id: 's-sample-2', title: 'Alex Morgan', linkType: 'outreach', linkId: 'o-sample-1', categoryId: 'followups', partId: 'afternoon', repeat: { type: 'days', days: [2, 4] }, time: '15:00', remind: true, startDate: getDaysAgoISO(0), isSample: true }
        ],
        scheduleDone: {}, // { 'YYYY-MM-DD': { itemId: true } }
        schemaVersion: 2,
        triggeredSlots: {}, // tracks "YYYY-MM-DD_HH:MM" to avoid duplicate alerts
        updatedAt: Date.now()
      };
    }

    /*************************************************************************
     * ON-DEVICE STORAGE (localStorage) — always on, with or without cloud sync
     *************************************************************************/
    const STORAGE_KEY = 'daily-pulse-state-v1';

    function normalizeState(data) {
      data = data || {};
      return {
        ...createStarterState(),
        ...data,
        sectionReminders: { tasks: true, outreach: true, todos: true, ...(data.sectionReminders || {}) },
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
        outreach: Array.isArray(data.outreach) ? data.outreach : [],
        todoLists: Array.isArray(data.todoLists) ? data.todoLists.map(l => ({ ...l, items: Array.isArray(l.items) ? l.items : [] })) : [],
        scheduleTimes: Array.isArray(data.scheduleTimes) ? data.scheduleTimes : ['09:00', '13:00', '17:00'],
        triggeredSlots: data.triggeredSlots || {},
        // Schedule tab (added in v2; older saved data gets defaults and no sample items)
        dayParts: normalizeDayParts(data.dayParts),
        categories: normalizeCategories(data.categories),
        partRemindersEnabled: data.partRemindersEnabled !== false,
        scheduleItems: Array.isArray(data.scheduleItems) ? data.scheduleItems.filter(i => i && i.id) : [],
        scheduleDone: data.scheduleDone && typeof data.scheduleDone === 'object' ? data.scheduleDone : {},
        schemaVersion: 2
      };
    }

    function loadLocalState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) return normalizeState(JSON.parse(raw));
      } catch (e) {
        console.warn('Could not read saved data; starting fresh.', e);
      }
      return createStarterState();
    }

    function saveLocalState() {
      try {
        // Drop alert bookkeeping from previous days so it doesn't grow forever
        const today = getDaysAgoISO(0);
        Object.keys(state.triggeredSlots || {}).forEach(k => {
          if (k.slice(0, 10) < today) delete state.triggeredSlots[k];
        });
        // Keep 120 days of schedule check-offs
        const cutoff = getDaysAgoISO(120);
        Object.keys(state.scheduleDone || {}).forEach(d => { if (d < cutoff) delete state.scheduleDone[d]; });
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        console.warn('Could not save to this device:', e);
        showBanner('Storage Full or Blocked', 'Changes could not be saved on this device.');
      }
    }

    let state = loadLocalState();

    // Keep other open tabs/windows of the app in step
    window.addEventListener('storage', (e) => {
      if (e.key === STORAGE_KEY && e.newValue) {
        try { state = normalizeState(JSON.parse(e.newValue)); renderAll(); } catch (err) {}
      }
    });

    /*************************************************************************
     * CLOUD FIRESTORE SYNC & AUTHENTICATION
     *************************************************************************/
    function getUserDocRef(uid) {
      // Strictly adheres to /artifacts/{appId}/users/{userId}/{collectionName}/{docId}
      return fb.doc(db, 'artifacts', appId, 'users', uid, 'pulseData', 'main');
    }

    async function persistState() {
      state.updatedAt = Date.now();
      saveLocalState();
      renderAll();

      if (!db || !currentUser || isRemoteUpdating) return;
      try {
        setSyncStatus('syncing', 'Syncing...');
        await fb.setDoc(getUserDocRef(currentUser.uid), state);
        setSyncStatus('synced', 'Synced via Cloud');
      } catch (err) {
        console.error('Firestore sync error:', err);
        setSyncStatus('error', 'Sync Retry');
      }
    }

    function setSyncStatus(status, label) {
      const dot = document.getElementById('sync-dot');
      const text = document.getElementById('sync-label');
      if (!dot || !text) return;
      text.textContent = label;
      if (status === 'synced') {
        dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500';
      } else if (status === 'syncing') {
        dot.className = 'w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse';
      } else {
        dot.className = 'w-1.5 h-1.5 rounded-full bg-amber-500';
      }
    }

    async function initFirebaseSync() {
      if (!firebaseConfig) {
        // Local-only mode: everything is already saved on this device.
        setSyncStatus('synced', 'Saved on this device');
        renderAll();
        return;
      }

      // Cloud mode: switch the info dialog over to the sync controls
      document.getElementById('local-sync-block').classList.add('hidden');
      document.getElementById('cloud-sync-block').classList.remove('hidden');
      document.getElementById('sync-modal-title').textContent = 'Phone & Computer Cloud Sync';
      document.getElementById('footer-sync-info').textContent = 'Real-time sync active across your phone & computer';
      setSyncStatus('syncing', 'Connecting...');

      try {
        fb = await loadFirebase();
        const { initializeApp, getAuth, getFirestore, signInWithCustomToken, signInAnonymously, onAuthStateChanged, onSnapshot, setDoc } = fb;
        app = initializeApp(firebaseConfig);
        auth = getAuth(app);
        db = getFirestore(app);

        // RULE 3: Authenticate FIRST and await before attaching Firestore listeners
        if (initialAuthToken) {
          await signInWithCustomToken(auth, initialAuthToken);
        } else {
          await signInAnonymously(auth);
        }

        onAuthStateChanged(auth, (user) => {
          currentUser = user;
          if (!user) return;

          document.getElementById('sync-uid-display').textContent = user.uid;
          setSyncStatus('syncing', 'Connecting...');

          if (unsubscribeSnapshot) unsubscribeSnapshot();

          const docRef = getUserDocRef(user.uid);
          unsubscribeSnapshot = onSnapshot(
            docRef,
            async (snap) => {
              if (snap.exists()) {
                isRemoteUpdating = true;
                state = normalizeState(snap.data());
                saveLocalState();
                renderAll();
                isRemoteUpdating = false;
                setSyncStatus('synced', 'Synced via Cloud');
              } else {
                // Brand-new cloud account -> upload what is already saved on this device
                await setDoc(docRef, state);
                renderAll();
                setSyncStatus('synced', 'Synced via Cloud');
              }
            },
            (error) => {
              console.error('Firestore onSnapshot error:', error);
              setSyncStatus('error', 'Sync Issue');
            }
          );
        });
      } catch (err) {
        console.error('Firebase initialization failed:', err);
        setSyncStatus('error', 'Saved on this device (sync off)');
        renderAll();
      }
    }

    window.signInWithGoogleAccount = async function () {
      if (!auth) return;
      try {
        const provider = new fb.GoogleAuthProvider();
        await fb.signInWithPopup(auth, provider);
        closeSyncModal();
        showBanner('Signed In', 'Your reminders are now linked to your Google profile across devices.');
      } catch (err) {
        showBanner('Sign-In Notice', 'Google popup was closed or restricted in this preview frame.');
      }
    };

    /*************************************************************************
     * NOTIFICATION ENGINE (Browser API + Audio Chime + Vibrate + Visibility)
     *************************************************************************/
    function updateNotificationButtonUI() {
      const btn = document.getElementById('notif-perm-btn');
      const dot = document.getElementById('notif-perm-dot');
      const txt = document.getElementById('notif-perm-text');
      const sBtn = document.getElementById('sched-notif-btn');
      const sDot = document.getElementById('sched-notif-dot');
      const sTxt = document.getElementById('sched-notif-text');

      if (!('Notification' in window)) {
        btn.className = 'inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-2 rounded-xl border border-slate-200 bg-slate-100 text-slate-600 cursor-pointer';
        dot.className = 'w-2 h-2 rounded-full bg-slate-400';
        txt.textContent = 'In-App Alerts';
        if (sBtn) {
          sBtn.className = 'inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-100 text-slate-600 cursor-pointer';
          sDot.className = 'w-2 h-2 rounded-full bg-slate-400';
          sTxt.textContent = 'In-App Alerts';
        }
        return;
      }

      if (Notification.permission === 'granted') {
        btn.className = 'inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-2 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 cursor-pointer';
        dot.className = 'w-2 h-2 rounded-full bg-emerald-500';
        txt.textContent = 'Notifications Active';
        if (sBtn) {
          sBtn.className = 'inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-700 cursor-pointer';
          sDot.className = 'w-2 h-2 rounded-full bg-emerald-500';
          sTxt.textContent = 'Push Alerts Active';
        }
      } else if (Notification.permission === 'denied') {
        btn.className = 'inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-2 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 cursor-pointer';
        dot.className = 'w-2 h-2 rounded-full bg-rose-500';
        txt.textContent = 'Alerts Blocked';
        if (sBtn) {
          sBtn.className = 'inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 cursor-pointer';
          sDot.className = 'w-2 h-2 rounded-full bg-rose-500';
          sTxt.textContent = 'Push Alerts Blocked';
        }
      } else {
        btn.className = 'inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-2 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 cursor-pointer';
        dot.className = 'w-2 h-2 rounded-full bg-amber-500';
        txt.textContent = 'Tap to Enable';
        if (sBtn) {
          sBtn.className = 'inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 cursor-pointer';
          sDot.className = 'w-2 h-2 rounded-full bg-amber-500';
          sTxt.textContent = 'Enable Push Alerts';
        }
      }
    }

    window.handleEnableNotifications = async function () {
      if (!('Notification' in window)) {
        showBanner('In-App Alerts Active', 'Your browser does not support system push notifications, so live banners and chimes will be used.');
        return;
      }
      if (Notification.permission === 'denied') {
        openPhoneModal();
        return;
      }
      try {
        const perm = await Notification.requestPermission();
        updateNotificationButtonUI();
        if (perm === 'granted') {
          fireReminderAlert('Notifications Active!', 'You will receive Daily Pulse reminders at your scheduled times.');
        }
      } catch (e) {
        updateNotificationButtonUI();
      }
    };

    function playSubtleChime() {
      if (!state.soundEnabled) return;
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        const now = ctx.currentTime;
        [587.33, 880].forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, now + i * 0.13);
          gain.gain.setValueAtTime(0.0001, now + i * 0.13);
          gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.13 + 0.025);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.13 + 0.45);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + i * 0.13);
          osc.stop(now + i * 0.13 + 0.5);
        });
      } catch (e) {}
    }

    function fireReminderAlert(title, body) {
      playSubtleChime();

      // Mobile haptic vibration feedback
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try {
          navigator.vibrate([180, 90, 180]);
        } catch (e) {}
      }

      // Native browser notification if permitted
      if ('Notification' in window && Notification.permission === 'granted') {
        showSystemNotification(title, body);
      }

      // Always display crisp in-app alert banner
      showBanner(title, body);
    }

    async function showSystemNotification(title, body) {
      const options = { body, tag: 'daily-pulse-' + Date.now(), icon: 'icons/icon-192.png', badge: 'icons/favicon-64.png' };
      try {
        // Installed apps (Android Chrome, iOS Home Screen) only allow notifications through the service worker
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg && reg.showNotification) {
            await reg.showNotification(title, options);
            return;
          }
        }
        const n = new Notification(title, options);
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch (e) {}
    }

    function showBanner(title, body) {
      const stack = document.getElementById('banner-stack');
      const id = 'b-' + Date.now() + '-' + Math.random().toString(36).slice(2, 5);
      const card = document.createElement('div');
      card.id = id;
      card.className = 'animate-banner pointer-events-auto bg-white rounded-2xl border border-indigo-200 shadow-lg p-3.5 space-y-2.5';
      card.innerHTML = `
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-[11px] font-bold uppercase tracking-wider text-indigo-600">Daily Pulse Reminder</div>
            <div class="text-sm font-bold text-slate-900 mt-0.5">${escapeHTML(title)}</div>
            <p class="text-xs text-slate-600 mt-0.5 leading-snug">${escapeHTML(body)}</p>
          </div>
          <button type="button" onclick="document.getElementById('${id}')?.remove()" class="text-slate-400 hover:text-slate-700 text-xs p-1 cursor-pointer shrink-0">✕</button>
        </div>
        <div class="flex items-center gap-2 pt-1 border-t border-slate-100">
          <button type="button" onclick="snoozeBanner('${id}', ${JSON.stringify(title)}, ${JSON.stringify(body)})" class="px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11px] font-semibold cursor-pointer">
            Snooze 15m
          </button>
          <button type="button" onclick="document.getElementById('${id}')?.remove()" class="px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-semibold cursor-pointer">
            Done
          </button>
        </div>
      `;
      stack.prepend(card);
      setTimeout(() => {
        const el = document.getElementById(id);
        if (el) el.remove();
      }, 14000);
    }

    window.snoozeBanner = function (id, title, body) {
      document.getElementById(id)?.remove();
      showBanner('Snoozed 15m', 'We will remind you again in 15 minutes.');
      setTimeout(() => {
        fireReminderAlert(`Snoozed: ${title}`, body);
      }, 15 * 60 * 1000);
    };

    /*************************************************************************
     * REAL-TIME SCHEDULER & BACKGROUND MISSED-WINDOW CATCH-UP
     *************************************************************************/
    function checkScheduleAndCatchUp(isForegroundCatchUp = false) {
      const now = new Date();
      const todayISO = localISODate(now);
      const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      if (!state.masterEnabled) return;

      let firedAny = false;

      // 1. Check scheduled daily times (exact match OR missed earlier today if catching up on mobile open)
      state.scheduleTimes.forEach(timeStr => {
        const slotKey = `${todayISO}_sched_${timeStr}`;
        if (state.triggeredSlots[slotKey]) return;

        const isExactNow = timeStr === currentHHMM;
        const isMissedEarlierToday = isForegroundCatchUp && timeStr < currentHHMM;

        if (isExactNow || isMissedEarlierToday) {
          state.triggeredSlots[slotKey] = true;
          firedAny = true;
          const label = isMissedEarlierToday
            ? `Catch-Up Reminder (${format12Hour(timeStr)})`
            : `Scheduled Reminder (${format12Hour(timeStr)})`;
          fireReminderAlert(label, buildReminderSummary());
        }
      });

      // 2. Check individual task-specific target times
      if (state.sectionReminders.tasks) {
        state.tasks.forEach(task => {
          if (task.completed || !task.remind || !task.time) return;
          const taskKey = `${todayISO}_task_${task.id}_${task.time}`;
          if (state.triggeredSlots[taskKey]) return;

          if (task.time === currentHHMM || (isForegroundCatchUp && task.time < currentHHMM)) {
            state.triggeredSlots[taskKey] = true;
            firedAny = true;
            fireReminderAlert(`Task Due (${format12Hour(task.time)})`, task.title);
          }
        });
      }

      // 3. Schedule tab: day-part reminders and exact item times
      if (checkScheduledParts(todayISO, currentHHMM, isForegroundCatchUp)) firedAny = true;

      if (firedAny) {
        persistState();
      }
    }

    // Short summary of what is open, used in each scheduled reminder
    function buildReminderSummary() {
      const parts = [];
      if (state.sectionReminders.tasks) {
        const open = state.tasks.filter(t => !t.completed && t.remind);
        if (open.length) {
          const high = open.filter(t => t.priority === 'High').length;
          parts.push(`${open.length} task${open.length === 1 ? '' : 's'} open${high ? ` (${high} high)` : ''}`);
        }
      }
      if (state.sectionReminders.outreach) {
        const due = state.outreach.filter(c => c.remind && isOutreachDue(c));
        if (due.length) {
          const names = due.slice(0, 3).map(c => c.name).join(', ');
          parts.push(`Reach out to ${names}${due.length > 3 ? ` +${due.length - 3} more` : ''}`);
        }
      }
      if (state.sectionReminders.todos) {
        const left = state.todoLists.filter(l => l.remind).reduce((n, l) => n + l.items.filter(i => !i.done).length, 0);
        if (left) parts.push(`${left} checklist item${left === 1 ? '' : 's'} left`);
      }
      const today = getDaysAgoISO(0);
      const openScheduled = itemsForDate(today).filter(i => !isItemDone(i, today)).length;
      if (openScheduled) parts.push(`${openScheduled} scheduled item${openScheduled === 1 ? '' : 's'} left today`);
      return parts.length ? parts.join(' · ') : 'All caught up. Nice work!';
    }

    // "Test" button in the header (was referenced but missing in the original page)
    window.triggerTestReminder = function () {
      fireReminderAlert('Test Reminder', buildReminderSummary());
    };

    // Re-check missed reminders immediately whenever user unlocks phone or switches back to app
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        checkScheduleAndCatchUp(true);
      }
    });

    /*************************************************************************
     * SCHEDULE CONTROLS & PRESETS
     *************************************************************************/
    window.toggleMasterReminders = function (enabled) {
      state.masterEnabled = enabled;
      persistState();
    };

    window.toggleSound = function () {
      state.soundEnabled = !state.soundEnabled;
      if (state.soundEnabled) playSubtleChime();
      persistState();
    };

    window.applyFrequencyPreset = function (count) {
      const presets = {
        1: ['09:00'],
        2: ['09:00', '17:00'],
        3: ['09:00', '13:00', '17:00'],
        4: ['09:00', '12:00', '15:00', '19:00']
      };
      state.scheduleTimes = presets[count] || ['09:00', '13:00', '17:00'];
      state.masterEnabled = true;
      persistState();
    };

    window.handleAddTime = function (e) {
      e.preventDefault();
      const val = document.getElementById('new-time-input').value;
      if (!val) return;
      if (!state.scheduleTimes.includes(val)) {
        state.scheduleTimes.push(val);
        state.scheduleTimes.sort((a, b) => a.localeCompare(b));
        state.masterEnabled = true;
        persistState();
      }
    };

    window.removeScheduleTime = function (timeStr) {
      state.scheduleTimes = state.scheduleTimes.filter(t => t !== timeStr);
      persistState();
    };

    window.toggleSectionReminder = function (section, enabled) {
      state.sectionReminders[section] = enabled;
      persistState();
    };

    /*************************************************************************
     * TASKS ACTIONS
     *************************************************************************/
    window.handleAddTask = function (e) {
      e.preventDefault();
      const input = document.getElementById('task-input');
      const priorityInput = document.getElementById('task-priority-input');
      const timeInput = document.getElementById('task-time-input');
      const title = input.value.trim();
      if (!title) return;

      state.tasks.unshift({
        id: 't-' + Date.now(),
        title,
        priority: priorityInput ? priorityInput.value : 'Medium',
        time: timeInput.value || '',
        remind: true,
        completed: false,
        isSample: false
      });

      input.value = '';
      timeInput.value = '';
      if (priorityInput) priorityInput.value = 'Medium';
      persistState();
    };

    window.toggleTaskDone = function (id) {
      const t = state.tasks.find(item => item.id === id);
      if (t) {
        t.completed = !t.completed;
        persistState();
      }
    };

    window.toggleTaskRemind = function (id) {
      const t = state.tasks.find(item => item.id === id);
      if (t) {
        t.remind = !t.remind;
        persistState();
      }
    };

    window.deleteTask = function (id) {
      state.tasks = state.tasks.filter(item => item.id !== id);
      persistState();
    };

    /*************************************************************************
     * OUTREACH ACTIONS
     *************************************************************************/
    function isOutreachDue(contact) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const last = new Date((contact.lastContacted || getDaysAgoISO(0)) + 'T00:00:00');
      const diffDays = Math.floor((today - last) / (1000 * 60 * 60 * 24));
      return diffDays >= Number(contact.frequencyDays || 7);
    }

    function formatFrequencyBadge(days) {
      const d = Number(days);
      if (d === 1) return 'Today / Daily';
      if (d === 3) return 'Every few days';
      if (d === 7) return 'Weekly';
      if (d === 14) return 'Biweekly';
      if (d === 30) return 'Monthly';
      return `Every ${d}d`;
    }

    window.handleAddOutreach = function (e) {
      e.preventDefault();
      const nameInput = document.getElementById('outreach-name-input');
      const freqInput = document.getElementById('outreach-freq-input');
      const noteInput = document.getElementById('outreach-note-input');
      const name = nameInput.value.trim();
      if (!name) return;

      const freq = Number(freqInput.value || 7);
      // Set lastContacted back by `freq` days so newly added contacts appear ready to reach out to immediately
      state.outreach.unshift({
        id: 'o-' + Date.now(),
        name,
        note: noteInput.value.trim(),
        frequencyDays: freq,
        lastContacted: getDaysAgoISO(freq),
        remind: true,
        isSample: false
      });

      nameInput.value = '';
      noteInput.value = '';
      persistState();
    };

    window.markReachedOut = function (id) {
      const c = state.outreach.find(item => item.id === id);
      if (c) {
        c.lastContacted = getDaysAgoISO(0);
        persistState();
        showBanner('Reached Out Logged', `Reset timer for ${c.name} (${formatFrequencyBadge(c.frequencyDays)}).`);
      }
    };

    window.toggleOutreachRemind = function (id) {
      const c = state.outreach.find(item => item.id === id);
      if (c) {
        c.remind = !c.remind;
        persistState();
      }
    };

    window.deleteOutreach = function (id) {
      state.outreach = state.outreach.filter(item => item.id !== id);
      persistState();
    };

    /*************************************************************************
     * TO-DO LISTS ACTIONS
     *************************************************************************/
    window.handleAddTodoList = function (e) {
      e.preventDefault();
      const input = document.getElementById('new-list-title');
      const title = input.value.trim();
      if (!title) return;

      state.todoLists.unshift({
        id: 'l-' + Date.now(),
        title,
        remind: true,
        isSample: false,
        items: []
      });

      input.value = '';
      persistState();
    };

    window.handleAddTodoItem = function (e, listId) {
      e.preventDefault();
      const input = document.getElementById('todo-item-in-' + listId);
      const text = input.value.trim();
      if (!text) return;

      const list = state.todoLists.find(l => l.id === listId);
      if (list) {
        list.items.push({
          id: 'li-' + Date.now(),
          text,
          done: false
        });
        input.value = '';
        persistState();
      }
    };

    window.toggleTodoItem = function (listId, itemId) {
      const list = state.todoLists.find(l => l.id === listId);
      if (!list) return;
      const item = list.items.find(i => i.id === itemId);
      if (item) {
        item.done = !item.done;
        persistState();
      }
    };

    window.deleteTodoItem = function (listId, itemId) {
      const list = state.todoLists.find(l => l.id === listId);
      if (!list) return;
      list.items = list.items.filter(i => i.id !== itemId);
      persistState();
    };

    window.toggleTodoListRemind = function (listId) {
      const list = state.todoLists.find(l => l.id === listId);
      if (list) {
        list.remind = !list.remind;
        persistState();
      }
    };

    window.deleteTodoList = function (listId) {
      state.todoLists = state.todoLists.filter(l => l.id !== listId);
      persistState();
    };

    window.clearSampleItems = function () {
      state.tasks = state.tasks.filter(t => !t.isSample);
      state.outreach = state.outreach.filter(o => !o.isSample);
      state.todoLists = state.todoLists.filter(l => !l.isSample);
      state.scheduleItems = state.scheduleItems.filter(i => !i.isSample);
      persistState();
    };

    /*************************************************************************
     * PHONE SETUP & .ICS CALENDAR EXPORT
     *************************************************************************/
    window.openPhoneModal = function () {
      const preview = state.scheduleTimes.length > 0
        ? state.scheduleTimes.map(format12Hour).join(', ')
        : '9:00 AM';
      document.getElementById('modal-times-preview').textContent = preview
        + (state.scheduleItems.length ? `, plus your ${state.scheduleItems.length} scheduled item${state.scheduleItems.length === 1 ? '' : 's'}` : '');
      document.getElementById('phone-modal').classList.remove('hidden');
    };

    window.closePhoneModal = function () {
      document.getElementById('phone-modal').classList.add('hidden');
    };

    window.openSyncModal = function () {
      document.getElementById('sync-modal').classList.remove('hidden');
    };

    window.closeSyncModal = function () {
      document.getElementById('sync-modal').classList.add('hidden');
    };

    window.copySyncId = function () {
      const uid = document.getElementById('sync-uid-display').textContent;
      const temp = document.createElement('textarea');
      temp.value = uid;
      document.body.appendChild(temp);
      temp.select();
      document.execCommand('copy');
      document.body.removeChild(temp);
      showBanner('Copied Sync ID', 'Sync Profile ID copied to clipboard.');
    };

    window.downloadBackup = function () {
      const blob = new Blob([JSON.stringify({ app: 'daily-pulse', version: 1, exportedAt: new Date().toISOString(), state }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `daily-pulse-backup-${getDaysAgoISO(0)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    window.restoreBackup = function (input) {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          const data = parsed && parsed.state ? parsed.state : parsed;
          if (!data || (!Array.isArray(data.tasks) && !Array.isArray(data.outreach) && !Array.isArray(data.todoLists))) throw new Error('not a backup');
          if (!confirm('Replace everything on this device with this backup?')) return;
          state = normalizeState(data);
          persistState();
          closeSyncModal();
          showBanner('Backup Restored', 'Your tasks, contacts, lists and schedule were restored.');
        } catch (e) {
          showBanner('Restore Failed', 'That file is not a Daily Pulse backup.');
        } finally {
          input.value = '';
        }
      };
      reader.readAsText(file);
    };

    window.downloadICSReminders = function () {
      const times = state.scheduleTimes.length > 0 ? state.scheduleTimes : ['09:00', '13:00', '17:00'];
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const dateStamp = `${yyyy}${mm}${dd}`;

      const events = times.map((t, idx) => {
        const [hh, min] = t.split(':');
        const startDT = `${dateStamp}T${hh}${min}00`;
        const endMin = String(Math.min(59, Number(min) + 10)).padStart(2, '0');
        const endDT = `${dateStamp}T${hh}${endMin}00`;

        return [
          'BEGIN:VEVENT',
          `UID:daily-pulse-${dateStamp}-${idx}@dailypulse.app`,
          `DTSTAMP:${dateStamp}T080000Z`,
          `DTSTART:${startDT}`,
          `DTEND:${endDT}`,
          'RRULE:FREQ=DAILY',
          `SUMMARY:Daily Pulse Check-In (${format12Hour(t)})`,
          'DESCRIPTION:Open Daily Pulse to review your tasks, outreach contacts, and to-do lists.',
          'BEGIN:VALARM',
          'TRIGGER:-PT0M',
          'ACTION:DISPLAY',
          'DESCRIPTION:Daily Pulse Reminder',
          'END:VALARM',
          'END:VEVENT'
        ].join('\r\n');
      });

      const icsContent = [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Daily Pulse//Reminder Schedule//EN',
        'CALSCALE:GREGORIAN',
        ...events,
        ...buildScheduleICSEvents(),
        'END:VCALENDAR'
      ].join('\r\n');

      const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'daily-pulse-reminders.ics';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    /*************************************************************************
     * RENDERING PIPELINE
     *************************************************************************/
    function renderAll() {
      // 1. Sound Icon & Schedule Sound Label
      document.getElementById('sound-icon').textContent = state.soundEnabled ? '🔔' : '🔕';
      const schedSoundLabel = document.getElementById('sched-sound-label');
      if (schedSoundLabel) {
        schedSoundLabel.textContent = state.soundEnabled ? '🔔 Chime On' : '🔕 Chime Off';
      }

      // 3. Master Toggle & Schedule Card State
      const masterToggle = document.getElementById('master-toggle');
      const masterText = document.getElementById('master-status-text');
      const schedBody = document.getElementById('schedule-controls-body');

      masterToggle.checked = state.masterEnabled;
      masterText.textContent = state.masterEnabled ? 'Reminders ON' : 'Reminders OFF';
      masterText.className = state.masterEnabled ? 'text-xs font-bold text-indigo-700' : 'text-xs font-bold text-slate-400';
      schedBody.className = state.masterEnabled ? 'space-y-3 pt-1' : 'space-y-3 pt-1 opacity-50 pointer-events-none';

      // Highlight matching frequency preset button
      document.querySelectorAll('.preset-btn').forEach(btn => {
        const pCount = Number(btn.getAttribute('data-preset'));
        const isMatch = state.scheduleTimes.length === pCount;
        btn.className = isMatch
          ? 'preset-btn px-3 py-1.5 rounded-xl text-xs font-semibold border border-indigo-600 bg-indigo-600 text-white transition cursor-pointer'
          : 'preset-btn px-3 py-1.5 rounded-xl text-xs font-semibold border border-slate-200 bg-slate-50 hover:bg-indigo-50 text-slate-700 transition cursor-pointer';
      });

      // Render Daily Time Chips
      const timesContainer = document.getElementById('schedule-times-list');
      timesContainer.innerHTML = state.scheduleTimes
        .slice()
        .sort((a, b) => a.localeCompare(b))
        .map(t => `
          <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-indigo-50 border border-indigo-200 text-indigo-800 text-xs font-semibold">
            <span>⏰ ${format12Hour(t)}</span>
            <button type="button" onclick="removeScheduleTime('${t}')" title="Remove time" class="text-indigo-400 hover:text-rose-600 ml-0.5 cursor-pointer">✕</button>
          </span>
        `).join('');

      // Sync Section Toggles (both in Schedule Card & Section Headers)
      ['tasks', 'outreach', 'todos'].forEach(sec => {
        const enabled = !!state.sectionReminders[sec];
        const sEl = document.getElementById('sec-toggle-' + sec);
        const cEl = document.getElementById('card-toggle-' + sec);
        if (sEl) sEl.checked = enabled;
        if (cEl) cEl.checked = enabled;
      });

      // 4. Render Tasks List
      const tasksEl = document.getElementById('tasks-list');
      if (state.tasks.length === 0) {
        tasksEl.innerHTML = `<p class="text-xs text-slate-400 text-center py-5">No tasks yet. Add one above!</p>`;
      } else {
        const sortedTasks = state.tasks.slice().sort((a, b) => Number(a.completed) - Number(b.completed));
        tasksEl.innerHTML = sortedTasks.map(t => {
          const prio = t.priority || 'Medium';
          const prioStyle = prio === 'High'
            ? 'bg-rose-50 text-rose-700 border-rose-200'
            : prio === 'Low'
              ? 'bg-slate-100 text-slate-600 border-slate-200'
              : 'bg-amber-50 text-amber-700 border-amber-200';
          return `
          <div class="flex items-center justify-between gap-2.5 p-3 rounded-xl border ${t.completed ? 'border-slate-100 bg-slate-50/60 opacity-60' : 'border-slate-200 bg-white'}">
            <label class="flex items-center gap-3 min-w-0 flex-1 cursor-pointer">
              <input type="checkbox" ${t.completed ? 'checked' : ''} onchange="toggleTaskDone('${t.id}')" class="w-5 h-5 rounded-md text-indigo-600 focus:ring-indigo-500 cursor-pointer shrink-0" />
              <div class="min-w-0">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="text-sm font-medium ${t.completed ? 'line-through text-slate-400' : 'text-slate-900'} truncate">${escapeHTML(t.title)}</span>
                  <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded-md border ${prioStyle}">${escapeHTML(prio)}</span>
                </div>
                ${t.time ? `<div class="text-[11px] font-medium text-indigo-600 mt-0.5">⏰ ${format12Hour(t.time)}</div>` : ''}
              </div>
            </label>
            <div class="flex items-center gap-2 shrink-0">
              <button type="button" onclick="toggleTaskRemind('${t.id}')" title="Toggle task reminder" class="px-2 py-1 rounded-lg text-[11px] font-semibold border transition cursor-pointer ${t.remind ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-slate-50 border-slate-200 text-slate-400'}">
                ${t.remind ? '🔔 On' : '🔕 Off'}
              </button>
              <button type="button" onclick="deleteTask('${t.id}')" title="Delete task" class="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 text-xs cursor-pointer">✕</button>
            </div>
          </div>
        `;
        }).join('');
      }

      // 5. Render Outreach Contacts
      const outreachEl = document.getElementById('outreach-list');
      if (state.outreach.length === 0) {
        outreachEl.innerHTML = `<p class="text-xs text-slate-400 text-center py-5">No contacts yet. Add someone above!</p>`;
      } else {
        const sortedOutreach = state.outreach.slice().sort((a, b) => Number(isOutreachDue(b)) - Number(isOutreachDue(a)));
        outreachEl.innerHTML = sortedOutreach.map(c => {
          const due = isOutreachDue(c);
          const last = c.lastContacted ? new Date(c.lastContacted + 'T00:00:00') : null;
          const daysSince = last ? Math.floor((new Date().setHours(0, 0, 0, 0) - last) / 86400000) : null;
          const lastLabel = daysSince === null ? '' : daysSince <= 0 ? 'Reached out today' : `Last reached ${daysSince}d ago`;
          return `
          <div class="p-3 rounded-xl border ${due ? 'border-amber-200 bg-amber-50/50' : 'border-slate-200 bg-white'} space-y-2">
            <div class="flex items-start justify-between gap-2.5">
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="text-sm font-semibold text-slate-900 truncate">${escapeHTML(c.name)}</span>
                  <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded-md border bg-slate-100 text-slate-600 border-slate-200">${escapeHTML(formatFrequencyBadge(c.frequencyDays))}</span>
                  ${due ? '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-md border bg-amber-100 text-amber-800 border-amber-200">Due</span>' : ''}
                </div>
                ${c.note ? `<p class="text-xs text-slate-600 mt-0.5 leading-snug">${escapeHTML(c.note)}</p>` : ''}
                ${lastLabel ? `<div class="text-[11px] font-medium text-slate-400 mt-0.5">${lastLabel}</div>` : ''}
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <button type="button" onclick="toggleOutreachRemind('${c.id}')" title="Toggle contact reminder" class="px-2 py-1 rounded-lg text-[11px] font-semibold border transition cursor-pointer ${c.remind ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-slate-50 border-slate-200 text-slate-400'}">
                  ${c.remind ? '🔔 On' : '🔕 Off'}
                </button>
                <button type="button" onclick="deleteOutreach('${c.id}')" title="Delete contact" class="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 text-xs cursor-pointer">✕</button>
              </div>
            </div>
            <button type="button" onclick="markReachedOut('${c.id}')" class="w-full py-1.5 rounded-lg text-xs font-semibold transition cursor-pointer ${due ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-slate-100 hover:bg-slate-200 text-slate-700'}">
              ✓ Reached Out
            </button>
          </div>
        `;
        }).join('');
      }

      // 6. Render To-Do Lists
      const listsEl = document.getElementById('todo-lists-container');
      if (state.todoLists.length === 0) {
        listsEl.innerHTML = `<p class="md:col-span-2 text-xs text-slate-400 text-center py-5">No to-do lists yet. Create one above!</p>`;
      } else {
        listsEl.innerHTML = state.todoLists.map(list => {
          const totalItems = list.items.length;
          const doneItems = list.items.filter(i => i.done).length;
          const pct = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 0;
          return `
          <div class="rounded-xl border border-slate-200 bg-slate-50/40 p-3.5 flex flex-col justify-between gap-3">
            <div>
              <div class="flex items-center justify-between gap-2 pb-2 border-b border-slate-200/70">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center justify-between gap-2">
                    <h3 class="text-sm font-bold text-slate-900 truncate">${escapeHTML(list.title)}</h3>
                    <span class="text-[11px] font-semibold text-slate-500 shrink-0">${doneItems}/${totalItems}</span>
                  </div>
                  <div class="w-full h-1.5 bg-slate-200/80 rounded-full overflow-hidden mt-1.5">
                    <div class="h-full bg-emerald-500 rounded-full transition-all duration-300" style="width: ${pct}%"></div>
                  </div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0 ml-2">
                  <button type="button" onclick="toggleTodoListRemind('${list.id}')" class="px-2 py-1 rounded-lg text-[11px] font-semibold border transition cursor-pointer ${list.remind ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-white border-slate-200 text-slate-400'}">
                    ${list.remind ? '🔔 On' : '🔕 Off'}
                  </button>
                  <button type="button" onclick="deleteTodoList('${list.id}')" class="p-1 rounded-lg text-slate-400 hover:text-rose-600 text-xs cursor-pointer">✕</button>
                </div>
              </div>

              <ul class="mt-2.5 space-y-1.5">
                ${list.items.length === 0 ? `<li class="text-xs text-slate-400 italic">No items yet</li>` : ''}
                ${list.items.map(item => `
                  <li class="flex items-center justify-between gap-2 py-1 px-1.5 rounded-lg hover:bg-white">
                    <label class="flex items-center gap-2.5 text-sm cursor-pointer flex-1 min-w-0">
                      <input type="checkbox" ${item.done ? 'checked' : ''} onchange="toggleTodoItem('${list.id}', '${item.id}')" class="w-4 h-4 rounded text-emerald-600 cursor-pointer shrink-0" />
                      <span class="${item.done ? 'line-through text-slate-400' : 'text-slate-800'} truncate">${escapeHTML(item.text)}</span>
                    </label>
                    <button type="button" onclick="deleteTodoItem('${list.id}', '${item.id}')" class="text-xs text-slate-400 hover:text-rose-600 px-1 cursor-pointer">✕</button>
                  </li>
                `).join('')}
              </ul>
            </div>

            <form onsubmit="handleAddTodoItem(event, '${list.id}')" class="flex items-center gap-1.5 pt-2 border-t border-slate-200/70">
              <input type="text" id="todo-item-in-${list.id}" placeholder="Add item..." class="flex-1 px-3 py-1.5 text-xs rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              <button type="submit" class="px-3 py-1.5 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer">Add</button>
            </form>
          </div>
        `;
        }).join('');
      }

      // Show/Hide Clear Sample Items button
      renderSchedule();

      const hasSamples = state.scheduleItems.some(i => i.isSample) || state.tasks.some(t => t.isSample) || state.outreach.some(o => o.isSample) || state.todoLists.some(l => l.isSample);
      document.getElementById('clear-samples-btn').style.display = hasSamples ? 'inline' : 'none';
    }

    /*************************************************************************
     * SCHEDULE TAB — day parts × categories, repeating items, per-day done state
     *************************************************************************/
    function normalizeDayParts(parts) {
      const byId = {};
      (Array.isArray(parts) ? parts : []).forEach(p => { if (p && p.id) byId[p.id] = p; });
      return DEFAULT_DAY_PARTS.map(d => ({ ...d, ...(byId[d.id] || {}), id: d.id, icon: d.icon }));
    }

    function normalizeCategories(cats) {
      const list = Array.isArray(cats) ? cats.filter(c => c && c.id && c.name) : [];
      const out = DEFAULT_CATEGORIES.map(d => ({ ...d, ...(list.find(c => c.id === d.id) || {}), builtin: true }));
      list.forEach(c => { if (!out.some(o => o.id === c.id)) out.push({ ...c, builtin: false, color: CATEGORY_COLORS[c.color] ? c.color : 'slate' }); });
      return out;
    }

    function parseISODate(iso) {
      const [y, m, d] = iso.split('-').map(Number);
      return new Date(y, m - 1, d);
    }

    function addDaysISO(iso, n) {
      const d = parseISODate(iso);
      d.setDate(d.getDate() + n);
      return localISODate(d);
    }

    function nowHHMM() {
      const n = new Date();
      return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
    }

    function getPart(id) {
      return state.dayParts.find(p => p.id === id) || state.dayParts[0];
    }

    function getCategory(id) {
      return state.categories.find(c => c.id === id) || { id, name: 'Other', color: 'slate' };
    }

    function itemOccursOn(item, iso) {
      const r = item.repeat || { type: 'daily' };
      if (r.type === 'once') return r.date === iso;
      if (item.startDate && iso < item.startDate) return false;
      const dow = parseISODate(iso).getDay();
      if (r.type === 'weekdays') return dow >= 1 && dow <= 5;
      if (r.type === 'days') return Array.isArray(r.days) && r.days.includes(dow);
      return true; // daily
    }

    function itemsForDate(iso) {
      return state.scheduleItems.filter(i => itemOccursOn(i, iso));
    }

    function isItemDone(item, iso) {
      return !!(state.scheduleDone[iso] && state.scheduleDone[iso][item.id]);
    }

    // Linked items show the live title of the task / contact / checklist they point to
    function itemDisplay(item) {
      if (item.linkType === 'task') {
        const t = state.tasks.find(x => x.id === item.linkId);
        return { title: t ? t.title : item.title, sub: t && t.priority ? `${t.priority} priority` : (t ? '' : 'Task was deleted') };
      }
      if (item.linkType === 'outreach') {
        const c = state.outreach.find(x => x.id === item.linkId);
        return { title: c ? `Reach out: ${c.name}` : item.title, sub: c ? (c.note || '') : 'Contact was deleted' };
      }
      if (item.linkType === 'list') {
        const l = state.todoLists.find(x => x.id === item.linkId);
        if (!l) return { title: item.title, sub: 'Checklist was deleted' };
        const left = l.items.filter(i => !i.done).length;
        return { title: `Checklist: ${l.title}`, sub: `${left} of ${l.items.length} items left` };
      }
      return { title: item.title, sub: item.note || '' };
    }

    function repeatLabel(item) {
      const r = item.repeat || { type: 'daily' };
      if (r.type === 'once') return 'One time';
      if (r.type === 'weekdays') return 'Weekdays';
      if (r.type === 'days') {
        const days = (r.days || []).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
        return days.length === 7 ? 'Daily' : days.map(d => DOW_SHORT[d]).join(', ');
      }
      return 'Daily';
    }

    function isItemOverdue(item, iso) {
      if (isItemDone(item, iso)) return false;
      const today = getDaysAgoISO(0);
      if (iso < today) return true;
      if (iso > today) return false;
      const now = nowHHMM();
      if (item.time) return item.time < now;
      return getPart(item.partId).end <= now;
    }

    function partStatus(part, iso, items) {
      const today = getDaysAgoISO(0);
      const allDone = items.length > 0 && items.every(i => isItemDone(i, iso));
      if (allDone) return 'done';
      if (iso < today) return items.length ? 'overdue' : 'past';
      if (iso > today) return 'upcoming';
      const now = nowHHMM();
      if (now >= part.end) return items.some(i => !isItemDone(i, iso)) ? 'overdue' : 'past';
      if (now >= part.start) return 'now';
      return 'upcoming';
    }

    function partRangeLabel(p) {
      return `${format12Hour(p.start)} – ${format12Hour(p.end)}`;
    }

    function selectedScheduleDate() {
      if (!uiState.scheduleDate) uiState.scheduleDate = getDaysAgoISO(0);
      return uiState.scheduleDate;
    }

    const uiState = { scheduleDate: null, tab: 'home' };

    /* ---------- Tabs ---------- */
    window.switchTab = function (tab) {
      uiState.tab = tab === 'schedule' ? 'schedule' : 'home';
      try { localStorage.setItem('daily-pulse-tab', uiState.tab); } catch (e) {}
      if (location.hash !== '#' + uiState.tab) history.replaceState(null, '', '#' + uiState.tab);
      document.getElementById('view-home').classList.toggle('hidden', uiState.tab !== 'home');
      document.getElementById('view-schedule').classList.toggle('hidden', uiState.tab !== 'schedule');
      const on = 'flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold border border-indigo-600 bg-indigo-600 text-white transition cursor-pointer';
      const off = 'flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition cursor-pointer';
      document.getElementById('tab-btn-home').className = uiState.tab === 'home' ? on : off;
      document.getElementById('tab-btn-schedule').className = uiState.tab === 'schedule' ? on : off;
      document.getElementById('tab-btn-home').setAttribute('aria-selected', String(uiState.tab === 'home'));
      document.getElementById('tab-btn-schedule').setAttribute('aria-selected', String(uiState.tab === 'schedule'));
      if (uiState.tab === 'schedule') renderSchedule();
      window.scrollTo(0, 0);
    };

    function initTab() {
      let tab = location.hash === '#schedule' ? 'schedule' : location.hash === '#home' ? 'home' : null;
      if (!tab) { try { tab = localStorage.getItem('daily-pulse-tab'); } catch (e) {} }
      switchTab(tab || 'home');
    }

    /* ---------- Day navigation ---------- */
    window.setScheduleDate = function (iso) {
      uiState.scheduleDate = iso;
      renderSchedule();
    };
    window.shiftScheduleWeek = function (n) {
      uiState.scheduleDate = addDaysISO(selectedScheduleDate(), 7 * n);
      renderSchedule();
    };
    window.scheduleGoToday = function () {
      uiState.scheduleDate = getDaysAgoISO(0);
      renderSchedule();
    };

    /* ---------- Done / undone ---------- */
    window.toggleScheduleDone = function (itemId, iso) {
      const item = state.scheduleItems.find(i => i.id === itemId);
      if (!item) return;
      if (!state.scheduleDone[iso]) state.scheduleDone[iso] = {};
      const nowDone = !state.scheduleDone[iso][itemId];
      if (nowDone) state.scheduleDone[iso][itemId] = true;
      else delete state.scheduleDone[iso][itemId];
      if (!Object.keys(state.scheduleDone[iso]).length) delete state.scheduleDone[iso];

      // Keep the linked item in step
      if (item.linkType === 'outreach' && nowDone) {
        const c = state.outreach.find(x => x.id === item.linkId);
        if (c && iso >= (c.lastContacted || '')) c.lastContacted = iso;
      }
      if (item.linkType === 'task' && (item.repeat || {}).type === 'once') {
        const t = state.tasks.find(x => x.id === item.linkId);
        if (t) t.completed = nowDone;
      }
      persistState();
    };

    /* ---------- Add / edit modal ---------- */
    function fillSelect(id, options, value) {
      const el = document.getElementById(id);
      el.innerHTML = options.map(o => `<option value="${escapeHTML(o.value)}">${escapeHTML(o.label)}</option>`).join('');
      if (value !== undefined && options.some(o => o.value === value)) el.value = value;
    }

    function linkOptions(source) {
      if (source === 'task') return state.tasks.map(t => ({ value: t.id, label: t.title + (t.completed ? ' (done)' : '') }));
      if (source === 'outreach') return state.outreach.map(c => ({ value: c.id, label: c.name }));
      if (source === 'list') return state.todoLists.map(l => ({ value: l.id, label: l.title }));
      return [];
    }

    const SOURCE_CATEGORY = { task: 'tasks', outreach: 'followups', list: 'checklists' };

    window.onScheduleSourceChange = function (keepCategory) {
      const source = document.getElementById('sched-source').value;
      const isNew = source === 'new';
      document.getElementById('sched-title-wrap').classList.toggle('hidden', !isNew);
      document.getElementById('sched-link-wrap').classList.toggle('hidden', isNew);
      document.getElementById('sched-title').required = isNew;
      if (!isNew) {
        const opts = linkOptions(source);
        fillSelect('sched-link', opts.length ? opts : [{ value: '', label: 'Nothing here yet — add one on the Home tab' }]);
      }
      if (!keepCategory && SOURCE_CATEGORY[source]) document.getElementById('sched-category').value = SOURCE_CATEGORY[source];
    };

    window.onScheduleRepeatChange = function () {
      const r = document.getElementById('sched-repeat').value;
      document.getElementById('sched-days-wrap').classList.toggle('hidden', r !== 'days');
      document.getElementById('sched-date-wrap').classList.toggle('hidden', r !== 'once');
    };

    window.onSchedulePartChange = function () {
      const p = getPart(document.getElementById('sched-part').value);
      document.getElementById('sched-time-hint').textContent = `Optional. ${p.name} is ${partRangeLabel(p)}; its reminder is at ${format12Hour(p.remind)}.`;
    };

    window.openScheduleItemModal = function (itemId, presetPartId) {
      const item = itemId ? state.scheduleItems.find(i => i.id === itemId) : null;
      const iso = selectedScheduleDate();
      fillSelect('sched-category', state.categories.map(c => ({ value: c.id, label: c.name })), item ? item.categoryId : 'tasks');
      fillSelect('sched-part', state.dayParts.map(p => ({ value: p.id, label: `${p.icon} ${p.name}` })), item ? item.partId : (presetPartId || currentOrNextPartId()));
      document.getElementById('sched-edit-id').value = item ? item.id : '';
      document.getElementById('sched-modal-title').textContent = item ? 'Edit Scheduled Item' : 'Schedule an Item';
      document.getElementById('sched-delete-btn').classList.toggle('hidden', !item);
      const source = item ? ({ task: 'task', outreach: 'outreach', list: 'list' }[item.linkType] || 'new') : 'new';
      document.getElementById('sched-source').value = source;
      document.getElementById('sched-title').value = item && !item.linkType ? item.title : '';
      onScheduleSourceChange(!!item);
      if (item && item.linkId) document.getElementById('sched-link').value = item.linkId;
      const r = item ? item.repeat : { type: 'daily' };
      document.getElementById('sched-repeat').value = r.type;
      document.querySelectorAll('input[name="sched-day"]').forEach(cb => {
        cb.checked = r.type === 'days' ? (r.days || []).includes(Number(cb.value)) : false;
      });
      document.getElementById('sched-date').value = r.type === 'once' ? r.date : iso;
      document.getElementById('sched-time').value = item ? (item.time || '') : '';
      document.getElementById('sched-remind').checked = item ? item.remind !== false : true;
      onScheduleRepeatChange();
      onSchedulePartChange();
      document.getElementById('sched-item-modal').classList.remove('hidden');
    };

    window.closeScheduleItemModal = function () {
      document.getElementById('sched-item-modal').classList.add('hidden');
    };

    function currentOrNextPartId() {
      const now = nowHHMM();
      const p = state.dayParts.find(p => now < p.end);
      return (p || state.dayParts[0]).id;
    }

    window.saveScheduleItem = function (e) {
      e.preventDefault();
      const editId = document.getElementById('sched-edit-id').value;
      const source = document.getElementById('sched-source').value;
      const repeatType = document.getElementById('sched-repeat').value;
      const repeat = { type: repeatType };
      if (repeatType === 'days') {
        repeat.days = Array.from(document.querySelectorAll('input[name="sched-day"]:checked')).map(cb => Number(cb.value));
        if (!repeat.days.length) { showBanner('Pick Some Days', 'Choose at least one day of the week.'); return; }
      }
      if (repeatType === 'once') {
        repeat.date = document.getElementById('sched-date').value;
        if (!repeat.date) { showBanner('Pick a Date', 'Choose the date for this one-time item.'); return; }
      }
      let title = '', linkType = null, linkId = null;
      if (source === 'new') {
        title = document.getElementById('sched-title').value.trim();
        if (!title) return;
      } else {
        linkId = document.getElementById('sched-link').value;
        if (!linkId) { showBanner('Nothing to Link', 'Add that item on the Home tab first, or choose "New item".'); return; }
        linkType = source;
        const opt = linkOptions(source).find(o => o.value === linkId);
        title = opt ? opt.label : 'Linked item';
      }
      const fields = {
        title, linkType, linkId, repeat,
        categoryId: document.getElementById('sched-category').value,
        partId: document.getElementById('sched-part').value,
        time: document.getElementById('sched-time').value || '',
        remind: document.getElementById('sched-remind').checked
      };
      const existing = editId && state.scheduleItems.find(i => i.id === editId);
      if (existing) Object.assign(existing, fields);
      else state.scheduleItems.push({ id: 's-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), startDate: getDaysAgoISO(0), isSample: false, ...fields });
      if (repeatType === 'once') uiState.scheduleDate = repeat.date;
      closeScheduleItemModal();
      persistState();
      showBanner(existing ? 'Schedule Updated' : 'Scheduled', `${fields.title} · ${getPart(fields.partId).name} · ${repeatLabel({ repeat })}`);
    };

    window.deleteScheduleItem = function () {
      const id = document.getElementById('sched-edit-id').value;
      if (!id || !confirm('Remove this item from your schedule?')) return;
      state.scheduleItems = state.scheduleItems.filter(i => i.id !== id);
      Object.keys(state.scheduleDone).forEach(d => { delete state.scheduleDone[d][id]; });
      closeScheduleItemModal();
      persistState();
    };

    /* ---------- Settings: day parts & categories ---------- */
    window.updateDayPart = function (id, field, value) {
      const p = state.dayParts.find(x => x.id === id);
      if (!p || !value) return;
      if (field === 'name') value = value.trim().slice(0, 24) || p.name;
      p[field] = value;
      persistState();
    };

    window.resetDayParts = function () {
      document.activeElement && document.activeElement.blur();
      state.dayParts = normalizeDayParts([]);
      persistState();
    };

    window.togglePartReminders = function (on) {
      state.partRemindersEnabled = on;
      persistState();
    };

    window.handleAddCategory = function (e) {
      e.preventDefault();
      const name = document.getElementById('new-category-name').value.trim();
      const color = document.getElementById('new-category-color').value;
      if (!name) return;
      if (state.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) { showBanner('Already There', `You already have a "${name}" category.`); return; }
      state.categories.push({ id: 'c-' + Date.now(), name: name.slice(0, 30), color, builtin: false });
      document.getElementById('new-category-name').value = '';
      document.activeElement && document.activeElement.blur();
      persistState();
    };

    window.deleteCategory = function (id) {
      const cat = state.categories.find(c => c.id === id);
      if (!cat || cat.builtin) return;
      const used = state.scheduleItems.filter(i => i.categoryId === id).length;
      if (!confirm(used ? `Delete "${cat.name}"? Its ${used} scheduled item(s) move to Tasks.` : `Delete "${cat.name}"?`)) return;
      state.scheduleItems.forEach(i => { if (i.categoryId === id) i.categoryId = 'tasks'; });
      state.categories = state.categories.filter(c => c.id !== id);
      document.activeElement && document.activeElement.blur();
      persistState();
    };

    /* ---------- Reminders ---------- */
    function partSummary(part, iso) {
      const items = itemsForDate(iso).filter(i => i.partId === part.id && i.remind !== false && !isItemDone(i, iso));
      if (!items.length) return null;
      const groups = {};
      items.forEach(i => { (groups[i.categoryId] = groups[i.categoryId] || []).push(itemDisplay(i).title.replace(/^(Checklist|Reach out): /, '')); });
      return Object.keys(groups).map(cid => `${getCategory(cid).name}: ${groups[cid].join(', ')}`).join(' · ');
    }

    function checkScheduledParts(todayISO, currentHHMM, isForegroundCatchUp) {
      let fired = false;
      if (state.partRemindersEnabled === false) return false;
      state.dayParts.forEach(part => {
        const key = `${todayISO}_part_${part.id}`;
        if (state.triggeredSlots[key]) return;
        const exact = part.remind === currentHHMM;
        const missed = isForegroundCatchUp && part.remind < currentHHMM && currentHHMM < part.end;
        if (!exact && !missed) return;
        const summary = partSummary(part, todayISO);
        state.triggeredSlots[key] = true;
        fired = true;
        if (summary) fireReminderAlert(`${part.icon} ${part.name} (${partRangeLabel(part)})`, summary);
      });
      itemsForDate(todayISO).forEach(item => {
        if (!item.time || item.remind === false || isItemDone(item, todayISO)) return;
        const key = `${todayISO}_sitem_${item.id}_${item.time}`;
        if (state.triggeredSlots[key]) return;
        const part = getPart(item.partId);
        const missed = isForegroundCatchUp && item.time < currentHHMM && currentHHMM < part.end;
        if (item.time !== currentHHMM && !missed) return;
        state.triggeredSlots[key] = true;
        fired = true;
        fireReminderAlert(`Due ${format12Hour(item.time)} · ${getCategory(item.categoryId).name}`, itemDisplay(item).title);
      });
      return fired;
    }

    /* ---------- .ics export: one recurring event per scheduled item ---------- */
    function icsEscape(s) {
      return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
    }

    function buildScheduleICSEvents() {
      const today = getDaysAgoISO(0);
      const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
      return state.scheduleItems.map(item => {
        const part = getPart(item.partId);
        const r = item.repeat || { type: 'daily' };
        let first = r.type === 'once' ? r.date : null;
        if (!first) {
          for (let k = 0; k < 7; k++) { const d = addDaysISO(today, k); if (itemOccursOn(item, d)) { first = d; break; } }
        }
        if (!first) return null;
        const t = item.time || part.remind;
        const [hh, mm] = t.split(':').map(Number);
        const end = new Date(2000, 0, 1, hh, mm + 15);
        const ymd = first.replace(/-/g, '');
        const lines = [
          'BEGIN:VEVENT',
          `UID:daily-pulse-item-${item.id}@dailypulse.app`,
          `DTSTAMP:${stamp}`,
          `DTSTART:${ymd}T${String(hh).padStart(2, '0')}${String(mm).padStart(2, '0')}00`,
          `DTEND:${ymd}T${String(end.getHours()).padStart(2, '0')}${String(end.getMinutes()).padStart(2, '0')}00`
        ];
        if (r.type === 'daily') lines.push('RRULE:FREQ=DAILY');
        if (r.type === 'weekdays') lines.push('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
        if (r.type === 'days') lines.push(`RRULE:FREQ=WEEKLY;BYDAY=${(r.days || []).map(d => ICS_DAYS[d]).join(',')}`);
        const disp = itemDisplay(item);
        lines.push(
          `SUMMARY:${icsEscape(disp.title)}`,
          `DESCRIPTION:${icsEscape(`${getCategory(item.categoryId).name} · ${part.name} (${partRangeLabel(part)})${disp.sub ? ' · ' + disp.sub : ''}`)}`,
          'BEGIN:VALARM', 'TRIGGER:-PT0M', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(disp.title)}`, 'END:VALARM',
          'END:VEVENT'
        );
        return lines.join('\r\n');
      }).filter(Boolean);
    }

    /* ---------- Rendering ---------- */
    function renderSchedule() {
      const container = document.getElementById('day-parts-container');
      if (!container) return;
      const iso = selectedScheduleDate();
      const today = getDaysAgoISO(0);
      const d = parseISODate(iso);

      document.getElementById('sched-date-title').textContent =
        iso === today ? 'Today' : iso === addDaysISO(today, 1) ? 'Tomorrow' : iso === addDaysISO(today, -1) ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long' });
      document.getElementById('sched-date-sub').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
      document.getElementById('sched-today-btn').classList.toggle('hidden', iso === today);

      // Week strip (Mon–Sun) with a dot for days that have items
      const monday = addDaysISO(iso, -((d.getDay() + 6) % 7));
      document.getElementById('week-strip').innerHTML = Array.from({ length: 7 }, (_, k) => {
        const day = addDaysISO(monday, k);
        const dd = parseISODate(day);
        const items = itemsForDate(day);
        const open = items.filter(i => !isItemDone(i, day)).length;
        const dot = !items.length ? 'bg-transparent' : open === 0 ? 'bg-emerald-500' : (day < today ? 'bg-rose-500' : 'bg-indigo-400');
        const sel = day === iso;
        const cls = sel ? 'bg-indigo-600 border-indigo-600 text-white' : day === today ? 'bg-indigo-50 border-indigo-200 text-indigo-800' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50';
        return `<button type="button" onclick="setScheduleDate('${day}')" data-date="${day}" class="flex flex-col items-center py-1.5 rounded-xl border text-[11px] font-semibold transition cursor-pointer ${cls}">
            <span class="${sel ? 'text-indigo-100' : 'text-slate-400'} text-[10px] font-medium">${DOW_SHORT[dd.getDay()]}</span>
            <span class="text-sm font-bold leading-tight">${dd.getDate()}</span>
            <span class="w-1.5 h-1.5 rounded-full mt-0.5 ${sel && items.length ? 'bg-white' : dot}"></span>
          </button>`;
      }).join('');

      const dayItems = itemsForDate(iso);
      const doneCount = dayItems.filter(i => isItemDone(i, iso)).length;
      const pct = dayItems.length ? Math.round((doneCount / dayItems.length) * 100) : 0;
      document.getElementById('sched-progress').innerHTML = dayItems.length
        ? `<div class="flex items-center justify-between text-[11px] font-semibold text-slate-500"><span>${doneCount} of ${dayItems.length} done</span><span>${pct}%</span></div>
           <div class="w-full h-1.5 bg-slate-200/80 rounded-full overflow-hidden mt-1"><div class="h-full bg-emerald-500 rounded-full transition-all duration-300" style="width:${pct}%"></div></div>`
        : `<p class="text-xs text-slate-400">Nothing scheduled for this day yet. Tap <strong>+ Schedule</strong> to add a task, follow-up or anything else to a part of the day.</p>`;

      const statusChip = {
        now: '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-md border bg-indigo-600 text-white border-indigo-600">Now</span>',
        done: '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-md border bg-emerald-50 text-emerald-700 border-emerald-200">All done</span>',
        overdue: '<span class="text-[10px] font-bold px-1.5 py-0.5 rounded-md border bg-rose-50 text-rose-700 border-rose-200">Overdue</span>',
        upcoming: '', past: ''
      };

      container.innerHTML = state.dayParts.map(part => {
        const items = dayItems.filter(i => i.partId === part.id)
          .sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
        const status = partStatus(part, iso, items);
        const ring = status === 'now' ? 'border-indigo-300 ring-2 ring-indigo-100' : status === 'overdue' ? 'border-rose-200' : 'border-slate-200';
        const catOrder = state.categories.map(c => c.id);
        const groups = {};
        items.forEach(i => { (groups[i.categoryId] = groups[i.categoryId] || []).push(i); });
        const groupIds = Object.keys(groups).sort((a, b) => {
          const ia = catOrder.indexOf(a), ib = catOrder.indexOf(b);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        });
        const body = !items.length
          ? `<button type="button" onclick="openScheduleItemModal(null, '${part.id}')" class="w-full py-3 rounded-xl border border-dashed border-slate-300 text-xs font-semibold text-slate-400 hover:text-indigo-600 hover:border-indigo-300 cursor-pointer">+ Add to ${escapeHTML(part.name)}</button>`
          : groupIds.map(cid => {
            const cat = getCategory(cid);
            const col = CATEGORY_COLORS[cat.color] || CATEGORY_COLORS.slate;
            return `<div class="space-y-1.5">
                <div class="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  <span class="w-2 h-2 rounded-full ${col.dot}"></span><span>${escapeHTML(cat.name)}</span>
                </div>
                ${groups[cid].map(item => {
                  const done = isItemDone(item, iso);
                  const overdue = isItemOverdue(item, iso);
                  const disp = itemDisplay(item);
                  const rowCls = done ? 'border-slate-100 bg-slate-50/60 opacity-60' : overdue ? 'border-rose-200 bg-rose-50/60' : 'border-slate-200 bg-white';
                  return `<div class="sched-item flex items-center justify-between gap-2.5 p-2.5 rounded-xl border ${rowCls}" data-item="${item.id}">
                      <label class="flex items-center gap-3 min-w-0 flex-1 cursor-pointer">
                        <input type="checkbox" ${done ? 'checked' : ''} onchange="toggleScheduleDone('${item.id}', '${iso}')" class="w-5 h-5 rounded-md text-indigo-600 cursor-pointer shrink-0" />
                        <div class="min-w-0">
                          <div class="text-sm font-medium ${done ? 'line-through text-slate-400' : 'text-slate-900'} truncate">${escapeHTML(disp.title)}</div>
                          <div class="flex items-center gap-1.5 flex-wrap mt-0.5">
                            ${item.time ? `<span class="text-[11px] font-semibold ${overdue ? 'text-rose-600' : 'text-indigo-600'}">⏰ ${format12Hour(item.time)}</span>` : ''}
                            <span class="text-[10px] font-semibold px-1.5 py-0.5 rounded-md border bg-slate-100 text-slate-600 border-slate-200">${escapeHTML(repeatLabel(item))}</span>
                            ${overdue ? '<span class="text-[10px] font-bold text-rose-600">Overdue</span>' : ''}
                            ${item.remind === false ? '<span class="text-[10px] text-slate-400">🔕</span>' : ''}
                            ${disp.sub ? `<span class="text-[11px] text-slate-500 truncate">${escapeHTML(disp.sub)}</span>` : ''}
                          </div>
                        </div>
                      </label>
                      <button type="button" onclick="openScheduleItemModal('${item.id}')" title="Edit" class="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 text-xs cursor-pointer shrink-0">✎</button>
                    </div>`;
                }).join('')}
              </div>`;
          }).join('');
        return `<section aria-label="${escapeHTML(part.name)}" data-part="${part.id}" class="bg-white rounded-2xl border ${ring} p-4 sm:p-5 shadow-2xs space-y-3">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-2 min-w-0">
                <span class="w-7 h-7 rounded-lg bg-slate-50 flex items-center justify-center text-sm">${part.icon}</span>
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5"><h3 class="text-base font-bold text-slate-900">${escapeHTML(part.name)}</h3>${statusChip[status]}</div>
                  <div class="text-[11px] font-medium text-slate-500">${partRangeLabel(part)} · 🔔 ${format12Hour(part.remind)}</div>
                </div>
              </div>
              ${items.length ? `<button type="button" onclick="openScheduleItemModal(null, '${part.id}')" title="Add to ${escapeHTML(part.name)}" class="w-8 h-8 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 text-sm font-bold cursor-pointer shrink-0">+</button>` : ''}
            </div>
            ${body}
          </section>`;
      }).join('');

      renderScheduleSettings();
    }

    function renderScheduleSettings() {
      const el = document.getElementById('sched-settings-body');
      if (!el || el.contains(document.activeElement)) return; // don't yank inputs while editing
      el.innerHTML = `
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <h4 class="text-xs font-bold text-slate-900">Parts of the day</h4>
            <button type="button" onclick="resetDayParts()" class="text-[11px] text-slate-500 hover:text-indigo-600 underline cursor-pointer">Reset to defaults</button>
          </div>
          ${state.dayParts.map(p => `
            <div class="grid grid-cols-[1fr_auto] gap-2 p-2.5 rounded-xl border border-slate-200 bg-slate-50/60">
              <input type="text" value="${escapeHTML(p.name)}" onchange="updateDayPart('${p.id}','name',this.value)" class="col-span-2 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 bg-white" aria-label="${escapeHTML(p.name)} name" />
              <div class="col-span-2 grid grid-cols-3 gap-2 text-[10px] font-semibold text-slate-500">
                <label class="space-y-0.5"><span>Starts</span><input type="time" value="${p.start}" onchange="updateDayPart('${p.id}','start',this.value)" class="w-full px-2 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-700" /></label>
                <label class="space-y-0.5"><span>Ends</span><input type="time" value="${p.end}" onchange="updateDayPart('${p.id}','end',this.value)" class="w-full px-2 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-700" /></label>
                <label class="space-y-0.5"><span>Reminder</span><input type="time" value="${p.remind}" onchange="updateDayPart('${p.id}','remind',this.value)" class="w-full px-2 py-1.5 text-xs rounded-lg border border-slate-300 bg-white text-slate-700" /></label>
              </div>
            </div>`).join('')}
          <label class="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer pt-1">
            <input type="checkbox" ${state.partRemindersEnabled !== false ? 'checked' : ''} onchange="togglePartReminders(this.checked)" class="w-4 h-4 rounded text-indigo-600 cursor-pointer" />
            <span>Remind me at each part's reminder time with what's due</span>
          </label>
        </div>
        <div class="space-y-2 pt-3 border-t border-slate-100">
          <h4 class="text-xs font-bold text-slate-900">Categories</h4>
          <div class="flex flex-wrap gap-2">
            ${state.categories.map(c => {
              const col = CATEGORY_COLORS[c.color] || CATEGORY_COLORS.slate;
              return `<span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border text-xs font-semibold ${col.chip}">
                  <span class="w-2 h-2 rounded-full ${col.dot}"></span>${escapeHTML(c.name)}
                  ${c.builtin ? '' : `<button type="button" onclick="deleteCategory('${c.id}')" title="Delete category" class="ml-0.5 opacity-60 hover:opacity-100 cursor-pointer">✕</button>`}
                </span>`;
            }).join('')}
          </div>
          <form onsubmit="handleAddCategory(event)" class="flex gap-2">
            <input type="text" id="new-category-name" required maxlength="30" placeholder="New category (e.g., Church, Jobs, Family)..." class="flex-1 min-w-0 px-3 py-2 text-xs rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <select id="new-category-color" class="px-2 py-2 text-xs font-semibold rounded-xl border border-slate-300 bg-white text-slate-700">
              ${Object.keys(CATEGORY_COLORS).filter(k => !['indigo', 'amber', 'emerald'].includes(k)).map(k => `<option value="${k}">${CATEGORY_COLORS[k].label}</option>`).join('')}
            </select>
            <button type="submit" class="px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold cursor-pointer shrink-0">Add</button>
          </form>
        </div>`;
    }

    // Refresh "Now"/"Overdue" states as the day moves on
    let lastScheduleMinute = '';
    setInterval(() => {
      const m = nowHHMM();
      if (m !== lastScheduleMinute) {
        if (lastScheduleMinute && uiState.tab === 'schedule') renderSchedule();
        lastScheduleMinute = m;
      }
    }, 5000);

    /*************************************************************************
     * FORMATTING UTILITIES
     *************************************************************************/
    function escapeHTML(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function format12Hour(hhmm) {
      if (!hhmm) return '';
      const [hStr, mStr] = hhmm.split(':');
      let h = Number(hStr);
      const ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12 || 12;
      return `${h}:${mStr} ${ampm}`;
    }

    /*************************************************************************
     * BOOTSTRAP ON WINDOW LOAD
     *************************************************************************/
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => console.warn('Service worker not registered:', err));
      });
    }

    window.onload = function () {
      updateNotificationButtonUI();
      renderAll();
      initTab();
      initFirebaseSync();

      // Run scheduler tick every second
      checkScheduleAndCatchUp(false);
      setInterval(() => checkScheduleAndCatchUp(false), 1000);
    };
  