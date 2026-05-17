let calendarDate = new Date();

function renderCalendar() {
    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();

    // Build workout date lookup
    const workoutDates = {};
    workouts.forEach(wk => {
        if (!wk.date) return;
        if (!workoutDates[wk.date]) workoutDates[wk.date] = [];
        workoutDates[wk.date].push(wk);
    });

    // Header label
    document.getElementById('cal-month-title').textContent =
        calendarDate.toLocaleString('default', { month: 'long', year: 'numeric' });

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    const firstDayOfWeek = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    let html = '';
    for (let i = 0; i < firstDayOfWeek; i++) html += '<div class="cal-day cal-empty"></div>';

    for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const hasWorkout = !!workoutDates[dateStr];
        const isToday = dateStr === todayStr;
        let cls = 'cal-day' + (hasWorkout ? ' cal-has-workout' : '') + (isToday ? ' cal-today' : '');
        const click = hasWorkout ? `onclick="showDaySummary('${dateStr}')"` : '';
        html += `<div class="${cls}" ${click}>${d}${hasWorkout ? '<span class="cal-dot"></span>' : ''}</div>`;
    }

    document.getElementById('cal-days').innerHTML = html;
    document.getElementById('cal-day-summary').innerHTML = '';
}

function calPrev() { calendarDate.setMonth(calendarDate.getMonth() - 1); renderCalendar(); }
function calNext() { calendarDate.setMonth(calendarDate.getMonth() + 1); renderCalendar(); }

function jumpCalendar(year, month) {
    calendarDate = new Date(year, month, 1);
    renderCalendar();
    document.getElementById('workout-calendar-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function showDaySummary(dateStr) {
    document.querySelectorAll('.cal-day.cal-selected').forEach(el => el.classList.remove('cal-selected'));
    document.querySelectorAll('.cal-day').forEach(el => {
        if (el.getAttribute('onclick') === `showDaySummary('${dateStr}')`) el.classList.add('cal-selected');
    });

    const panel = document.getElementById('cal-day-summary');
    const paired = pairWorkoutsWithWatchData(workouts).filter(wk => wk.date === dateStr);
    if (!paired.length) { panel.innerHTML = ''; return; }

    const dateObj = new Date(dateStr + 'T12:00:00');
    const formatted = dateObj.toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric' });

    let html = `<div class="cal-summary-date">${formatted}</div>`;

    paired.forEach(wk => {
        const themeColor = getWorkoutColor(wk);
        const isCardio = isCardioWorkout(wk) && !hasStrengthExercises(wk);
        const metrics = normalizeWatchMetrics(wk);
        const cardioStats = renderWatchMetricGrid(metrics, isCardio);

        const exHTML = (wk.exercises || []).map(ex => {
            const setsHTML = (ex.sets || []).map(s => {
                const wStr = String(s.weight).toUpperCase();
                const displayWeight = (wStr === 'BW' || wStr === '0') ? 'BW' : s.weight + 'lbs';
                return `<span style="display:inline-block; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); padding:3px 8px; border-radius:6px; margin:3px 4px 0 0; font-size:12px; color:#ccc; text-shadow:1px 1px 1px #000;">${displayWeight} × ${s.reps}</span>`;
            }).join('');
            const noteHTML = ex.note ? `<div style="color:#888; font-style:italic; font-size:12px; margin-top:4px;">📝 ${ex.note}</div>` : '';
            return `<div style="margin-bottom:12px;">
                <strong style="color:#fff; letter-spacing:0.5px;">${ex.name || 'Unknown'}</strong>
                ${noteHTML}
                <div style="margin-top:4px;">${setsHTML}</div>
            </div>`;
        }).join('');

        html += `<div class="cal-summary-workout" style="border-left:3px solid ${themeColor};">
            <div class="cal-summary-name" style="color:${themeColor}; text-shadow:0 0 8px ${themeColor}60;">${wk.name || 'Workout'}</div>
            ${cardioStats}
            ${exHTML}
        </div>`;
    });

    panel.innerHTML = html;
}

function getAuthHeader() {
    const token = localStorage.getItem('liftlog_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// Current logged-in user 
// The Decoder: Cracks open the JWT to find out who is logged in
function getUserIdFromToken() {
    const token = localStorage.getItem('liftlog_token');
    if (!token) return null;
    try {
        return JSON.parse(atob(token.split('.')[1])).user_id; 
    } catch (e) {
        console.error("Could not decode token:", e);
        return null;
    }
}

// Current logged-in user (Dynamically pulled from the JWT Token!)
const CURRENT_USER_ID = getUserIdFromToken();

let templates = JSON.parse(localStorage.getItem('templates')) || [];
let workouts = JSON.parse(localStorage.getItem('workouts')) || [];
let currentTemplateExercises = []; // This holds the list of exercises while you are building a new template
let currentWorkout = null;
let currentEditingTemplateIndex = -1;

// ==========================================
// SESSION INACTIVITY TIMER (30 Minutes)
// ==========================================
let inactivityTimer;
const TIMEOUT_MINUTES = 30; 
const SESSION_LAST_ACTIVE_KEY = 'liftlog_last_active_at';

function forceLogout(reason) {
    console.log(reason || "Session ended.");
    localStorage.removeItem('liftlog_token');
    localStorage.removeItem(SESSION_LAST_ACTIVE_KEY);
    window.location.href = '/login.html';
}

function sessionTimedOut() {
    const lastActive = parseInt(localStorage.getItem(SESSION_LAST_ACTIVE_KEY) || '0', 10);
    return !lastActive || (Date.now() - lastActive) > TIMEOUT_MINUTES * 60 * 1000;
}

function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    
    // Only run the countdown if they actually have a wristband
    if (localStorage.getItem('liftlog_token')) {
        localStorage.setItem(SESSION_LAST_ACTIVE_KEY, String(Date.now()));
        inactivityTimer = setTimeout(() => {
            forceLogout("Session timed out due to inactivity.");
        }, TIMEOUT_MINUTES * 60 * 1000); // Converts 30 mins to milliseconds
    }
}

function checkSessionTimeout() {
    if (!localStorage.getItem('liftlog_token')) return;

    if (sessionTimedOut()) {
        forceLogout("Session expired while the app was idle.");
        return;
    }

    clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
        forceLogout("Session timed out due to inactivity.");
    }, TIMEOUT_MINUTES * 60 * 1000);
}

function recordUserActivity() {
    if (!localStorage.getItem('liftlog_token')) return;

    if (sessionTimedOut()) {
        forceLogout("Session expired while the app was idle.");
        return;
    }

    resetInactivityTimer();
}

function initializeSessionTimer() {
    if (!localStorage.getItem('liftlog_token')) return false;

    if (sessionTimedOut()) {
        forceLogout("Session expired while the app was idle.");
        return false;
    }

    resetInactivityTimer();
    return true;
}

// Reset the clock anytime the user interacts with the app
window.onload = resetInactivityTimer;
document.onmousemove = recordUserActivity;  // For mouse users
document.onkeypress = recordUserActivity;   // For typing in inputs
document.ontouchstart = recordUserActivity; // CRITICAL: For iPad/Phone taps!
document.onclick = recordUserActivity;      // General clicks
window.addEventListener('focus', checkSessionTimeout);
window.addEventListener('pageshow', checkSessionTimeout);
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkSessionTimeout();
});
setInterval(checkSessionTimeout, 60 * 1000);


async function syncFromPi() {
    localStorage.removeItem('workouts'); // Clear the "ghost" data
    console.log("=== SYNC FROM PI STARTED ===");
    try {
        // Change: Use the direct relative path
        const response = await fetch(`/api/workouts?user_id=${CURRENT_USER_ID}&t=${Date.now()}`, {
            method: 'GET',
            headers: getAuthHeader()
        });

        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        const piWorkouts = await response.json();

        if (Array.isArray(piWorkouts)) {
            // Update the global workouts variable
            workouts = piWorkouts.map(wk => {
               let parsedEx = [];
               try {
                   parsedEx = Array.isArray(wk.exercises) ? wk.exercises : JSON.parse(wk.exercises || '[]');
               } catch (e) {
                   console.error("Failed to parse exercises for:", wk.date, e);
                   parsedEx = []; // Fallback to empty so the app doesn't crash
               }
    
               let parsedWatchData = wk.watchData;
               if (typeof parsedWatchData === 'string' && parsedWatchData) {
                   try {
                       parsedWatchData = JSON.parse(parsedWatchData);
                   } catch (e) {
                       console.warn("Failed to parse watchData for:", wk.date, e);
                       parsedWatchData = null;
                   }
               }

               return {
                   ...wk,
                   exercises: parsedEx,
                   watchData: parsedWatchData
               };
            });
            
            localStorage.setItem('workouts', JSON.stringify(workouts));
            renderHistory()
            renderTemplates();
            if (typeof renderReports === 'function') renderReports();
            return true;
        }
    } catch (err) {
        console.error("❌ SYNC FAILED:", err.message);
    }
    return false;
}

// Run this as soon as the page opens
window.addEventListener('load', syncFromPi);

function syncLocalWithPi(piWorkouts) {
    if (!Array.isArray(piWorkouts)) return;

    let hasNewData = false;
    
    piWorkouts.forEach(piWk => {
        // Create a unique ID based on Date and Name
        const piID = `${piWk.date}-${piWk.name}`;
        
        // Check if this EXACT workout already exists in local memory
        const exists = workouts.some(localWk => `${localWk.date}-${localWk.name}` === piID);
        
        if (!exists) {
            workouts.unshift(piWk);
            hasNewData = true;
        }
    });

    if (hasNewData) {
        // Sort them so the UI doesn't jump around
        workouts.sort((a, b) => b.date.localeCompare(a.date));
        localStorage.setItem('workouts', JSON.stringify(workouts));
        renderHistory();
        if (typeof renderReports === 'function') renderReports();
    }
}

async function saveWorkoutToPi(workoutData) {
    showStatus("Saving to Pi...", "info");

    try {

        const workoutWithUser = { ...workoutData, user_id: CURRENT_USER_ID };

        const response = await fetch('/add-workout', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                ...getAuthHeader() 
            },            
            body: JSON.stringify(workoutWithUser),
            signal: AbortSignal.timeout(8000)
        });

        if (response.ok) {
            showStatus("✅ Saved to Pi successfully", "success");
            console.log("Workout saved to Pi");
            // Force full replace from Pi after save
            await syncFromPi();
            return true;
        } else {
            showStatus("❌ Pi rejected the save", "error");
            return false;
        }
    } catch (error) {
        showStatus("⚠️ Saved locally only", "error");
        console.log("Pi unreachable");
        return false;
    }
}

async function syncTemplates() {
    try {
        const response = await fetch(`/api/templates?t=${Date.now()}`, {
            headers: getAuthHeader()
        });

        if (!response.ok) {
            console.log("Templates fetch failed:", response.status); // temporary, can remove later
            return;
        }

        const remoteTemplates = await response.json();
        
        if (Array.isArray(remoteTemplates)) {
            templates = remoteTemplates; 
            localStorage.setItem('templates', JSON.stringify(templates));
            renderTemplates();
            console.log(`Loaded ${templates.length} templates from Pi`);
        }
    } catch (error) {
        console.log("Template sync error, using local if any", error);
    }
}

async function saveTemplates() {
    localStorage.setItem('templates', JSON.stringify(templates));
    
    try {
        const response = await fetch('/save-templates', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                ...getAuthHeader()
            },
            body: JSON.stringify(templates)
        });

        if (response.ok) {
            console.log(`✅ Saved ${templates.length} templates to Pi`);
            return true;
        } else {
            console.error("Pi rejected template save");
            return false;
        }
    } catch (err) {
        console.error("Template save failed", err);
        return false;
    }
}


function saveWorkouts() { 
    localStorage.setItem('workouts', JSON.stringify(workouts)); 
    // We don't call saveWorkoutToPi here anymore to prevent infinite sync loops
}

