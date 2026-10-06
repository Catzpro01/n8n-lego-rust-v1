import { parse } from '../apps/n8n-lego/node_modules/flatted/esm/index.js';

async function run() {
  const loginRes = await fetch('http://localhost:5677/rest/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'catzpro01@gmail.com', password: 'Mrizki26082003' })
  });
  const cookie = loginRes.headers.get('set-cookie');
  if (!cookie) {
    console.error('Login failed:', await loginRes.text());
    process.exit(1);
  }

  // TEST 1: User's exact code with $input.all() in runOnceForAllItems
  const wf1 = {
    workflowData: {
      name: 'Test Code Node Success',
      nodes: [
        { id: '1', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: '2', name: 'Code in JavaScript', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: 'for (const item of $input.all()) {\n  item.json.myNewField = 1;\n}\nreturn $input.all();'
        }}
      ],
      connections: {
        'Trigger': { main: [[{ node: 'Code in JavaScript', type: 'main', index: 0 }]] }
      }
    }
  };
  const res1 = await fetch('http://localhost:5677/rest/workflows/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'Origin': 'http://localhost:5677' },
    body: JSON.stringify(wf1)
  });
  const runPayload1 = await res1.json();
  const execId1 = runPayload1.data?.executionId || runPayload1.data?.id;
  const execRes1 = await fetch(`http://localhost:5677/rest/executions/${execId1}`, {
    headers: { 'Cookie': cookie }
  });
  const execJson1 = await execRes1.json();
  const parsedData1 = parse(execJson1.data?.data);
  console.log('--- TEST 1 ($input.all() SUCCESS) ---');
  console.log('Workflow Status:', execJson1.data?.status);
  const codeNodeRun1 = parsedData1?.resultData?.runData?.['Code in JavaScript']?.[0];
  console.log('Code Node Status:', codeNodeRun1?.executionStatus);
  console.log('Code Node Output:', JSON.stringify(codeNodeRun1?.data?.main));

  // TEST 2: DELIBERATE ERROR (to verify error is NOT hidden!)
  const wf2 = {
    workflowData: {
      name: 'Test Code Node Error',
      nodes: [
        { id: '1', name: 'Trigger', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: '2', name: 'Code in JavaScript', type: 'n8n-nodes-base.code', typeVersion: 2, position: [200, 0], parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: 'throw new Error("Sengaja Error untuk Validasi");'
        }}
      ],
      connections: {
        'Trigger': { main: [[{ node: 'Code in JavaScript', type: 'main', index: 0 }]] }
      }
    }
  };
  const res2 = await fetch('http://localhost:5677/rest/workflows/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'Origin': 'http://localhost:5677' },
    body: JSON.stringify(wf2)
  });
  const runPayload2 = await res2.json();
  const execId2 = runPayload2.data?.executionId || runPayload2.data?.id;
  const execRes2 = await fetch(`http://localhost:5677/rest/executions/${execId2}`, {
    headers: { 'Cookie': cookie }
  });
  const execJson2 = await execRes2.json();
  const parsedData2 = parse(execJson2.data?.data);
  console.log('--- TEST 2 (DELIBERATE ERROR PROPAGATION) ---');
  console.log('Workflow Status (MUST BE error):', execJson2.data?.status);
  console.log('ResultData Error:', parsedData2?.resultData?.error?.message);
  const errNodeRun = parsedData2?.resultData?.runData?.['Code in JavaScript']?.[0];
  console.log('Code Node Status:', errNodeRun?.executionStatus);
  console.log('Code Node Error Message:', errNodeRun?.error?.message);
}

run();
