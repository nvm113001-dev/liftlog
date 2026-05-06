function getAuthHeader() {
    const token = localStorage.getItem('liftlog_token');
    return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// Handle token from URL after Google login
const urlParams = new URLSearchParams(window.location.search);
const tokenFromUrl = urlParams.get('token');
const debug = urlParams.get('debug');

if (tokenFromUrl) {
    localStorage.setItem('liftlog_token', tokenFromUrl);
    localStorage.setItem('liftlog_last_active_at', String(Date.now()));
    window.history.replaceState({}, document.title, window.location.pathname);
}

// Force login screen if no token
if (!localStorage.getItem('liftlog_token')) {
    // Check if we are ALREADY on the login page to prevent infinite loops
    if (!window.location.pathname.includes('login.html')) {
        window.location.href = '/login.html'; // Send them to the waiting room
    }
}

window.onerror = function(msg, url, lineNo, columnNo, error) {
  alert('Error: ' + msg + '\nLine: ' + lineNo);
  return false;
};
const API_BASE = 'https://liftlognm.tailee3a44.ts.net';// Current logged-in user 
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
    return {
        name: watch.name || wk.name || 'Watch Activity',
        type: watch.type || watch.sportType || wk.type || '',
        sportType: watch.sportType || watch.type || wk.type || '',
        distance: parseFloat(watch.distance ?? wk.distance ?? 0) || 0,
        duration: parseInt(watch.duration ?? wk.duration ?? 0, 10) || 0,
        elapsedTime: parseInt(watch.elapsedTime ?? wk.elapsedTime ?? 0, 10) || 0,
        hr: parseInt(watch.hr ?? wk.hr ?? 0, 10) || 0,
        maxHr: parseInt(watch.maxHr ?? wk.maxHr ?? 0, 10) || 0,
        calories: parseInt(watch.calories ?? wk.calories ?? 0, 10) || 0,
        pace: watch.pace || wk.pace || '',
        elevation: parseFloat(watch.elevation ?? wk.elevation ?? 0) || 0,
        elevationHigh: parseFloat(watch.elevationHigh ?? wk.elevationHigh ?? 0) || 0,
        elevationLow: parseFloat(watch.elevationLow ?? wk.elevationLow ?? 0) || 0,
        averageSpeed: parseFloat(watch.averageSpeed ?? wk.averageSpeed ?? 0) || 0,
        maxSpeed: parseFloat(watch.maxSpeed ?? wk.maxSpeed ?? 0) || 0,
        averageCadence: parseFloat(watch.averageCadence ?? wk.averageCadence ?? 0) || 0,
        averageWatts: parseFloat(watch.averageWatts ?? wk.averageWatts ?? 0) || 0,
        weightedAverageWatts: parseFloat(watch.weightedAverageWatts ?? wk.weightedAverageWatts ?? 0) || 0,
        kilojoules: parseFloat(watch.kilojoules ?? wk.kilojoules ?? 0) || 0,
        sufferScore: parseInt(watch.sufferScore ?? wk.sufferScore ?? 0, 10) || 0,
        achievementCount: parseInt(watch.achievementCount ?? wk.achievementCount ?? 0, 10) || 0,
        kudosCount: parseInt(watch.kudosCount ?? wk.kudosCount ?? 0, 10) || 0,
        trainer: Boolean(watch.trainer ?? wk.trainer),
        commute: Boolean(watch.commute ?? wk.commute),
        manual: Boolean(watch.manual ?? wk.manual),
        startTime: watch.startTime || wk.startTime || '',
        source: watch.source || 'Strava'
    };
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

    const metricRows = [
        ['Activity', metrics.name],
        ['Type', metrics.sportType || metrics.type],
        ['Start', formatStartTime(metrics.startTime)],
        ['Moving', metrics.duration ? `${metrics.duration} min` : ''],
        ['Elapsed', metrics.elapsedTime ? `${metrics.elapsedTime} min` : ''],
        ['Distance', metrics.distance ? `${metrics.distance.toFixed(2)} mi` : ''],
        ['Pace', metrics.pace],
        ['Avg HR', metrics.hr ? `${metrics.hr} bpm` : ''],
        ['Max HR', metrics.maxHr ? `${metrics.maxHr} bpm` : ''],
        ['Calories', metrics.calories ? `${metrics.calories} cal` : ''],
        ['Elevation', metrics.elevation ? `${Math.round(metrics.elevation)} ft` : ''],
        ['Elev High', metrics.elevationHigh ? `${Math.round(metrics.elevationHigh)} ft` : ''],
        ['Elev Low', metrics.elevationLow ? `${Math.round(metrics.elevationLow)} ft` : ''],
        ['Avg Speed', metrics.averageSpeed ? `${metersPerSecondToMph(metrics.averageSpeed)} mph` : ''],
        ['Max Speed', metrics.maxSpeed ? `${metersPerSecondToMph(metrics.maxSpeed)} mph` : ''],
        ['Cadence', metrics.averageCadence ? `${metrics.averageCadence.toFixed(1)}` : ''],
        ['Avg Watts', metrics.averageWatts ? `${Math.round(metrics.averageWatts)} W` : ''],
        ['Weighted W', metrics.weightedAverageWatts ? `${Math.round(metrics.weightedAverageWatts)} W` : ''],
        ['Kilojoules', metrics.kilojoules ? `${Math.round(metrics.kilojoules)} kJ` : ''],
        ['Effort', metrics.sufferScore ? `${metrics.sufferScore}` : ''],
        ['Achievements', metrics.achievementCount ? `${metrics.achievementCount}` : ''],
        ['Kudos', metrics.kudosCount ? `${metrics.kudosCount}` : ''],
        ['Trainer', metrics.trainer ? 'Yes' : ''],
        ['Commute', metrics.commute ? 'Yes' : ''],
        ['Manual', metrics.manual ? 'Yes' : '']
    ].filter(([, value]) => value !== '' && value !== null && value !== undefined);

    if (metricRows.length === 0) return '';

    return `
        <div style="background:#fff5f0; padding:12px; border-radius:8px; margin-bottom:10px; font-size:13px; color:#e65100; border: 1px solid #ffdecb;">
            <strong>${isCardio ? 'Activity' : 'Watch Data'} (${metrics.source || 'Strava'}):</strong>
            <div style="display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:8px; margin-top:10px;">
                ${metricRows.map(([label, value]) => `
                    <div style="background:white; border:1px solid #ffe1d0; border-radius:7px; padding:7px;">
                        <div style="font-size:10px; text-transform:uppercase; color:#a84b00; letter-spacing:0;">${label}</div>
                        <strong style="display:block; color:#3a2a1f; margin-top:2px; overflow-wrap:anywhere;">${value}</strong>
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

    const sortedMonths = Object.keys(monthlyCount).sort().reverse();
    monthContainer.innerHTML = sortedMonths.map(monthStr => {
        const [year, monthNum] = monthStr.split('-');
        const d = new Date(year, monthNum - 1);
        const name = d.toLocaleString('default', { month: 'long' });
        return `<div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #eee;">
            <span><strong>${name} ${year}</strong></span>
            <strong style="color: #007aff;">${monthlyCount[monthStr].size} sessions</strong>
        </div>`;
    }).join('') || '<p style="text-align:center; padding:20px;">No month data found.</p>';

    const sortedExercises = Object.keys(exerciseData).sort((a, b) => exerciseData[b].totalVol - exerciseData[a].totalVol);
    exListContainer.innerHTML = sortedExercises.map(name => {
        const data = exerciseData[name];
        const display1RM = data.best1RM > 0 ? `${Math.round(data.best1RM)} lbs` : "N/A (BW)";
        
        const avgRIR = data.rirCount > 0 ? (data.rirSum / data.rirCount).toFixed(1) : null;
        const rirBadge = avgRIR !== null ? 
            `<span style="font-size: 0.8em; color: #ff9500; background: #fff9f0; padding: 2px 8px; border-radius: 10px; margin-left:5px;">Avg RIR: ${avgRIR}</span>` : '';

        // NEW: 1 RIR Projections Grid
        let projectionsHTML = '';
        if (data.best1RM > 0) {
            const p3 = Math.round(data.best1RM * 0.86); 
            const p5 = Math.round(data.best1RM * 0.82); 
            const p8 = Math.round(data.best1RM * 0.76); 
            const p10 = Math.round(data.best1RM * 0.71); 

            projectionsHTML = `
                <div style="margin-top: 10px; padding-top: 8px; border-top: 1px dashed #eee;">
                    <div style="font-size: 0.7em; color: #999; margin-bottom: 4px; text-transform: uppercase;">1 RIR Targets</div>
                    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; text-align: center;">
                        <div style="background: #fcfcfc; border: 1px solid #f0f0f0; border-radius: 4px; padding: 4px;">
                            <div style="font-size: 0.65em; color: #666;">3 Reps</div>
                            <strong style="font-size: 0.85em;">${p3}</strong>
                        </div>
                        <div style="background: #fcfcfc; border: 1px solid #f0f0f0; border-radius: 4px; padding: 4px;">
                            <div style="font-size: 0.65em; color: #666;">5 Reps</div>
                            <strong style="font-size: 0.85em;">${p5}</strong>
                        </div>
                        <div style="background: #fcfcfc; border: 1px solid #f0f0f0; border-radius: 4px; padding: 4px;">
                            <div style="font-size: 0.65em; color: #666;">8 Reps</div>
                            <strong style="font-size: 0.85em;">${p8}</strong>
                        </div>
                        <div style="background: #fcfcfc; border: 1px solid #f0f0f0; border-radius: 4px; padding: 4px;">
                            <div style="font-size: 0.65em; color: #666;">10 Reps</div>
                            <strong style="font-size: 0.85em;">${p10}</strong>
                        </div>
                    </div>
                </div>
            `;
        }

        return `
            <div class="exercise" style="margin-bottom: 12px; border-left: 5px solid #5856d6; padding: 12px; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 5px;">
                    <strong style="font-size: 1.1em;">${name} ${rirBadge}</strong>
                    <span style="font-size: 0.8em; color: #666; background: #f0f0f5; padding: 2px 8px; border-radius: 10px;">${data.count} sessions</span>
                </div>
                <div style="display:flex; justify-content:space-between; font-size: 0.9em; color: #333;">
                    <span>Est. 1RM: <strong style="color: #007aff;">${display1RM}</strong></span>
                    <span>Total Vol: <strong>${(data.totalVol / 1000).toFixed(1)}k lbs</strong></span>
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

        div.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <strong style="font-size: 1.25em; color: #007aff;">${tmpl.name}</strong>
                <div style="display: flex; gap: 5px;">
                    <button onclick="renameTemplate(${idx})" style="width: auto; padding: 4px 8px; font-size: 11px; background: #8e8e93;">Rename</button>
                    <button onclick="deleteTemplate(${idx})" style="width: auto; padding: 4px 8px; font-size: 11px; background: #ff3b30;">Delete</button>
                </div>
            </div>
            
            <div style="margin-bottom: 15px; font-size: 0.95em; color: #555; line-height: 1.4; font-style: italic;">
                ${exercisePreview}
            </div>

            <div style="display: flex; gap: 10px;">
                <button onclick="editTemplate(${idx})" style="flex: 1; padding: 10px;">Edit</button>
                <button onclick="startFromTemplateByIndex(${idx})" style="flex: 1; padding: 10px; background: #34c759;">Start Workout</button>
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
            ex.sets.push({ reps: reps, weight: 0 });
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
            
            <div style="font-size: 0.85em; color: #666; margin-bottom: 10px;">
                Target: ${ex.target_sets || 0} x ${ex.target_reps || 0}
            </div>

            <textarea 
                placeholder="Add a note (e.g. 'felt heavy')" 
                oninput="updateActiveNote(${exIdx}, this.value)"
                style="width: 100%; margin-bottom: 15px; border: 1px solid #ddd; border-radius: 8px; padding: 8px; font-family: inherit; font-size: 14px; box-sizing: border-box;">${ex.note || ''}</textarea>

            <div id="sets-${exIdx}"></div>
            <button onclick="addSet(${exIdx})">+ Set</button>
        `;

        container.appendChild(div);
        const setsDiv = document.getElementById(`sets-${exIdx}`);
        ex.sets.forEach((set, setIdx) => {
            const row = document.createElement('div');
            row.style.marginBottom = "8px"; // Adding a little breathing room between sets
            row.innerHTML = `
                <span style="font-size: 0.9em; color: #666; margin-right: 5px;">Set ${setIdx+1}</span>
                <input type="text" placeholder="lbs" value="${set.weight||''}" 
                       oninput="updateSet(${exIdx},${setIdx},'weight',this.value)" 
                       style="width:70px; padding: 8px; border: 1px solid #ddd; border-radius: 6px; text-align: center;"> 
                <input type="number" placeholder="reps" value="${set.reps||''}" 
                       oninput="updateSet(${exIdx},${setIdx},'reps',this.value)" 
                       style="width:55px; padding: 8px; border: 1px solid #ddd; border-radius: 6px; text-align: center;">
                <button onclick="removeSet(${exIdx},${setIdx})" 
                        style="width:auto; background:#ff3b30; padding: 8px 12px; margin-left: 5px;">-</button>
             `;
             setsDiv.appendChild(row);
        });
    });

    // NEW: Add a button at the bottom to add a new exercise to this specific workout
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
        sets: [{reps: 0, weight: 0}] // Start with one empty set
    });
    
    // Save to backup immediately so it's crash-proof
    localStorage.setItem('active_workout_backup', JSON.stringify(currentWorkout));
    
    renderActiveWorkout();
}

