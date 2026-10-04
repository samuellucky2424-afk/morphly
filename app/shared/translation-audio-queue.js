// Two seconds of 16-bit, mono 16 kHz PCM per direction. Oldest unsent audio
// expires rather than allowing a network outage to grow playback latency forever.
export function createTranslationAudioQueue({ maxMs = 2000, now = Date.now } = {}) {
  const entries = [];
  const bytes = new Map();
  const remove = index => {
    const [entry] = entries.splice(index, 1);
    bytes.set(entry.message.direction, (bytes.get(entry.message.direction) || 0) - entry.bytes);
    return entry;
  };
  function prune() { while (entries.length && now() - entries[0].at > maxMs) remove(0); }
  return {
    push(message) {
      if (message.type !== 'audio' || !['incoming', 'outgoing'].includes(message.direction)
        || typeof message.data !== 'string' || message.data.length > 12000) return;
      prune();
      const size = Buffer.from(message.data, 'base64').length;
      if (!size || size % 2 || size > maxMs * 32) return;
      bytes.set(message.direction, (bytes.get(message.direction) || 0) + size);
      entries.push({ message, bytes: size, at: now() });
      while (bytes.get(message.direction) > maxMs * 32) remove(entries.findIndex(entry => entry.message.direction === message.direction));
    },
    shift() { prune(); return entries.length ? remove(0) : undefined; },
    get length() { prune(); return entries.length; },
    clear() { entries.length = 0; bytes.clear(); },
  };
}
