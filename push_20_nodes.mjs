import fs from 'fs';

async function pushToInstances() {
  const workflowData = JSON.parse(fs.readFileSync('test_20_nodes.json', 'utf-8'));
  const commonNodes = workflowData.nodes;
  const commonConnections = workflowData.connections;
  
  const passwords = {
    lego: process.env.N8N_LEGO_OWNER_PASSWORD || 'change_me',
    resmi: process.env.N8N_REFERENCE_PASSWORD || 'change_me'
  };

  async function updateInstance(port, type, id, loginPath, emailKey) {
    console.log(`\n--- Pushing to ${type} (Port ${port}) ---`);
    try {
      let cookie = '';
      if (loginPath) {
        let body = {};
        const email = process.env.N8N_OWNER_EMAIL || 'catzpro01@gmail.com';
        if (emailKey === 'email') body = { email, password: passwords.lego };
        else body = { emailOrLdapLoginId: email, password: passwords.resmi };

        const login = await fetch(`http://localhost:${port}${loginPath}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
      }

      const res = await fetch(`http://localhost:${port}/rest/workflows/${id}`, {
        method: 'PATCH',
        headers: {
          'Cookie': cookie,
          'Content-Type': 'application/json',
          'Origin': `http://localhost:${port}`
        },
        body: JSON.stringify({
          name: `Universal 20 Nodes Test - ${type.toUpperCase()}`,
          nodes: commonNodes,
          connections: commonConnections
        })
      });
      console.log(`Update status: ${res.status}`);
    } catch (e) {
      console.error(`${type} error:`, e.message);
    }
  }

  // Sync to instances
  await updateInstance(5677, 'Lego', 'PCnUYdBOcqchaa06', '/rest/login', 'email');
  await updateInstance(5678, 'Rust', 'e5fcb57cf0ff4f07', '', '');
  await updateInstance(5680, 'Reference', '4xqv5ngwYnwpo36g', '/rest/login', 'emailOrLdapLoginId');
}

pushToInstances();