function updateSet(e, s, f, v) { 
    if(f==='weight') currentWorkout.exercises[e].sets[s][f] = v.toLowerCase()==='bw' ? 'BW' : parseFloat(v)||0;
    else currentWorkout.exercises[e].sets[s][f] = parseInt(v)||0;
    
    // ONLY save to phone backup while training. 
    // Do NOT call saveWorkoutToPi here.
    localStorage.setItem('active_workout_backup', JSON.stringify(currentWorkout));
}


function updateActiveNote(exIdx, val) {
    if (currentWorkout && currentWorkout.exercises[exIdx]) {
        currentWorkout.exercises[exIdx].note = val;
        // Save to phone backup immediately so notes aren't lost if Safari refreshes
        localStorage.setItem('active_workout_backup', JSON.stringify(currentWorkout));
    }
}

function addSet(i) { currentWorkout.exercises[i].sets.push({reps:0, weight:0}); renderActiveWorkout(); }
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
        <div style="display: flex; justify-content: space-between; background: #fff; padding: 10px; margin-bottom: 5px; border-radius: 5px; border: 1px solid #eee;">
            <span><strong>${ex.name}</strong> (${ex.muscleGroup || 'General'})</span>
            <button onclick="removeExerciseFromNewTemplate(${index})" style="background: none; color: #ff3b30; width: auto; padding: 0; border: none;">✕</button>
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
        div.style.borderLeft = isCardio ? "5px solid #FC6100" : "5px solid #34c759";
        
        const metrics = normalizeWatchMetrics(wk);

        const cardioStats = renderWatchMetricGrid(metrics, isCardio);

        const exHTML = (wk.exercises || []).map(ex => {
            const noteHTML = ex.note ? `<div style="color:#666; font-style:italic; font-size:12px; margin-top:2px;">📝 ${ex.note}</div>` : '';
            return `
                <div style="margin-bottom:10px;">
                    <strong>${ex.name || "Unknown"}</strong> 
                    ${noteHTML}
                    <div style="padding-left:10px;">
                        <small style="color:#444;">${(ex.sets || []).map(s => s.weight + 'lb x ' + s.reps).join(', ')}</small>
                    </div>
                </div>`;
        }).join('');

        div.innerHTML = `
            <div style="display:flex; justify-content:space-between;">
                <div>
                    <h3 onclick="renameHistoryItem(${idx})" style="color:#007aff; cursor:pointer; margin:0;">${wk.name || "Unnamed Workout"} ✏️</h3>
                    <small>${wk.date || "No Date"}</small>
                </div>
                <button onclick="deleteWorkout('${wk.date}', '${wk.name}')" style="background:none; color:#ff3b30; border:none; width:auto; font-size:14px;">Delete</button>
            </div>
            <hr style="border:0; border-top:1px solid #eee; margin:10px 0;">
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
    }
}

// Call it when page loads
window.addEventListener('load', addAdminRestartButton);

window.onload = () => { 
    if (!initializeSessionTimer()) return;

    const backup = localStorage.getItem('active_workout_backup');
    
    if (backup) {
        currentWorkout = JSON.parse(backup);
        showSection('log');
        renderActiveWorkout();
    } else {
        showSection('dashboard');
    }

    // Force clean sync on load
    cleanupDuplicates();
    syncFromPi();
    syncTemplates();
};

// Run the sync as soon as the page loads
window.addEventListener('load', syncFromPi);