function showSection(section) {
    console.log("Forcing section:", section);

    if (section === 'history') {
        section = 'progress';
    }

    // Update bottom nav active state
    const navSection = section === 'edit-template' ? 'templates' : section;
    document.querySelectorAll('#bottom-nav button').forEach(btn => {
        btn.classList.toggle('nav-active', btn.dataset.section === navSection);
    });

    // 1. Hide EVERY section using both class AND direct style
    document.querySelectorAll('.section').forEach(s => {
        s.classList.remove('active');
        s.style.display = 'none'; // Force hide
    });

    // 2. Find the target section
    let target = document.getElementById(section + '-section');
    
    if (target) {
        // 3. Force show using both methods
        target.classList.add('active');
        target.style.display = 'block'; // Force show
        console.log("Target section found and displayed.");
        
    } else {
        console.error("CRITICAL: Could not find section ID:", section + '-section');
    }

    if (section === 'log') {
        populateTemplateSelect(); // This fills the dropdown with your new templates
    }

    // 4. Run the data syncs in the background
    if (section === 'dashboard') renderReports();
    if (section === 'reports') renderReports();
    if (section === 'history') renderHistory();
    if (section === 'templates') renderTemplates();
    if (section === 'import') renderPendingSync();
    if (section === 'history' || section === 'reports') {
        cleanupDuplicates();
        syncFromPi();
    }
    // === MINIMAL ADDITIONS FOR NEW LAYOUT ONLY ===
    if (section === 'progress') {
        showProgressTab('history');
    }

        if (section === 'settings') {
        console.log("🔧 Opening Settings tab");
        target = document.getElementById('settings-section');
        if (target) {
            target.style.display = 'block';
            console.log("✅ Settings section forced visible");
        }
        const importContent = document.getElementById('settings-import-content');
        if (importContent) importContent.style.display = 'block';
        setTimeout(() => {
            if (typeof showSettingsTab === 'function') showSettingsTab('import');
        }, 10);
        loadAppleHealthTokenStatus();
    }
}



function switchReportTab(tab) {
    const isSummary = tab === 'summary';
    
    // 1. Toggle the visibility of the data views
    const viewSummary = document.getElementById('view-summary');
    const viewExercises = document.getElementById('progress-exercises-content') || document.getElementById('view-exercises');
    
    if (viewSummary) viewSummary.style.display = isSummary ? 'block' : 'none';
    if (viewExercises) viewExercises.style.display = isSummary ? 'none' : 'block';
    
    // 2. Grab the button elements
    const sBtn = document.getElementById('tab-summary');
    const eBtn = document.getElementById('tab-exercises');
    
    // 3. Swap the CSS classes to update colors
    if (sBtn && eBtn) {
        if (isSummary) {
            sBtn.className = 'report-tab tab-active';
            eBtn.className = 'report-tab tab-inactive';
        } else {
            sBtn.className = 'report-tab tab-inactive';
            eBtn.className = 'report-tab tab-active';
        }
    }
}

function workoutBelongsToCurrentUser(wk) {
    return !wk.user_id || !CURRENT_USER_ID || String(wk.user_id) === String(CURRENT_USER_ID);
}

function hasStrengthExercises(wk) {
    return Array.isArray(wk.exercises) && wk.exercises.length > 0;
}

function isCardioWorkout(wk) {
    return wk.type === 'cardio' || parseFloat(wk.distance) > 0;
}

function isWatchOnlyWorkout(wk) {
    return !hasStrengthExercises(wk) && (
        wk.watchData ||
        wk.type === 'watch' ||
        wk.type === 'cardio' ||
        parseFloat(wk.distance) > 0 ||
        parseInt(wk.duration) > 0 ||
        parseInt(wk.hr) > 0 ||
        parseInt(wk.calories) > 0
    );
}



function normalizeWatchMetrics(wk) {
    if (!wk) return null;

    const watch = wk.watchData && typeof wk.watchData === 'object' ? wk.watchData : {};

    // `appleHealth` sub-object is present on merged workouts (Strava + Apple Health import)
    const ah = watch.appleHealth || null;

    // When Apple Health data is present, prefer it for HR and calorie metrics
    // (Apple Watch is more accurate for these than Strava, especially for strength workouts)
    const hrSrc = ah || watch;

    // Source label drives which display template is used in renderWatchMetricGrid
    const source = ah ? 'AppleHealth' : (watch.source || 'Strava');

    return {
        name:                 watch.name || wk.name || 'Watch Activity',
        type:                 watch.type || watch.sportType || wk.type || '',
        sportType:            watch.sportType || watch.type || wk.type || '',
        // Distance: prefer Strava GPS for merged workouts, fall back to AH
        distance:             parseFloat(watch.distance ?? ah?.distance ?? wk.distance ?? 0) || 0,
        // ah.duration covers new imports; ah.durationMinutes covers old stored records
        duration:             parseInt((ah?.duration ?? ah?.durationMinutes) ?? watch.duration ?? wk.duration ?? 0, 10) || 0,
        elapsedTime:          parseInt(watch.elapsedTime ?? wk.elapsedTime ?? 0, 10) || 0,
        // HR: prefer Apple Health; ah.hr covers new imports, ah.avgHeartRate covers old stored records
        hr:                   parseInt((ah?.hr ?? ah?.avgHeartRate) ?? watch.hr ?? wk.hr ?? 0, 10) || 0,
        maxHr:                parseInt((ah?.maxHr ?? ah?.maxHeartRate) ?? watch.maxHr ?? wk.maxHr ?? 0, 10) || 0,
        minHr:                parseInt(ah?.minHr ?? 0, 10) || 0,
        // Calories: prefer Apple Health
        calories:             parseInt((ah?.calories ?? null) ?? watch.calories ?? wk.calories ?? 0, 10) || 0,
        totalCalories:        parseInt((ah?.totalCalories ?? null) ?? 0, 10) || 0,
        // Pace: prefer Strava GPS, then AH computed pace
        pace:                 watch.pace || ah?.pace || wk.pace || '',
        // Strava-specific fields (preserved for Strava cardio display)
        elevation:            parseFloat(watch.elevation ?? wk.elevation ?? 0) || 0,
        elevationHigh:        parseFloat(watch.elevationHigh ?? wk.elevationHigh ?? 0) || 0,
        elevationLow:         parseFloat(watch.elevationLow ?? wk.elevationLow ?? 0) || 0,
        averageSpeed:         parseFloat(watch.averageSpeed ?? wk.averageSpeed ?? 0) || 0,
        maxSpeed:             parseFloat(watch.maxSpeed ?? wk.maxSpeed ?? 0) || 0,
        averageCadence:       parseFloat(watch.averageCadence ?? wk.averageCadence ?? 0) || 0,
        averageWatts:         parseFloat(watch.averageWatts ?? wk.averageWatts ?? 0) || 0,
        weightedAverageWatts: parseFloat(watch.weightedAverageWatts ?? wk.weightedAverageWatts ?? 0) || 0,
        kilojoules:           parseFloat(watch.kilojoules ?? wk.kilojoules ?? 0) || 0,
        sufferScore:          parseInt(watch.sufferScore ?? wk.sufferScore ?? 0, 10) || 0,
        achievementCount:     parseInt(watch.achievementCount ?? wk.achievementCount ?? 0, 10) || 0,
        kudosCount:           parseInt(watch.kudosCount ?? wk.kudosCount ?? 0, 10) || 0,
        trainer:              Boolean(watch.trainer ?? wk.trainer),
        commute:              Boolean(watch.commute ?? wk.commute),
        manual:               Boolean(watch.manual ?? wk.manual),
        startTime:            watch.startTime || ah?.startTime || wk.startTime || '',
        source,
        appleActivityType:    ah?.appleActivityType || watch.appleActivityType || '',
    };
}

// ==================== SERVER-SIDE 45-DAY 1RM (client only reads the stats) ====================

let exerciseStats = {};

// Helper to get estimated 1RM safely (handles case and whitespace)
function getEstimated1RM(exerciseName) {
    if (!exerciseName) return null;
    const name = exerciseName.trim().toLowerCase();
    for (const key in exerciseStats) {
        if (key.trim().toLowerCase() === name) return exerciseStats[key];
    }
    return null;
}

// Load latest 1RM stats from the server when the app starts
async function loadExerciseStats() {
    try {
        const response = await fetch('/exercise_stats', {
            headers: getAuthHeader()
        });
        if (response.ok) {
            exerciseStats = await response.json();
            console.log("✅ Loaded 45-day 1RM stats from server", exerciseStats);
        }
    } catch (e) {
        console.log("No exercise_stats yet (first time)");
    }
}

// History sneak peek — most recent previous workout for this exact exercise
function getLastWorkoutForExercise(exerciseName) {
    if (!workouts || !currentWorkout) return null;

    const past = workouts
        .filter(w => w.date < currentWorkout.date)
        .sort((a, b) => new Date(b.date) - new Date(a.date));

    for (const workout of past) {
        const match = workout.exercises?.find(ex => ex.name === exerciseName);
        if (match && match.sets && match.sets.length > 0) {
            const totalWeight = match.sets.reduce((sum, s) => sum + (parseFloat(s.weight) || 0), 0);
            const totalReps   = match.sets.reduce((sum, s) => sum + (parseFloat(s.reps)   || 0), 0);
            
            return {
                date: workout.date,
                avgWeight: Math.round(totalWeight / match.sets.length),
                avgReps: (totalReps / match.sets.length).toFixed(1),
                sets: match.sets
            };
        }
    }
    return null;
}

function metersPerSecondToMph(speed) {
    return speed ? (speed * 2.23694).toFixed(1) : '';
}

