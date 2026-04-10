let templates = JSON.parse(localStorage.getItem('templates')) || [];
let workouts = JSON.parse(localStorage.getItem('workouts')) || [];
let currentWorkout = null;
let currentEditingTemplateIndex = -1;

if (templates.length === 0) {
    templates = [{
        id: "push-1",
        name: "Push Day",
        exercises: [
            { name: "Bench Press", sets: [{reps: 8, weight: 0}, {reps: 8, weight: 0}] },
            { name: "Overhead Press", sets: [{reps: 8, weight: 0}] }
        ]
    }];
    saveTemplates();
}

function saveTemplates() { localStorage.setItem('templates', JSON.stringify(templates)); }
function saveWorkouts() { localStorage.setItem('workouts', JSON.stringify(workouts)); }

function showSection(section) {
    document.querySelectorAll('.section').forEach(s => s.style.display = 'none');
    const target = document.getElementById(section + '-section');
    if (target) target.style.display = 'block';
    
    // NEW: Trigger the report building
    if (section === 'reports') renderReports();

    if (section === 'log') populateTemplateSelect();
    if (section === 'templates') renderTemplates();
    if (section === 'history') renderHistory();
}

function switchReportTab(tab) {
    const isSummary = tab === 'summary';
    
    // 1. Toggle the visibility of the data views
    const viewSummary = document.getElementById('view-summary');
    const viewExercises = document.getElementById('view-exercises');
    
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

function renderReports() {
    const statsContainer = document.getElementById('report-summary');
    const monthContainer = document.getElementById('monthly-breakdown');
    const exListContainer = document.getElementById('exercise-breakdown-list');
    if (!statsContainer || !monthContainer || !exListContainer) return;

    let lifetimeVolume = 0;
    const monthlyCount = {};
    const exerciseData = {}; 

    // 1. Process all workout data
    workouts.forEach(wk => {
        const month = wk.date.substring(0, 7); // "YYYY-MM"
        monthlyCount[month] = (monthlyCount[month] || 0) + 1;

        wk.exercises.forEach(ex => {
            // Determine if this is a bodyweight exercise
            const isBW = ex.name.toLowerCase().includes('bw') || 
                         ex.sets.some(s => String(s.weight).toLowerCase() === 'bw');

            if (!exerciseData[ex.name]) {
                exerciseData[ex.name] = { 
                    count: 0, 
                    best1RM: 0, 
                    maxReps: 0, 
                    lastDate: wk.date, 
                    totalVol: 0, 
                    history: [], 
                    isBodyweight: isBW 
                };
            }
            
            let dailyVol = 0;
            let dailyMax1RM = 0;
            let dailyTotalReps = 0;

            ex.sets.forEach(s => {
                const isSetBW = String(s.weight).toLowerCase() === 'bw';
                const w = (isSetBW || typeof s.weight !== 'number') ? 0 : s.weight;
                const r = s.reps || 0;
                
                dailyTotalReps += r;
                dailyVol += (w * r);
                
                // Strength Calc (Brzycki) for weighted sets
                if (r > 0 && w > 0) {
                    const est = w * (36 / (37 - Math.min(r, 36)));
                    if (est > dailyMax1RM) dailyMax1RM = est;
                }
                // Max Reps for BW sets
                if (r > exerciseData[ex.name].maxReps) exerciseData[ex.name].maxReps = r;
            });

            exerciseData[ex.name].count++;
            exerciseData[ex.name].totalVol += dailyVol;
            if (dailyMax1RM > exerciseData[ex.name].best1RM) exerciseData[ex.name].best1RM = dailyMax1RM;
            
            // Store progress data: 1RM for weighted, Total Reps for BW
            exerciseData[ex.name].history.push({ 
                date: wk.date, 
                value: isBW ? dailyTotalReps : dailyMax1RM 
            });
            lifetimeVolume += dailyVol;
        });
    });

    // 2. Render Summary Tab Cards
    statsContainer.innerHTML = `
        <div style="background: #007aff; color: white; padding: 15px; border-radius: 12px; text-align: center;">
            <div style="font-size: 1.8em; font-weight: bold;">${workouts.length}</div>
            <div style="font-size: 0.8em; opacity: 0.9;">Total Workouts</div>
        </div>
        <div style="background: #5856d6; color: white; padding: 15px; border-radius: 12px; text-align: center;">
            <div style="font-size: 1.4em; font-weight: bold;">${(lifetimeVolume / 1000).toFixed(1)}k lbs</div>
            <div style="font-size: 0.8em; opacity: 0.9;">Total Volume</div>
        </div>
    `;

    // 3. Render Monthly List
    const sortedMonths = Object.keys(monthlyCount).sort().reverse();
    monthContainer.innerHTML = sortedMonths.map(m => {
        const [y, mon] = m.split('-');
        const d = new Date(y, mon - 1);
        return `<div style="display:flex; justify-content:space-between; padding:10px 0; border-bottom:1px solid #eee;">
            <span><strong>${d.toLocaleString('default', {month:'long'})} ${y}</strong></span>
            <strong style="color: #007aff;">${monthlyCount[m]} sessions</strong>
        </div>`;
    }).join('') || '<p>No history yet.</p>';

    // 4. Render Exercise Tab with Progress Graphs
    const sortedEx = Object.keys(exerciseData).sort((a,b) => exerciseData[b].count - exerciseData[a].count);
    
    exListContainer.innerHTML = sortedEx.map(name => {
        const data = exerciseData[name];
        const avgVol = Math.round(data.totalVol / data.count);
        
        // Build mini graph (last 8 sessions)
        const history = data.history.sort((a,b) => a.date.localeCompare(b.date)).slice(-8);
        const maxVal = Math.max(...history.map(h => h.value)) || 1;
        
        const graphHTML = history.map(h => {
            const height = (h.value / maxVal) * 30; // 30px max height
            const unit = data.isBodyweight ? "reps" : "lbs";
            const color = data.isBodyweight ? '#5856d6' : '#34c759'; // Purple for BW, Green for Weights
            return `<div style="width: 12%; background: ${color}; height: ${height}px; border-radius: 2px;" title="${h.date}: ${Math.round(h.value)} ${unit}"></div>`;
        }).join('');

        return `
            <div class="exercise" style="margin-bottom: 12px; padding: 15px; border: 1px solid #eee; background: #fff; border-radius: 8px;">
                <div style="display:flex; justify-content:space-between; align-items: center; margin-bottom: 12px;">
                    <div>
                        <strong style="font-size: 1.1em; color: #333;">${name}</strong>
                        ${data.isBodyweight ? '<small style="display:block; color:#5856d6; font-size:9px; font-weight:bold;">BODYWEIGHT PROGRESSION</small>' : ''}
                    </div>
                    <div style="display: flex; align-items: flex-end; gap: 2px; height: 32px; width: 85px; background: #f4f4f4; padding: 3px; border-radius: 4px;">
                        ${graphHTML}
                    </div>
                </div>
                
                <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; text-align: center; background: #fafafa; padding: 10px; border-radius: 6px;">
                    <div>
                        <small style="color:#999; font-size:9px; display:block; text-transform:uppercase;">${data.isBodyweight ? 'Max Reps' : 'Best 1RM'}</small>
                        <strong style="font-size: 1.1em; color: #007aff;">${data.isBodyweight ? data.maxReps : Math.round(data.best1RM)}</strong>
                    </div>
                    <div>
                        <small style="color:#999; font-size:9px; display:block; text-transform:uppercase;">Avg Vol</small>
                        <strong style="font-size: 1.1em;">${avgVol.toLocaleString()}</strong>
                    </div>
                    <div>
                        <small style="color:#999; font-size:9px; display:block; text-transform:uppercase;">Logs</small>
                        <strong style="font-size: 1.1em;">${data.count}</strong>
                    </div>
                </div>
            </div>
        `;
    }).join('') || '<p style="text-align:center; padding:20px;">No exercises logged yet.</p>';
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
    // Check if there is actual data logged so you don't accidentally lose a whole workout
    const hasData = currentWorkout && currentWorkout.exercises.some(ex => 
        ex.sets.some(s => s.reps > 0 || s.weight > 0)
    );

    if (hasData) {
        if (!confirm("Are you sure? This will delete your progress for this session.")) {
            return; // Exit if they click "No"
        }
    }

    // Reset and go back
    currentWorkout = null;
    showSection('templates');
}

function renameTemplate(idx) {
    const name = prompt("New name:", templates[idx].name);
    if (name) { templates[idx].name = name; saveTemplates(); renderTemplates(); }
}

function editTemplate(idx) {
    currentEditingTemplateIndex = idx;
    showSection('edit-template');
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
        div.innerHTML = `<strong>${ex.name}</strong><div id="sets-${exIdx}"></div><button onclick="addSet(${exIdx})">+ Set</button>`;
        container.appendChild(div);
        const setsDiv = document.getElementById(`sets-${exIdx}`);
        ex.sets.forEach((set, setIdx) => {
            const row = document.createElement('div');
            row.innerHTML = `
                Set ${setIdx+1} 
                <input type="text" value="${set.weight||''}" onchange="updateSet(${exIdx},${setIdx},'weight',this.value)" style="width:60px;"> 
                <input type="number" value="${set.reps||''}" onchange="updateSet(${exIdx},${setIdx},'reps',this.value)" style="width:50px;">
                <button onclick="removeSet(${exIdx},${setIdx})" style="width:auto; background:#ff3b30;">-</button>`;
            setsDiv.appendChild(row);
        });
    });
}

