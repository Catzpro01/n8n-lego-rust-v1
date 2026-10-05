import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { METRIC_CONTRACT, METRIC_DEFINITIONS, METRIC_LABEL_POLICY, LATENCY_BUCKETS_MS, METRIC_LIMITS, createMetricGovernor } from '../src/lego/metric-governor.mjs';
const reserve = METRIC_DEFINITIONS.length;
const create = (extra = 5) => createMetricGovernor({ maxSeries: reserve + extra });

test('P9.3 versioned family fixture and policy are immutable and cover all requested domains', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/p9/metrics.json', import.meta.url)));
  assert.deepEqual({ contract: METRIC_CONTRACT, metrics: METRIC_DEFINITIONS, labels: METRIC_LABEL_POLICY, latencyBoundsMs: LATENCY_BUCKETS_MS }, fixture);
  assert.equal(new Set(METRIC_DEFINITIONS.map(d => d.name)).size, reserve);
  for (const name of ['execution.started','execution.duration','node.runtime_load','node.cold_start','frontier.depth','checkpoint.operations','execution.memory_pressure','execution.cpu_pressure','ingress.duplicate','webhook.latency','schedule.delay','node.admission','node.quarantine','registry.epoch','runtime.lease','runtime.rollback','telemetry.cardinality_rejected']) assert.ok(METRIC_DEFINITIONS.some(d => d.name === name), name);
  assert.ok(Object.isFrozen(METRIC_DEFINITIONS)); assert.ok(Object.isFrozen(METRIC_LABEL_POLICY.component));
});

test('P9.3 counter/gauge/histogram aggregation matches deterministic fixture', () => {
  const g = create();
  g.observe('execution.started', 2); g.observe('execution.started', 3);
  g.observe('frontier.depth', 10); g.observe('frontier.depth', 4);
  for (const value of [0,1,5,10,5001]) g.observe('execution.duration', value);
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/p9/metric-aggregation.json', import.meta.url)));
  assert.deepEqual(g.snapshot(), fixture);
  assert.equal(g.snapshot().series.find(s=>s.name==='frontier.depth').value,4);
  assert.ok(Object.isFrozen(g.snapshot().series[0]));
});

test('P9.3 empty store does not invent observations or health/epoch values', () => {
  assert.deepEqual(create().snapshot().series, []);
  const g = create();
  for (const d of METRIC_DEFINITIONS) assert.equal(g.observe(d.name, 1), true);
  assert.equal(g.snapshot().series.length, reserve);
});

test('P9.3 high cardinality 100k unique IDs stays within slots, stores no IDs and loses no counts', () => {
  const g = create(2);
  for (let i=0;i<100000;i++) assert.equal(g.observe('execution.started',1,{executionId:'exec-'+i,workflowId:'wf-'+i,component:'unbounded-'+i}),true);
  assert.ok(g.stats().allocatedSeries<=reserve+2);
  assert.equal(g.stats().cardinalityRejected,300000);
  assert.equal(g.stats().accepted,100000);
  const snap = g.snapshot();
  assert.equal(snap.series.reduce((sum,s)=>sum+s.value,0),100000);
  assert.equal(snap.series[0].labels.component,'other');
  assert.doesNotMatch(JSON.stringify(snap),/exec-\d|wf-\d|unbounded-/);
});

test('P9.3 valid dimension explosion falls back to reserved aggregates without starving new families', () => {
  const g=create(1);
  g.observe('execution.started',1,{component:'execution'});
  g.observe('execution.started',2,{component:'node'});
  g.observe('execution.started',3,{component:'webhook'});
  assert.equal(g.stats().allocatedSeries,reserve+1);
  assert.equal(g.stats().aggregated,2);
  assert.equal(g.snapshot().series.reduce((sum,s)=>sum+s.value,0),6);
  assert.equal(g.snapshot().series.find(s=>!Object.keys(s.labels).length).reducedCount,2);
  assert.equal(g.observe('node.failed',1,{component:'node'}),true);
  assert.equal(g.stats().aggregated,3);
});

test('P9.3 denied labels are never read: secrets, tenant IDs, URLs, request IDs', () => {
  let reads=0; const labels={component:'execution'};
  for(const key of ['password','tenantId','url','requestId','nodeId']) Object.defineProperty(labels,key,{enumerable:true,get(){reads++;throw Error('secret');}});
  const g=create(); assert.equal(g.observe('execution.failed',1,labels),true);
  assert.equal(reads,0); assert.equal(g.stats().cardinalityRejected,5);
  assert.doesNotMatch(JSON.stringify(g.snapshot()),/password|tenantId|requestId|secret/);
  assert.equal(g.observe('execution.failed',1,{component:'gh'+'p_FAKE_TOKEN'}),true);
  assert.doesNotMatch(JSON.stringify(g.snapshot()),/FAKE_TOKEN/);
});

