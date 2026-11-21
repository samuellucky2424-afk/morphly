import { randomUUID } from 'node:crypto';

const RETURN_PATH = '/api/flutterwave-payment-return';

function parseSecureUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url;
  } catch {
    // An unparseable URL cannot be used by the checkout window.
  }
  return null;
}

export function readCheckoutReturn(url, origin, reference) {
  if (!url || url.origin !== origin || url.pathname !== RETURN_PATH ||
      url.searchParams.get('tx_ref') !== reference) return null;
  return {
    status: url.searchParams.get('status')?.slice(0, 32).toLowerCase() || 'closed',
    transactionId: url.searchParams.get('transaction_id')?.slice(0, 64) || '',
  };
}

export async function openFlutterwaveCheckout(BrowserWindow, parent, { checkoutUrl, apiOrigin, reference }) {
  const checkout = parseSecureUrl(checkoutUrl);
  const api = parseSecureUrl(apiOrigin);
  if (!checkout || !api || typeof reference !== 'string' || !reference || reference.length > 160) {
    return { success: false, error: 'Flutterwave returned an invalid checkout session.' };
  }
  const directReturn = readCheckoutReturn(checkout, api.origin, reference);
  if (directReturn) return { success: true, ...directReturn };
  if (checkout.origin !== 'https://checkout.flutterwave.com' ||
      !checkout.pathname.startsWith('/v3/hosted/pay/')) {
    return { success: false, error: 'Flutterwave returned an untrusted checkout link.' };
  }

  const modal = new BrowserWindow({
    parent, modal: true, show: false,
    title: 'Flutterwave Payment',
    width: 540, height: 740, useContentSize: true,
    autoHideMenuBar: true, minimizable: false, maximizable: false,
    webPreferences: {
      partition: `flutterwave-checkout-${randomUUID()}`,
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      devTools: false,
    },
  });
  const { webContents } = modal;
  webContents.session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  webContents.session.setPermissionCheckHandler(() => false);
  webContents.session.on('will-download', (event) => event.preventDefault());
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  return new Promise((resolve) => {
    let result = { success: true, status: 'closed', transactionId: '' };
    modal.once('closed', () => resolve(result));
    modal.once('ready-to-show', () => modal.show());
    const finish = (outcome) => {
      if (modal.isDestroyed()) return;
      result = outcome;
      modal.destroy();
    };
    const handleNavigation = (event) => {
      if (!event.isMainFrame && event.url === 'about:blank') return;
      const url = parseSecureUrl(event.url);
      if (!url) {
        event.preventDefault();
        return;
      }
      if (!event.isMainFrame) return;
      const paymentReturn = readCheckoutReturn(url, api.origin, reference);
      if (paymentReturn) {
        event.preventDefault();
        finish({ success: true, ...paymentReturn });
      }
    };
    webContents.on('will-frame-navigate', handleNavigation);
    webContents.on('will-redirect', handleNavigation);
    webContents.once('render-process-gone', () => {
      finish({ success: false, error: 'The payment window closed unexpectedly.' });
    });
    void modal.loadURL(checkout.href).catch(() => {
      finish({ success: false, error: 'Could not load Flutterwave. Please try again.' });
    });
  });
}
