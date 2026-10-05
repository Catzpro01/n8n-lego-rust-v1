/**
 * Credentials LEGO — reference tests (n8n 2.9.4 `Cipher`, `Credentials`, REST redaction)
 * All key material and payloads here are throw-away dummies. NO real secrets.
 * Run: node --test tests/reference/agent-4/credentials/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createDecipheriv } from 'node:crypto';
import { hasRuntime, n8nRequire, golden, LIVE, live, liveLogin, stripStack } from '../helpers.ts';

const skipUnit = { skip: hasRuntime ? false : 'N8N_RUNTIME not available' };
const DUMMY_KEY = 'agent4-dummy-key-not-a-secret';
const OTHER_KEY = 'agent4-other-dummy-key';

const BLANK = '__n8n_BLANK_VALUE_e5362baf-c777-4d57-a609-6eaf1f9e87f6';
const EMPTY = '__n8n_EMPTY_VALUE_7b1af746-3729-4c60-9b9b-e08eb29e58da';

function cipher(key = DUMMY_KEY) {
	const { Cipher } = n8nRequire('n8n-core/dist/encryption/cipher');
	return new Cipher({ encryptionKey: key });
}

/** Independent re-implementation of OpenSSL EVP_BytesToKey(MD5, 1 round) used to cross-check the wire format. */
function evpBytesToKey(pass: string, salt: Buffer) {
	const password = Buffer.concat([Buffer.from(pass, 'binary'), salt]);
	const h1 = createHash('md5').update(password).digest();
	const h2 = createHash('md5').update(Buffer.concat([h1, password])).digest();
	const iv = createHash('md5').update(Buffer.concat([h2, password])).digest();
	return { key: Buffer.concat([h1, h2]), iv };
}

test('Credentials: encrypt → decrypt round trip; wire format is base64("Salted__" + 8-byte salt + AES-256-CBC)', skipUnit, () => {
	const c = cipher();
	const plain = { user: 'dummy', token: 'not-a-real-token-123' };
	// INPUT: object → EXPECTED OUTPUT: base64 string beginning with "Salted__"
	const enc: string = c.encrypt(plain);
	const raw = Buffer.from(enc, 'base64');
	assert.equal(raw.subarray(0, 8).toString('ascii'), 'Salted__');
	assert.equal(c.decrypt(enc), JSON.stringify(plain));
	// SIDE EFFECT: random salt → two encryptions differ, both decrypt
	assert.notEqual(c.encrypt(plain), enc);
	// cross-check with independent EVP_BytesToKey implementation
	const { key, iv } = evpBytesToKey(DUMMY_KEY, raw.subarray(8, 16));
	const d = createDecipheriv('aes-256-cbc', key, iv);
	assert.equal(Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString('utf8'), JSON.stringify(plain));
});

test('Credentials: decrypt with the wrong key throws; short input returns empty string', skipUnit, () => {
	const enc = cipher(DUMMY_KEY).encrypt('hello');
	// ERROR: bad decrypt (padding) from node:crypto
	assert.throws(() => cipher(OTHER_KEY).decrypt(enc));
	assert.equal(cipher().decrypt(Buffer.from('short').toString('base64')), '');
});

