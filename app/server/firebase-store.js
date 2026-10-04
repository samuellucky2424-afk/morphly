import { randomUUID, createHash } from 'node:crypto';

const jsonFields = new Set(['metadata','before_data','after_data','package_snapshot','provider_metadata','payload']);
const dateField = k => /(_at|_time)$/.test(k) || ['starts_at','ends_at'].includes(k);
const dateString = value => typeof value==='string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d/.test(value) ? value.replace(' ','T') + (/Z$|[+-]\d\d:?\d\d$/.test(value)?'':'Z') : value;
const decode = row => Object.fromEntries(Object.entries(row).map(([k,v]) => {
  if (jsonFields.has(k) && typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
  if (dateField(k) && typeof v === 'string') v=dateString(v);
  return [k,v];
}));
export const encode = row => Object.fromEntries(Object.entries(row).filter(([,v])=>v!==undefined).map(([k,v]) => [k, v instanceof Date ? v.toISOString() : jsonFields.has(k) && v !== null && typeof v === 'object' ? JSON.stringify(v) : v]));
export const hash = v => createHash('sha256').update(String(v)).digest('hex');
const split = text => { let depth=0,start=0,out=[]; for(let i=0;i<text.length;i++){ if(text[i]==='(')depth++; if(text[i]===')')depth--; if(text[i]===','&&!depth){out.push(text.slice(start,i));start=i+1;} } out.push(text.slice(start)); return out; };
function compare(row,field,op,value) {
  let actual=row[field]??null;
  if(dateField(field)&&actual!==null){actual=Date.parse(dateString(actual));value=typeof value==='string'?Date.parse(dateString(value)):value;}
  if(op==='eq'||op==='is')return actual===value;
  if(op==='neq')return actual!==value;
  if(op==='in')return value.includes(actual);
  if(actual===null)return false;
  if(op==='gt')return actual>value; if(op==='gte')return actual>=value;
  if(op==='lt')return actual<value; if(op==='lte')return actual<=value;
  throw new Error(`Unsupported Firebase filter: ${op}`);
}
function expression(row,text) {
  if(text.startsWith('and('))return split(text.slice(4,-1)).every(x=>expression(row,x));
  if(text.startsWith('or('))return split(text.slice(3,-1)).some(x=>expression(row,x));
  const [,field,op,value]=text.match(/^([\w]+)\.([\w]+)\.(.*)$/)||[];
  return compare(row,field,op,value==='null'?null:value==='true'?true:value==='false'?false:value);
}
export class FirebaseQuery {
  constructor(db,table){ this.db=db;this.table=table;this.filters=[];this.orders=[];this.action='read';this.columns='*';this.options={}; }
  select(columns='*',options={}){this.columns=columns;this.options=options;return this;}
  eq(f,v){return this.filter(f,'eq',v);} neq(f,v){return this.filter(f,'neq',v);} in(f,v){return this.filter(f,'in',v);}
  gt(f,v){return this.filter(f,'gt',v);} gte(f,v){return this.filter(f,'gte',v);} lt(f,v){return this.filter(f,'lt',v);} lte(f,v){return this.filter(f,'lte',v);} is(f,v){return this.filter(f,'is',v);}
  filter(f,op,v){this.filters.push({f,op,v});return this;}
  or(text){this.orText=text;return this;}
  order(field,options={}){this.orders.push({field,ascending:options.ascending!==false});return this;}
  limit(n){this.take=n;return this;} range(from,to){this.offset=from;this.take=to-from+1;return this;}
  single(){this.cardinality='one';return this;} maybeSingle(){this.cardinality='optional';return this;}
  insert(values){this.action='insert';this.values=values;return this;}
  upsert(values,options={}){this.action='upsert';this.values=values;this.upsertOptions=options;return this;}
  update(values){this.action='update';this.values=values;return this;} delete(){this.action='delete';return this;}
  then(resolve,reject){return this.execute().then(resolve,reject);}
  async matching(){
    const col=this.db.collection(this.table);
    const idFilter=this.filters.find(x=>x.f==='id'&&x.op==='eq');
    if(idFilter){const doc=await col.doc(String(idFilter.v)).get();return doc.exists?[doc]:[];}
    // One indexed predicate avoids requiring composite indexes for existing
    // relational filters. Restrict by owner first, then evaluate the rest.
    const primary=this.filters.find(x=>x.f==='user_id'&&x.op==='eq')||this.filters.find(x=>x.op==='eq'&&x.v!==null)||this.filters.find(x=>['gte','gt','lte','lt'].includes(x.op));
    const operators={eq:'==',gte:'>=',gt:'>',lte:'<=',lt:'<'};
    let query=col;
    if(primary){
      if(dateField(primary.f)&&primary.op!=='eq'){
        // SQL exports use a space and retain microseconds; new Firebase writes
        // use ISO. Read a complete day then compare parsed UTC times below.
        const date=new Date(dateString(primary.v));
        if(['lte','lt'].includes(primary.op)){date.setUTCDate(date.getUTCDate()+1);query=col.where(primary.f,'<',date.toISOString().slice(0,10)+' ');}
        else query=col.where(primary.f,'>=',date.toISOString().slice(0,10)+' ');
      }else query=col.where(primary.f,operators[primary.op],primary.v);
    }
    return (await query.get()).docs;
  }
  async execute(){try{
    let docs=[],rows=[];
    if(['insert','upsert'].includes(this.action)){
      for(const input of Array.isArray(this.values)?this.values:[this.values]){
        const row=encode({...input});
        const conflict=this.upsertOptions?.onConflict||'id';
        let ref;
        if(conflict==='id'&&row.id)ref=this.db.collection(this.table).doc(String(row.id));
        else if(conflict==='user_id'&&['users','admin_users','customer_email_preferences'].includes(this.table))ref=this.db.collection(this.table).doc(row.user_id);
        else if(this.action==='upsert'){const old=await this.db.collection(this.table).where(conflict,'==',row[conflict]).limit(2).get();if(old.size>1)throw new Error('Ambiguous upsert');ref=old.docs[0]?.ref;}
        ref??=this.db.collection(this.table).doc(row.id||randomUUID());
        if(!row.id&&!['admin_users','customer_email_preferences'].includes(this.table))row.id=ref.id;
        await this.db.runTransaction(async tx=>{const old=await tx.get(ref);if(this.action==='insert'&&old.exists)throw new Error('Record already exists');if(old.exists&&this.upsertOptions?.ignoreDuplicates)return;tx.set(ref,old.exists?row:{created_at:new Date().toISOString(),...defaults(this.table),...row},{merge:this.action==='upsert'});});
        rows.push(decode((await ref.get()).data()));
      }
    }else{
      docs=(await this.matching()).filter(d=>this.filters.every(x=>compare(d.data(),x.f,x.op,x.v))&&(!this.orText||split(this.orText).some(x=>expression(d.data(),x))));
      rows=docs.map(d=>decode(d.data()));
      if(['update','delete'].includes(this.action)){
        // Server handlers authenticate and authorize before reaching this layer.
        if(this.filters.some(f=>f.f==='lease_id')){
          for(const doc of docs)await this.db.runTransaction(async tx=>{const current=await tx.get(doc.ref);if(current.exists&&this.filters.every(f=>compare(current.data(),f.f,f.op,f.v)))this.action==='delete'?tx.delete(doc.ref):tx.update(doc.ref,encode(this.values));});
        }else for(let i=0;i<docs.length;i+=400){const batch=this.db.batch();for(const d of docs.slice(i,i+400))this.action==='delete'?batch.delete(d.ref):batch.update(d.ref,encode(this.values));await batch.commit();}
        if(this.action==='update')rows=rows.map(r=>({...r,...this.values}));
      }
    }
    const count=rows.length;
    if(this.orders.length)rows.sort((a,b)=>{for(const {field,ascending} of this.orders){const av=dateField(field)?Date.parse(a[field]||''):a[field]??'',bv=dateField(field)?Date.parse(b[field]||''):b[field]??'';const result=av<bv?-1:av>bv?1:0;if(result)return ascending?result:-result;}return 0;});
    rows=rows.slice(this.offset||0,this.take===undefined?undefined:(this.offset||0)+this.take);
    if(this.columns!=='*'){const fields=this.columns.split(',').map(x=>x.trim());rows=rows.map(r=>Object.fromEntries(fields.map(k=>[k,r[k]??null])));}
    if(this.cardinality&&(rows.length>1||(this.cardinality==='one'&&rows.length!==1)))throw new Error('Expected one database record');
    return {data:this.options.head?null:this.cardinality?rows[0]??null:rows,error:null,count:this.options.count?count:null};
  }catch(error){return {data:null,error:{message:error.message,code:'FIREBASE_OPERATION_FAILED'},count:null};}}
}
function defaults(table){
  if(table==='sessions')return {status:'active',seconds_used:0,cost:0,credits_used:0,wallet_debited_credits:0};
  if(table==='customer_email_preferences')return {enabled:true,unsubscribe_token:randomUUID()};
  if(table==='customer_reviews')return {status:'new'};
  if(table==='customer_email_jobs')return {status:'pending',attempts:0,due_at:new Date().toISOString()};
  return {};
}
