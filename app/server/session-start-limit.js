export function sessionStartLimit(events, now = Date.now()) {
  const windows = [{ milliseconds: 60_000, limit: 6 }, { milliseconds: 600_000, limit: 30 }];
  const timestamps = events.map(event => Date.parse(event.created_at)).filter(time => Number.isFinite(time) && time <= now);
  let retryAfterSeconds = 0;
  for (const window of windows) {
    const recent = timestamps.filter(time => time > now - window.milliseconds).sort((a,b) => a-b);
    if (recent.length >= window.limit) {
      const releasesAt = recent[recent.length-window.limit] + window.milliseconds;
      retryAfterSeconds = Math.max(retryAfterSeconds, Math.ceil((releasesAt-now)/1000));
    }
  }
  return { count: timestamps.length, retryAfterSeconds };
}
