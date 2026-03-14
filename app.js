const tg = window.Telegram?.WebApp;
const profileInput = document.getElementById('profile');
const statusEl = document.getElementById('status');
const buttons = Array.from(document.querySelectorAll('[data-action]'));
const metricsEl = document.getElementById('metrics');
const snapshotMetaEl = document.getElementById('snapshot-meta');
const sessionListEl = document.getElementById('session-list');
const eventFeedEl = document.getElementById('event-feed');
const incidentFeedEl = document.getElementById('incident-feed');
const presetListEl = document.getElementById('preset-list');

const STORAGE_KEY = 'nodeflow-miniapp-profile';
const API_STORAGE_KEY = 'nodeflow-miniapp-api';
const SNAPSHOT_STORAGE_KEY = 'nodeflow-miniapp-last-snapshot';
const SNAPSHOT_POLL_MS = 30000;
let snapshotPollTimer = null;
let snapshotPollInFlight = false;

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

function saveSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return;
  try {
    localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {}
}

function loadStoredSnapshot() {
  try {
    const raw = localStorage.getItem(SNAPSHOT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
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
  const targetLabel = profile ? ` for ${profile}` : '';
  setStatus(`Sent "${action}"${targetLabel} to the bot. Telegram will return the result as a chat message.`, 'success');
}

function sendPresetAction(presetId, presetName) {
  if (!tg) {
    setStatus('Telegram WebApp SDK is unavailable. Open this page from Telegram.', 'error');
    return;
  }

  const payload = {
    source: 'nodeflow-miniapp',
    version: 1,
    action: 'run_preset',
    presetId,
    requestedAt: Date.now(),
  };

  tg.HapticFeedback?.impactOccurred?.('light');
  tg.sendData(JSON.stringify(payload));
  setStatus(`Sent workflow preset "${presetName}" to the bot.`, 'success');
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

function formatTargetHost(targetUrl) {
  if (!targetUrl) return '';
  try {
    const url = new URL(targetUrl);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function decodeSnapshot() {
  const params = new URLSearchParams(window.location.search);
  const rawState = params.get('state');
  if (!rawState) return null;
  try {
    const json = atob(rawState.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(json);
    saveSnapshot(parsed);
    return parsed;
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

function getSnapshotProgress(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;

  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const activeSessions = sessions.filter((session) => Number(session.progressTotal || 0) > 0);
  if (activeSessions.length > 0) {
    const total = activeSessions.reduce((sum, session) => sum + Number(session.progressTotal || 0), 0);
    const current = activeSessions.reduce((sum, session) => sum + Number(session.progressCurrent || 0), 0);
    const percent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;
    return {
      label: 'Session Progress',
      current,
      total,
      percent,
    };
  }

  const checkpointTotal = Number(snapshot.checkpoint?.totalSteps || 0);
  const checkpointCurrent = Number(snapshot.checkpoint?.completedSteps || 0);
  if (checkpointTotal > 0) {
    const percent = Math.max(0, Math.min(100, Math.round((checkpointCurrent / checkpointTotal) * 100)));
    return {
      label: 'Workflow Progress',
      current: checkpointCurrent,
      total: checkpointTotal,
      percent,
    };
  }

  return null;
}

function renderMetrics(snapshot) {
  if (!metricsEl) return;
  if (!snapshot) {
    metricsEl.innerHTML = '';
    return;
  }

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

  const progress = getSnapshotProgress(snapshot);
  const progressMarkup = progress ? `
    <div class="metric-card metric-progress">
      <div class="metric-label">${progress.label}</div>
      <div class="metric-progress-head">
        <div class="metric-value">${progress.percent}%</div>
        <div class="metric-sub">${progress.current}/${progress.total}</div>
      </div>
      <div class="progress-line progress-line-strong">
        <span style="width:${progress.percent}%"></span>
      </div>
    </div>
  ` : '';

  metricsEl.innerHTML = metrics.map((metric) => `
    <div class="metric-card">
      <div class="metric-label">${metric.label}</div>
      <div class="metric-value">${metric.value}</div>
      <div class="metric-sub">${metric.sub}</div>
    </div>
  `).join('') + progressMarkup;
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
    ? `Snapshot captured at ${generatedAt.toLocaleTimeString()}. Auto-refresh checks run every 30 seconds while this Mini App stays open.`
    : 'Snapshot loaded. Live refresh checks run every 30 seconds while this Mini App stays open.';

  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  if (sessions.length === 0) {
    sessionListEl.innerHTML = '<div class="hint">No session data in the current snapshot.</div>';
    return;
  }

  sessionListEl.innerHTML = sessions.map((session) => {
    const total = Number(session.progressTotal || 0);
    const current = Number(session.progressCurrent || 0);
    const progressPercent = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;
    const timerDuration = Number(session.timerDurationMs || 0);
    const timerRemaining = Number(session.timerRemainingMs || 0);
    const timerPercent = timerDuration > 0 ? Math.max(0, Math.min(100, Math.round(((timerDuration - timerRemaining) / timerDuration) * 100))) : 0;
    return `
      <div class="session-card" data-session-name="${String(session.name || '').replace(/"/g, '&quot;')}">
        <div class="session-head">
          <div class="session-name">${session.name}</div>
          <div class="metric-sub">${total > 0 ? `${current}/${total}` : 'idle'}</div>
        </div>
        <div class="session-kpis">
          <span>${session.promptCount || 0} prompts</span>
          <span>${session.downloadedCount || 0} downloads</span>
        </div>
        ${(session.activeAction || session.selectorId) ? `
          <div class="session-detail-row">
            ${session.activeAction ? `<span class="session-chip">${session.activeAction}</span>` : ''}
            ${session.selectorId ? `<span class="session-chip session-chip-mono">${session.selectorId}</span>` : ''}
            ${session.targetUrl ? `<span class="session-chip">${formatTargetHost(session.targetUrl)}</span>` : ''}
          </div>
        ` : ''}
        ${total > 0 ? `<div class="progress-line"><span style="width:${progressPercent}%"></span></div>` : ''}
        ${timerDuration > 0 ? `
          <div class="session-timer">
            <div class="session-timer-head">
              <span>${session.timerLabel || 'Timer'}</span>
              <span>${Math.ceil(timerRemaining / 1000)}s</span>
            </div>
            <div class="progress-line progress-line-muted"><span style="width:${timerPercent}%"></span></div>
          </div>
        ` : ''}
        <div class="session-msg">${session.message || 'Idle'}</div>
      </div>
    `;
  }).join('');

  Array.from(sessionListEl.querySelectorAll('[data-session-name]')).forEach((card) => {
    card.addEventListener('click', () => {
      const sessionName = card.getAttribute('data-session-name');
      if (!sessionName) return;
      profileInput.value = sessionName;
      saveProfile();
      setStatus(`Selected session ${sessionName}.`, 'success');
      tg?.HapticFeedback?.selectionChanged?.();
    });
  });
}

function renderPresets(snapshot) {
  if (!presetListEl) return;
  const presets = Array.isArray(snapshot?.presets) ? snapshot.presets : [];
  if (presets.length === 0) {
    presetListEl.innerHTML = '<div class="hint">No saved presets found yet. Save a workflow preset in Automator first.</div>';
    return;
  }

  presetListEl.innerHTML = presets.slice(0, 8).map((preset) => `
    <button class="preset-action" data-preset-id="${preset.id}" data-preset-name="${String(preset.name || '').replace(/"/g, '&quot;')}">
      <span class="preset-name">${preset.name}</span>
      <span class="preset-meta">${preset.stepCount || 0} steps · ${preset.nodeCount || 0} nodes</span>
    </button>
  `).join('');

  Array.from(presetListEl.querySelectorAll('[data-preset-id]')).forEach((button) => {
    button.addEventListener('click', () => {
      const presetId = button.getAttribute('data-preset-id');
      const presetName = button.getAttribute('data-preset-name') || 'Preset';
      if (!presetId) return;
      sendPresetAction(presetId, presetName);
    });
  });
}

function renderEventFeed(snapshot) {
  if (!eventFeedEl) return;
  const events = Array.isArray(snapshot?.recentEvents) ? snapshot.recentEvents : [];
  if (events.length === 0) {
    eventFeedEl.innerHTML = '<div class="hint">No recent runtime events yet.</div>';
    return;
  }

  eventFeedEl.innerHTML = events.map((event) => `
    <div class="feed-item">
      <div class="feed-head">
        <span class="feed-title">${event.sessionName || event.scope || 'Runtime'}</span>
        <span class="feed-time">${new Date(event.timestamp).toLocaleTimeString()}</span>
      </div>
      <div class="feed-meta">
        <span class="feed-pill">${event.status}</span>
        ${event.action ? `<span class="feed-pill">${event.action}</span>` : ''}
        ${event.selectorId ? `<span class="feed-pill feed-pill-mono">${event.selectorId}</span>` : ''}
        ${event.targetUrl ? `<span class="feed-pill">${formatTargetHost(event.targetUrl)}</span>` : ''}
      </div>
      <div class="feed-message">${event.message || 'Runtime update'}${event.detail ? `<br><span class="hint">${event.detail}</span>` : ''}</div>
    </div>
  `).join('');
}

function renderIncidentFeed(snapshot) {
  if (!incidentFeedEl) return;
  const incidents = Array.isArray(snapshot?.recentIncidents) ? snapshot.recentIncidents : [];
  if (incidents.length === 0) {
    incidentFeedEl.innerHTML = '<div class="hint">No incidents in the current snapshot.</div>';
    return;
  }

  incidentFeedEl.innerHTML = incidents.map((incident) => `
    <div class="feed-item feed-item-incident">
      <div class="feed-head">
        <span class="feed-title">${incident.sessionName || 'Workflow'}</span>
        <span class="feed-time">${new Date(incident.timestamp).toLocaleTimeString()}</span>
      </div>
      <div class="feed-meta">
        <span class="feed-pill feed-pill-danger">${incident.status}</span>
        ${incident.action ? `<span class="feed-pill">${incident.action}</span>` : ''}
        ${incident.errorCode ? `<span class="feed-pill feed-pill-mono">${incident.errorCode}</span>` : ''}
        ${incident.targetUrl ? `<span class="feed-pill">${formatTargetHost(incident.targetUrl)}</span>` : ''}
      </div>
      <div class="feed-message">${incident.message || 'Incident detected'}${incident.detail ? `<br><span class="hint">${incident.detail}</span>` : ''}</div>
    </div>
  `).join('');
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
    if (snapshotPollInFlight) return;
    snapshotPollInFlight = true;
    try {
      const snapshot = await fetchLiveSnapshot(apiUrl);
      if (snapshot) {
        saveSnapshot(snapshot);
        renderMetrics(snapshot);
        renderSessions(snapshot);
        renderPresets(snapshot);
        renderEventFeed(snapshot);
        renderIncidentFeed(snapshot);
        setStatus('Live runtime snapshot synced from public API.', 'success');
      } else {
        const cachedSnapshot = loadStoredSnapshot();
        if (cachedSnapshot) {
          renderMetrics(cachedSnapshot);
          renderSessions(cachedSnapshot);
          renderPresets(cachedSnapshot);
          renderEventFeed(cachedSnapshot);
          renderIncidentFeed(cachedSnapshot);
          snapshotMetaEl.textContent = 'Live API is reachable, but no fresh desktop snapshot has been published yet. Showing the last cached runtime snapshot.';
          setStatus('Showing last cached snapshot while waiting for the desktop publisher.', 'success');
        } else {
          snapshotMetaEl.textContent = 'Public API is reachable, but no desktop snapshot has been published yet. Live sync checks every 30 seconds. Check that Nodeflow is running, Public Snapshot is enabled, and WRITE_SECRET matches the Worker secret.';
        }
      }
    } catch (error) {
      const cachedSnapshot = loadStoredSnapshot();
      if (cachedSnapshot) {
        renderMetrics(cachedSnapshot);
        renderSessions(cachedSnapshot);
        renderPresets(cachedSnapshot);
        renderEventFeed(cachedSnapshot);
        renderIncidentFeed(cachedSnapshot);
        snapshotMetaEl.textContent = `Public API sync failed: ${error.message}. Showing the last cached snapshot instead.`;
        setStatus('Using cached runtime snapshot while the public API is unavailable.', 'error');
      } else {
        snapshotMetaEl.textContent = `Public API sync failed: ${error.message}`;
        setStatus('Public snapshot API is configured but not responding.', 'error');
      }
    } finally {
      snapshotPollInFlight = false;
    }
  };

  void run();
  snapshotPollTimer = window.setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    void run();
  }, SNAPSHOT_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void run();
    }
  });
}

function boot() {
  loadProfile();
  const snapshot = decodeSnapshot() || loadStoredSnapshot();
  renderMetrics(snapshot);
  renderSessions(snapshot);
  renderPresets(snapshot);
  renderEventFeed(snapshot);
  renderIncidentFeed(snapshot);
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