function formatStartTime(startTime) {
    if (!startTime) return '';

    const date = new Date(startTime);
    if (Number.isNaN(date.getTime())) return startTime;

    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function renderWatchMetricGrid(metrics, isCardio) {
    if (!metrics) return '';

    const isAppleHealth = metrics.source === 'AppleHealth';

    if (isAppleHealth) {
        const durationStr = metrics.duration ? `${metrics.duration} min` : '';
        let rows;

        if (isCardio) {
            rows = [
                ['Duration',   durationStr],
                ['Distance',   metrics.distance ? `${metrics.distance.toFixed(2)} mi` : ''],
                ['Avg Pace',   metrics.pace || ''],
                ['Active Cal', metrics.calories ? `${metrics.calories} cal` : ''],
                ['Total Cal',  metrics.totalCalories ? `${metrics.totalCalories} cal` : ''],
                ['Avg HR',     metrics.hr ? `${metrics.hr} bpm` : ''],
                ['Max HR',     metrics.maxHr ? `${metrics.maxHr} bpm` : ''],
                ['Min HR',     metrics.minHr ? `${metrics.minHr} bpm` : ''],
            ];
        } else {
            rows = [
                ['Duration',   durationStr],
                ['Active Cal', metrics.calories ? `${metrics.calories} cal` : ''],
                ['Total Cal',  metrics.totalCalories ? `${metrics.totalCalories} cal` : ''],
                ['Avg HR',     metrics.hr ? `${metrics.hr} bpm` : ''],
                ['Max HR',     metrics.maxHr ? `${metrics.maxHr} bpm` : ''],
                ['Min HR',     metrics.minHr ? `${metrics.minHr} bpm` : ''],
            ];
        }

        rows = rows.filter(([, v]) => v !== '' && v != null);
        if (rows.length === 0) return '';

        const label = isCardio ? 'Cardio' : 'Strength';
        return `
            <div style="background: rgba(0,0,0,0.2); padding:12px; border-radius:12px; margin-bottom:12px; font-size:13px; border: 1px solid rgba(255,255,255,0.1); box-shadow: inset 0 2px 10px rgba(0,0,0,0.3);">
                <strong style="color: #ccc; letter-spacing: 0.5px; display: block; margin-bottom: 10px; text-transform: uppercase; font-size: 11px;">${label} · Apple Health 🍎</strong>
                <div style="display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:8px;">
                    ${rows.map(([lbl, value]) => `
                        <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 8px; box-shadow: inset 0 1px 3px rgba(0,0,0,0.2);">
                            <div style="font-size:10px; text-transform:uppercase; color:#888; letter-spacing:0.5px; margin-bottom: 2px;">${lbl}</div>
                            <strong style="display:block; color:#fff; text-shadow: 1px 1px 2px #000; overflow-wrap:anywhere;">${value}</strong>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    // Strava / other source — full metric dump
    const metricRows = [
        ['Elapsed',      metrics.elapsedTime ? `${metrics.elapsedTime} min` : ''],
        ['Distance',     metrics.distance ? `${metrics.distance.toFixed(2)} mi` : ''],
        ['Pace',         metrics.pace],
        ['Avg HR',       metrics.hr ? `${metrics.hr} bpm` : ''],
        ['Max HR',       metrics.maxHr ? `${metrics.maxHr} bpm` : ''],
        ['Calories',     metrics.calories ? `${metrics.calories} cal` : ''],
        ['Elevation',    metrics.elevation ? `${Math.round(metrics.elevation)} ft` : ''],
        ['Elev High',    metrics.elevationHigh ? `${Math.round(metrics.elevationHigh)} ft` : ''],
        ['Elev Low',     metrics.elevationLow ? `${Math.round(metrics.elevationLow)} ft` : ''],
        ['Avg Speed',    metrics.averageSpeed ? `${metersPerSecondToMph(metrics.averageSpeed)} mph` : ''],
        ['Max Speed',    metrics.maxSpeed ? `${metersPerSecondToMph(metrics.maxSpeed)} mph` : ''],
        ['Cadence',      metrics.averageCadence ? `${metrics.averageCadence.toFixed(1)}` : ''],
        ['Avg Watts',    metrics.averageWatts ? `${Math.round(metrics.averageWatts)} W` : ''],
        ['Weighted W',   metrics.weightedAverageWatts ? `${Math.round(metrics.weightedAverageWatts)} W` : ''],
        ['Kilojoules',   metrics.kilojoules ? `${Math.round(metrics.kilojoules)} kJ` : ''],
        ['Effort',       metrics.sufferScore ? `${metrics.sufferScore}` : ''],
        ['Achievements', metrics.achievementCount ? `${metrics.achievementCount}` : ''],
        ['Kudos',        metrics.kudosCount ? `${metrics.kudosCount}` : ''],
        ['Commute',      metrics.commute ? 'Yes' : ''],
        ['Manual',       metrics.manual ? 'Yes' : '']
    ].filter(([, value]) => value !== '' && value !== null && value !== undefined);

    if (metricRows.length === 0) return '';

    return `
        <div style="background: rgba(0,0,0,0.2); padding:12px; border-radius:12px; margin-bottom:12px; font-size:13px; border: 1px solid rgba(255,255,255,0.1); box-shadow: inset 0 2px 10px rgba(0,0,0,0.3);">
            <strong style="color: #ccc; letter-spacing: 0.5px; display: block; margin-bottom: 10px; text-transform: uppercase; font-size: 11px;">${isCardio ? 'Cardio' : 'Watch Metrics'} (${metrics.source || 'Strava'})</strong>
            <div style="display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:8px;">
                ${metricRows.map(([label, value]) => `
                    <div style="background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 8px; box-shadow: inset 0 1px 3px rgba(0,0,0,0.2);">
                        <div style="font-size:10px; text-transform:uppercase; color:#888; letter-spacing:0.5px; margin-bottom: 2px;">${label}</div>
                        <strong style="display:block; color:#fff; text-shadow: 1px 1px 2px #000; overflow-wrap:anywhere;">${value}</strong>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

function pairWorkoutsWithWatchData(sourceWorkouts) {
    const byDate = {};

    sourceWorkouts
        .filter(workoutBelongsToCurrentUser)
        .forEach(wk => {
            if (!wk.date) return;
            if (!byDate[wk.date]) byDate[wk.date] = [];
            byDate[wk.date].push(wk);
        });

    const paired = [];

    Object.keys(byDate).sort().reverse().forEach(date => {
        const dayEntries = byDate[date];
        const manualWorkouts = dayEntries.filter(hasStrengthExercises);
        const watchOnly = dayEntries.filter(wk => !hasStrengthExercises(wk) && isWatchOnlyWorkout(wk));
        const otherEntries = dayEntries.filter(wk => !hasStrengthExercises(wk) && !isWatchOnlyWorkout(wk));
        const usedWatch = new Set();

        manualWorkouts.forEach(manual => {
            const likelyStrengthWatch = watchOnly.find(wk => {
                const label = `${wk.name || ''} ${wk.type || ''}`.toLowerCase();
                return !usedWatch.has(wk) && (
                    label.includes('weight') ||
                    label.includes('workout') ||
                    label.includes('strength') ||
                    label.includes('training')
                );
            });

            const pairedWatch = likelyStrengthWatch || watchOnly.find(wk => !usedWatch.has(wk) && !isCardioWorkout(wk));
            const watchActivities = watchOnly
                .filter(wk => wk === pairedWatch)
                .map(normalizeWatchMetrics)
                .filter(Boolean);

            if (pairedWatch) usedWatch.add(pairedWatch);

            paired.push({
                ...manual,
                __sourceIndex: sourceWorkouts.indexOf(manual),
                watchData: watchActivities[0] || manual.watchData || null,
                watchActivities
            });
        });

        watchOnly.forEach(wk => {
            if (!usedWatch.has(wk)) {
                paired.push(wk);
            }
        });

        paired.push(...otherEntries);
    });

    return paired;
}

function renderReports() {
    const statsContainer = document.getElementById('report-summary');
    const monthContainer = document.getElementById('monthly-breakdown');
    const exListContainer = document.getElementById('exercise-breakdown-list');
    if (!statsContainer || !monthContainer || !exListContainer) return;

    let lifetimeVolume = 0;
    let totalMiles = 0;
    let totalMinutes = 0;
    const monthlyCount = {};
    const exerciseData = {}; 
    const uniqueSessions = new Set();

    const currentYear = new Date().getFullYear();

    const pairedWorkouts = pairWorkoutsWithWatchData(workouts);

    pairedWorkouts.forEach(wk => {
        if (!wk.date || !wk.date.startsWith(currentYear)) return;

        const metrics = normalizeWatchMetrics(wk);
        const category = hasStrengthExercises(wk) ? `strength-${wk.name || 'workout'}` : `cardio-${wk.name || 'activity'}`;
        const sessionKey = `${wk.date}-${category}`;
        uniqueSessions.add(sessionKey);

        let dateObj = new Date(wk.date);
        if (isNaN(dateObj.getTime()) && wk.date.includes('-')) {
            const parts = wk.date.split('-');
            dateObj = new Date(parts[0], parts[1] - 1, parts[2]);
        }

        const y = dateObj.getFullYear() || 2026;
        const m = String(dateObj.getMonth() + 1).padStart(2, '0');
        const monthKey = `${y}-${m}`; 

        if (!monthlyCount[monthKey]) monthlyCount[monthKey] = new Set();
        monthlyCount[monthKey].add(sessionKey);

        if (metrics.distance > 0) {
            totalMiles += metrics.distance;
        }

        if (metrics.duration > 0) {
            totalMinutes += metrics.duration;
        } else if (wk.duration) {
            totalMinutes += parseInt(wk.duration);
        }


        if (hasStrengthExercises(wk)) {
            wk.exercises.forEach(ex => {
                const cleanName = ex.name;
                if (!exerciseData[cleanName]) {
                    exerciseData[cleanName] = { count: 0, best1RM: 0, totalVol: 0, rirSum: 0, rirCount: 0 };
                }
                
                let dailyVol = 0;
                let dailyMax1RM = 0;

                (ex.sets || []).forEach(s => {
                    const w = String(s.weight).toLowerCase().includes('bw') || String(s.weight).toLowerCase().includes('bodyweight') ? 0 : (parseFloat(s.weight) || 0);
                    const r = parseInt(s.reps) || 0;
                    dailyVol += (w * r);
                    
                    if (r > 0 && w > 0) {
                        const est = w * (36 / (37 - Math.min(r, 36)));
                        if (est > dailyMax1RM) dailyMax1RM = est;
                    }

                    if (s.rir !== undefined && s.rir !== null && s.rir !== "") {
                        exerciseData[cleanName].rirSum += parseFloat(s.rir);
                        exerciseData[cleanName].rirCount++;
                    }
                });

                exerciseData[cleanName].count++;
                exerciseData[cleanName].totalVol += dailyVol;
                if (dailyMax1RM > exerciseData[cleanName].best1RM) exerciseData[cleanName].best1RM = dailyMax1RM;
                lifetimeVolume += dailyVol;
            });
        }
    });

    statsContainer.innerHTML = `
        <div style="background: #007aff; color: white; padding: 15px; border-radius: 12px; text-align: center;">
            <div style="font-size: 1.8em; font-weight: bold;">${uniqueSessions.size}</div>
            <div style="font-size: 0.8em; opacity: 0.9;">Total Sessions</div>
        </div>
        <div style="background: #FC6100; color: white; padding: 15px; border-radius: 12px; text-align: center;">
            <div style="font-size: 1.4em; font-weight: bold;">${totalMiles.toFixed(1)} mi</div>
            <div style="font-size: 0.8em; opacity: 0.9;">Total Distance</div>
        </div>
        <div style="background: #5856d6; color: white; padding: 15px; border-radius: 12px; text-align: center;">
            <div style="font-size: 1.4em; font-weight: bold;">${(lifetimeVolume / 1000).toFixed(1)}k lbs</div>
            <div style="font-size: 0.8em; opacity: 0.9;">Lifting Volume</div>
        </div>
        <div style="background: #34c759; color: white; padding: 15px; border-radius: 12px; text-align: center;">
            <div style="font-size: 1.4em; font-weight: bold;">${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m</div>
            <div style="font-size: 0.8em; opacity: 0.9;">Time Active</div>
        </div>
    `;

    renderCalendar();

    const sortedMonths = Object.keys(monthlyCount).sort().reverse();
    monthContainer.innerHTML = sortedMonths.map(monthStr => {
        const [year, monthNum] = monthStr.split('-');
        const d = new Date(year, monthNum - 1);
        const name = d.toLocaleString('default', { month: 'long' });
        return `<div onclick="jumpCalendar(${year}, ${parseInt(monthNum)-1})" style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px solid #333; cursor:pointer;">
            <span style="font-weight:900; letter-spacing:0.5px; font-size:1.1em; color:#ffffff;">${name} ${year}</span>
            <div style="display:flex; align-items:center; gap:10px;">
                <strong style="font-size:1.1em; color:#ffffff;">${monthlyCount[monthStr].size} sessions</strong>
                <span style="color:#ff5e00; font-size:1.1em;">›</span>
            </div>
        </div>`;
    }).join('') || '<p style="text-align:center; padding:20px; color:#aaa;">No month data found.</p>';

    const sortedExercises = Object.keys(exerciseData).sort((a, b) => exerciseData[b].totalVol - exerciseData[a].totalVol);
    const neonColors = ['#ff107a', '#b026ff', '#00e5ff', '#39ff14', '#ff5e00', '#007aff'];

    exListContainer.innerHTML = sortedExercises.map((name, idx) => {
        const data = exerciseData[name];
        const display1RM = data.best1RM > 0 ? `${Math.round(data.best1RM)} lbs` : "N/A (BW)";
        
        const avgRIR = data.rirCount > 0 ? (data.rirSum / data.rirCount).toFixed(1) : null;
        const rirBadge = avgRIR !== null ? 
            `<span style="font-size: 0.7em; color: #ff5e00; background: rgba(255, 94, 0, 0.1); border: 1px solid rgba(255, 94, 0, 0.3); padding: 2px 8px; border-radius: 10px; margin-left:8px; vertical-align: middle; text-shadow: none;">Avg RIR: ${avgRIR}</span>` : '';

        // Dynamic neon theme alternating for the cards
        const themeColor = neonColors[idx % neonColors.length];

        // NEW: 1 RIR Projections Grid
        let projectionsHTML = '';
        if (data.best1RM > 0) {
            const p3 = Math.round(data.best1RM * 0.86); 
            const p5 = Math.round(data.best1RM * 0.82); 
            const p8 = Math.round(data.best1RM * 0.76); 
            const p10 = Math.round(data.best1RM * 0.71); 

            // Fixed columns colors for consistent 1 RIR targets grid
            const c3 = { bg: 'rgba(255, 16, 122, 0.15)', border: '#ff107a', text: '#ff107a' }; // Pink
            const c5 = { bg: 'rgba(176, 38, 255, 0.15)', border: '#b026ff', text: '#b026ff' }; // Purple
            const c8 = { bg: 'rgba(0, 122, 255, 0.15)', border: '#007aff', text: '#4da6ff' }; // Blue
            const c10 = { bg: 'rgba(0, 229, 255, 0.15)', border: '#00e5ff', text: '#00e5ff' }; // Cyan

            projectionsHTML = `
                <div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.1);">
                    <div style="font-size: 0.75em; color: ${themeColor}; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 1px; text-shadow: 0 0 5px ${themeColor}60;">1 RIR Targets</div>
                    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; text-align: center;">
                        <div style="background: ${c3.bg}; border: 1px solid ${c3.border}50; border-radius: 8px; padding: 8px; box-shadow: inset 0 2px 8px ${c3.border}30;">
                            <div style="font-size: 0.7em; color: ${c3.text}; margin-bottom:2px; text-shadow: 0 0 5px ${c3.text}60;">3 Reps</div>
                            <strong style="font-size: 1.1em; color: #fff; text-shadow: 0 0 8px ${c3.border}, 1px 1px 2px #000;">${p3}</strong>
                        </div>
                        <div style="background: ${c5.bg}; border: 1px solid ${c5.border}50; border-radius: 8px; padding: 8px; box-shadow: inset 0 2px 8px ${c5.border}30;">
                            <div style="font-size: 0.7em; color: ${c5.text}; margin-bottom:2px; text-shadow: 0 0 5px ${c5.text}60;">5 Reps</div>
                            <strong style="font-size: 1.1em; color: #fff; text-shadow: 0 0 8px ${c5.border}, 1px 1px 2px #000;">${p5}</strong>
                        </div>
                        <div style="background: ${c8.bg}; border: 1px solid ${c8.border}50; border-radius: 8px; padding: 8px; box-shadow: inset 0 2px 8px ${c8.border}30;">
                            <div style="font-size: 0.7em; color: ${c8.text}; margin-bottom:2px; text-shadow: 0 0 5px ${c8.text}60;">8 Reps</div>
                            <strong style="font-size: 1.1em; color: #fff; text-shadow: 0 0 8px ${c8.border}, 1px 1px 2px #000;">${p8}</strong>
                        </div>
                        <div style="background: ${c10.bg}; border: 1px solid ${c10.border}50; border-radius: 8px; padding: 8px; box-shadow: inset 0 2px 8px ${c10.border}30;">
                            <div style="font-size: 0.7em; color: ${c10.text}; margin-bottom:2px; text-shadow: 0 0 5px ${c10.text}60;">10 Reps</div>
                            <strong style="font-size: 1.1em; color: #fff; text-shadow: 0 0 8px ${c10.border}, 1px 1px 2px #000;">${p10}</strong>
                        </div>
                    </div>
                </div>
            `;
        }

        return `
            <div class="exercise" style="margin-bottom: 16px; padding: 16px; background: #1c1c1e !important; border-radius: 12px; border: 1px solid ${themeColor} !important; box-shadow: 0 8px 25px rgba(0,0,0,0.6), 0 0 12px ${themeColor}40 !important; border-left: 4px solid ${themeColor} !important;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 8px;">
                    <strong style="font-size: 1.2em; color: ${themeColor}; text-shadow: 0 0 8px ${themeColor}60, 1px 1px 2px #000;">${name} ${rirBadge}</strong>
                    <span style="font-size: 0.8em; color: #ccc; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1); padding: 4px 10px; border-radius: 12px;">${data.count} sessions</span>
                </div>
                <div style="display:flex; justify-content:space-between; font-size: 0.95em; color: #ddd; background: rgba(0,0,0,0.2); padding: 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.05);">
                    <span>Est. 1RM: <strong style="color: #fff; text-shadow: 1px 1px 2px #000;">${display1RM}</strong></span>
                    <span>Total Vol: <strong style="color: #fff; text-shadow: 1px 1px 2px #000;">${(data.totalVol / 1000).toFixed(1)}k lbs</strong></span>
                </div>
                ${projectionsHTML}
            </div>
        `;
    }).join('') || '<p style="text-align:center; padding:20px; color:#999;">No exercise data found.</p>';
}


function renderTemplates() {
    const list = document.getElementById('template-list');
    list.innerHTML = '';
    
    templates.forEach((tmpl, idx) => {
        const div = document.createElement('div');
        div.className = 'exercise';
        
        // Creates the list of exercises or a fallback message
        const exercisePreview = tmpl.exercises.length > 0 
            ? tmpl.exercises.map(ex => ex.name).join(', ') 
            : '<em>No exercises added yet</em>';

        // Apply dynamic neon theme colors based on template name
        const themeColor = getWorkoutColor({ name: tmpl.name });
        div.style.setProperty('border', `1px solid ${themeColor}`, 'important');
        div.style.setProperty('box-shadow', `0 8px 25px rgba(0,0,0,0.6), 0 0 12px ${themeColor}40`, 'important');
        div.style.setProperty('border-left', `4px solid ${themeColor}`, 'important');

        div.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
                <strong style="font-size: 1.3em; color:${themeColor}; text-shadow: 0 0 8px ${themeColor}60, 1px 1px 2px #000; letter-spacing: 0.5px;">${tmpl.name}</strong>
                <div style="display: flex; gap: 5px;">
                    <button onclick="renameTemplate(${idx})" style="background:rgba(255,255,255,0.1) !important; color:#fff !important; border:1px solid rgba(255,255,255,0.2) !important; box-shadow:none !important; border-bottom:1px solid rgba(255,255,255,0.2) !important; width:auto; font-size:12px; padding:6px 10px; border-radius:8px; text-shadow:none !important;">Rename</button>
                    <button onclick="deleteTemplate(${idx})" style="background:rgba(255,59,48,0.1) !important; color:#ff3b30 !important; border:1px solid rgba(255,59,48,0.3) !important; box-shadow:none !important; border-bottom:1px solid rgba(255,59,48,0.3) !important; width:auto; font-size:12px; padding:6px 10px; border-radius:8px; text-shadow:none !important;">Delete</button>
                </div>
            </div>
            
            <div style="margin-bottom: 15px; font-size: 0.95em; color: #bbb; line-height: 1.4; font-style: italic;">
                ${exercisePreview}
            </div>

            <div style="display: flex; gap: 10px;">
                <button onclick="editTemplate(${idx})" style="flex: 1; padding: 10px; font-size: 14px; background: linear-gradient(145deg, #2a2a2e, #1c1c1e) !important; color: ${themeColor} !important; border: 1px solid ${themeColor}80 !important; border-bottom: 3px solid ${themeColor}80 !important; text-shadow: 1px 1px 2px #000 !important;">Edit</button>
                <button onclick="startFromTemplateByIndex(${idx})" style="flex: 1; padding: 10px; font-size: 14px; background: linear-gradient(145deg, ${themeColor}, ${themeColor}cc) !important; color: #fff !important; border: 1px solid ${themeColor} !important; border-bottom: 3px solid ${themeColor}80 !important; text-shadow: 1px 1px 2px #000 !important;">Start Workout</button>
            </div>
        `;
        list.appendChild(div);
    });
}

function cancelCurrentWorkout() {
    const hasData = currentWorkout && currentWorkout.exercises.some(ex => 
        ex.sets.some(s => s.reps > 0 || s.weight > 0)
    );

    if (hasData && !confirm("Are you sure? This will delete your progress.")) {
        return;
    }

    // 1. Clear the storage
    localStorage.removeItem('active_workout_backup');

    // 2. Clear the variable
    currentWorkout = null;

    // 3. WIPE THE HTML so the old workout isn't visible anymore
    document.getElementById('active-workout').innerHTML = '';

    // 4. SHOW THE PICKER so you can start a new one
    const picker = document.getElementById('template-picker-area');
    if (picker) picker.style.display = 'block';

    // 5. Go back
    showSection('templates');
}

function renameTemplate(idx) {
    const name = prompt("New name:", templates[idx].name);
    if (name) { templates[idx].name = name; saveTemplates(); renderTemplates(); }
}



function renderEditingTemplate() {
    const container = document.getElementById('edit-template-content');
    if (!container) return;
    container.innerHTML = '';
    const tmpl = templates[currentEditingTemplateIndex];
    
    tmpl.exercises.forEach((ex, exIdx) => {
        const div = document.createElement('div');
        div.className = 'exercise';
        div.innerHTML = `
            <strong>${ex.name}</strong>
            <button onclick="removeExerciseFromTemplate(${exIdx})" style="float:right; background:#ff3b30;">Remove</button>
            <div id="tmpl-sets-${exIdx}"></div>
            <button onclick="addSetToTemplateExercise(${exIdx})">+ Set</button>
        `;
        container.appendChild(div);
        
        const setsDiv = document.getElementById(`tmpl-sets-${exIdx}`);
        ex.sets.forEach((set, setIdx) => {
            setsDiv.innerHTML += `<div>Set ${setIdx+1}: <input type="number" value="${set.reps}" onchange="updateTemplateSet(${exIdx},${setIdx},'reps',this.value)"></div>`;
        });
    });
}

function updateTemplateSet(e, s, f, v) { templates[currentEditingTemplateIndex].exercises[e].sets[s][f] = parseInt(v) || 0; }
function addSetToTemplateExercise(i) { templates[currentEditingTemplateIndex].exercises[i].sets.push({reps:8, weight:0}); renderEditingTemplate(); }
function removeExerciseFromTemplate(i) { templates[currentEditingTemplateIndex].exercises.splice(i, 1); renderEditingTemplate(); }

function startFromTemplateByIndex(idx) {
    currentWorkout = JSON.parse(JSON.stringify(templates[idx]));
    const d = new Date();
    currentWorkout.date = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;

    currentWorkout.exercises.forEach(ex => {
        // If the template has a target, create that many empty rows
        const count = ex.target_sets || 0;
        const reps = ex.target_reps || 0;
        
        // Reset the sets array so we start fresh with the targets
        ex.sets = []; 
        
        for (let i = 0; i < count; i++) {
            ex.sets.push({ reps: reps, weight: '' });
        }
    });

    showSection('log');
    renderActiveWorkout();
}

function renderActiveWorkout() {
    const container = document.getElementById('active-workout');
    if (!container || !currentWorkout) return;

    container.innerHTML = `<h3>${currentWorkout.name} - ${currentWorkout.date}</h3>`;

        currentWorkout.exercises.forEach((ex, exIdx) => {
        const lastWorkout = getLastWorkoutForExercise(ex.name);
        
        let placeholderText = "Add a note (e.g. 'felt heavy')";
        let lastTimeHTML = '';
        
        if (lastWorkout && lastWorkout.sets) {
            // Format date from YYYY-MM-DD to m/d/yy (no leading zeros)
            let formattedDate = lastWorkout.date;
            const parts = lastWorkout.date.split('-');
            if (parts.length === 3) {
                const m = parseInt(parts[1], 10);
                const d = parseInt(parts[2], 10);
                formattedDate = `${m}/${d}/${parts[0].slice(-2)}`;
            }
            
            const setDetailsHTML = lastWorkout.sets.map(s => {
                const wStr = String(s.weight).toUpperCase();
                const displayWeight = (wStr === 'BW' || wStr === '0') ? 'BW' : s.weight;
                return `<div>${displayWeight}x${s.reps}</div>`;
            }).join('');
            
            lastTimeHTML = `
                <div style="color: black; margin-bottom: 12px; font-size: 0.95em; line-height: 1.4;">
                    <div>Last Time (${formattedDate})</div>
                    ${setDetailsHTML}
                </div>
            `;
        }

        const div = document.createElement('div');
        div.className = 'exercise';

        div.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                <strong style="font-size: 1.2em;">${ex.name}</strong>
                <button onclick="removeExerciseFromActive(${exIdx})" 
                        style="width: auto; background: #ff3b30; color: white; border: none; 
                       font-size: 0.7em; padding: 4px 10px; border-radius: 12px; 
                       cursor: pointer; font-weight: bold;">Delete</button>
            </div>

            ${lastTimeHTML}

            <textarea 
                placeholder="${placeholderText}" 
                oninput="updateActiveNote(${exIdx}, this.value)"
                style="width: 100%; margin-bottom: 15px; border: 1px solid #ddd; border-radius: 8px; padding: 8px; font-family: inherit; font-size: 14px; box-sizing: border-box;">${ex.note || ''}</textarea>

            <div id="sets-${exIdx}"></div>
            <button onclick="addSet(${exIdx})">+ Set</button>
        `;

        container.appendChild(div);

        const setsDiv = document.getElementById(`sets-${exIdx}`);
        ex.sets.forEach((set, setIdx) => {
            const targetReps = parseInt(set.reps) || ex.target_reps || 10;
            
            // Server-stored 45-day estimated 1RM for light-grey suggestion
            const estimatedOneRM = getEstimated1RM(ex.name);
            const suggested = estimatedOneRM 
                ? Math.round(estimatedOneRM / (1 + targetReps / 30)) 
                : null;

            const row = document.createElement('div');
            row.style.marginBottom = "8px";
            row.innerHTML = `
                <span style="font-size: 0.9em; color: #666; margin-right: 5px;">Set ${setIdx+1}</span>
                <input type="text" 
                       id="weight-input-${exIdx}-${setIdx}"
                       placeholder="${suggested || 'lbs'}" 
                       value="${set.weight || ''}" 
                       oninput="updateSet(${exIdx},${setIdx},'weight',this.value)" 
                       style="width:70px; padding: 8px; border: 1px solid #ddd; border-radius: 6px; text-align: center; 
                              ${!set.weight ? 'color: #888;' : ''}">
                <span style="margin:0 4px; color:#666;">lbs</span>
                <input type="number" 
                       placeholder="reps" 
                       value="${set.reps||''}" 
                       oninput="updateSet(${exIdx},${setIdx},'reps',this.value)" 
                       style="width:55px; padding: 8px; border: 1px solid #ddd; border-radius: 6px; text-align: center;">
                <button onclick="removeSet(${exIdx},${setIdx})" 
                        style="width:auto; background:#ff3b30; padding: 8px 12px; margin-left: 5px;">-</button>
            `;
            setsDiv.appendChild(row);
        });
    });

    // Add exercise button
    const addExBtn = document.createElement('div');
    addExBtn.innerHTML = `
        <hr style="margin: 20px 0;">
        <button onclick="addNewExerciseToActive()" style="width: 100%; background: #007aff; padding: 15px;">+ Add Exercise</button>
    `;
    container.appendChild(addExBtn);
}

function addNewExerciseToActive() {
    const name = prompt("Enter exercise name:");
    if (!name) return;
    
    currentWorkout.exercises.push({
        name: name,
        sets: [{reps: 10, weight: ''}] // Start with one predicted set
    });
    
    // Save to backup immediately so it's crash-proof
    localStorage.setItem('active_workout_backup', JSON.stringify(currentWorkout));
    
    renderActiveWorkout();
}

function updateSet(e, s, f, v) { 
    const exercise = currentWorkout.exercises[e];
    const set = exercise.sets[s];

    if (f === 'weight') {
        set[f] = v.toLowerCase() === 'bw' ? 'BW' : parseFloat(v) || 0;
    } else if (f === 'reps') {
            const newReps = parseInt(v) || 0;
            set[f] = newReps;
            
            // Auto-update the suggested weight placeholder
            const weightInput = document.getElementById(`weight-input-${e}-${s}`);
            if (weightInput) {
                const estimatedOneRM = getEstimated1RM(exercise.name);
                if (estimatedOneRM && newReps > 0) {
                    weightInput.placeholder = Math.round(estimatedOneRM / (1 + newReps / 30));
                } else {
                    weightInput.placeholder = 'lbs';
                }
            }
    }

    // Save backup
    localStorage.setItem('active_workout_backup', JSON.stringify(currentWorkout));
}


function updateActiveNote(exIdx, val) {
    if (currentWorkout && currentWorkout.exercises[exIdx]) {
        currentWorkout.exercises[exIdx].note = val;
        // Save to phone backup immediately so notes aren't lost if Safari refreshes
        localStorage.setItem('active_workout_backup', JSON.stringify(currentWorkout));
    }
}

function addSet(i) { 
    const ex = currentWorkout.exercises[i];
    const reps = ex.target_reps || 10;
    ex.sets.push({reps: reps, weight: ''}); 
    renderActiveWorkout(); 
}
function removeSet(e, s) { currentWorkout.exercises[e].sets.splice(s, 1); renderActiveWorkout(); }

async function finishWorkout() {
    if (!currentWorkout || currentWorkout.exercises.length === 0) return;

    if (confirm("Finish and Save workout to Pi?")) {
        showStatus("Syncing to T7 SSD...", "info");

        // 1. Send to Pi
        const savedToPi = await saveWorkoutToPi(currentWorkout);

        if (savedToPi) {
            // 2. Clear local backup ONLY if Pi confirmed save
            localStorage.removeItem('active_workout_backup');
            currentWorkout = null;
            document.getElementById('active-workout').innerHTML = '';
            
            // 3. Clear local array and pull fresh from Pi to ensure no duplicates
            workouts = []; 
            await syncFromPi(); 
            showSection('history');
        } else {
            let pending = JSON.parse(localStorage.getItem('pending_sync')) || [];
            pending.push(currentWorkout); 
            localStorage.setItem('pending_sync', JSON.stringify(pending));

            // Cleanup the active session
            localStorage.removeItem('active_workout_backup');
            currentWorkout = null;
            document.getElementById('active-workout').innerHTML = '';
            
            showStatus("⚠️ Offline. Saved to Pending Mailbox.", "error");
            
            // Re-render history so you can see your mirrored data
            renderHistory();
            showSection('history');
        }
    }
}

function startEmptyWorkout() {
    // 1. Ask for the workout name right away
    let workoutName = prompt("Enter a name for this workout:", "New Workout");
    
    // 2. If they hit cancel, don't start the workout at all
    if (workoutName === null) return; 

    // 3. Fallback to "New Workout" if they leave it blank
    if (workoutName.trim() === "") workoutName = "New Workout";

    const d = new Date();
    currentWorkout = {
        name: workoutName,
        date: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,
        exercises: []
    };
    
    // 4. Save to backup immediately in case of refresh
    localStorage.setItem('active_workout_backup', JSON.stringify(currentWorkout));

    document.getElementById('template-picker-area').style.display = 'none';
    renderActiveWorkout();
}

function addExerciseToTemplate() {
    const nameInput = document.getElementById('template-exercise-name');
    const muscleInput = document.getElementById('template-exercise-muscle');

    const setsInput = document.getElementById('template-sets');
    const repsInput = document.getElementById('template-reps');

    const name = nameInput.value.trim();
    const muscle = muscleInput.value.trim(); 
    if (!name) {
        alert("Please enter an exercise name.");
        return;
    }
    // Add to our temporary array for the template being built
    currentTemplateExercises.push({
        name: name,
        muscleGroup: muscle,
        target_sets: parseInt(setsInput.value) || 3, // Changed to use the variable
        target_reps: parseInt(repsInput.value) || 10, // Changed to use the variable
        note: "", 
        sets: []  
    });

    // Clear inputs for the next exercise
    nameInput.value = '';
    muscleInput.value = '';
    if (setsInput) setsInput.value = ''; // Clean up
    if (repsInput) repsInput.value = ''; // Clean up

    renderTemplateExerciseList();
}

function renderTemplateExerciseList() {
    const container = document.getElementById('template-exercises-list');
    if (!container) return;

    container.innerHTML = currentTemplateExercises.map((ex, index) => `
        <div style="display: flex; justify-content: space-between; align-items: center; background: #1c1c1e; padding: 12px 14px; margin-bottom: 8px; border-radius: 10px; border: 1px solid; border-image: linear-gradient(135deg, #39ff14, #ff107a, #b026ff, #ff5e00) 1; box-shadow: 0 2px 8px rgba(0,0,0,0.4);">
            <span style="color: #e0e0e0;"><strong style="color: #fff;">${ex.name}</strong> <span style="color: #888; font-size: 0.9em;">(${ex.muscleGroup || 'General'})</span></span>
            <button onclick="removeExerciseFromNewTemplate(${index})" style="background: none !important; color: #ff3b30 !important; width: auto; padding: 4px 8px !important; border: none !important; box-shadow: none !important; font-size: 1.1em; min-width: 0;">✕</button>
        </div>
    `).join('');
}

async function deleteWorkout(date, name) {
    if (!confirm(`Permanently delete ${name} from ${date}?`)) return;

    try {
        const response = await fetch(`/api/workouts?date=${encodeURIComponent(date)}&name=${encodeURIComponent(name)}`, {
            method: 'DELETE',
            headers: getAuthHeader()
        });

        if (response.ok) {
            workouts = workouts.filter(wk => !(wk.date === date && wk.name === name));
            localStorage.setItem('workouts', JSON.stringify(workouts));
            renderHistory(); 
            console.log(`✅ Deleted ${name} on ${date}`);
        } else {
            console.error("Pi rejected delete:", response.status);
            // Try a more lenient delete as fallback (name contains)
            const fallbackRes = await fetch(`/api/workouts?date=${encodeURIComponent(date)}`, {
                method: 'DELETE',
                headers: getAuthHeader()
            });
            if (fallbackRes.ok) {
                workouts = workouts.filter(wk => wk.date !== date);
                localStorage.setItem('workouts', JSON.stringify(workouts));
                renderHistory();
                alert("Deleted all workouts on that date (Strava duplicate cleaned).");
            } else {
                alert("Could not delete from Pi. Check Pi connection.");
            }
        }
    } catch (err) {
        console.error("Delete error:", err);
        alert("Could not delete from Pi. Check Pi connection.");
    }
}

// Helper to remove exercises from the list before you hit "Save"
function removeExerciseFromNewTemplate(index) {
    currentTemplateExercises.splice(index, 1);
    renderTemplateExerciseList();
}

function deleteTemplate(idx) {
    if (confirm("Are you sure you want to delete this template?")) {
        templates.splice(idx, 1);
        localStorage.setItem('templates', JSON.stringify(templates));
        saveTemplates();
        renderTemplates();
        console.log("Template deleted and SSD update triggered.");
    }
}

async function renameHistoryItem(idx) {
    const oldName = workouts[idx].name;
    const date = workouts[idx].date;
    const newName = prompt("Enter new name for this workout:", oldName);

    if (newName && newName !== oldName) {
        // 1. Update locally first
        workouts[idx].name = newName;
        localStorage.setItem('workouts', JSON.stringify(workouts));

        // 2. Sync the change to the Pi
        try {
            const response = await fetch('/rename-workout', {   // Use consistent path
                method: 'POST',
                headers: { 
                    'Content-Type': 'application/json',
                    ...getAuthHeader()     // ← This was missing
                },
                body: JSON.stringify({ date, oldName, newName })
            });

            if (response.ok) {
                console.log("Rename synced to Pi");
                renderHistory();
            } else {
                console.error("Rename failed on Pi:", response.status);
            }
        } catch (err) {
            console.error("Rename sync failed:", err);
        }
    }
}

function deleteHistoryItem(i) {
    if(confirm("Delete?")) {
        const wk = workouts[i];

        // NEW: Tell the Pi to delete this specific record
        fetch(`/api/workouts?date=${encodeURIComponent(wk.date)}&name=${encodeURIComponent(wk.name)}`, {
            method: 'DELETE',
            headers: getAuthHeader()
        });

        workouts.splice(i, 1);
        saveWorkouts();
        renderHistory();
    }
}

async function processCSVRows(rows) {
    const workoutMap = new Map();

    rows.forEach((row, index) => {
        const trimmed = row.trim();
        if (!trimmed || trimmed.toLowerCase().includes('date')) return;

        const cols = trimmed.split(',').map(c => c.trim());
        if (cols.length < 5) return;

        const dateStr = cols[0]; 
        const name = cols[1];
        const reps = cols[3];
        const weight = cols[4];
        const cleanName = name.replace(/\s*\(.*?\)\s*/g, ' ').replace(/'/g, '').trim();

        if (!workoutMap.has(dateStr)) {
            // CRITICAL: We use 'Imported Workout' consistently so the sync can find it
            workoutMap.set(dateStr, { name: "Imported Workout", date: dateStr, exercises: [] });
        }

        const workout = workoutMap.get(dateStr);
        let ex = workout.exercises.find(e => e.name === cleanName);
        if (!ex) {
            ex = { name: cleanName, sets: [] };
            workout.exercises.push(ex);
        }
        const weightVal = (weight.toLowerCase().includes('bodyweight') || weight.toLowerCase() === 'bw') ? 'BW' : (parseFloat(weight) || 0);
        ex.sets.push({ weight: weightVal, reps: parseInt(reps) || 0 });
    });

        const finalWorkouts = Array.from(workoutMap.values()).filter(wk => wk.exercises.length > 0);
    
    // Better duplicate checking - only skip if exact same date AND same name
    const existingKeys = new Set(workouts.map(wk => `${wk.date}-${wk.name || 'Unnamed'}`));
    
    const trulyNew = finalWorkouts.filter(nw => {
        const key = `${nw.date}-${nw.name || 'Unnamed'}`;
        return !existingKeys.has(key);
    });

    if (trulyNew.length > 0) {
        workouts = [...workouts, ...trulyNew];
        saveWorkouts();

        showStatus(`Adding ${trulyNew.length} new imported workouts...`, "info");

        for (const wk of trulyNew) {
            await saveWorkoutToPi(wk);
        }

        alert(`Successfully added ${trulyNew.length} new workout days from CSV.`);
        await syncFromPi(); 
    } else {
        alert("No new unique workouts found to import.\n\nAll dates already exist in history.");
    }
    
    location.reload();
}

// Helper to assign neon theme colors based on workout name
function getWorkoutColor(wk) {
    const wkName = (wk.name || "").toLowerCase();
    if (isCardioWorkout(wk) && !hasStrengthExercises(wk)) return '#ff5e00'; // Neon Orange
    if (wkName.includes('chest')) return '#ff107a'; // Neon Pink
    if (wkName.includes('leg')) return '#b026ff'; // Neon Purple
    if (wkName.includes('back') && !wkName.includes('chest')) return '#39ff14'; // Neon Green
    if (wkName.includes('shoulder') || wkName.includes('bis') || wkName.includes('bicep') || wkName.includes('tri') || wkName.includes('arm')) return '#00e5ff'; // Neon Cyan
    return '#007aff'; // Default Neon Blue
}

function filterHistory(category) {
    const searchInput = document.getElementById('history-search');
    if (searchInput) {
        searchInput.value = category;   // Keep your existing logic
    }
    renderHistory();   // This will re-render with the filter
}

function renderHistory() {
    const container = document.getElementById('workout-history');
    const searchInput = document.getElementById('history-search');
    const term = searchInput ? searchInput.value.toLowerCase() : "";
    
    if (!container) return;

    if (!Array.isArray(workouts)) workouts = [];
    workouts.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    const userWorkouts = pairWorkoutsWithWatchData(workouts);

    // Get filter from dropdown
        // Get filter from dropdown
    const filterSelect = document.getElementById('history-filter');
    const selectedCategory = filterSelect ? filterSelect.value.toLowerCase() : "";

    const filtered = userWorkouts.filter(wk => {
        if (!selectedCategory) return true; // All

        const wkName = (wk.name || "Unnamed Workout").toLowerCase();

        if (selectedCategory === "cardio") {
            return (wk.type === 'cardio' || wk.distance > 0) && (!wk.exercises || wk.exercises.length === 0);
        }

        if (selectedCategory === "shoulders") {
            return wkName.includes("shoulder") || wkName.includes("bis") || wkName.includes("bicep");
        }

        if (selectedCategory === "back") {
            return wkName.includes("back") && !wkName.includes("chest");
        }

        if (selectedCategory === "chest") {
            return wkName.includes("chest");
        }

        if (selectedCategory === "legs") {
            return wkName.includes("leg");
        }

        // Default fallback
        return wkName.includes(selectedCategory);
    });

    container.innerHTML = '';
    
    if (filtered.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:#666;">No results found.</p>`;
        return;
    }

    filtered.forEach((wk) => {
        const idx = Number.isInteger(wk.__sourceIndex) ? wk.__sourceIndex : workouts.indexOf(wk);
        const div = document.createElement('div');
        div.className = 'exercise';
        
        const isCardio = isCardioWorkout(wk) && !hasStrengthExercises(wk);
        
        // Apply dynamic neon theme colors, borders, and shadows to the card
        const themeColor = getWorkoutColor(wk);
        div.style.setProperty('border', `1px solid ${themeColor}`, 'important');
        div.style.setProperty('box-shadow', `0 8px 25px rgba(0,0,0,0.6), 0 0 12px ${themeColor}40`, 'important');
        div.style.setProperty('border-left', `4px solid ${themeColor}`, 'important');
        
        const metrics = normalizeWatchMetrics(wk);

        const cardioStats = renderWatchMetricGrid(metrics, isCardio);

        const exHTML = (wk.exercises || []).map(ex => {
            const noteHTML = ex.note ? `<div style="color:#888; font-style:italic; font-size:12px; margin-top:4px;">📝 ${ex.note}</div>` : '';
            
            // Upgrade sets string into clean, dimmed out readable pills
            const setsHTML = (ex.sets || []).map(s => {
                const wStr = String(s.weight).toUpperCase();
                const displayWeight = (wStr === 'BW' || wStr === '0') ? 'BW' : s.weight + 'lbs';
                return `<span style="display:inline-block; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.1); padding:3px 8px; border-radius:6px; margin:3px 4px 0 0; font-size:12px; color:#ccc; text-shadow: 1px 1px 1px #000;">${displayWeight} × ${s.reps}</span>`;
            }).join('');

            return `
                <div style="margin-bottom:12px;">
                    <strong style="color:#fff; letter-spacing:0.5px;">${ex.name || "Unknown"}</strong> 
                    ${noteHTML}
                    <div style="margin-top:4px;">
                        ${setsHTML}
                    </div>
                </div>`;
        }).join('');

        div.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <div>
                    <h3 onclick="renameHistoryItem(${idx})" style="color:${themeColor}; text-shadow: 0 0 8px ${themeColor}60, 1px 1px 2px #000; cursor:pointer; margin:0; font-size: 1.3em;">${wk.name || "Unnamed Workout"} ✏️</h3>
                    <small style="color:#888;">${wk.date || "No Date"}</small>
                </div>
                <button onclick="deleteWorkout('${wk.date}', '${wk.name}')" style="background:rgba(255,59,48,0.1) !important; color:#ff3b30 !important; border:1px solid rgba(255,59,48,0.3) !important; box-shadow:none !important; border-bottom:1px solid rgba(255,59,48,0.3) !important; width:auto; font-size:12px; padding:6px 10px; border-radius:8px; text-shadow:none !important;">Delete</button>
            </div>
            <hr style="border:0; border-top:1px solid #333; margin:12px 0;">
            ${cardioStats}
            ${exHTML}
        `;
        container.appendChild(div);
    });
}

// Fixes the "cancelEditTemplate is not defined" error
function cancelEditTemplate() {
    showSection('templates');
}

// Fixes the "populateTemplateSelect is not defined" error
function populateTemplateSelect() {
    const select = document.getElementById('template-select');
    if (!select) return;
    
    select.innerHTML = '<option value="">-- Choose a Template --</option>';
    templates.forEach((tmpl, idx) => {
        const opt = document.createElement('option');
        opt.value = idx;
        opt.textContent = tmpl.name;
        select.appendChild(opt);
    });
}

// This handles the "Start from Selected Template" button logic
function startFromTemplate() {
    const select = document.getElementById('template-select');
    const idx = select.value;
    if (idx === "") {
        alert("Please select a template first!");
        return;
    }
    startFromTemplateByIndex(parseInt(idx));
}

function createNewTemplate() {
    const name = prompt("Enter a name for your new template (e.g., Leg Day):");
    if (!name || name.trim() === "") return;

    const newTemplate = {
        id: "custom-" + Date.now(),
        name: name,
        exercises: []
    };

    templates.push(newTemplate);
    saveTemplates();
    
    // This part automatically opens the editor for the new template you just made
    editTemplate(templates.length - 1);
}

function pasteAndImport() {
    const textArea = document.getElementById('csv-paste');
    if (!textArea || !textArea.value.trim()) {
        alert("Please paste some CSV data first.");
        return;
    }
    
    // This sends the text to your CSV processor
    processCSVRows(textArea.value.split('\n'));
    
    // Clear the box and refresh
    textArea.value = '';
    alert("CSV Data Processed and Synced!");
    location.reload(); 
}
function handleImportFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(e) {
        try {
            const importedData = JSON.parse(e.target.result);
            const importedWorkouts = Array.isArray(importedData.workouts) ? importedData.workouts : [];
            const importedTemplates = Array.isArray(importedData.templates) ? importedData.templates : [];

            if (!importedWorkouts.length && !importedTemplates.length) {
                alert("No workouts or templates found in the backup file.");
                return;
            }

            showStatus("Importing backup to Pi...", "info");

            await syncFromPi();

            const workoutPromises = [];
            const restoreWorkouts = importedWorkouts.map(wk => ({
                ...wk,
                date: wk.date,
                name: wk.name || "Imported Workout",
                exercises: Array.isArray(wk.exercises) ? wk.exercises : [],
                type: wk.type || "strength",
                distance: wk.distance || 0,
                duration: wk.duration || 0,
                pace: wk.pace || "",
                rpe: wk.rpe ?? null,
                notes: wk.notes || "",
                hr: wk.hr ?? null,
                calories: wk.calories ?? null,
                rir: wk.rir ?? null,
                watchData: wk.watchData || null
            }));

            const existingKeys = new Set(workouts.map(wk => `${wk.date}-${wk.name || 'Unnamed'}`));
            const uniqueWorkouts = restoreWorkouts.filter(wk => {
                const key = `${wk.date}-${wk.name || 'Unnamed'}`;
                if (existingKeys.has(key)) return false;
                existingKeys.add(key);
                return true;
            });

            for (const wk of uniqueWorkouts) {
                workoutPromises.push(
                    fetch('/add-workout', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                        body: JSON.stringify(wk)
                    }).then(res => {
                        if (!res.ok) {
                            return res.text().then(text => {
                                throw new Error(`Workout save failed (${res.status}): ${text}`);
                            });
                        }
                    })
                );
            }

            const restoredTemplates = importedTemplates.map(t => ({
                name: t.name || "Imported Template",
                exercises: Array.isArray(t.exercises) ? t.exercises : []
            }));

            const templateKeySet = new Set(templates.map(t => t.name));
            const uniqueNewTemplates = restoredTemplates.filter(t => {
                if (templateKeySet.has(t.name)) return false;
                templateKeySet.add(t.name);
                return true;
            });

            const mergedTemplates = [...templates, ...uniqueNewTemplates];

            const templatePromise = mergedTemplates.length > 0
                ? fetch('/save-templates', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
                    body: JSON.stringify(mergedTemplates)
                }).then(res => {
                    if (!res.ok) throw new Error(`Template save failed (${res.status})`);
                })
                : Promise.resolve();

            await Promise.all([templatePromise, ...workoutPromises]);

            await Promise.all([syncFromPi(), syncTemplates()]);

            showStatus(`✅ Backup imported and stored on Pi`, "success");
            alert(`Imported ${uniqueWorkouts.length} workouts and ${restoredTemplates.length} templates.`);

            renderHistory();
            renderTemplates();
            if (typeof renderReports === 'function') renderReports();
        } catch (err) {
            console.error("Critical Import Error:", err);
            const message = err && err.message ? err.message : "The file format is invalid or the import failed.";
            alert(`Import failed: ${message}`);
            showStatus("❌ Backup import failed.", "error");
        }
    };
    reader.readAsText(file);
}

function exportData() {
    if (!CURRENT_USER_ID) {
        alert("Please log in first.");
        return;
    }

    showStatus("Generating backup...", "info");

    Promise.all([syncFromPi(), syncTemplates()]).then(() => {
        const userWorkouts = workouts.filter(w => w.user_id === CURRENT_USER_ID);
        const userTemplates = templates.filter(t => t.user_id === CURRENT_USER_ID);

        const backup = {
            exportedAt: new Date().toISOString(),
            workouts: userWorkouts.map(wk => {
                const { user_id, id, ...rest } = wk;
                return rest;
            }),
            templates: userTemplates.map(t => {
                const { user_id, id, ...rest } = t;
                return rest;
            })
        };

        const jsonString = JSON.stringify(backup, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const link = document.createElement('a');
        link.href = url;
        link.download = `liftlog_backup.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);

        showStatus(`✅ Backup downloaded!`, "success");
    });
}


function editTemplate(idx) {
    currentEditingTemplateIndex = idx;
    
    // 1. Load the existing exercises into our temporary builder list
    currentTemplateExercises = [...templates[idx].exercises];
    
    // 2. Refresh the visual list so you can see them immediately
    renderTemplateExerciseList();
    
    // 3. Update the header and show the section
    document.getElementById('editing-template-name').innerText = "Editing: " + templates[idx].name;
    showSection('edit-template');
}

function saveEditedTemplate() {
    if (currentEditingTemplateIndex === -1) return;

    // Save the builder list back to the main template
    templates[currentEditingTemplateIndex].exercises = [...currentTemplateExercises];

    // Clear everything out for next time
    currentTemplateExercises = [];

    saveTemplates();
    renderTemplates();
    showSection('templates');
    
    alert("Template updated!");
}

function removeExerciseFromActive(index) {
    if (confirm("Are you sure you want to remove this exercise?")) {
        // 1. Remove it from the current session
        currentWorkout.exercises.splice(index, 1);
        
        // 2. Save the change to the backup immediately
        localStorage.setItem('active_workout_backup', JSON.stringify(currentWorkout));
        
        // 3. Refresh the screen so it disappears
        renderActiveWorkout();
    }
}

// Clean up exact duplicates (same date + same name)
function cleanupDuplicates() {
    const seen = new Map();
    const unique = [];

    workouts.forEach(wk => {
        const key = `${wk.date}-${wk.name || 'Unnamed'}`;
        if (!seen.has(key)) {
            seen.set(key, true);
            unique.push(wk);
        }
    });

    if (unique.length < workouts.length) {
        console.log(`🧹 Removed ${workouts.length - unique.length} duplicate workouts`);
        workouts = unique;
        saveWorkouts();
        renderHistory();
        if (typeof renderReports === 'function') renderReports();
    }
}

function clearAllDeviceData() {
    if (confirm("Clear ALL local data on this device? This cannot be undone.")) {
        localStorage.clear();
        workouts = [];
        templates = [];
        currentWorkout = null;
        currentTemplateExercises = [];
        
        
        alert("Local data cleared. Syncing from Pi now...");
        
        
        setTimeout(() => {
            location.reload();
        }, 600);
    }
}

// Show temporary status message on screen
// Reliable on-screen status message
function showStatus(message, type = "info") {
    // Remove any old message
    let old = document.getElementById('status-msg');
    if (old) old.remove();

    const div = document.createElement('div');
    div.id = 'status-msg';
    div.style.cssText = `
        position: fixed; top: 70px; left: 50%; transform: translateX(-50%);
        padding: 14px 24px; border-radius: 10px; font-size: 16px; font-weight: 500;
        z-index: 99999; box-shadow: 0 6px 20px rgba(0,0,0,0.25); text-align: center;
        max-width: 90%; white-space: nowrap;
    `;

    if (type === "success") {
        div.style.backgroundColor = "#34c759";
        div.style.color = "white";
    } else if (type === "error") {
        div.style.backgroundColor = "#ff3b30";
        div.style.color = "white";
    } else {
        div.style.backgroundColor = "#007aff";
        div.style.color = "white";
    }

    div.textContent = message;
    document.body.appendChild(div);

    setTimeout(() => div.remove(), 4500);
}

async function syncEverything() {
    showStatus("Checking for pending data...", "info");
    
    let pending = JSON.parse(localStorage.getItem('pending_sync')) || [];
    let uploadedWorkouts = 0;

    if (pending.length > 0) {
        showStatus(`Uploading ${pending.length} unsynced workouts...`, "info");
        for (const wk of pending) {
            const success = await saveWorkoutToPi(wk);
            if (success) uploadedWorkouts++;
        }
        if (uploadedWorkouts > 0) {
            localStorage.removeItem('pending_sync');
        }
    }

    // Refresh from Pi
    const hadNewWorkouts = await syncFromPi();
    const hadNewTemplates = await syncTemplatesWithCount();   // We'll create this helper

    let message = "✅ Sync complete";
    if (uploadedWorkouts > 0 || hadNewWorkouts || hadNewTemplates > 0) {
        message = `✅ Synced ${uploadedWorkouts} workout(s) + ${hadNewTemplates} template(s) from Pi`;
    }
    showStatus(message, "success");
}

async function syncTemplatesWithCount() {
    try {
        const response = await fetch('/api/templates?t=' + Date.now(), {
            headers: getAuthHeader()
        });

        if (!response.ok) {
            console.error("Template fetch failed with status:", response.status);
            return 0;
        }

        const remoteTemplates = await response.json();
        console.log("Received from Pi:", remoteTemplates);   // ← Debug line

        if (Array.isArray(remoteTemplates)) {
            const previousCount = templates.length;
            templates = remoteTemplates;
            localStorage.setItem('templates', JSON.stringify(templates));
            renderTemplates();

            const added = templates.length - previousCount;
            console.log(`Templates updated: ${templates.length} total (${added > 0 ? '+' + added : 'no change'})`);
            return added > 0 ? added : 0;
        }
    } catch (error) {
        console.error("Template sync error:", error);
    }
    return 0;
}

function renderPendingSync() {
    const container = document.getElementById('pending-sync-list');
    if (!container) return;

    const pending = JSON.parse(localStorage.getItem('pending_sync')) || [];
    
    if (pending.length === 0) {
        container.innerHTML = ""; // Hide if empty
        return;
    }

    container.innerHTML = `
        <h3 style="color: #ff9500;">⏳ Pending Uploads (${pending.length})</h3>
        ${pending.map(wk => `
            <div style="background: #fff3e0; border-left: 5px solid #ff9500; padding: 10px; margin-bottom: 10px; border-radius: 8px; font-size: 0.9em;">
                <strong>${wk.name}</strong> - ${wk.date}
            </div>
        `).join('')}
    `;
}

async function syncStrava() {
    const btn = document.getElementById('strava-sync-btn');
    if (!btn) return;

    const originalText = btn.innerText;
    btn.innerText = "⏳ Syncing...";
    btn.disabled = true;

    try {
        // This calls the new route we just added to server.js
        const response = await fetch('/api/strava/sync', {
            method: 'GET',
            headers: getAuthHeader() // Sends your JWT password token
        });

        if (response.ok) {
            alert("Strava Sync Complete!");
            // This tells the app to reload the data from the Pi
            if (typeof syncFromPi === "function") {
                await syncFromPi(); 
            } else {
                location.reload(); // Fallback to refresh the whole page
            }
        } else {
            const errorData = await response.json();
            alert("Sync failed: " + (errorData.error || "Unknown error"));
        }
    } catch (err) {
        console.error("Sync Error:", err);
        alert("Could not connect to Pi for Strava sync.");
    } finally {
        btn.innerText = originalText;
        btn.disabled = false;
    }
}

async function restartServer() {
    if (!confirm("Restart the LiftLog server on the Pi?\n\nThis will take ~10 seconds.")) {
        return;
    }

    try {
        showStatus("Restarting server...", "info");

        const response = await fetch('/restart', {
            method: 'POST',
            headers: getAuthHeader()
        });

        if (response.ok) {
            showStatus("Server restart requested. Waiting...", "success");
            // Optional: reload the app after some time
            setTimeout(() => location.reload(), 8000);
        } else {
            showStatus("Failed to restart server", "error");
        }
    } catch (err) {
        showStatus("Could not reach Pi to restart", "error");
    }
}

// Add Restart Button for Admin (you) only
function addAdminRestartButton() {
    if (CURRENT_USER_ID !== 75001) return;

    if (!localStorage.getItem('liftlog_token')) return;   // Only show for logged-in user

    const btn = document.createElement('button');
    btn.innerHTML = '🔄 Restart Server (Admin Only)';
    btn.style.cssText = `
        background: #ff9500; 
        color: white; 
        padding: 12px 20px; 
        border: none; 
        border-radius: 8px; 
        margin: 15px auto; 
        display: block; 
        font-size: 16px; 
        cursor: pointer;
    `;
    btn.onclick = restartServer;

    // Add it to the bottom of the Templates section (you can change this)
    const templatesSection = document.getElementById('templates-section');
    if (templatesSection) {
        templatesSection.appendChild(btn);
    }
}

function showSettingsTab(tab) {
    const importContent = document.getElementById('settings-import-content');
    const accountContent = document.getElementById('settings-account-content');
    const importTab = document.getElementById('settings-tab-import');
    const accountTab = document.getElementById('settings-tab-account');

    if (!importContent || !accountContent) {
        console.error("Settings elements not found yet");
        return;
    }

    // Show/hide content
    importContent.style.display = tab === 'import' ? 'block' : 'none';
    accountContent.style.display = tab === 'account' ? 'block' : 'none';

    // Update active tab styling
    if (importTab) importTab.className = tab === 'import' ? 'settings-tab tab-active' : 'settings-tab';
    if (accountTab) accountTab.className = tab === 'account' ? 'settings-tab tab-active' : 'settings-tab';
}

function saveUsername() {
    const username = document.getElementById('account-username').value.trim();
    if (username) {
        localStorage.setItem('liftlog_username', username);
        showStatus('✅ Username saved', 'success');
    }
}

function logout() {
    localStorage.removeItem('liftlog_token');
    localStorage.removeItem(SESSION_LAST_ACTIVE_KEY);
    showStatus("Signing out...", "info");
    setTimeout(() => {
        window.location.href = '/login.html';
    }, 400);
}

function showProgressTab(tab) {
    const historyContent = document.getElementById('progress-history-content');
    const exercisesContent = document.getElementById('progress-exercises-content');
    const historyBtn = document.getElementById('progress-tab-history');
    const exercisesBtn = document.getElementById('progress-tab-exercises');

    if (!historyContent || !exercisesContent || !historyBtn || !exercisesBtn) {
        console.error("Progress tab elements are missing.");
        return;
    }

    // Show/hide the two main contents
    historyContent.style.display = tab === 'history' ? 'block' : 'none';
    exercisesContent.style.display = tab === 'exercises' ? 'block' : 'none';

    // Update active tab style
        // Update button styles - selected = blue background, unselected = white with blue border
    if (tab === 'history') {
        historyBtn.style.background = '#007aff';
        historyBtn.style.color = 'white';
        exercisesBtn.style.background = 'white';
        exercisesBtn.style.color = '#007aff';
    } else {
        exercisesBtn.style.background = '#007aff';
        exercisesBtn.style.color = 'white';
        historyBtn.style.background = 'white';
        historyBtn.style.color = '#007aff';
    }

    // Load data
    if (tab === 'history') {
        renderHistory();
    } else if (tab === 'exercises') {
        if (typeof renderReports === 'function') renderReports();
        populateProgressExerciseSelector();
    }
}

let progressChartInstance = null;

function populateProgressExerciseSelector() {
    const sel = document.getElementById('progress-exercise-select');
    if (!sel) return;
    const names = [...new Set(
        workouts.flatMap(w => (w.exercises || []).map(e => e.name).filter(Boolean))
    )].sort();
    const current = sel.value;
    sel.innerHTML = '<option value="">— select an exercise —</option>' +
        names.map(n => `<option value="${encodeURIComponent(n)}"${encodeURIComponent(n) === current ? ' selected' : ''}>${n}</option>`).join('');
    if (current) renderProgressChart();
}

async function renderProgressChart() {
    const sel = document.getElementById('progress-exercise-select');
    const canvas = document.getElementById('progress-chart');
    if (!sel || !canvas) return;

    const encoded = sel.value;
    if (!canvas.getContext) return;

    if (progressChartInstance) {
        progressChartInstance.destroy();
        progressChartInstance = null;
    }

    if (!encoded) return;

    const token = localStorage.getItem('authToken') || sessionStorage.getItem('authToken');
    let rows = [];
    try {
        const res = await fetch(`/api/progress/${encoded}`, { headers: { Authorization: `Bearer ${token}` } });
        rows = await res.json();
    } catch (e) {
        console.warn('Progress chart fetch failed:', e);
        return;
    }

    if (!Array.isArray(rows) || rows.length === 0) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#aaa';
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No history yet — log a workout to start tracking.', canvas.width / 2, canvas.height / 2);
        return;
    }

    const labels = rows.map(r => r.date);
    const values = rows.map(r => r.estimated_1rm);

    // Simple linear regression trend line via least-squares
    let trendData = null;
    if (rows.length >= 3 && typeof window.ss !== 'undefined') {
        const xVals = rows.map((_, i) => i);
        const m = window.ss.linearRegressionLine(window.ss.linearRegression(xVals.map((x, i) => [x, values[i]])));
        trendData = xVals.map(x => Math.round(m(x)));
    }

    const datasets = [{
        label: 'Est. 1RM (lbs)',
        data: values,
        borderColor: '#007aff',
        backgroundColor: 'rgba(0,122,255,0.12)',
        tension: 0.3,
        pointRadius: 4,
        fill: true,
    }];

    if (trendData) {
        datasets.push({
            label: 'Trend',
            data: trendData,
            borderColor: 'rgba(255,94,0,0.7)',
            borderDash: [6, 3],
            pointRadius: 0,
            fill: false,
        });
    }

    progressChartInstance = new Chart(canvas, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { labels: { color: '#333' } } },
            scales: {
                x: { ticks: { maxTicksLimit: 8, color: '#666' } },
                y: { ticks: { color: '#666' }, title: { display: true, text: 'lbs', color: '#666' } }
            }
        }
    });
}

