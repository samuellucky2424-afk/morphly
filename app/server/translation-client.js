import WebSocket from 'ws';

export function connectTranslation({ gatewayUrl, accessToken, targetLanguage, incoming, onAudio, onError }) {
  const url = new URL(gatewayUrl);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('Translation requires a secure server connection.');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid translation server URL.');
  if (!accessToken) throw new Error('Sign in to use translation.');
  const socket = new WebSocket(url, { maxPayload: 2 * 1024 * 1024, handshakeTimeout: 10000 });
  let stopping = false;
  let failReady;
  const ready = new Promise((resolve, reject) => {
    failReady = reject;
    const timeout = setTimeout(() => fail('Translation connection timed out.'), 20000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', accessToken, targetLanguage, incoming })));
    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'ready') { clearTimeout(timeout); resolve(); }
        else if (message.type === 'error') fail(message.message || 'Translation failed.');
        else if (message.type === 'audio' || message.type === 'clear') onAudio(message);
      } catch { fail('Invalid translation response.'); }
    });
    socket.on('error', () => fail('Translation connection failed. Check your internet connection.'));
    socket.on('close', () => { clearTimeout(timeout); if (!stopping) fail('Translation disconnected. Start again to reconnect.'); });
  });
  function fail(message) {
    if (stopping) return;
    stopping = true;
    socket.terminate();
    failReady(new Error(message));
    onError(message);
  }
  return {
    ready,
    send(message) {
      if (socket.readyState !== WebSocket.OPEN || stopping) return;
      if (socket.bufferedAmount > 128 * 1024) { fail('The connection is too slow for translation.'); return; }
      socket.send(JSON.stringify(message));
    },
    close() { stopping = true; failReady(new Error('Translation stopped.')); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop' })); socket.close(); },
  };
}
