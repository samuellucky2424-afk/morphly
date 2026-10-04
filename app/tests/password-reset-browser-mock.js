// Load only into the isolated verification browser with agent-browser eval --stdin.
// Intercepts Auth requests; no email is delivered or real password changed.
(() => {
  const original = window.fetch.bind(window);
  const user = { id: 'reset-test-user', email: 'reset@example.com', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} };
  const token = `${btoa(JSON.stringify({ alg: 'HS256' }))}.${btoa(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 }))}.fixture`;
  window.resetTestRequests = [];
  window.fetch = async (input, init = {}) => {
    const url = String(input);
    if (!url.includes('/auth/v1/')) return original(input, init);
    const path = new URL(url).pathname;
    const payload = JSON.parse(init.body || '{}');
    window.resetTestRequests.push({ path, method: init.method || 'GET', payload });
    let body = {};
    let status = 200;
    if (path.endsWith('/verify')) {
      if (payload.token !== '123456' || payload.type !== 'recovery') {
        status = 403; body = { code: 'otp_expired', msg: 'Code expired' };
      } else {
        body = { access_token: token, refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'bearer', user };
      }
    } else if (path.endsWith('/user')) body = user;
    else if (!path.endsWith('/recover') && !path.endsWith('/logout')) throw new Error(`Unexpected Auth call: ${path}`);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return 'Auth requests are mocked in this page only.';
})();