// Call it when page loads
window.addEventListener('load', addAdminRestartButton);

window.onload = () => {
    loadExerciseStats();
    if (!initializeSessionTimer()) return;

    // Handle ?strava= redirect after OAuth
    const urlParams = new URLSearchParams(window.location.search);
    const stravaResult = urlParams.get('strava');
    if (stravaResult) {
        window.history.replaceState({}, document.title, window.location.pathname);
        if (stravaResult === 'connected') {
            setTimeout(() => {
                showSection('settings');
                // small delay so settings renders first
                setTimeout(() => {
                    if (typeof showSettingsTab === 'function') showSettingsTab('account');
                }, 50);
                alert('✅ Strava connected successfully!');
            }, 300);
        } else if (stravaResult === 'error') {
            alert('❌ Could not connect Strava. Please try again.');
        }
    }

    const backup = localStorage.getItem('active_workout_backup');
    if (backup) {
        currentWorkout = JSON.parse(backup);
        showSection('log');
        renderActiveWorkout();
    } else if (!stravaResult) {
        showSection('dashboard');
    }

    cleanupDuplicates();
    syncFromPi();
    syncTemplates();
    checkStravaStatus();
    loadAppleHealthTokenStatus();
};

// Run the sync as soon as the page loads
window.addEventListener('load', syncFromPi);

