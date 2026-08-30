const fs = require('fs');
const path = require('path');

// Written by server/scripts/write-version.js at build time (run from
// pw.json's server build step and from build.yml's build-server job) from
// whatever `.git` is present in a fresh clone. Absent entirely on local dev
// (the build step never runs there) or on a plain tarball build with no
// `.git` — both are the expected "unknown" path, not a bug.
const DEFAULT_VERSION_FILE = path.join(__dirname, '..', '..', 'version.json');

function readVersionFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      sha: typeof parsed.sha === 'string' ? parsed.sha : null,
      version: typeof parsed.version === 'string' ? parsed.version : null,
    };
  } catch {
    // Missing file, unreadable, or invalid JSON are all the same case here:
    // no usable build info. Never let a malformed file take the server down.
    return { sha: null, version: null };
  }
}

/**
 * Resolve the running build's identity for /health/live and /health/ready.
 * Precedence: env vars (a future PW-side injection, per issue #184) win
 * outright over the generated file (this repo's own build-time fallback),
 * which wins over the literal string "unknown".
 */
function getBuildInfo(filePath = DEFAULT_VERSION_FILE) {
  const fromFile = readVersionFile(filePath);
  return {
    version: process.env.APP_VERSION || fromFile.version || 'unknown',
    sha: process.env.APP_SHA || fromFile.sha || 'unknown',
  };
}

module.exports = { getBuildInfo, DEFAULT_VERSION_FILE };
