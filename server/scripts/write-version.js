// Build-time step (invoked by pw.json's server build command and by
// build.yml's build-server job — the two pipelines CI/CD rule 5 requires to
// stay equivalent) that stamps the commit this build was produced from.
//
// server/index.js has always read process.env.APP_SHA / APP_VERSION for
// /health/live and /health/ready, but nothing at deploy time ever set them
// (issue #184) — the orchestrator has no sha-injection mechanism, so the
// only route available FROM THIS REPO is to record what we can determine
// at build time and let the server read it as a fallback.
//
// This runs on whatever cloned the repo to build it: the PW orchestrator
// (fresh `git clone` per issue #184's own description) or the GH Actions
// self-hosted runner (`actions/checkout`). Both leave a real `.git` next to
// this file's repo root. A plain tarball build (no `.git` at all) does not,
// and that is treated as a legitimate, expected case — not an error.
//
// Contract: NEVER throw, NEVER exit non-zero, NEVER write a sha that isn't
// actually HEAD. Worst case on failure is an "unknown"-shaped file, which
// server/src/utils/version.js already treats identically to a missing file.
// Silently stamping a wrong sha would be worse than reporting nothing.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_PATH = path.join(__dirname, '..', 'version.json');
const SHA_RE = /^[0-9a-f]{40}$/;

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function resolve() {
  if (!fs.existsSync(path.join(REPO_ROOT, '.git'))) {
    return { sha: null, version: null, dirty: null, reason: 'no .git directory (tarball build?)' };
  }

  let sha;
  try {
    sha = git(['rev-parse', 'HEAD']);
  } catch (err) {
    return { sha: null, version: null, dirty: null, reason: `git rev-parse HEAD failed: ${err.message}` };
  }
  if (!SHA_RE.test(sha)) {
    return { sha: null, version: null, dirty: null, reason: `git rev-parse HEAD returned something that isn't a commit sha: ${sha}` };
  }

  // Informational only — doesn't affect whether we trust `sha` above, which
  // is HEAD regardless of working-tree state. Untracked files (this script's
  // own output included, plus client/dist/ build output) never count.
  let dirty = null;
  try {
    dirty = git(['status', '--porcelain', '--untracked-files=no']).length > 0;
  } catch {
    // Non-fatal — leave dirty as null (unknown) rather than guessing.
  }

  // A human-readable tag/branch-ish label. `--always` falls back to the
  // abbreviated sha when no tag is reachable, which also makes this safe on
  // a shallow (--depth 1) clone with no tag history at all.
  let version;
  try {
    version = git(['describe', '--tags', '--always', '--dirty']);
  } catch {
    version = sha.slice(0, 7);
  }

  return { sha, version, dirty };
}

function main() {
  let info;
  try {
    info = resolve();
  } catch (err) {
    // Belt-and-suspenders: resolve() already catches everything it expects
    // to fail, but this build step must never be the reason a deploy fails.
    info = { sha: null, version: null, dirty: null, reason: `unexpected error: ${err.message}` };
  }

  const payload = {
    sha: info.sha,
    version: info.version,
    dirty: info.dirty,
    generatedAt: new Date().toISOString(),
    ...(info.reason ? { reason: info.reason } : {}),
  };

  try {
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + '\n');
    console.log(
      payload.sha
        ? `[write-version] stamped ${OUTPUT_PATH} — sha=${payload.sha.slice(0, 12)} version=${payload.version} dirty=${payload.dirty}`
        : `[write-version] wrote ${OUTPUT_PATH} with no sha (${payload.reason}) — /health/live will report "unknown" unless APP_SHA is set`
    );
  } catch (err) {
    // Still never fail the build — a server started without this file just
    // falls back to "unknown", same as today.
    console.warn(`[write-version] could not write ${OUTPUT_PATH}: ${err.message}`);
  }
}

main();