// ==================== STRAVA PER-USER CONNECTION ====================

async function connectStrava() {
    // Fetch the redirect URL from the server (needs auth header), then follow it
    try {
        const res = await fetch('/api/strava/connect', {
            headers: getAuthHeader(),
            redirect: 'manual'   // don't auto-follow — we want the Location header
        });
        // Server returns 302; browser won't follow cross-origin redirects manually,
        // so the server instead returns the URL as JSON when redirect=manual isn't fully supported
        if (res.type === 'opaqueredirect' || res.status === 0) {
            // Some browsers still follow — if we're already going to Strava this is fine
            return;
        }
        const data = await res.json();
        if (data.url) window.location.href = data.url;
    } catch (e) {
        console.error('Strava connect error', e);
    }
}

async function checkStravaStatus() {
    try {
        const res = await fetch('/api/strava/status', { headers: getAuthHeader() });
        if (!res.ok) return;
        const data = await res.json();
        updateStravaUI(data.connected, data.name);
    } catch (e) { /* silent */ }
}

function updateStravaUI(connected, athleteName) {
    const btn = document.getElementById('strava-connect-btn');
    const statusEl = document.getElementById('strava-status-display');
    const syncHint = document.getElementById('strava-sync-hint');
    const syncBtn = document.getElementById('strava-sync-btn');

    if (connected) {
        if (btn) {
            btn.textContent = '✅ Strava Connected';
            btn.style.background = '#34c759';
            btn.onclick = null;
            btn.style.cursor = 'default';
        }
        if (statusEl) statusEl.textContent = athleteName ? `Connected as ${athleteName}` : 'Account connected';
        if (syncHint) syncHint.style.display = 'none';
        if (syncBtn) { syncBtn.style.background = '#fc4c02'; syncBtn.style.opacity = '1'; }
    } else {
        if (statusEl) statusEl.textContent = 'Not connected';
        if (syncHint) syncHint.style.display = 'block';
        if (syncBtn) { syncBtn.style.opacity = '0.5'; }
    }
}

