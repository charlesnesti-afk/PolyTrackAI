(() => {
  'use strict';
  if (window.__POLYPILOT_BRIDGE_ISOLATED__) return;
  window.__POLYPILOT_BRIDGE_ISOLATED__ = true;

  const CHANNEL_MAIN_TO_ISO = 'POLYPILOT_MAIN_TO_ISO_V1';
  const CHANNEL_ISO_TO_MAIN = 'POLYPILOT_ISO_TO_MAIN_V1';

  let isGameFrame = false;
  let latestSnapshot = null;

  function sendToMain(type, payload, reqId) {
    window.postMessage({
      __channel: CHANNEL_ISO_TO_MAIN,
      type,
      payload: payload || null,
      reqId: reqId || null
    }, '*');
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window || !event.data || event.data.__channel !== CHANNEL_MAIN_TO_ISO) {
      return;
    }
    const { type, payload, reqId } = event.data;

    try {
      if (type === 'FRAME_READY') {
        isGameFrame = true;
        latestSnapshot = payload;
        return;
      }
      if (type === 'STATUS_SNAPSHOT') {
        isGameFrame = true;
        latestSnapshot = payload;
        return;
      }
      if (type === 'STORAGE_GET') {
        const key = payload?.key;
        const all = await chrome.storage.local.get(key ? [key] : null);
        sendToMain('STORAGE_RES', { ok: true, data: key ? all[key] : all }, reqId);
        return;
      }
      if (type === 'STORAGE_SET') {
        await chrome.storage.local.set(payload?.items || {});
        sendToMain('STORAGE_RES', { ok: true }, reqId);
        return;
      }
      if (type === 'STORAGE_REMOVE') {
        await chrome.storage.local.remove(payload?.keys || []);
        sendToMain('STORAGE_RES', { ok: true }, reqId);
        return;
      }
    } catch (err) {
      sendToMain('STORAGE_RES', { ok: false, error: String(err?.message || err) }, reqId);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.__polypilotPopup) return false;

    // Only the frame actually hosting PolyTrack responds so outer iframe wrappers never shadow it
    const hasScreenCanvas = isGameFrame || !!document.getElementById('screen');
    if (!hasScreenCanvas) return false;

    if (msg.action === 'GET_STATUS') {
      sendResponse({
        ok: true,
        active: true,
        frameUrl: location.href,
        snapshot: latestSnapshot
      });
      return true;
    }

    if (msg.action === 'COMMAND') {
      sendToMain('POPUP_COMMAND', msg.commandPayload || {});
      sendResponse({ ok: true });
      return true;
    }

    return false;
  });
})();
