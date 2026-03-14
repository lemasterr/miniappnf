const tg = window.Telegram?.WebApp;
const profileInput = document.getElementById('profile');
const statusEl = document.getElementById('status');
const buttons = Array.from(document.querySelectorAll('[data-action]'));
const metricsEl = document.getElementById('metrics');
const snapshotMetaEl = document.getElementById('snapshot-meta');
const sessionListEl = document.getElementById('session-list');

const STORAGE_KEY = 'nodeflow-miniapp-profile';
const API_STORAGE_KEY = 'nodeflow-miniapp-api';
const SNAPSHOT_POLL_MS = 15000;
let snapshotPollTimer = null;

function setStatus(message, tone) {
  statusEl.textContent = message;
  statusEl.style.borderColor =
    tone === 'error' ? 'rgba(255,107,107,0.35)' :
    tone === 'success' ? 'rgba(53,214,160,0.35)' :
    'rgba(86,102,122,0.24)';
  statusEl.style.color =
    tone === 'error' ? '#ffb6b6' :
    tone === 'success' ? '#b8ffe2' :
    '#98a7bb';
}

function getProfile() {
  return (profileInput.value || '').trim();
}

function saveProfile() {
  try {
    localStorage.setItem(STORAGE_KEY, getProfile());
  } catch {}
}

function loadProfile() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value) {
      profileInput.value = value;
    }
  } catch {}
}

