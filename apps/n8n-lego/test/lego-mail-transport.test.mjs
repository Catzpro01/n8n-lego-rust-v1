/**
 * P5-M06 — mail transport + password-recovery delivery (DEC-0028 rev 2, option A).
 *
 * Focused suite (CP-04):
 *   1. transport contract conformance — closed error model, message freeze,
 *      injection swap (recording fake vs console) with no hidden provider;
 *   2. deterministic composition — byte-stable recovery mail, pinned subject;
 *   3. failure propagation — typed codes preserved, foreign throws wrapped,
 *      never a silent drop;
 *   4. secret hygiene — the reset URL (the credential) never reaches a log;
 *   5. end to end over the P5 reset-token primitive — forgot-password ->
 *      injected transport -> change-password, replay refused;
 *   6. rollback — unplugging delivery restores the pinned upstream no-SMTP 500
 *      and touches no reset-token history; the composition root accepts an
 *      injected transport and an explicit `mailTransport: false`.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { isErrorCode } from '../src/lego/errors.mjs';
import { startServer } from '../src/server.mjs';
import { createStore } from '../src/store.mjs';
import { HttpError } from '../src/compat/error.mjs';
import { readBody, sendError } from '../src/compat/response.mjs';
import { authRoutes } from '../src/auth/routes.mjs';
import { createAccountSecurity } from '../src/auth/account-routes.mjs';
import { currentUser, createOwner } from '../src/auth.mjs';
import {
  MAIL_TRANSPORT_REASON,
  MailTransportError,
  assertMailTransport,
  assertMailTransportReason,
  createConsoleMailTransport,
  createRecordingMailTransport,
  freezeMailMessage,
  isMailTransportError,
  redactMailSecrets,
} from '../src/auth/security/mail-transport.mjs';
import {
  PASSWORD_RESET_MAIL_SUBJECT,
  composePasswordResetMail,
  createPasswordResetDelivery,
} from '../src/auth/password-reset-delivery.mjs';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_CATALOG = join(APP_ROOT, '..', '..', 'catalog');
const PASSWORD = 'Correct-Horse-9';
const NEW_PASSWORD = 'Fresh-Horse-7';

function spyLogger() {
  const lines = [];
  const log = (level) => (msg, data) => lines.push(JSON.stringify([level, msg, data]));
  return {
    lines,
    text: () => lines.join('\n'),
    logger: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
  };
}

/* ======================================================================= 1 */
/*                    TRANSPORT CONTRACT (DEC-0028 option A)                 */
/* ======================================================================= */

