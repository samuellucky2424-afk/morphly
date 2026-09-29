// Retain setup state in the main process: downloads can start before sign-in or
// before the voice panel mounts, and navigation must not restart a download.
export function createVoiceEngineSetup({ isInstalled, install, onInstalled, onState = () => {} }) {
  let pending = null;
  let state = { phase: 'idle', percent: 0, retrying: false, error: null };
  const publish = patch => { state = { ...state, retrying: false, error: null, ...patch }; onState(getState()); };
  const getState = () => ({ ...state, installed: isInstalled() });
  const start = () => {
    if (pending) return pending;
    if (isInstalled()) return Promise.resolve({ success: true });
    publish({ phase: 'downloading' });
    pending = Promise.resolve().then(async () => {
      try {
        const result = await install(progress => publish(progress));
        await onInstalled();
        publish({ phase: 'done', percent: 100 });
        return { success: true, ...result };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unable to install the voice engine.';
        publish({ phase: 'idle', error: message });
        return { success: false, error: message };
      } finally { pending = null; }
    });
    return pending;
  };
  return { start, getState };
}