// ==================== ADMIN: INVITE KEY GENERATION ====================

function isOwner() {
    const token = localStorage.getItem('liftlog_token');
    if (!token) return false;
    try {
        const p = JSON.parse(atob(token.split('.')[1]));
        return p.user_id === 75001 || p.user === 'noah';
    } catch(e) { return false; }
}

window.addEventListener('load', () => {
    if (isOwner()) {
        const card = document.getElementById('admin-invite-card');
        if (card) card.style.display = 'block';
    }
});

async function generateInviteKey() {
    const btn = document.getElementById('generate-invite-btn');
    const resultDiv = document.getElementById('invite-result');
    const tokenDisplay = document.getElementById('invite-token-display');
    const expiryMsg = document.getElementById('invite-expiry-msg');

    btn.disabled = true;
    btn.textContent = 'Generating...';
    try {
        const res = await fetch('/api/invites/generate', {
            method: 'POST',
            headers: getAuthHeader()
        });
        if (!res.ok) { alert('Failed to generate key'); return; }
        const data = await res.json();
        tokenDisplay.textContent = data.token;
        expiryMsg.textContent = `Expires: ${new Date(data.expiresAt).toLocaleString()}`;
        resultDiv.style.display = 'block';
    } catch(e) {
        alert('Error reaching server');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Generate New Invite Key';
    }
}