describe('MailTransport contract: closed error model, frozen values', () => {
  test('every reason is a published error code — the mapping cannot drift', () => {
    for (const [name, code] of Object.entries(MAIL_TRANSPORT_REASON)) {
      assert.ok(isErrorCode(code), `${name} -> ${code} must be published`);
      assert.equal(assertMailTransportReason(code), true);
    }
    assert.throws(() => assertMailTransportReason('lego.unknown-code'), TypeError);
    assert.throws(() => assertMailTransportReason('MAIL_TIMEOUT'), TypeError);
  });

  test('MailTransportError refuses codes outside the closed set and freezes', () => {
    const err = new MailTransportError(MAIL_TRANSPORT_REASON.TIMEOUT, 'send timed out', { details: { phase: 'send' } });
    assert.ok(err instanceof Error && isMailTransportError(err));
    assert.equal(err.name, 'MailTransportError');
    assert.equal(err.code, 'lego.deadline_exceeded');
    assert.equal(err.status, 504);
    assert.ok(Object.isFrozen(err) && Object.isFrozen(err.details));
    // Published but NOT a mail reason: still refused — the model is closed.
    assert.throws(() => new MailTransportError('lego.cancelled', 'nope'), TypeError);
    assert.throws(() => new MailTransportError('made.up', 'nope'), TypeError);
  });

  test('assertMailTransport accepts exactly objects with send()', () => {
    const ok = { send: async () => {} };
    assert.equal(assertMailTransport(ok), ok);
    for (const bad of [null, undefined, 'x', 42, {}, { send: 1 }, { send: 'x' }]) {
      assert.throws(() => assertMailTransport(bad), TypeError, JSON.stringify(bad));
    }
  });

  test('freezeMailMessage freezes a provider-neutral shape and rejects misuse with INVALID_MESSAGE', () => {
    const msg = freezeMailMessage({ to: ' a@b.io ', subject: ' S ', text: 'body', html: '<p>b</p>', providerField: 'nope' });
    assert.deepEqual({ ...msg }, { to: 'a@b.io', subject: 'S', text: 'body', html: '<p>b</p>' });
    assert.ok(Object.isFrozen(msg) && !('providerField' in msg), 'provider-specific fields cannot enter the contract');
    for (const bad of [
      null,
      'x',
      {},
      { to: 'nope', subject: 'S', text: 'b' },
      { to: 'a@b.io', subject: '', text: 'b' },
      { to: 'a@b.io', subject: 'S', text: '' },
      { to: 'a@b.io', subject: 'S', text: 'b', html: '' },
    ]) {
      try {
        freezeMailMessage(bad);
        assert.fail(`expected INVALID_MESSAGE for ${JSON.stringify(bad)}`);
      } catch (error) {
        assert.ok(isMailTransportError(error));
        assert.equal(error.code, MAIL_TRANSPORT_REASON.INVALID_MESSAGE);
      }
    }
  });

  test('redactMailSecrets masks token query parameters (the URL is the credential)', () => {
    const url = 'http://host/change-password?token=AbCdEf0123456789&mfaEnabled=false';
    const red = redactMailSecrets(`Open ${url} now`);
    assert.ok(!red.includes('AbCdEf0123456789'));
    assert.ok(red.includes('token=[REDACTED]') && red.includes('mfaEnabled=false'));
  });
});

/* ======================================================================= 2 */
/*                     DETERMINISTIC COMPOSITION (CP-02)                     */
/* ======================================================================= */

describe('composePasswordResetMail: deterministic, pinned upstream shape', () => {
  const input = { email: 'ada@p56.test', firstName: 'Ada', passwordResetUrl: 'http://host/change-password?token=T0K&mfaEnabled=false' };

  test('same input -> byte-identical frozen message; subject pinned to upstream', () => {
    const a = composePasswordResetMail(input);
    const b = composePasswordResetMail(input);
    assert.deepEqual(a, b);
    assert.equal(a.text, b.text);
    assert.ok(Object.isFrozen(a));
    assert.equal(a.to, 'ada@p56.test');
    assert.equal(a.subject, PASSWORD_RESET_MAIL_SUBJECT);
    assert.equal(a.subject, 'n8n password reset');
    assert.ok(a.text.includes(input.passwordResetUrl), 'the credential URL reaches the message body');
    assert.ok(a.text.includes('Hello Ada,'));
    assert.ok(a.text.includes('20 minutes') && a.text.includes('once'));
  });

  test('missing firstName falls back to a fixed greeting (still deterministic)', () => {
    const a = composePasswordResetMail({ email: 'ada@p56.test', passwordResetUrl: 'http://u' });
    assert.equal(a.text.split('\n')[0], 'Hello there,');
    assert.equal(a.text, composePasswordResetMail({ email: 'ada@p56.test', firstName: '  ', passwordResetUrl: 'http://u' }).text);
  });

  test('malformed input is INVALID_MESSAGE — closed model end to end', () => {
    for (const bad of [null, {}, { email: 'a@b.io' }, { passwordResetUrl: 'http://u' }, { email: '', passwordResetUrl: 'http://u' }, { email: 'a@b.io', passwordResetUrl: '' }]) {
      try {
        composePasswordResetMail(bad);
        assert.fail('expected INVALID_MESSAGE');
      } catch (error) {
        assert.ok(isMailTransportError(error));
        assert.equal(error.code, MAIL_TRANSPORT_REASON.INVALID_MESSAGE);
      }
    }
  });
});

