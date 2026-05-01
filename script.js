/* ═══════════════════════════════════════════════════
   AquaBot Dashboard — script.js
   Fetches data from ThingSpeak, drives all UI updates
═══════════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────
//  ▶ CONFIG — fill before opening dashboard
// ─────────────────────────────────────────
const CONFIG = {
  CHANNEL_ID:    'YOUR_CHANNEL_ID',       // e.g. '2345678'
  READ_API_KEY:  'YOUR_READ_API_KEY',     // ThingSpeak read API key
  RESULTS:       20,                      // number of feed entries to fetch
  REFRESH_MS:    10000,                   // auto-refresh interval (ms)
  MAX_RPM:       3000,                    // used to scale the arc gauge
  MAX_DIST_CM:   150,                     // used to scale bar gauges
  WASTE_WARN_CM: 30,                      // waste warning threshold
  OBS_WARN_CM:   20,                      // obstacle danger threshold

  // Set to true to run in demo mode (simulated data, no API call)
  DEMO_MODE: true,
};

// ─────────────────────────────────────────
//  DOM REFERENCES
// ─────────────────────────────────────────
const $ = id => document.getElementById(id);

const el = {
  connDot:      $('connDot'),
  connLabel:    $('connLabel'),
  lastUpdated:  $('lastUpdated'),
  countdown:    $('refreshCountdown'),
  alertStrip:   $('alertStrip'),
  alertText:    $('alertText'),
  alertClose:   $('alertClose'),
  // Waste
  wasteVal:     $('wasteVal'),
  wasteFill:    $('wasteFill'),
  wasteTag:     $('wasteTag'),
  cardWaste:    $('cardWaste'),
  // Obstacle
  obsVal:       $('obsVal'),
  obsFill:      $('obsFill'),
  obsTag:       $('obsTag'),
  cardObs:      $('cardObs'),
  // RPM
  rpmVal:       $('rpmVal'),
  rpmArc:       $('rpmArc'),
  cardRpm:      $('cardRpm'),
  // Motor
  motorStatus:  $('motorStatus'),
  motorLed:     $('motorLed'),
  motorSub:     $('motorSub'),
  // Servo
  servoStatus:  $('servoStatus'),
  servoLed:     $('servoLed'),
  servoArm:     $('servoArm'),
  servoAngle:   $('servoAngle'),
  // ThingSpeak iframes
  tsChartsRow:  $('tsChartsRow'),
  footerTime:   $('footerTime'),
};

// ─────────────────────────────────────────
//  CHART.JS SETUP
// ─────────────────────────────────────────
const MAX_POINTS = 20;

const chartDefaults = {
  animation: false,
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index', intersect: false },
  scales: {
    x: {
      ticks: { color: '#475569', maxTicksLimit: 6, maxRotation: 0, font: { size: 10 } },
      grid:  { color: 'rgba(255,255,255,0.04)' },
    },
    y: {
      ticks: { color: '#475569', font: { size: 10 } },
      grid:  { color: 'rgba(255,255,255,0.06)' },
    },
  },
  plugins: {
    legend: { display: false },
    tooltip: {
      backgroundColor: 'rgba(15,23,42,0.95)',
      borderColor: 'rgba(99,102,241,0.3)',
      borderWidth: 1,
      titleColor: '#94a3b8',
      bodyColor: '#f1f5f9',
    },
  },
};

function makeGradient(ctx, color1, color2) {
  const g = ctx.createLinearGradient(0, 0, 0, 200);
  g.addColorStop(0, color1 + '55');
  g.addColorStop(1, color2 + '00');
  return g;
}

// Distance chart
const distCtx = $('chartDist').getContext('2d');
const distChart = new Chart(distCtx, {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      {
        label: 'Waste (cm)',
        data: [],
        borderColor: '#06b6d4',
        borderWidth: 2,
        pointRadius: 3,
        pointBackgroundColor: '#06b6d4',
        fill: true,
        backgroundColor: makeGradient(distCtx, '#06b6d4', '#06b6d4'),
        tension: 0.4,
      },
      {
        label: 'Obstacle (cm)',
        data: [],
        borderColor: '#f97316',
        borderWidth: 2,
        pointRadius: 3,
        pointBackgroundColor: '#f97316',
        fill: true,
        backgroundColor: makeGradient(distCtx, '#f97316', '#f97316'),
        tension: 0.4,
      },
    ],
  },
  options: {
    ...chartDefaults,
    scales: {
      ...chartDefaults.scales,
      y: { ...chartDefaults.scales.y, min: 0 },
    },
  },
});

// RPM chart
const rpmCtx = $('chartRpm').getContext('2d');
const rpmChart = new Chart(rpmCtx, {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      {
        label: 'RPM',
        data: [],
        borderColor: '#8b5cf6',
        borderWidth: 2,
        pointRadius: 3,
        pointBackgroundColor: '#8b5cf6',
        fill: true,
        backgroundColor: makeGradient(rpmCtx, '#8b5cf6', '#8b5cf6'),
        tension: 0.4,
      },
    ],
  },
  options: {
    ...chartDefaults,
    scales: {
      ...chartDefaults.scales,
      y: { ...chartDefaults.scales.y, min: 0 },
    },
  },
});

// ─────────────────────────────────────────
//  THINGSPEAK IFRAME CHARTS
// ─────────────────────────────────────────
function injectTsCharts() {
  if (!CONFIG.CHANNEL_ID || CONFIG.CHANNEL_ID === 'YOUR_CHANNEL_ID') {
    el.tsChartsRow.innerHTML = `<p style="color:var(--text-muted);font-size:.82rem;padding:8px 0">
      Set <code style="color:var(--cyan)">CHANNEL_ID</code> &amp;
      <code style="color:var(--cyan)">READ_API_KEY</code> in <strong>script.js</strong> to enable cloud charts.</p>`;
    return;
  }
  const fieldLabels = ['Waste Distance', 'Obstacle Distance', 'Motor RPM', 'Motor Status', 'Servo Status'];
  const colors = ['00BCD4', 'FF9800', '9C27B0', '4CAF50', 'FF5722'];
  const base = `https://thingspeak.com/channels/${CONFIG.CHANNEL_ID}/charts/`;
  const params = `?api_key=${CONFIG.READ_API_KEY}&bgcolor=%23111827&color=%23FFFFFF&dynamic=true&type=line&width=auto&height=200`;

  el.tsChartsRow.innerHTML = fieldLabels.map((label, i) => `
    <div class="ts-iframe-wrap" title="${label}">
      <iframe src="${base}${i + 1}${params}&title=${encodeURIComponent(label)}" loading="lazy"></iframe>
    </div>`).join('');
}

// ─────────────────────────────────────────
//  CONNECTION STATE
// ─────────────────────────────────────────
function setOnline(online) {
  el.connDot.className = 'conn-dot ' + (online ? 'online' : 'offline');
  el.connLabel.textContent = online ? 'Live' : 'Offline';
}

// ─────────────────────────────────────────
//  ALERT SYSTEM
// ─────────────────────────────────────────
const activeAlerts = new Set();

function showAlert(msg) {
  activeAlerts.add(msg);
  el.alertText.textContent = [...activeAlerts].join('  |  ');
  el.alertStrip.hidden = false;
}
function clearAlert(msg) {
  activeAlerts.delete(msg);
  if (activeAlerts.size === 0) el.alertStrip.hidden = true;
  else el.alertText.textContent = [...activeAlerts].join('  |  ');
}
el.alertClose.addEventListener('click', () => {
  activeAlerts.clear();
  el.alertStrip.hidden = true;
});

// ─────────────────────────────────────────
//  ANIMATED NUMBER UPDATE
// ─────────────────────────────────────────
function animateValue(el_, value, decimals = 0) {
  el_.classList.remove('updated');
  void el_.offsetWidth; // reflow
  el_.textContent = isNaN(value) ? '—' : value.toFixed(decimals);
  el_.classList.add('updated');
}

// ─────────────────────────────────────────
//  SVG ARC HELPER  (RPM radial gauge)
//  Full arc = 173px dasharray (semicircle)
// ─────────────────────────────────────────
function updateRpmArc(rpm) {
  const pct = Math.min(rpm / CONFIG.MAX_RPM, 1);
  const offset = 173 - pct * 173;
  el.rpmArc.style.strokeDashoffset = offset;
}

// ─────────────────────────────────────────
//  SERVO ARM SVG HELPER
// ─────────────────────────────────────────
function updateServoArm(angleDeg) {
  // Arm pivots at (50,55). At 0° arm points straight up (50,15). At 90° it points right.
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  const len = 40;
  const x2 = 50 + Math.cos(rad) * len;
  const y2 = 55 + Math.sin(rad) * len;
  el.servoArm.setAttribute('x2', x2.toFixed(1));
  el.servoArm.setAttribute('y2', y2.toFixed(1));
}

// ─────────────────────────────────────────
//  PUSH DATA TO CHARTS
// ─────────────────────────────────────────
function pushToCharts(label, waste, obs, rpm) {
  function pushPoint(chart, datasetIdx, value) {
    chart.data.datasets[datasetIdx].data.push(value);
    if (chart.data.datasets[datasetIdx].data.length > MAX_POINTS)
      chart.data.datasets[datasetIdx].data.shift();
  }
  // distance chart labels (shared)
  distChart.data.labels.push(label);
  if (distChart.data.labels.length > MAX_POINTS) distChart.data.labels.shift();
  pushPoint(distChart, 0, waste);
  pushPoint(distChart, 1, obs);
  distChart.update();

  rpmChart.data.labels.push(label);
  if (rpmChart.data.labels.length > MAX_POINTS) rpmChart.data.labels.shift();
  pushPoint(rpmChart, 0, rpm);
  rpmChart.update();
}

// ─────────────────────────────────────────
//  APPLY PARSED DATA TO UI
// ─────────────────────────────────────────
function applyData(d) {
  const { waste, obs, rpm, motorOn, servoOpen, label } = d;

  // Waste
  animateValue(el.wasteVal, waste, 1);
  el.wasteFill.style.width = Math.min((waste / CONFIG.MAX_DIST_CM) * 100, 100) + '%';
  const wasteWarn = waste > 0 && waste < CONFIG.WASTE_WARN_CM;
  el.wasteTag.textContent = wasteWarn ? '⚠️ Waste Nearby!' : waste < 0 ? 'No Reading' : 'Normal';
  el.wasteTag.classList.toggle('card-tag--danger', wasteWarn);

  // Obstacle
  animateValue(el.obsVal, obs, 1);
  el.obsFill.style.width = Math.min((obs / CONFIG.MAX_DIST_CM) * 100, 100) + '%';
  const obsDanger = obs > 0 && obs < CONFIG.OBS_WARN_CM;
  el.obsTag.textContent = obsDanger ? '🚨 Obstacle! < 20 cm' : obs < 0 ? 'No Reading' : 'Clear';
  el.obsTag.classList.toggle('card-tag--danger', obsDanger);
  el.cardObs.classList.toggle('card--danger', obsDanger);

  if (obsDanger)  showAlert('🚨 Obstacle detected < 20 cm — Robot may have stopped!');
  else            clearAlert('🚨 Obstacle detected < 20 cm — Robot may have stopped!');
  if (wasteWarn)  showAlert('♻️ Waste object within 30 cm — collection active!');
  else            clearAlert('♻️ Waste object within 30 cm — collection active!');

  // RPM
  animateValue(el.rpmVal, rpm, 0);
  updateRpmArc(rpm);

  // Motor
  el.motorStatus.textContent = motorOn ? 'ON' : 'OFF';
  el.motorLed.className = 'status-led ' + (motorOn ? 'on-led' : 'off-led');
  el.motorSub.textContent = motorOn ? 'Running at ' + Math.round(rpm) + ' RPM' : 'Motor is idle';

  // Servo
  const angle = servoOpen ? 90 : 0;
  el.servoStatus.textContent = servoOpen ? 'Open' : 'Closed';
  el.servoLed.className = 'status-led ' + (servoOpen ? 'open-led' : 'closed-led');
  el.servoAngle.textContent = angle + '°';
  updateServoArm(angle);

  // Charts
  pushToCharts(label, waste, obs, rpm);

  // Timestamps
  const now = new Date();
  el.lastUpdated.textContent = 'Updated ' + now.toLocaleTimeString();
  el.footerTime.textContent = now.toLocaleDateString(undefined, { weekday:'short', year:'numeric', month:'short', day:'numeric' });
}

// ─────────────────────────────────────────
//  THINGSPEAK FETCH
// ─────────────────────────────────────────
async function fetchThingSpeak() {
  const url = `https://api.thingspeak.com/channels/${CONFIG.CHANNEL_ID}/feeds.json`
            + `?api_key=${CONFIG.READ_API_KEY}&results=${CONFIG.RESULTS}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function parseThingSpeakFeed(json) {
  const feeds = json.feeds;
  if (!feeds || feeds.length === 0) throw new Error('No feed data');

  // Populate all history points into charts first
  const entries = feeds.map(f => ({
    waste:    parseFloat(f.field1) || 0,
    obs:      parseFloat(f.field2) || 0,
    rpm:      parseFloat(f.field3) || 0,
    motorOn:  parseInt(f.field4)   === 1,
    servoOpen:parseInt(f.field5)   === 1,
    label:    new Date(f.created_at).toLocaleTimeString(),
  }));

  return entries;
}

// ─────────────────────────────────────────
//  DEMO DATA GENERATOR
// ─────────────────────────────────────────
let _demoT = 0;
function demoData() {
  _demoT += 0.12;
  return {
    waste:     40 + Math.sin(_demoT * 0.7) * 25 + Math.random() * 5,
    obs:       55 + Math.cos(_demoT * 0.5) * 30 + Math.random() * 5,
    rpm:       Math.max(0, 1200 + Math.sin(_demoT) * 800 + Math.random() * 100),
    motorOn:   Math.sin(_demoT) > -0.5,
    servoOpen: Math.sin(_demoT * 0.3) > 0,
    label:     new Date().toLocaleTimeString(),
  };
}

// ─────────────────────────────────────────
//  MAIN REFRESH LOOP
// ─────────────────────────────────────────
let refreshTimer  = null;
let countdownVal  = CONFIG.REFRESH_MS / 1000;
let countdownTimer = null;

function startCountdown() {
  clearInterval(countdownTimer);
  countdownVal = CONFIG.REFRESH_MS / 1000;
  el.countdown.textContent = `⟳ ${countdownVal}s`;
  countdownTimer = setInterval(() => {
    countdownVal--;
    el.countdown.textContent = `⟳ ${Math.max(0, countdownVal)}s`;
  }, 1000);
}

async function refresh() {
  try {
    if (CONFIG.DEMO_MODE) {
      // push one new demo point per tick
      applyData(demoData());
      setOnline(true);
    } else {
      const json    = await fetchThingSpeak();
      const entries = parseThingSpeakFeed(json);
      // Only apply the latest entry to the cards; all entries already pushed to charts above
      // For simplicity, reset charts and repopulate
      distChart.data.labels = [];
      distChart.data.datasets[0].data = [];
      distChart.data.datasets[1].data = [];
      rpmChart.data.labels = [];
      rpmChart.data.datasets[0].data = [];

      entries.forEach(e => {
        distChart.data.labels.push(e.label);
        distChart.data.datasets[0].data.push(e.waste);
        distChart.data.datasets[1].data.push(e.obs);
        rpmChart.data.labels.push(e.label);
        rpmChart.data.datasets[0].data.push(e.rpm);
      });
      distChart.update();
      rpmChart.update();

      applyData(entries[entries.length - 1]);
      setOnline(true);
    }
  } catch (err) {
    console.error('[AquaBot]', err.message);
    setOnline(false);
  }
  startCountdown();
}

// ─────────────────────────────────────────
//  INIT
// ─────────────────────────────────────────
function init() {
  injectTsCharts();
  refresh();
  refreshTimer = setInterval(refresh, CONFIG.REFRESH_MS);

  // Footer clock
  setInterval(() => {
    el.footerTime.textContent = new Date().toLocaleDateString(undefined,
      { weekday:'short', year:'numeric', month:'short', day:'numeric' });
  }, 60000);

  console.log(`%c🚤 AquaBot Dashboard`, 'color:#06b6d4;font-weight:700;font-size:14px');
  console.log(`%cMode: ${CONFIG.DEMO_MODE ? 'DEMO' : 'LIVE'} | Refresh: ${CONFIG.REFRESH_MS}ms`, 'color:#94a3b8');
}


// ═══════════════════════════════════════════════════════
//  CONFIGURATION PANEL MODULE
//  Reads / writes localStorage, patches CONFIG at runtime,
//  and hot-restarts the refresh loop when settings change.
//  All IDs match the new HTML block in index.html.
// ═══════════════════════════════════════════════════════
const ConfigPanel = (() => {

  // localStorage key prefix
  const LS = {
    CHANNEL_ID:   'aquabot_channel_id',
    READ_API_KEY: 'aquabot_read_api_key',
    BLYNK_TOKEN:  'aquabot_blynk_token',
    DEMO_MODE:    'aquabot_demo_mode',
  };

  // ── Toast helper ──
  function toast(msg, type = 'ok') {
    const t = $('cfgToast');
    if (!t) return;
    t.textContent = msg;
    t.className = `cfg-toast toast--${type} show`;
    clearTimeout(t._tid);
    t._tid = setTimeout(() => { t.classList.remove('show'); }, 3500);
  }

  // ── Validate a single field; mark it red on error ──
  function validate(inputEl, label) {
    const v = inputEl.value.trim();
    if (!v) {
      inputEl.classList.add('cfg-error');
      return null;
    }
    inputEl.classList.remove('cfg-error');
    return v;
  }

  // ── Patch the live CONFIG object so the running app uses new values ──
  function applyToConfig(channelId, readKey, demoMode) {
    CONFIG.CHANNEL_ID   = channelId;
    CONFIG.READ_API_KEY = readKey;
    CONFIG.DEMO_MODE    = demoMode;
  }

  // ── Restart the polling loop with current CONFIG ──
  function restartLoop() {
    clearInterval(refreshTimer);
    clearInterval(countdownTimer);
    refresh();                                          // immediate first tick
    refreshTimer = setInterval(refresh, CONFIG.REFRESH_MS);
    injectTsCharts();                                   // re-render cloud charts
  }

  // ── Save button handler ──
  function onSave() {
    const chEl  = $('cfgChannelId');
    const rkEl  = $('cfgReadKey');
    const btEl  = $('cfgBlynkToken');
    const demoMode = CONFIG.DEMO_MODE;                  // read current mode

    // When live mode is active, all three fields are required
    let hasError = false;

    if (!demoMode) {
      if (!validate(chEl,  'Channel ID'))   hasError = true;
      if (!validate(rkEl,  'Read API Key')) hasError = true;
    }
    // Blynk token is optional (dashboard is read-only); still trim
    if (btEl) btEl.classList.remove('cfg-error');

    if (hasError) {
      toast('⚠️ Please fill in the required fields (highlighted in red).', 'err');
      return;
    }

    const channelId = chEl  ? chEl.value.trim()  : '';
    const readKey   = rkEl  ? rkEl.value.trim()  : '';
    const blynkTok  = btEl  ? btEl.value.trim()  : '';

    // Persist
    localStorage.setItem(LS.CHANNEL_ID,   channelId);
    localStorage.setItem(LS.READ_API_KEY, readKey);
    localStorage.setItem(LS.BLYNK_TOKEN,  blynkTok);
    localStorage.setItem(LS.DEMO_MODE,    demoMode ? '1' : '0');

    // Apply to runtime
    applyToConfig(channelId, readKey, demoMode);
    restartLoop();

    const modeLabel = demoMode ? 'Demo' : 'Live (ThingSpeak)';
    toast(`✅ Saved! Running in ${modeLabel} mode.`, 'ok');
    console.log(`[Config] Saved — Channel: ${channelId || '—'} | Mode: ${modeLabel}`);
  }

  // ── Clear button handler ──
  function onClear() {
    Object.values(LS).forEach(k => localStorage.removeItem(k));
    [$('cfgChannelId'), $('cfgReadKey'), $('cfgBlynkToken')].forEach(el_ => {
      if (el_) { el_.value = ''; el_.classList.remove('cfg-error'); }
    });
    // Revert to demo mode
    applyToConfig('YOUR_CHANNEL_ID', 'YOUR_READ_API_KEY', true);
    setDemoBtn(true);
    restartLoop();
    toast('🗑️ Configuration cleared. Running in Demo mode.', 'ok');
  }

  // ── Mode toggle buttons ──
  function setDemoBtn(isDemo) {
    const liveBtn = $('btnModeLive');
    const demoBtn = $('btnModeDemo');
    if (!liveBtn || !demoBtn) return;
    liveBtn.classList.toggle('active', !isDemo);
    demoBtn.classList.toggle('active',  isDemo);
    CONFIG.DEMO_MODE = isDemo;
  }

  function bindModeButtons() {
    const liveBtn = $('btnModeLive');
    const demoBtn = $('btnModeDemo');
    if (liveBtn) liveBtn.addEventListener('click', () => setDemoBtn(false));
    if (demoBtn) demoBtn.addEventListener('click', () => setDemoBtn(true));
  }

  // ── Load saved values from localStorage into inputs & CONFIG ──
  function loadSaved() {
    const channelId = localStorage.getItem(LS.CHANNEL_ID)   || '';
    const readKey   = localStorage.getItem(LS.READ_API_KEY) || '';
    const blynkTok  = localStorage.getItem(LS.BLYNK_TOKEN)  || '';
    const demoMode  = localStorage.getItem(LS.DEMO_MODE) !== '0'; // default: demo

    const chEl  = $('cfgChannelId');
    const rkEl  = $('cfgReadKey');
    const btEl  = $('cfgBlynkToken');

    if (chEl) chEl.value = channelId;
    if (rkEl) rkEl.value = readKey;
    if (btEl) btEl.value = blynkTok;

    // Apply to running CONFIG only if real values exist
    if (channelId && readKey) {
      applyToConfig(channelId, readKey, demoMode);
    } else {
      CONFIG.DEMO_MODE = true;          // fall back to demo if no credentials
    }

    setDemoBtn(CONFIG.DEMO_MODE);

    if (channelId && readKey) {
      const mode = CONFIG.DEMO_MODE ? 'Demo' : 'Live';
      console.log(`[Config] Loaded from localStorage — Channel: ${channelId} | Mode: ${mode}`);
    }
  }

  // ── Public init ──
  function init() {
    bindModeButtons();
    loadSaved();

    const saveBtn  = $('cfgSaveBtn');
    const clearBtn = $('cfgClearBtn');
    if (saveBtn)  saveBtn.addEventListener('click',  onSave);
    if (clearBtn) clearBtn.addEventListener('click', onClear);
  }

  return { init };
})();

// ── Boot both systems ──
document.addEventListener('DOMContentLoaded', () => {
  ConfigPanel.init();   // load localStorage FIRST so CONFIG is ready
  init();               // then start charts + polling with correct CONFIG
});
