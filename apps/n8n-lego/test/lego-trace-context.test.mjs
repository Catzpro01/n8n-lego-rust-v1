import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createEnvelope } from '../src/lego/envelope.mjs';
import { createTelemetryContext,telemetryContextFromEnvelope,deriveTelemetryContext,createTelemetryRecord,serializeTelemetryRecord,deserializeTelemetryRecord } from '../src/lego/telemetry-envelope.mjs';
import { TRACE_CONTRACT,TRACE_WIRE_VERSION,TRACE_LIMITS,createTraceSpan,createChildTraceSpan,injectTraceParent,parseTraceParent,continueTrace,createTracePayloadReference } from '../src/lego/trace-context.mjs';
const traceId='0123456789abcdef0123456789abcdef';
const spanId='0123456789abcdef';
const base=createTelemetryContext({workflowId:'wf-1',workflowVersion:'v1',executionId:'exec-1',correlationId:'req-1'});
const root=()=>createTraceSpan({traceId,spanId,sampled:true},base);

test('P9.4 version and canonical 55-byte propagation fixture',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/p9/trace.json',import.meta.url)));
  assert.equal(TRACE_CONTRACT.version,'1.0.0');assert.equal(TRACE_CONTRACT.owner,'agent-6');assert.equal(TRACE_WIRE_VERSION,'00');
  assert.equal(injectTraceParent(root()),fixture.traceparent);
  assert.equal(injectTraceParent(root()).length,TRACE_LIMITS.traceparentChars);
  assert.deepEqual(parseTraceParent(fixture.traceparent),fixture.remoteParent);
});

test('P9.4 trigger -> admission -> node/runtime -> checkpoint fixture preserves correlation',()=>{
  const foundation=createEnvelope({legoId:'webhook',operation:'admit',requestId:'req-1',traceId});
  const projected=telemetryContextFromEnvelope(foundation);
  const ctx=deriveTelemetryContext(projected,{workflowId:'wf-1',workflowVersion:'v1',executionId:'exec-1',triggerId:'trigger-1'});
  const trigger=createTraceSpan({traceId,spanId,sampled:true},ctx);
  const admission=createChildTraceSpan(trigger,'1111111111111111',{requestId:'req-2',causationId:'req-1'});
  const node=createChildTraceSpan(admission,'2222222222222222',{nodeId:'node-1',runtimeId:'runtime-1',registryEpoch:7,runtimeLeaseId:'lease-1'});
  const checkpoint=createChildTraceSpan(node,'3333333333333333',{checkpointId:'checkpoint-1'});
  const all=[trigger,admission,node,checkpoint];
  for(let i=0;i<all.length;i++){
    assert.ok(all[i]);assert.equal(all[i].context.traceId,traceId);assert.equal(all[i].context.executionId,'exec-1');assert.equal(all[i].context.correlationId,'req-1');
    if(i)assert.equal(all[i].context.parentSpanId,all[i-1].context.spanId);
    assert.ok(createTelemetryRecord({timestamp:1,signalType:'TRACE',component:['trigger','ingress','runtime','checkpoint'][i]},all[i].context));
  }
  assert.equal(checkpoint.context.checkpointId,'checkpoint-1');assert.equal(trigger.context.nodeId,undefined);
});

test('P9.4 serialized local boundary + W3C carrier continues as a new child, not cloned parent',()=>{
  const a=root();const event=createTelemetryRecord({timestamp:1,signalType:'TRACE',component:'execution'},a.context);
  const received=deserializeTelemetryRecord(serializeTelemetryRecord(event));
  const b=continueTrace(injectTraceParent(a),'1111111111111111',received.context);
  assert.equal(b.context.parentSpanId,a.context.spanId);assert.equal(b.context.traceId,a.context.traceId);
  assert.equal(b.context.correlationId,a.context.correlationId);assert.notEqual(b.context.spanId,a.context.spanId);
  assert.equal(continueTrace(injectTraceParent(a),a.context.spanId,received.context),null);
});

test('P9.4 malformed carriers, unsupported versions/flags, zero IDs and injection reject safely',()=>{
  const valid=injectTraceParent(root());
  const cases=[null,{},[],1,'',valid+'x',' '+valid,valid+'\r\nAuthorization: secret',valid.toUpperCase(),'ff'+valid.slice(2),'01'+valid.slice(2),valid.slice(0,-2)+'03',valid.slice(0,-2)+'zz','00-'+'0'.repeat(32)+'-'+spanId+'-01','00-'+traceId+'-'+'0'.repeat(16)+'-01'];
  for(const header of cases){assert.equal(parseTraceParent(header),null);assert.equal(continueTrace(header,'1111111111111111',base),null);}
});