/* ======================================================================= 3 */
/*                     ADAPTERS + FAILURE PROPAGATION                        */
/* ======================================================================= */

describe('adapters: injection swap, typed failures, no hidden side effects', () => {
  test('recording transport records frozen messages and injects typed failures once', async () => {
    const transport = createRecordingMailTransport();
    const outcome = await transport.send({ to: 'a@b.io', subject: 'S', text: 'b' });
    assert.deepEqual({ ...outcome }, { messageId: 'rec-0001', accepted: ['a@b.io'] });
    assert.ok(Object.isFrozen(outcome) && Object.isFrozen(outcome.accepted));
    assert.equal(transport.messages().length, 1);
    assert.ok(Object.isFrozen(transport.messages()[0]));

    transport.failNext(MAIL_TRANSPORT_REASON.REFUSED, 'relay refused', { rejected: ['a@b.io'] });
    await assert.rejects(
      () => transport.send({ to: 'a@b.io', subject: 'S', text: 'b' }),
      (error) => isMailTransportError(error) && error.code === 'lego.access_denied' && error.details.rejected[0] === 'a@b.io',
    );
    await transport.send({ to: 'a@b.io', subject: 'S', text: 'b' }); // failure was single-use
    assert.equal(transport.messages().length, 2);
  });

  test('console transport logs a redacted view only — the raw token never reaches a log', async () => {
    const spy = spyLogger();
    const transport = createConsoleMailTransport({ logger: spy.logger });
    const url = 'http://host/change-password?token=Sup3rSecretTokenValue123&mfaEnabled=true';
    const outcome = await transport.send(composePasswordResetMail({ email: 'ada@p56.test', firstName: 'Ada', passwordResetUrl: url }));
    assert.equal(outcome.messageId.slice(0, 8), 'console-');
    assert.deepEqual([...outcome.accepted], ['ada@p56.test']);
    const all = spy.text();
    assert.ok(all.includes('token=[REDACTED]'), 'the redacted view is what gets logged');
    assert.ok(!all.includes('Sup3rSecretTokenValue123'), 'the credential never reaches the log');
    assert.ok(all.includes('ada@p56.test') && all.includes(PASSWORD_RESET_MAIL_SUBJECT));
  });

  test('delivery uses ONLY the injected transport (swap = no hidden provider) and logs outcome, not body', async () => {
    const recording = createRecordingMailTransport();
    const spy = spyLogger();
    const delivery = createPasswordResetDelivery({ transport: recording, logger: spy.logger });
    const url = 'http://host/change-password?token=AbcTOKENxyz&mfaEnabled=false';
    const outcome = await delivery.passwordReset({ email: 'ada@p56.test', firstName: 'Ada', passwordResetUrl: url });
    assert.equal(outcome.messageId, 'rec-0001');
    assert.equal(recording.messages().length, 1, 'the injected transport got the message');
    const all = spy.text();
    assert.ok(all.includes('mail.password-reset-sent') && all.includes('rec-0001'));
    assert.ok(!all.includes('AbcTOKENxyz') && !all.includes(url), 'no body, no URL in logs');
  });

  test('transport failures propagate with their closed code; foreign throws are wrapped into UNAVAILABLE', async () => {
    for (const code of [MAIL_TRANSPORT_REASON.TIMEOUT, MAIL_TRANSPORT_REASON.REFUSED, MAIL_TRANSPORT_REASON.UNAVAILABLE]) {
      const recording = createRecordingMailTransport();
      recording.failNext(code, 'boom');
      const delivery = createPasswordResetDelivery({ transport: recording, logger: spyLogger().logger });
      await assert.rejects(
        () => delivery.passwordReset({ email: 'a@b.io', passwordResetUrl: 'http://u' }),
        (error) => isMailTransportError(error) && error.code === code,
      );
    }
    const foreign = {
      send: async () => {
        throw new Error('provider internals: user=smtp-admin pass=hunter2');
      },
    };
    const delivery = createPasswordResetDelivery({ transport: foreign, logger: spyLogger().logger });
    await assert.rejects(
      () => delivery.passwordReset({ email: 'a@b.io', passwordResetUrl: 'http://u' }),
      (error) => {
        assert.ok(isMailTransportError(error));
        assert.equal(error.code, MAIL_TRANSPORT_REASON.UNAVAILABLE);
        assert.ok(!error.message.includes('hunter2'), 'foreign internals are not copied into the closed model');
        return true;
      },
    );
    assert.throws(() => createPasswordResetDelivery({ transport: {}, logger: spyLogger().logger }), TypeError);
    assert.throws(() => createPasswordResetDelivery({ transport: { send: async () => {} }, logger: {} }), TypeError);
  });

  test('compose failures never reach the transport (no side effect on INVALID input)', async () => {
    const recording = createRecordingMailTransport();
    const delivery = createPasswordResetDelivery({ transport: recording, logger: spyLogger().logger });
    await assert.rejects(() => delivery.passwordReset({ email: 'a@b.io' }), isMailTransportError);
    assert.equal(recording.messages().length, 0);
  });
});

