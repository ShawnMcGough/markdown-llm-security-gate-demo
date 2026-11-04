import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CHECK_NAME, CLI_VERSION, reviewId, rulesFrom, sha256 } from './core.mjs';

const policy = await readFile(new URL('../SECURITY_STANDARD.md', import.meta.url), 'utf8');
const runnerUrl = new URL('./run.mjs', import.meta.url).href;

async function report(t, options = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'markdown-reporter-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const repository = 'fixture/demo';
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const before = Buffer.from('before\n');
  const after = Buffer.from('after\n');
  const blobId = (bytes) => createHash('sha1')
    .update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const snapshot = {
    repository, pr: 1, head_sha: head, base_sha: base, policy_sha256: sha256(policy),
    before_blob: blobId(before), after_blob: blobId(after),
  };
  const review = {
    schema_version: 1, review_id: reviewId(snapshot), review_complete: true,
    files: [{
      path: 'app.py',
      assessments: rulesFrom(policy).map((rule) => ({
        policy_id: rule.id,
        status: options.violation && rule.id === 'SEC-001' ? 'fail' : 'pass',
        rationale: 'Synthetic reporter fixture, not model evidence.',
      })),
    }],
    findings: options.violation ? [{
      policy_id: 'SEC-001', path: 'app.py', line: 1, severity: 'HIGH',
      rationale: 'Synthetic policy violation.',
    }] : [],
  };
  const pr = {
    number: 1, state: 'open', changed_files: 1,
    head: { sha: head, repo: { full_name: repository } },
    base: { sha: base, ref: 'main', repo: { full_name: repository } },
  };
  const responses = {
    'pulls/1': pr,
    'pulls/1/files?per_page=100': [{ filename: 'app.py', status: 'modified' }],
    'check-runs/42': {
      name: CHECK_NAME, head_sha: head, external_id: '100:1',
    },
  };
  for (const [sha, bytes] of [[base, before], [head, after]]) {
    responses[`git/trees/${sha}`] = {
      truncated: false,
      tree: [{ path: 'app.py', type: 'blob', mode: '100644', sha: blobId(bytes) }],
    };
    responses[`git/blobs/${blobId(bytes)}`] = {
      encoding: 'base64', size: bytes.length, content: bytes.toString('base64'),
    };
  }
  await mkdir(join(cwd, 'gate-output'));
  await writeFile(join(cwd, 'SECURITY_STANDARD.md'), policy);
  await writeFile(join(cwd, 'event.json'), JSON.stringify({ inputs: { pr_number: '1' } }));
  if (!options.missingArtifact) {
    await writeFile(join(cwd, 'gate-output', 'review.json'),
      options.malformedArtifact ? '{broken' : JSON.stringify({
        snapshot, cli_version: CLI_VERSION, review,
      }));
  }
  // Exercise the real reporter with a closed, in-process API fixture: no network or model calls.
  const program = `
    import assert from 'node:assert/strict';
    import { writeFileSync } from 'node:fs';
    const responses = ${JSON.stringify(responses)};
    globalThis.fetch = async (url, init) => {
      const prefix = 'https://api.github.com/repos/${repository}/';
      assert(url.startsWith(prefix), 'Unexpected API host');
      const path = url.slice(prefix.length);
      if (init.method === 'PATCH') {
        assert.equal(path, 'check-runs/42');
        writeFileSync('publication.json', init.body);
        const status = ${options.publishStatus ?? 200};
        return { ok: status === 200, status, json: async () => ({}) };
      }
      assert.equal(init.method, 'GET');
      assert(Object.hasOwn(responses, path), 'Unexpected API path: ' + path);
      return { ok: true, status: 200, json: async () => responses[path] };
    };
    process.argv[2] = 'finish';
    await import(${JSON.stringify(runnerUrl)});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd, encoding: 'utf8', timeout: 10000,
    env: {
      GITHUB_TOKEN: 'synthetic-test-token', GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
      GITHUB_EVENT_PATH: join(cwd, 'event.json'), GITHUB_RUN_ID: '100',
      GITHUB_RUN_ATTEMPT: '1', GITHUB_STEP_SUMMARY: join(cwd, 'summary.md'),
      TRUSTED_SHA: base, EXPECTED_HEAD: head, EXPECTED_BASE: base, CHECK_ID: '42',
      START_RESULT: 'success', REVIEW_RESULT: options.reviewResult ?? 'success',
    },
  });
  assert.ifError(result.error);
  return {
    ...result,
    publication: JSON.parse(await readFile(join(cwd, 'publication.json'), 'utf8')),
    summary: await readFile(join(cwd, 'summary.md'), 'utf8'),
  };
}

test('clean review publishes success and reporting job succeeds', async (t) => {
  const result = await report(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.publication.conclusion, 'success');
  assert.deepEqual(result.publication.output.annotations, []);
});

test('policy rejection fails only the required gate, not the successful reporter', async (t) => {
  const result = await report(t, { violation: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.publication.conclusion, 'failure');
  assert.equal(result.publication.output.annotations[0].title, 'SEC-001 (HIGH)');
  assert.match(result.summary, /Published required merge check: \*\*FAILURE\*\*/);
  assert.match(result.summary, /reporting job succeeds when publication succeeds/);
});

for (const options of [
  { missingArtifact: true }, { malformedArtifact: true }, { reviewResult: 'skipped' },
]) {
  test(`invalid evidence fails both gate and reporter: ${JSON.stringify(options)}`, async (t) => {
    const result = await report(t, options);
    assert.equal(result.status, 1);
    assert.equal(result.publication.conclusion, 'failure');
    assert.match(result.stderr, /Review validation failed:/);
    assert.match(result.summary, /reporting job and the required gate fail closed/);
  });
}

test('publication error still fails the reporting job', async (t) => {
  const result = await report(t, { violation: true, publishStatus: 503 });
  assert.equal(result.status, 1);
  assert.equal(result.publication.conclusion, 'failure');
  assert.match(result.stderr, /Gate error: GitHub PATCH check-runs\/42: HTTP 503/);
  assert.doesNotMatch(result.summary, /Published required merge check:/);
});