function copyInviteKey() {
    const token = document.getElementById('invite-token-display').textContent.trim();
    if (!token) return;
    navigator.clipboard.writeText(token)
        .then(() => alert('Copied to clipboard!'))
        .catch(() => alert('Select the key and copy manually'));
}

// ==================== APPLE HEALTH IMPORT ====================

async function loadAppleHealthTokenStatus() {
    try {
        const res = await fetch('/api/apple-health/token-status', { headers: getAuthHeader() });
        if (!res.ok) return;
        const data = await res.json();
        if (data.token) {
            document.getElementById('ah-token-section').style.display = 'block';
            document.getElementById('ah-token-text').textContent = data.token;
            const baseUrl = window.location.origin;
            document.getElementById('ah-endpoint-url').textContent = `${baseUrl}/api/apple-health/import?token=${data.token}`;
            const lastEl = document.getElementById('ah-last-import-text');
            if (data.lastImport) {
                lastEl.textContent = `Last import: ${new Date(data.lastImport + 'Z').toLocaleString()}`;
            } else {
                lastEl.textContent = 'No imports yet';
            }
        }
    } catch(e) { /* silent */ }
}

async function generateAppleHealthToken() {
    const btn = document.getElementById('ah-generate-btn');
    btn.disabled = true;
    btn.textContent = 'Generating...';
    try {
        const res = await fetch('/api/apple-health/generate-token', {
            method: 'POST',
            headers: getAuthHeader()
        });
        if (!res.ok) { alert('Failed to generate token'); return; }
        const data = await res.json();
        document.getElementById('ah-token-section').style.display = 'block';
        document.getElementById('ah-token-text').textContent = data.token;
        const baseUrl = window.location.origin;
        document.getElementById('ah-endpoint-url').textContent = `${baseUrl}/api/apple-health/import?token=${data.token}`;
        document.getElementById('ah-last-import-text').textContent = 'No imports yet';
    } catch(e) {
        alert('Error reaching server');
    } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Regenerate Token';
    }
}