test('P9.3 malformed config/sample fails softly and snapshots remain unchanged', () => {
  for(const maxSeries of [0,reserve-1,4097,NaN,Infinity,1.5,'100']) assert.equal(createMetricGovernor({maxSeries}),null);
  for(const config of [null,{},[],{maxSeries:reserve,extra:1}]) assert.equal(createMetricGovernor(config),null);
  const g=create();
  for(const value of [-1,NaN,Infinity,'5',{},null]) assert.equal(g.observe('execution.started',value),false);
  assert.equal(g.observe('execution.started',0.2),false);
  assert.equal(g.observe('unknown.metric',1),false);
  assert.equal(g.observe('x'.repeat(100000),1),false);
  for(const labels of [null,[],new Date(),{component:{}},{component:'x'.repeat(65)},Object.fromEntries(Array.from({length:9},(_,i)=>['x'+i,1]))]) assert.equal(g.observe('node.failed',1,labels),false);
  assert.equal(g.observe('node.failed',1,Object.defineProperty({},'component',{get(){throw Error('secret');},enumerable:true})),false);
  assert.equal(g.observe('node.failed',1,new Proxy({},{ownKeys(){throw Error('secret');}})),false);
  assert.deepEqual(g.snapshot().series,[]);
});

test('P9.3 key order does not create new series and snapshots are detached immutable views', () => {
  const a=create(),b=create();
  a.observe('node.failed',1,{component:'node',severity:'ERROR'});
  b.observe('node.failed',1,{severity:'ERROR',component:'node'});
  assert.deepEqual(a.snapshot(),b.snapshot());
  const old=a.snapshot();a.observe('node.failed',2,{severity:'ERROR',component:'node'});
  assert.equal(old.series[0].value,1);assert.equal(a.snapshot().series[0].value,3);
  assert.throws(()=>{old.series[0].labels.component='other';},TypeError);
});

test('P9.3 arithmetic overflow does not partially mutate totals or buckets', () => {
  const g=create();g.observe('execution.started',Number.MAX_SAFE_INTEGER);
  assert.equal(g.observe('execution.started',1),false);
  assert.equal(g.snapshot().series[0].count,1);
  assert.equal(g.snapshot().series[0].value,Number.MAX_SAFE_INTEGER);
  g.observe('execution.duration',Number.MAX_SAFE_INTEGER);
  const before=g.snapshot().series.find(s=>s.name==='execution.duration');
  assert.equal(g.observe('execution.duration',2),false);
  assert.deepEqual(g.snapshot().series.find(s=>s.name==='execution.duration'),before);
});

test('P9.3 histogram uses disjoint closed upper buckets plus explicit overflow, no raw samples', () => {
  const g=create();for(const v of LATENCY_BUCKETS_MS)g.observe('node.duration',v);
  g.observe('node.duration',5001);
  const s=g.snapshot().series[0];assert.deepEqual(s.buckets,new Array(11).fill(1));
  assert.equal(s.count,11);assert.equal(s.buckets.reduce((a,b)=>a+b,0),11);
  assert.equal(Object.hasOwn(s,'samples'),false);
});

test('P9.3 reset reclaims dimensions and preserves the fixed family reservation', () => {
  const g=create();g.observe('node.failed',1,{component:'node'});g.reset();
  assert.deepEqual(g.snapshot().series,[]);assert.equal(g.stats().allocatedSeries,reserve);assert.equal(g.stats().accepted,0);
});

test('P9.3 producer does not encode, read clock, call runtime or export per event', () => {
  const g=create();const stringify=JSON.stringify,now=Date.now;
  try {JSON.stringify=()=>{throw Error('encoding');};Date.now=()=>{throw Error('clock');};assert.equal(g.observe('execution.duration',2.5),true);}
  finally {JSON.stringify=stringify;Date.now=now;}
  const source=readFileSync(new URL('../src/lego/metric-governor.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\b(?:fetch|setTimeout|setInterval|readFile|writeFile)\s*\(/);
  assert.equal(METRIC_LIMITS.maxSeries,4096);
});

test('P9.3 count/health gauges are honest scalar observations, not invented fractions', () => {
  const g=create();assert.equal(g.observe('frontier.depth',0.5),false);assert.equal(g.observe('registry.epoch',1.5),false);
  assert.equal(g.observe('node.health',2),false);assert.equal(g.observe('node.health',0),true);
  assert.equal(g.observe('execution.memory_pressure',1.5),true); // oversubscribed reported ratio is possible
});

test('P9.3 global cap holds across every family and many valid dimension combinations', () => {
  const g=create(16);let n=0;
  for(const d of METRIC_DEFINITIONS)for(const component of METRIC_LABEL_POLICY.component)for(const severity of METRIC_LABEL_POLICY.severity){
    assert.equal(g.observe(d.name,1,{component,severity}),true);n++;
    assert.ok(g.stats().allocatedSeries<=reserve+16);
  }
  assert.equal(g.stats().accepted,n);assert.ok(g.stats().aggregated>0);
  assert.ok(g.snapshot().series.length<=reserve+16);
  assert.equal(g.snapshot().series.reduce((sum,s)=>sum+s.count,0),n);
});