test('Credentials class: setData/getData; NO_DATA, DECRYPTION_FAILED, INVALID_JSON errors', skipUnit, () => {
	const { Container } = n8nRequire('@n8n/di');
	const { Cipher } = n8nRequire('n8n-core/dist/encryption/cipher');
	const { Credentials, CredentialDataError } = n8nRequire('n8n-core/dist/credentials');
	Container.set(Cipher, cipher(DUMMY_KEY));

	const cred = new Credentials({ id: 'c1', name: 'dummy' }, 'httpHeaderAuth');
	// ERROR: no data yet
	assert.throws(() => cred.getData(), (e: any) => e instanceof CredentialDataError && e.message === 'No data is set on this credentials.');

	cred.setData({ name: 'X-Dummy', value: 'not-a-real-secret' });
	assert.deepEqual(cred.getData(), { name: 'X-Dummy', value: 'not-a-real-secret' });
	const toSave = cred.getDataToSave();
	assert.deepEqual(Object.keys(toSave).sort(), ['data', 'id', 'name', 'type']);
	assert.ok(Buffer.from(toSave.data, 'base64').subarray(0, 8).equals(Buffer.from('Salted__')));
	assert.ok(!toSave.data.includes('not-a-real-secret'));

	cred.updateData({ value: 'changed' }, ['name']);
	assert.deepEqual(cred.getData(), { value: 'changed' });

	// ERROR: wrong key
	Container.set(Cipher, cipher(OTHER_KEY));
	const wrong = new Credentials({ id: 'c1', name: 'dummy' }, 'httpHeaderAuth', toSave.data);
	assert.throws(() => wrong.getData(), (e: any) => e.message === 'Credentials could not be decrypted. The likely reason is that a different "encryptionKey" was used to encrypt the data.');

	// ERROR: decrypts but not JSON
	Container.set(Cipher, cipher(DUMMY_KEY));
	const notJson = new Credentials({ id: 'c2', name: 'dummy' }, 'httpHeaderAuth', cipher(DUMMY_KEY).encrypt('plain text, not json'));
	assert.throws(() => notJson.getData(), (e: any) => e.message === 'Decrypted credentials data is not valid JSON.');

	// ERROR: setData with a non-object literal is an assertion failure
	assert.throws(() => cred.setData('string' as any));
});

test('Credentials golden: REST surface redacts secrets and never returns plaintext', () => {
	const g = golden('credentials');
	assert.deepEqual(g.constants, { CREDENTIAL_BLANKING_VALUE: BLANK, CREDENTIAL_EMPTY_VALUE: EMPTY });
	assert.equal(g.cases.create.expected.status, 200);
	assert.equal(g.cases.create.expected.dataFieldPresent, true, 'create response carries ciphertext `data`');
	assert.equal(g.cases.getWithoutData.expected.hasData, false);
	assert.deepEqual(g.cases.getWithDataIsRedacted.expected.data, { name: 'X-Dummy', value: BLANK });
	assert.deepEqual(g.cases.updateWithBlankedValueKeepsSecret.expected, { status: 200, dataFieldPresent: false });
	assert.deepEqual(g.cases.notFound.expected, { status: 404, body: { code: 404, message: 'Credential with ID "does-not-exist" could not be found.' } });
	assert.deepEqual(g.cases.createInvalidType.expected, { status: 500, body: { code: 0, message: 'Unrecognized credential type: noSuchCredentialType' } });
	assert.deepEqual(g.cases.delete.expected, { status: 200, body: { data: true } });
	// no plaintext dummy secret leaked anywhere into the golden
	assert.ok(!JSON.stringify(g).includes('not-a-real-secret-0000'));
});

test('Credentials live: lookup / missing / invalid type / redaction round-trip', { skip: LIVE ? false : 'N8N_URL not set' }, async () => {
	await liveLogin();
	const created = await live('POST', '/rest/credentials', { name: `Agent4 live dummy ${Date.now()}`, type: 'httpHeaderAuth', data: { name: 'X-Dummy', value: 'dummy-value-not-secret' } });
	assert.equal(created.status, 200);
	const id = created.json.data.id;
	const plain = await live('GET', `/rest/credentials/${id}`);
	assert.equal('data' in plain.json.data, false);
	const red = await live('GET', `/rest/credentials/${id}?includeData=true`);
	assert.deepEqual(red.json.data.data, { name: 'X-Dummy', value: BLANK });
	const missing = await live('GET', '/rest/credentials/does-not-exist');
	assert.deepEqual(stripStack(missing.json), { code: 404, message: 'Credential with ID "does-not-exist" could not be found.' });
	const bad = await live('POST', '/rest/credentials', { name: 'bad type', type: 'noSuchCredentialType', data: { a: 1 } });
	assert.equal(bad.status, 500);
	assert.equal(bad.json.message, 'Unrecognized credential type: noSuchCredentialType');
	const del = await live('DELETE', `/rest/credentials/${id}`);
	assert.deepEqual(del.json, { data: true });
});