function copyAppleHealthToken() {
    const token = document.getElementById('ah-token-text').textContent.trim();
    if (!token) return;
    navigator.clipboard.writeText(token)
        .then(() => alert('Token copied!'))
        .catch(() => alert('Select the token and copy manually'));
}

async function uploadAppleHealthFile() {
    const fileInput = document.getElementById('ah-upload-file');
    const statusEl  = document.getElementById('ah-upload-status');
    const file = fileInput.files[0];
    if (!file) { alert('Please select a JSON file first'); return; }

    statusEl.style.display    = 'block';
    statusEl.style.background = '#e0f0ff';
    statusEl.style.color      = '#0066cc';
    statusEl.textContent      = '⏳ Parsing and uploading...';

    try {
        const text = await file.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch(parseErr) {
            statusEl.style.background = '#f8d7da';
            statusEl.style.color      = '#721c24';
            statusEl.textContent      = `❌ Invalid JSON: ${parseErr.message}`;
            return;
        }

        // Strip per-sample time-series arrays that HAE includes but we never use.
        // These can balloon the export to hundreds of MB — drop them before upload.
        const STRIP_KEYS = new Set(['heartRate', 'heartRateData', 'activeEnergy', 'vo2Max',
                                    'respiratoryRate', 'runningPower', 'groundContactTime',
                                    'stepLength', 'verticalOscillation', 'strideLength']);
        const stripWorkout = w => {
            const out = {};
            for (const k of Object.keys(w)) {
                if (!STRIP_KEYS.has(k)) out[k] = w[k];
            }
            return out;
        };
        if (json?.data?.workouts)  json.data.workouts  = json.data.workouts.map(stripWorkout);
        else if (json?.workouts)   json.workouts        = json.workouts.map(stripWorkout);

        const res  = await fetch('/api/apple-health/upload', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', ...getAuthHeader() },
            body:    JSON.stringify(json)
        });
        const data = await res.json();

        if (res.ok && data.success) {
            const merged = data.workoutsMatchedAndUpdated || 0;
            const sp = data.sampleParsedWorkout;
            const sampleLine = sp
                ? `<br><span style="font-size:11px; color:#555;">Sample: ${sp.start} → ${sp.duration ?? sp.durationMinutes}min, ${sp.calories}cal, HR ${sp.hr ?? sp.avgHeartRate}/${sp.maxHr ?? sp.maxHeartRate}</span>`
                : '';
            statusEl.style.background = merged > 0 ? '#d4edda' : '#fff3cd';
            statusEl.style.color      = merged > 0 ? '#155724' : '#856404';
            statusEl.innerHTML = `
                <strong>${merged > 0 ? '✅' : '⚠️'} ${data.message}</strong><br>
                Processed: ${data.workoutsProcessed} total<br>
                Merged into existing: <strong>${merged}</strong><br>
                Skipped (no match): ${data.workoutsSkippedNoMatch ?? 0}<br>
                Skipped (before 2026): ${data.workoutsSkippedOld ?? 0}
                ${sampleLine}
            `;
            if (merged > 0) {
                fileInput.value = '';
                await syncFromPi();
            }
        } else {
            statusEl.style.background = '#f8d7da';
            statusEl.style.color      = '#721c24';
            statusEl.textContent      = `❌ ${data.error || 'Upload failed'}`;
        }
    } catch(e) {
        statusEl.style.background = '#f8d7da';
        statusEl.style.color      = '#721c24';
        statusEl.textContent      = `❌ ${e.message}`;
    }
}
