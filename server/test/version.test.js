const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const { getBuildInfo } = require('../src/utils/version');

// Issue #184: /health/live must report a real sha when the build step's
// generated file exists, "unknown" when it doesn't, and let env vars (a
// future PW-side injection) win over both without any code change.

function withTempVersionFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tally-version-test-'));
  const filePath = path.join(dir, 'version.json');
  if (contents !== undefined) {
    fs.writeFileSync(filePath, typeof contents === 'string' ? contents : JSON.stringify(contents));
  }
  return {
    filePath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test.beforeEach(() => {
  delete process.env.APP_SHA;
  delete process.env.APP_VERSION;
});

test.afterEach(() => {
  delete process.env.APP_SHA;
  delete process.env.APP_VERSION;
});

test('reports "unknown" when the generated file does not exist', () => {
  const { filePath, cleanup } = withTempVersionFile(undefined);
  try {
    const build = getBuildInfo(filePath);
    assert.deepEqual(build, { version: 'unknown', sha: 'unknown' });
  } finally {
    cleanup();
  }
});

test('reports the sha/version from the generated file when present', () => {
  const { filePath, cleanup } = withTempVersionFile({
    sha: 'a'.repeat(40),
    version: 'v1.2.3',
    dirty: false,
    generatedAt: '2026-08-30T00:00:00.000Z',
  });
  try {
    const build = getBuildInfo(filePath);
    assert.deepEqual(build, { version: 'v1.2.3', sha: 'a'.repeat(40) });
  } finally {
    cleanup();
  }
});

test('a malformed generated file is treated the same as a missing one', () => {
  const { filePath, cleanup } = withTempVersionFile('{ not valid json');
  try {
    const build = getBuildInfo(filePath);
    assert.deepEqual(build, { version: 'unknown', sha: 'unknown' });
  } finally {
    cleanup();
  }
});

test('env vars win over the generated file', () => {
  const { filePath, cleanup } = withTempVersionFile({ sha: 'b'.repeat(40), version: 'from-file' });
  try {
    process.env.APP_SHA = 'c'.repeat(40);
    process.env.APP_VERSION = 'from-env';
    const build = getBuildInfo(filePath);
    assert.deepEqual(build, { version: 'from-env', sha: 'c'.repeat(40) });
  } finally {
    cleanup();
  }
});

test('env vars win even when the generated file is absent', () => {
  const { filePath, cleanup } = withTempVersionFile(undefined);
  try {
    process.env.APP_SHA = 'd'.repeat(40);
    process.env.APP_VERSION = 'from-env-only';
    const build = getBuildInfo(filePath);
    assert.deepEqual(build, { version: 'from-env-only', sha: 'd'.repeat(40) });
  } finally {
    cleanup();
  }
});

// ── End-to-end shape: a route built exactly like /health/live's, over HTTP ──

async function withServer(app, fn) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function buildHealthApp(versionFilePath) {
  const app = express();
  app.get('/health/live', (req, res) => {
    const build = getBuildInfo(versionFilePath);
    res.json({ status: 'ok', version: build.version, sha: build.sha });
  });
  return app;
}

test('/health/live reports a real sha when the generated file exists', async () => {
  const { filePath, cleanup } = withTempVersionFile({ sha: 'e'.repeat(40), version: 'master-e5adcaf' });
  try {
    await withServer(buildHealthApp(filePath), async (base) => {
      const res = await fetch(`${base}/health/live`);
      const body = await res.json();
      assert.equal(body.sha, 'e'.repeat(40));
      assert.equal(body.version, 'master-e5adcaf');
    });
  } finally {
    cleanup();
  }
});

test('/health/live reports "unknown" when the generated file is absent', async () => {
  const { filePath, cleanup } = withTempVersionFile(undefined);
  try {
    await withServer(buildHealthApp(filePath), async (base) => {
      const res = await fetch(`${base}/health/live`);
      const body = await res.json();
      assert.equal(body.sha, 'unknown');
      assert.equal(body.version, 'unknown');
    });
  } finally {
    cleanup();
  }
});

test('/health/live prefers env vars over the generated file', async () => {
  const { filePath, cleanup } = withTempVersionFile({ sha: 'f'.repeat(40), version: 'from-file' });
  try {
    process.env.APP_SHA = '1'.repeat(40);
    process.env.APP_VERSION = 'from-env';
    await withServer(buildHealthApp(filePath), async (base) => {
      const res = await fetch(`${base}/health/live`);
      const body = await res.json();
      assert.equal(body.sha, '1'.repeat(40));
      assert.equal(body.version, 'from-env');
    });
  } finally {
    cleanup();
  }
});
