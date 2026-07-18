// @ts-nocheck
import crypto from 'crypto';
import { supabaseAdmin, supabaseAdminConfigError } from '../supabase-admin.js';
import { authenticateRequestUser } from '../../../shared/admin-auth.js';

const EVENTS = new Set(['download_clicked','first_app_open','signup_started','signup_completed','login_success','payment_started','payment_succeeded','payment_failed','decart_token_requested','connection_started','connection_failed','first_frame_received','session_completed','session_disconnected']);
const SAFE_METADATA_KEYS = new Set(['mode','stage','reason','durationMs','latencyMs','source','networkType']);
const text = (value, max = 100) => typeof value === 'string' ? value.trim().slice(0, max) : null;
const safeMetadata = (input) => Object.fromEntries(Object.entries(input && typeof input === 'object' ? input : {}).filter(([key, value]) => SAFE_METADATA_KEYS.has(key) && ['string','number','boolean'].includes(typeof value)).slice(0, 20));

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error:'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ error:supabaseAdminConfigError });
  const eventName = text(req.body?.eventName);
  if (!EVENTS.has(eventName)) return res.status(400).json({ error:'Unsupported event' });
  const auth = await authenticateRequestUser(req, supabaseAdmin);
  const userId = auth.error ? null : auth.user.id;
  const { error } = await supabaseAdmin.from('analytics_events').insert({ user_id:userId, installation_id:text(req.body?.installationId), session_id:req.body?.sessionId || null,
    platform:text(req.body?.platform,30), app_version:text(req.body?.appVersion,30), acquisition_source:text(req.body?.acquisitionSource,60), event_name:eventName, metadata:safeMetadata(req.body?.metadata) });
  if (error) return res.status(500).json({ error:'Failed to record event' }); return res.status(202).json({ recorded:true });
}

export async function errorLogHandler(req,res) {
  res.setHeader('Access-Control-Allow-Origin','*'); res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end(); if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  const auth=await authenticateRequestUser(req,supabaseAdmin); const userId=auth.error?null:auth.user.id;
  const errorCode=text(req.body?.errorCode,80)||'UNKNOWN'; const stage=text(req.body?.decartStage,60); const platform=text(req.body?.platform,30);
  const fingerprint=crypto.createHash('sha256').update(`${errorCode}|${stage}|${platform}`).digest('hex');
  const record={fingerprint,error_code:errorCode,safe_message:text(req.body?.safeMessage,240)||'Application error',user_id:userId,session_id:req.body?.sessionId||null,platform,
    os_version:text(req.body?.osVersion,50),app_version:text(req.body?.appVersion,30),network_type:text(req.body?.networkType,30),decart_stage:stage,
    request_latency_ms:Number.isSafeInteger(req.body?.requestLatencyMs)?Math.max(0,req.body.requestLatencyMs):null,severity:['info','warning','error','critical'].includes(req.body?.severity)?req.body.severity:'error',last_seen_at:new Date().toISOString(),metadata:safeMetadata(req.body?.metadata)};
  const {data:existing}=await supabaseAdmin.from('error_logs').select('occurrences').eq('fingerprint',fingerprint).maybeSingle(); record.occurrences=(existing?.occurrences||0)+1;
  const {error}=await supabaseAdmin.from('error_logs').upsert(record,{onConflict:'fingerprint'}); if(error)return res.status(500).json({error:'Failed to record error'}); return res.status(202).json({recorded:true});
}
