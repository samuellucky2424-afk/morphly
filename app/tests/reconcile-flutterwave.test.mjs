import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileFlutterwavePage} from '../server/reconcile-flutterwave.js';
test('cutover reconciliation processes only recent successful Morphly charges through verification',async()=>{
  const now=Date.now(),seen=[];
  const rows=[{id:1,status:'successful',tx_ref:'morphly_recent',created_at:new Date(now-1000).toISOString()},{id:2,status:'successful',tx_ref:'another_app',created_at:new Date(now-1000).toISOString()},{id:3,status:'failed',tx_ref:'morphly_failed',created_at:new Date(now-1000).toISOString()},{id:4,status:'successful',tx_ref:'morphly_old',created_at:new Date(now-2*86400000).toISOString()}];
  const report=await reconcileFlutterwavePage({since:new Date(now-60000).toISOString(),now,secretKey:'mock',fetchImpl:async()=>({ok:true,json:async()=>({status:'success',data:rows,meta:{page_info:{total_pages:2}}})}),processTransaction:async id=>{seen.push(id);return {status:200,data:{processed:true,duplicate:true}};}});
  assert.deepEqual(seen,[1]);assert.equal(report.duplicate,1);assert.equal(report.processed,0);assert.equal(report.ignored,3);assert.equal(report.nextPage,2);
});
test('cutover reconciliation rejects unbounded windows before calling the gateway',async()=>{
  await assert.rejects(reconcileFlutterwavePage({since:'invalid',secretKey:'mock'}),/window/);
  await assert.rejects(reconcileFlutterwavePage({since:new Date(Date.now()-2*86400000).toISOString(),secretKey:'mock'}),/window/);
});
