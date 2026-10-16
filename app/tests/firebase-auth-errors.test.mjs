import test from 'node:test';
import assert from 'node:assert/strict';
import {getFirebaseAuthErrorMessage} from '../src/lib/firebase-auth-errors.ts';
import {RESET_REQUEST_MESSAGE} from '../src/lib/auth-flow.ts';

test('login failures distinguish expired sessions from incorrect credentials without exposing account existence',()=>{
  const missing=getFirebaseAuthErrorMessage({code:'auth/user-not-found'});
  assert.equal(missing,getFirebaseAuthErrorMessage({code:'auth/wrong-password'}));
  assert.equal(missing,getFirebaseAuthErrorMessage({code:'auth/invalid-credential'}));
  assert.match(missing,/Forgot password/);
  assert.match(getFirebaseAuthErrorMessage({code:'auth/user-token-expired'}),/session has expired.*Sign in again/);
  assert.match(getFirebaseAuthErrorMessage({code:'auth/network-request-failed'}),/internet connection/);
});
test('recovery promises the Firebase email link rather than an OTP',()=>{
  assert.match(RESET_REQUEST_MESSAGE,/secure password reset link/);
  assert.doesNotMatch(RESET_REQUEST_MESSAGE,/reset code|OTP/);
});

test('desktop login failures explain how Google-registered users get a desktop password',()=>{
  for (const code of ['auth/invalid-credential','auth/wrong-password','auth/user-not-found']) {
    const desktop=getFirebaseAuthErrorMessage({code},true);
    assert.match(desktop,/created your account with Google/);
    assert.match(desktop,/Forgot password/);
    assert.doesNotMatch(desktop,/use Google sign-in/,'desktop has no Google button');
  }
  assert.match(getFirebaseAuthErrorMessage({code:'auth/email-already-in-use'},true),/Forgot password to set a desktop password/);
  assert.match(getFirebaseAuthErrorMessage({code:'auth/invalid-credential'},false),/use Google sign-in/);
});
