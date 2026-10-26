import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';

test('finds Turso settings, including names prefixed by the Vercel integration', () => {
  const plain = loadConfig({ VERCEL: '1', TURSO_DATABASE_URL: 'libsql://a.turso.io', TURSO_AUTH_TOKEN: 't1' } as NodeJS.ProcessEnv);
  assert.deepEqual(plain.db, { url: 'libsql://a.turso.io', authToken: 't1' });
  const prefixed = loadConfig({ VERCEL: '1', STORAGE_TURSO_DATABASE_URL: 'libsql://b.turso.io', STORAGE_TURSO_AUTH_TOKEN: 't2' } as NodeJS.ProcessEnv);
  assert.deepEqual(prefixed.db, { url: 'libsql://b.turso.io', authToken: 't2' });
});

test('on Vercel a missing database names the related settings it found, never their values', () => {
  assert.throws(() => loadConfig({ VERCEL: '1', MY_DATABASE_URI: 'secret-value' } as NodeJS.ProcessEnv), (err: Error) => {
    assert.match(err.message, /TURSO_DATABASE_URL is not set/);
    assert.match(err.message, /MY_DATABASE_URI/);
    assert.doesNotMatch(err.message, /secret-value/);
    return true;
  });
  // On a PC without Turso settings, a local file is used.
  assert.match(loadConfig({} as NodeJS.ProcessEnv).db.url, /^file:.*local\.db$/);
});
