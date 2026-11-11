(() => {
  'use strict';

  const statusSub = document.getElementById('status-sub');
  const modePill = document.getElementById('mode-pill');
  const stTrack = document.getElementById('st-track');
  const stEp = document.getElementById('st-ep');
  const stTop = document.getElementById('st-top');
  const stMem = document.getElementById('st-mem');
  const connectedActions = document.getElementById('connected-actions');
  const disconnectedActions = document.getElementById('disconnected-actions');

  let activeTabId = null;

  async function queryGameFrame() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    activeTabId = tab.id;

    try {
      const res = await chrome.tabs.sendMessage(tab.id, {
        __polypilotPopup: true,
        action: 'GET_STATUS'
      });

      if (res && res.ok && res.active) {
        connectedActions.hidden = false;
        disconnectedActions.hidden = true;
        const snap = res.snapshot || {};
        modePill.textContent = (snap.mode || 'IDLE').toUpperCase();
        modePill.classList.add('live');
        statusSub.textContent = snap.inRace ? 'Connected to live track' : 'Connected (in track menu)';
        stTrack.textContent = snap.trackName || 'PolyTrack';
        stEp.textContent = `#${snap.episodes || 0}`;
        stTop.textContent = `${snap.topRunsCount || 0} saved`;
        if (snap.memStats) {
          stMem.textContent = `${snap.memStats.weightKB} KB (${snap.memStats.heapUsedMB} MB)`;
        }
        return;
      }
    } catch (_) {}

    connectedActions.hidden = true;
    disconnectedActions.hidden = false;
    modePill.textContent = 'STANDBY';
    modePill.classList.remove('live');
    statusSub.textContent = 'Open PolyTrack to start HUD';
  }

  document.querySelectorAll('[data-mode]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!activeTabId) return;
      const mode = btn.getAttribute('data-mode');
      await chrome.tabs.sendMessage(activeTabId, {
        __polypilotPopup: true,
        action: 'COMMAND',
        commandPayload: { type: 'SET_MODE', mode }
      });
      setTimeout(queryGameFrame, 120);
    });
  });

  document.getElementById('btn-toggle-hud').addEventListener('click', async () => {
    if (!activeTabId) return;
    await chrome.tabs.sendMessage(activeTabId, {
      __polypilotPopup: true,
      action: 'COMMAND',
      commandPayload: { type: 'TOGGLE_HUD' }
    });
  });

  document.getElementById('btn-open-polytrack').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://www.kodub.com/apps/polytrack' });
    window.close();
  });

  document.getElementById('btn-inject-mirror').addEventListener('click', async () => {
    if (!activeTabId) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId, allFrames: true },
        world: 'MAIN',
        files: [
          'src/early_hook.js',
          'src/vision.js',
          'src/track3d.js',
          'src/telemetry.js',
          'src/controls.js',
          'src/brain.js',
          'src/storage.js',
          'src/hud.js',
          'src/agent.js'
        ]
      });
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId, allFrames: true },
        world: 'ISOLATED',
        files: ['src/bridge_isolated.js']
      });
      statusSub.textContent = 'Injected! Reload tab if canvas was already initialized.';
      setTimeout(queryGameFrame, 500);
    } catch (err) {
      statusSub.textContent = 'Cannot inject onto browser system page.';
    }
  });

  queryGameFrame();
})();