function normalizeApiUrl(rawValue) {
  const value = (rawValue || '').trim();
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function loadStoredApiUrl() {
  try {
    return normalizeApiUrl(localStorage.getItem(API_STORAGE_KEY));
  } catch {
    return null;
  }
}

function saveApiUrl(apiUrl) {
  if (!apiUrl) return;
  try {
    localStorage.setItem(API_STORAGE_KEY, apiUrl);
  } catch {}
}

function sendAction(action) {
  if (!tg) {
    setStatus('Telegram WebApp SDK is unavailable. Open this page from Telegram.', 'error');
    return;
  }

  const profile = getProfile();
  if ((action === 'run' || action === 'download') && !profile) {
    setStatus('Profile is required for run/download.', 'error');
    tg.HapticFeedback?.notificationOccurred?.('error');
    return;
  }

  saveProfile();

  const payload = {
    source: 'nodeflow-miniapp',
    version: 1,
    action,
    profile: profile || undefined,
    requestedAt: Date.now(),
  };

  tg.HapticFeedback?.impactOccurred?.('light');
  tg.sendData(JSON.stringify(payload));
  setStatus(`Sent "${action}" to the bot. Telegram will return the result as a chat message.`, 'success');
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function decodeSnapshot() {
  const params = new URLSearchParams(window.location.search);
  const rawState = params.get('state');
  if (!rawState) return null;
  try {
    const json = atob(rawState.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function resolveSnapshotApiUrl() {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = normalizeApiUrl(params.get('api'));
  if (fromQuery) {
    saveApiUrl(fromQuery);
    return fromQuery;
  }
  return loadStoredApiUrl();
}

function unwrapSnapshotPayload(payload) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'snapshot' in payload) {
    return payload.snapshot;
  }
  return payload;
}

function renderMetrics(snapshot) {
  if (!snapshot || !metricsEl) return;
  const metrics = [
    {
      label: 'Prompts Left',
      value: snapshot.totals?.promptCount ?? 0,
      sub: `${snapshot.totals?.sessions ?? 0} sessions`,
    },
    {
      label: 'Downloads',
      value: snapshot.totals?.downloadedCount ?? 0,
      sub: `${snapshot.totals?.activeTasks ?? 0} active tasks`,
    },
    {
      label: 'CPU',
      value: `${snapshot.resources?.cpu ?? 0}%`,
      sub: formatBytes(snapshot.resources?.ramUsed ?? 0),
    },
    {
      label: 'Checkpoint',
      value: snapshot.checkpoint?.active
        ? `${snapshot.checkpoint?.completedSteps ?? 0}/${snapshot.checkpoint?.totalSteps ?? 0}`
        : 'Idle',
      sub: snapshot.checkpoint?.status || 'idle',
    },
  ];

  metricsEl.innerHTML = metrics.map((metric) => `
    <div class="metric-card">
      <div class="metric-label">${metric.label}</div>
      <div class="metric-value">${metric.value}</div>
      <div class="metric-sub">${metric.sub}</div>
    </div>
  `).join('');
}

function renderSessions(snapshot) {
  if (!sessionListEl || !snapshotMetaEl) return;

  if (!snapshot) {
    snapshotMetaEl.textContent = 'Open via /miniapp or connect the public snapshot API to load runtime state.';
    sessionListEl.innerHTML = '';
    return;
  }

  const generatedAt = snapshot.generatedAt ? new Date(snapshot.generatedAt) : null;
  snapshotMetaEl.textContent = generatedAt
    ? `Snapshot captured at ${generatedAt.toLocaleTimeString()}. Reopen with /miniapp to refresh.`
    : 'Snapshot loaded.';

  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  if (sessions.length === 0) {
    sessionListEl.innerHTML = '<div class="hint">No session data in the current snapshot.</div>';
    return;
  }

  sessionListEl.innerHTML = sessions.map((session) => {
    const total = Number(session.progressTotal || 0);
    const current = Number(session.progressCurrent || 0);
    const progressPercent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;
    return `
      <div class="session-card">
        <div class="session-head">
          <div class="session-name">${session.name}</div>
          <div class="metric-sub">${total > 0 ? `${current}/${total}` : 'idle'}</div>
        </div>
        <div class="session-kpis">
          <span>${session.promptCount || 0} prompts</span>
          <span>${session.downloadedCount || 0} downloads</span>
        </div>
        ${total > 0 ? `<div class="progress-line"><span style="width:${progressPercent}%"></span></div>` : ''}
        <div class="session-msg">${session.message || 'Idle'}</div>
      </div>
    `;
  }).join('');
}

async function fetchLiveSnapshot(apiUrl) {
  const response = await fetch(apiUrl, {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Snapshot API returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  return unwrapSnapshotPayload(payload);
}

function startSnapshotPolling() {
  const apiUrl = resolveSnapshotApiUrl();
  if (!apiUrl) return;

  const run = async () => {
    try {
      const snapshot = await fetchLiveSnapshot(apiUrl);
      if (snapshot) {
        renderMetrics(snapshot);
        renderSessions(snapshot);
        setStatus('Live runtime snapshot synced from public API.', 'success');
      } else {
        snapshotMetaEl.textContent = 'Public API is reachable, but no desktop snapshot has been published yet.';
      }
    } catch (error) {
      snapshotMetaEl.textContent = `Public API sync failed: ${error.message}`;
      setStatus('Public snapshot API is configured but not responding.', 'error');
    }
  };

  void run();
  snapshotPollTimer = window.setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    void run();
  }, SNAPSHOT_POLL_MS);
}

function boot() {
  loadProfile();
  const snapshot = decodeSnapshot();
  renderMetrics(snapshot);
  renderSessions(snapshot);
  startSnapshotPolling();

  if (!tg) {
    setStatus('Open this page from the Telegram bot launcher to use the Mini App.', 'error');
    return;
  }

  tg.ready();
  tg.expand();
  tg.MainButton.setText('Send Current Action');
  tg.MainButton.hide();

  const themeBg = tg.themeParams?.bg_color;
  if (themeBg) {
    document.documentElement.style.backgroundColor = themeBg;
  }

  profileInput.addEventListener('input', saveProfile);
  buttons.forEach((button) => {
    button.addEventListener('click', () => sendAction(button.dataset.action));
  });

  setStatus('Ready. Choose an action to send it to Nodeflow desktop.', 'success');
}

boot();