/* ======================================================================= 4 */
/*          END TO END OVER THE P5 RESET-TOKEN PRIMITIVE (CP-02/03)          */
/* ======================================================================= */

async function harness({ delivery = null, security = createAccountSecurity(), store = createStore({ storage: 'memory' }), secret = randomBytes(16).toString('hex') } = {}) {
  const logs = [];
  const logger = {
    info: (m, d) => logs.push(JSON.stringify([m, d])),
    warn: (m, d) => logs.push(JSON.stringify([m, d])),
    error: (m, d) => logs.push(JSON.stringify([m, d])),
    debug: () => {},
  };
  const config = {
    secret,
    protocol: 'http',
    port: 0,
    publicUrl: 'http://127.0.0.1',
    storage: 'memory',
    catalogDir: process.env.N8N_LEGO_CATALOG_DIR ?? REPO_CATALOG,
  };
  const routes = authRoutes({ logger, delivery, security });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://h');
    const route = routes.find((r) => (Array.isArray(r.method) ? r.method.includes(req.method) : r.method === req.method) && r.path === url.pathname);
    const ctx = { req, res, config, logger, store, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), params: {}, body: undefined, user: null };
    try {
      ctx.user = currentUser(store, config, req);
      if (!route) throw new HttpError(404, 'Not found');
      if (!route.public && !ctx.user) throw new HttpError(401, 'Unauthorized');
      if (['POST', 'PATCH'].includes(req.method)) ctx.body = await readBody(req, { limit: 1e6 });
      await route.handler(ctx);
    } catch (error) {
      sendError(res, error);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = base;
  return { base, store, config, security, logs, close: () => new Promise((r) => server.close(r)) };
}

function browser(base) {
  return {
    async call(method, path, body) {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
    },
  };
}

