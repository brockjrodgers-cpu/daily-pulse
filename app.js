
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
        triggeredSlots: data.triggeredSlots || {}
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
      persistState();
    };

    /*************************************************************************
     * PHONE SETUP & .ICS CALENDAR EXPORT
     *************************************************************************/
    window.openPhoneModal = function () {
      const preview = state.scheduleTimes.length > 0
        ? state.scheduleTimes.map(format12Hour).join(', ')
        : '9:00 AM';
      document.getElementById('modal-times-preview').textContent = preview;
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
      const hasSamples = state.tasks.some(t => t.isSample) || state.outreach.some(o => o.isSample) || state.todoLists.some(l => l.isSample);
      document.getElementById('clear-samples-btn').style.display = hasSamples ? 'inline' : 'none';
    }

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
      initFirebaseSync();

      // Run scheduler tick every second
      checkScheduleAndCatchUp(false);
      setInterval(() => checkScheduleAndCatchUp(false), 1000);
    };
  