function updateSet(e, s, f, v) { 
    if(f==='weight') currentWorkout.exercises[e].sets[s][f] = v.toLowerCase()==='bw' ? 'BW' : parseFloat(v)||0;
    else currentWorkout.exercises[e].sets[s][f] = parseInt(v)||0;
}
function addSet(i) { currentWorkout.exercises[i].sets.push({reps:0, weight:0}); renderActiveWorkout(); }
function removeSet(e, s) { currentWorkout.exercises[e].sets.splice(s, 1); renderActiveWorkout(); }

function finishWorkout() {
    if(confirm("Save workout?")) { workouts.unshift(currentWorkout); saveWorkouts(); currentWorkout = null; showSection('history'); }
}

function renderHistory() {
    const container = document.getElementById('workout-history');
    const searchInput = document.getElementById('history-search');
    const term = searchInput ? searchInput.value.toLowerCase() : "";
    if (!container) return;

    workouts.sort((a, b) => b.date.localeCompare(a.date));
    const filtered = workouts.filter(wk => wk.name.toLowerCase().includes(term) || wk.exercises.some(ex => ex.name.toLowerCase().includes(term)));

    container.innerHTML = '';
    filtered.forEach((wk) => {
        const idx = workouts.indexOf(wk);
        const div = document.createElement('div');
        div.className = 'exercise';
        div.style.borderLeft = "5px solid #34c759";
        const exHTML = wk.exercises.map(ex => `<div><strong>${ex.name}</strong>: <small>${ex.sets.map(s => s.weight + 'x' + s.reps).join(', ')}</small></div>`).join('');
        div.innerHTML = `
            <div style="display:flex; justify-content:space-between;">
                <div><h3 onclick="renameHistoryItem(${idx})" style="color:#007aff; cursor:pointer; margin:0;">${wk.name} ✏️</h3><small>${wk.date}</small></div>
                <button onclick="deleteHistoryItem(${idx})" style="background:none; color:#ff3b30; border:none; width:auto;">Delete</button>
            </div><hr>${exHTML}`;
        container.appendChild(div);
    });
}