describe('password recovery over the injected transport (E2E)', () => {
  test('forgot-password delivers through the transport; token completes the reset; replay refused', async () => {
    const recording = createRecordingMailTransport();
    const security = createAccountSecurity();
    const delivery = createPasswordResetDelivery({ transport: recording, logger: { info: () => {}, warn: () => {} } });
    const h = await harness({ delivery, security });
    try {
      createOwner(h.store, { email: 'owner@p56.test', firstName: 'Ada', lastName: 'L', password: PASSWORD });
      const b = browser(h.base);

      const r1 = await b.call('POST', '/rest/forgot-password', { email: 'OWNER@p56.test' });
      assert.equal(r1.status, 200, r1.raw);
      assert.equal(r1.raw, '{}', 'the answer is the pinned empty 200 ({})');
      await new Promise((r) => setTimeout(r, 20)); // delivery is fire-and-forget by contract
      const messages = recording.messages();
      assert.equal(messages.length, 1);
      const mail = messages[0];
      assert.equal(mail.to, 'owner@p56.test');
      assert.equal(mail.subject, PASSWORD_RESET_MAIL_SUBJECT);
      const match = mail.text.match(/token=([A-Za-z0-9_-]{43})/);
      assert.ok(match, 'the message carries the issued token');
      const token = match[1];
      assert.ok(mail.text.includes('/change-password?token='));
      assert.ok(!h.logs.join('\n').includes(token), 'the token never reaches a log');

      const resolve1 = await b.call('GET', `/rest/resolve-password-token?token=${token}`);
      assert.equal(resolve1.status, 200, resolve1.raw);
      const done = await b.call('POST', '/rest/change-password', { token, password: NEW_PASSWORD });
      assert.equal(done.status, 200, done.raw);

      const replay = await b.call('POST', '/rest/change-password', { token, password: NEW_PASSWORD });
      assert.equal(replay.status, 404, 'single use: the consumed link answers 404 like every other miss');
      const resolve2 = await b.call('GET', `/rest/resolve-password-token?token=${token}`);
      assert.equal(resolve2.status, 404);

      const login = await b.call('POST', '/rest/login', { emailOrLdapLoginId: 'owner@p56.test', password: NEW_PASSWORD });
      assert.equal(login.status, 200, login.raw);
    } finally {
      await h.close();
    }
  });

  test('unknown accounts answer identically and nothing is sent', async () => {
    const recording = createRecordingMailTransport();
    const delivery = createPasswordResetDelivery({ transport: recording, logger: { info: () => {}, warn: () => {} } });
    const h = await harness({ delivery });
    try {
      createOwner(h.store, { email: 'owner@p56.test', firstName: 'Ada', lastName: 'L', password: PASSWORD });
      const b = browser(h.base);
      const known = await b.call('POST', '/rest/forgot-password', { email: 'owner@p56.test' });
      const unknown = await b.call('POST', '/rest/forgot-password', { email: 'ghost@p56.test' });
      assert.equal(known.status, unknown.status);
      assert.equal(known.raw, unknown.raw);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(recording.messages().length, 1, 'only the known account produced mail');
      assert.equal(recording.messages()[0].to, 'owner@p56.test');
    } finally {
      await h.close();
    }
  });

  test('a failing transport is an explicit warn, never a silent drop or a different HTTP answer', async () => {
    const recording = createRecordingMailTransport();
    recording.failNext(MAIL_TRANSPORT_REASON.UNAVAILABLE, 'relay down');
    const delivery = createPasswordResetDelivery({ transport: recording, logger: { info: () => {}, warn: () => {} } });
    const h = await harness({ delivery });
    try {
      createOwner(h.store, { email: 'owner@p56.test', firstName: 'Ada', lastName: 'L', password: PASSWORD });
      const r = await browser(h.base).call('POST', '/rest/forgot-password', { email: 'owner@p56.test' });
      assert.equal(r.status, 200, r.raw);
      await new Promise((r) => setTimeout(r, 20));
      assert.ok(h.logs.join('\n').includes('auth.password-reset-delivery-failed'), 'the failure is logged explicitly');
    } finally {
      await h.close();
    }
  });
});

/* ======================================================================= 5 */
/*                    ROLLBACK: UNPLUG / EXPLICIT DISABLE                    */
/* ======================================================================= */

