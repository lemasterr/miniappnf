const tg = window.Telegram?.WebApp;
const profileInput = document.getElementById('profile');
const statusEl = document.getElementById('status');
const buttons = Array.from(document.querySelectorAll('[data-action]'));

const STORAGE_KEY = 'nodeflow-miniapp-profile';

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

function boot() {
  loadProfile();

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
