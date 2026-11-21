import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { openFlutterwaveCheckout } from '../electron/flutterwave-checkout.js';

const parent = {};
const session = {
  checkoutUrl: 'https://checkout.flutterwave.com/v3/hosted/pay/session',
  apiOrigin: 'https://morphly.example',
  reference: 'morphly_ref',
};

test('desktop opens a sandboxed child modal and accepts only its matching app callback', async () => {
  let modal;
  class TestWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = Object.assign(new EventEmitter(), {
        setWindowOpenHandler: (handler) => { this.popupAction = handler(); },
        session: Object.assign(new EventEmitter(), {
          setPermissionRequestHandler() {},
          setPermissionCheckHandler() {},
        }),
      });
      modal = this;
    }
    isDestroyed() { return this.closed === true; }
    destroy() { this.closed = true; this.emit('closed'); }
    show() { this.visible = true; }
    async loadURL(url) { this.url = url; this.emit('ready-to-show'); }
  }
  const result = openFlutterwaveCheckout(TestWindow, parent, session);
  assert.equal(modal.url, session.checkoutUrl);
  assert.equal(modal.visible, true);
  assert.equal(modal.options.parent, parent);
  assert.equal(modal.options.modal, true);
  assert.equal(modal.options.webPreferences.sandbox, true);
  assert.equal(modal.options.webPreferences.preload, undefined);
  assert.equal(modal.popupAction.action, 'deny');

  const returnPath = '/api/flutterwave-payment-return?status=successful&transaction_id=12&tx_ref=';
  const navigate = (url, isMainFrame = true) => {
    let stopped = false;
    modal.webContents.emit('will-redirect', { url, isMainFrame, preventDefault: () => { stopped = true; } });
    return stopped;
  };
  assert.equal(navigate('file:///untrusted'), true);
  assert.equal(navigate('https://other.example' + returnPath + session.reference), false);
  assert.equal(navigate(session.apiOrigin + returnPath + 'other'), false);
  assert.equal(navigate(session.apiOrigin + returnPath + session.reference, false), false);
  assert.equal(modal.isDestroyed(), false);
  assert.equal(navigate(session.apiOrigin + returnPath + session.reference), true);
  assert.deepEqual(await result, { success: true, status: 'successful', transactionId: '12' });
});