test('P9.4 malformed native context and forged spans fail softly without echoing secrets',()=>{
  for(const changes of [{traceId:'x'}, {spanId:'0'.repeat(16)}, {parentSpanId:spanId}, {sampled:'yes'}, {payload:'secret'}, {contractVersion:'2.0.0'}])assert.equal(createTraceSpan({traceId,spanId,...changes},base),null);
  assert.equal(createTraceSpan({traceId,spanId},{}),null);
  assert.equal(injectTraceParent({...root()}),null);assert.equal(createChildTraceSpan({...root()},'1111111111111111'),null);
  assert.equal(createTraceSpan(Object.defineProperty({},'traceId',{enumerable:true,get(){throw Error('secret');}}),base),null);
  assert.equal(createTraceSpan(new Proxy({},{ownKeys(){throw Error('secret');}}),base),null);
});

test('P9.4 trace and execution identity cannot silently change across children',()=>{
  const a=root();
  for(const changes of [{traceId:'a'.repeat(32)},{executionId:'other'},{workflowId:'other'},{correlationId:'other'},{tenantId:'other'},{spanId:'1111111111111111'}])assert.equal(createChildTraceSpan(a,'2222222222222222',changes),null);
  assert.equal(createTraceSpan({traceId:'a'.repeat(32),spanId:'1111111111111111',parentSpanId:spanId},a.context),null);
  assert.equal(createTraceSpan({traceId,spanId:'1111111111111111'},a.context),null);
  assert.equal(createChildTraceSpan(a,spanId),null);
});

test('P9.4 sampled and unsampled traces retain identical correlation identities',()=>{
  const a=createTraceSpan({traceId,spanId,sampled:true},base),b=createTraceSpan({traceId,spanId,sampled:false},base);
  assert.deepEqual(a.context,b.context);assert.equal(injectTraceParent(a).slice(0,-2),injectTraceParent(b).slice(0,-2));
  assert.equal(parseTraceParent(injectTraceParent(b)).sampled,false);
  assert.equal(createChildTraceSpan(b,'1111111111111111').sampled,false);
});

test('P9.4 tenant identity requires existing authorization, never authority from header',()=>{
  const policy={authorizedTenantId:'tenant-a'};
  const tenant=createTelemetryContext({tenantId:'tenant-a'},policy);
  assert.equal(createTraceSpan({traceId,spanId},tenant),null);
  const a=createTraceSpan({traceId,spanId},tenant,policy);assert.ok(a);
  assert.equal(createChildTraceSpan(a,'1111111111111111'),null);
  assert.ok(createChildTraceSpan(a,'1111111111111111',{},policy));
  assert.equal(continueTrace(injectTraceParent(a),'1111111111111111',tenant,{authorizedTenantId:'tenant-b'}),null);
  const single=continueTrace(injectTraceParent(a),'1111111111111111',base);assert.equal(single.context.tenantId,undefined);
});

test('P9.4 large payload is represented only by fixed hash + size, never captured or hashed in producer',()=>{
  const payload=Buffer.alloc(4*1024*1024,7);const hash=createHash('sha256').update(payload).digest('hex');
  const ref=createTracePayloadReference({sha256:hash,sizeBytes:payload.byteLength});assert.ok(Object.isFrozen(ref));assert.equal(JSON.stringify(ref).length<128,true);
  assert.equal(ref.sizeBytes,payload.length);assert.equal(Object.hasOwn(ref,'payload'),false);
  let reads=0;const bad={sha256:hash,sizeBytes:payload.length};Object.defineProperty(bad,'payload',{enumerable:true,get(){reads++;throw Error('payload traversal');}});
  assert.equal(createTracePayloadReference(bad),null);assert.equal(reads,0);
  for(const spec of [{sha256:'secret',sizeBytes:1},{sha256:hash,sizeBytes:-1},{sha256:hash,sizeBytes:Infinity},{sha256:hash,sizeBytes:1.5},{sha256:hash,sizeBytes:Number.MAX_SAFE_INTEGER+1}])assert.equal(createTracePayloadReference(spec),null);
});

test('P9.4 pure producer does not serialize, generate IDs, read clock or invoke a backend',()=>{
  const stringify=JSON.stringify,now=Date.now;
  try{JSON.stringify=()=>{throw Error('encode');};Date.now=()=>{throw Error('clock');};assert.ok(createChildTraceSpan(root(),'1111111111111111'));}
  finally{JSON.stringify=stringify;Date.now=now;}
  const source=readFileSync(new URL('../src/lego/trace-context.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/\b(?:fetch|randomUUID|randomBytes|createHash|setTimeout|readFile|writeFile)\s*\(/);
});

test('P9.4 schema uses the canonical envelope schema identity rather than an ambiguous relative URN',()=>{
  const schema=JSON.parse(readFileSync(new URL('../../../docs/architecture/p9/trace-context.schema.json',import.meta.url)));
  const envelope=JSON.parse(readFileSync(new URL('../../../docs/architecture/p9/telemetry-envelope.schema.json',import.meta.url)));
  assert.equal(schema.properties.contractVersion.const,TRACE_CONTRACT.version);
  assert.equal(schema.properties.context.allOf[0].$ref,envelope.$id+'#/properties/context');
  assert.equal(schema.additionalProperties,false);
});
