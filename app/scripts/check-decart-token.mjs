import fs from 'node:fs';
import dotenv from 'dotenv';
import {createDecartTemporaryKey} from '../server/decart-token.js';
const env=dotenv.parse(fs.readFileSync('C:/morphly-private/vercel-review.env'));
if(!env.DECART_API_KEY||env.DECART_API_KEY==='[SENSITIVE]')throw new Error('Decart key unavailable for local verification');
const result=await createDecartTemporaryKey({apiKey:env.DECART_API_KEY,maxSeconds:60,allowedOrigins:[],userId:'firebase-review',sessionId:'decart-verification'});
console.log(JSON.stringify({provider:'decart',model:'lucy-2.5',tokenIssued:!!result.token,expiresAt:result.expiresAt,providerStatus:result.error?.providerStatus}));
if(!result.token)process.exitCode=1;