describe('rollback: unplugging delivery restores the pinned upstream answer', () => {
  test('delivery = null -> the upstream no-SMTP 500 for every address; reset history untouched', async () => {
    const recording = createRecordingMailTransport();
    const security = createAccountSecurity();
    // One account world across both phases (same store + secret): the token's
    // fingerprint is bound to them, so only a shared world can prove that the
    // rollback leaves reset-token history intact.
    const store = createStore({ storage: 'memory' });
    const secret = randomBytes(16).toString('hex');
    const delivery = createPasswordResetDelivery({ transport: recording, logger: { info: () => {}, warn: () => {} } });
    const wired = await harness({ delivery, security, store, secret });
    let token = '';
    try {
      createOwner(store, { email: 'owner@p56.test', firstName: 'Ada', lastName: 'L', password: PASSWORD });
      await browser(wired.base).call('POST', '/rest/forgot-password', { email: 'owner@p56.test' });
      await new Promise((r) => setTimeout(r, 20));
      token = recording.messages()[0].text.match(/token=([A-Za-z0-9_-]{43})/)[1];
    } finally {
      await wired.close();
    }
    // Unplugged: same security state (token history intact), no delivery port.
    const unplugged = await harness({ security, store, secret });
    try {
      const b = browser(unplugged.base);
      const known = await b.call('POST', '/rest/forgot-password', { email: 'owner@p56.test' });
      const unknown = await b.call('POST', '/rest/forgot-password', { email: 'ghost@p56.test' });
      assert.equal(known.status, 500);
      assert.equal(known.raw, unknown.raw, 'identical for every address');
      assert.equal(known.body.message, 'Email sending must be set up in order to request a password reset email');
      // The outstanding token from the wired phase still resolves: history intact.
      const resolve = await b.call('GET', `/rest/resolve-password-token?token=${token}`);
      assert.equal(resolve.status, 200, resolve.raw);
    } finally {
      await unplugged.close();
    }
  });
});

/* ======================================================================= 6 */
/*              COMPOSITION ROOT: INJECTION + EXPLICIT DISABLE                */
/* ======================================================================= */

describe('composition root (startServer): injected transport and mailTransport: false', () => {
  const USER_FOLDER = mkdtempSync(join(tmpdir(), 'n8n-lego-p5m06-'));
  const env = () => ({
    ...process.env,
    N8N_LEGO_PORT: '0',
    N8N_LEGO_HOST: '127.0.0.1',
    N8N_LEGO_STORAGE: 'file',
    N8N_LEGO_LOG_LEVEL: 'error',
    N8N_LEGO_PROTOCOL: 'http',
    N8N_LEGO_USER_FOLDER: USER_FOLDER,
    N8N_LEGO_CATALOG_DIR: process.env.N8N_LEGO_CATALOG_DIR ?? REPO_CATALOG,
  });
  after(() => rmSync(USER_FOLDER, { recursive: true, force: true }));

  async function call(base, method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', origin: base },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, raw: text };
  }

  test('an injected MailTransport receives the recovery mail; mailTransport: false restores the 500', async () => {
    const recording = createRecordingMailTransport();
    const first = await startServer({ env: env(), mailTransport: recording });
    try {
      const base = `http://127.0.0.1:${first.server.address().port}`;
      assert.equal(first.mailTransport, recording, 'the composition root keeps the injected handle');
      const setup = await call(base, 'POST', '/rest/owner/setup', { email: 'owner@real.test', firstName: 'O', lastName: 'W', password: PASSWORD });
      assert.equal(setup.status, 200, setup.raw);
      const r = await call(base, 'POST', '/rest/forgot-password', { email: 'owner@real.test' });
      assert.equal(r.status, 200, r.raw);
      await new Promise((res) => setTimeout(res, 20));
      assert.equal(recording.messages().length, 1, 'delivery ran through the injected transport');
      assert.equal(recording.messages()[0].subject, PASSWORD_RESET_MAIL_SUBJECT);
    } finally {
      await new Promise((r) => first.server.close(r));
    }

    const second = await startServer({ env: env(), mailTransport: false });
    try {
      const base = `http://127.0.0.1:${second.server.address().port}`;
      assert.equal(second.mailTransport, null);
      const r = await call(base, 'POST', '/rest/forgot-password', { email: 'owner@real.test' });
      assert.equal(r.status, 500);
      assert.equal(r.body.message, 'Email sending must be set up in order to request a password reset email');
    } finally {
      await new Promise((r) => second.server.close(r));
    }
  });
});