function renameHistoryItem(i) { const n = prompt("Rename:", workouts[i].name); if(n) { workouts[i].name = n; saveWorkouts(); renderHistory(); } }
function deleteHistoryItem(i) { if(confirm("Delete?")) { workouts.splice(i, 1); saveWorkouts(); renderHistory(); } }

function processCSVRows(rows) {
    const grouped = {};
    rows.forEach(row => {
        const cols = row.split(',').map(c => c.trim());
        if (cols.length < 5) return;
        let [dateStr, name, set, reps, weight] = cols;
        const d = new Date(dateStr);
        const date = !isNaN(d.getTime()) ? `${d.getFullYear() <= 2001 ? 2026 : d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` : dateStr;
        if (!grouped[date]) grouped[date] = { name: "Imported Workout", date: date, exercises: [] };
        let ex = grouped[date].exercises.find(e => e.name === name);
        if (!ex) { ex = { name: name, sets: [] }; grouped[date].exercises.push(ex); }
        ex.sets.push({ weight: weight.toLowerCase()==='bw'?'BW':parseFloat(weight)||0, reps: parseInt(reps)||0 });
    });
    Object.values(grouped).forEach(wk => workouts.unshift(wk));
    saveWorkouts(); renderHistory(); alert("Imported!");
}

// This function sets the "search" value and refreshes the list
function filterHistory(category) {
    const searchInput = document.getElementById('history-search');
    if (searchInput) {
        searchInput.value = category;
        renderHistory();
    }
}

