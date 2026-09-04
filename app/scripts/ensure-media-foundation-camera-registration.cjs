const { runRegistration } = require('./media-foundation-camera-registration.cjs');

function ensureRegistration({ run = runRegistration } = {}) {
  try {
    const probeResult = run('probe');
    if (probeResult?.skipped) {
      return { installed: false, skipped: true };
    }
    console.log('WhatsApp-compatible Media Foundation camera registration verified.');
    return { installed: false, skipped: false };
  } catch {
    console.log('Media Foundation camera registration is missing. Windows may request Administrator approval once.');
  }

  run('install');
  run('probe');
  console.log('WhatsApp-compatible Media Foundation camera installed and verified.');
  return { installed: true, skipped: false };
}

if (require.main === module) {
  try {
    ensureRegistration();
  } catch (error) {
    console.error(
      'Morphly could not install its WhatsApp-compatible camera. ' +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

module.exports = { ensureRegistration };