function renderHistory() {
    const container = document.getElementById('workout-history');
    const searchInput = document.getElementById('history-search');
    const term = searchInput ? searchInput.value.toLowerCase() : "";
    
    if (!container) return;

    // 1. Sort by date (Newest first)
    workouts.sort((a, b) => b.date.localeCompare(a.date));

    // 2. Filter logic: Checks workout name OR exercise names
    const filtered = workouts.filter(wk => 
        wk.name.toLowerCase().includes(term) || 
        wk.exercises.some(ex => ex.name.toLowerCase().includes(term))
    );

    container.innerHTML = '';
    
    if (filtered.length === 0) {
        container.innerHTML = `<p style="text-align:center; color:#666;">No results for "${term}"</p>`;
        return;
    }

    filtered.forEach((wk) => {
        const idx = workouts.indexOf(wk);
        const div = document.createElement('div');
        div.className = 'exercise';
        div.style.borderLeft = "5px solid #34c759";
        
        const exHTML = wk.exercises.map(ex => 
            `<div><strong>${ex.name}</strong>: <small>${ex.sets.map(s => s.weight + 'x' + s.reps).join(', ')}</small></div>`
        ).join('');

        div.innerHTML = `
            <div style="display:flex; justify-content:space-between;">
                <div>
                    <h3 onclick="renameHistoryItem(${idx})" style="color:#007aff; cursor:pointer; margin:0;">${wk.name} ✏️</h3>
                    <small>${wk.date}</small>
                </div>
                <button onclick="deleteHistoryItem(${idx})" style="background:none; color:#ff3b30; border:none; width:auto; font-size:14px;">Delete</button>
            </div>
            <hr style="border:0; border-top:1px solid #eee; margin:10px 0;">
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

function pasteAndImport() { processCSVRows(document.getElementById('csv-paste').value.split('\n')); }
function handleFileImport(e) { 
    const reader = new FileReader(); 
    reader.onload = (ev) => processCSVRows(ev.target.result.split('\n')); 
    reader.readAsText(e.target.files[0]); 
}

function handleImportFile(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedData = JSON.parse(e.target.result);
            
            // Validate that it's a real LiftLog backup
            if (!importedData.workouts && !importedData.templates) {
                throw new Error("Invalid format");
            }

            // Save to the phone's storage
            if (importedData.workouts) {
                localStorage.setItem('workouts', JSON.stringify(importedData.workouts));
            }
            if (importedData.templates) {
                localStorage.setItem('templates', JSON.stringify(importedData.templates));
            }
            
            alert("Success! Your PC history is now synced to this device.");
            location.reload(); // This refreshes the page to show your data
        } catch (err) {
            console.error(err);
            alert("Error: This file is not a valid LiftLog backup. Make sure it's the .json file from your PC.");
        }
    };
    reader.readAsText(file);
}

function exportData() {
    // 1. Get the workouts from the computer's memory
    const savedWorkouts = JSON.parse(localStorage.getItem('workouts')) || [];
    
    if (savedWorkouts.length === 0) {
        alert("No workouts found to export! Log a workout or import data first.");
        return;
    }

    // 2. Create the CSV Header (Matching your import format)
    let csvContent = "Date,Exercise,MuscleGroup,SetNumber,Weight,Reps\n";

    // 3. Convert each workout object into a text row
    savedWorkouts.forEach(w => {
        const row = [
            w.date,
            `"${w.exercise}"`, // Quotes handle names with commas
            w.muscleGroup,
            w.setNumber,
            w.weight,
            w.reps
        ].join(",");
        csvContent += row + "\n";
    });

    // 4. Create the "Download" link in the background
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", "liftlog_history.csv");
    
    // 5. Trigger the download and clean up
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}
window.onload = () => { showSection('templates'); };