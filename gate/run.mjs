import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  CHECK_NAME, CLI_VERSION, escapeHtml, finalConclusion, promptFor, sha256,
  validateChanges, validateReview,
} from './core.mjs';

const execute = promisify(execFile);
const env = process.env;
const output = resolve('gate-output');
const repo = env.GITHUB_REPOSITORY;
const runUrl = `https://github.com/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;

async function api(path, method = 'GET', body) {
  assert(env.GITHUB_TOKEN, 'GITHUB_TOKEN is required');
  assert(/^[\w.-]+\/[\w.-]+$/.test(repo), 'Invalid repository');
  const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
  });
  assert(response.ok, `GitHub ${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function context() {
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  assert(['pull_request_target', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME),
    'Unsupported trigger');
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Dispatch only from trusted main');
  }
  const number = Number(event.pull_request?.number ?? event.inputs?.pr_number);
  assert(Number.isSafeInteger(number) && number > 0, 'Invalid PR number');
  const pr = await api(`pulls/${number}`);
  assert.equal(pr.state, 'open', 'PR must be open');
  assert.equal(pr.base.ref, 'main', 'Only main is protected by this demo');
  assert.equal(pr.base.repo.full_name, repo, 'Unexpected base repository');
  assert.equal(pr.head.repo.full_name, repo, 'This demo accepts same-repository PRs only');
  for (const sha of [pr.head.sha, pr.base.sha]) assert(/^[a-f0-9]{40}$/.test(sha));
  if (event.pull_request) {
    assert.equal(pr.head.sha, event.pull_request.head.sha, 'Stale head event');
    assert.equal(pr.base.sha, event.pull_request.base.sha, 'Stale base event');
  }
  if (env.EXPECTED_HEAD) assert.equal(pr.head.sha, env.EXPECTED_HEAD, 'Head changed during review');
  if (env.EXPECTED_BASE) assert.equal(pr.base.sha, env.EXPECTED_BASE, 'Base changed during review');
  assert.equal(env.TRUSTED_SHA, pr.base.sha, 'Checker checkout must equal current trusted base');
  return pr;
}

async function sourceAt(sha) {
  const tree = await api(`git/trees/${sha}`);
  assert.equal(tree.truncated, false, 'Truncated source tree');
  const entry = tree.tree.find((item) => item.path === 'app.py');
  assert(entry?.type === 'blob' && entry.mode === '100644', 'app.py must be a regular file');
  const blob = await api(`git/blobs/${entry.sha}`);
  assert.equal(blob.encoding, 'base64', 'Unexpected blob encoding');
  assert(blob.size > 0 && blob.size <= 20000, 'Application exceeds demo review limit');
  const bytes = Buffer.from(blob.content, 'base64');
  assert.equal(bytes.length, blob.size, 'Incomplete source blob');
  const hash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  assert.equal(hash, entry.sha, 'Blob integrity mismatch');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert(!source.includes('\0'), 'Binary source is not supported');
  return { sha: entry.sha, source };
}

async function collect(pr) {
  assert.equal(pr.changed_files, 1, 'Only app.py may change; infrastructure is locked');
  const files = await api(`pulls/${pr.number}/files?per_page=100`);
  validateChanges(files, pr.changed_files);
  const [before, after, policy] = await Promise.all([
    sourceAt(pr.base.sha), sourceAt(pr.head.sha), readFile('SECURITY_STANDARD.md', 'utf8'),
  ]);
  const snapshot = {
    repository: repo, pr: pr.number, head_sha: pr.head.sha, base_sha: pr.base.sha,
    policy_sha256: sha256(policy), before_blob: before.sha, after_blob: after.sha,
  };
  await context();
  return { snapshot, policy, before: before.source, after: after.source };
}

async function start() {
  const pr = await context();
  const check = await api('check-runs', 'POST', {
    name: CHECK_NAME, head_sha: pr.head.sha, status: 'in_progress',
    external_id: `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`,
    details_url: runUrl,
    output: { title: 'Review pending', summary: 'A complete real LLM review is required.' },
  });
  await appendFile(env.GITHUB_OUTPUT,
    `check_id=${check.id}\nhead=${pr.head.sha}\nbase=${pr.base.sha}\n`);
}

async function review() {
  const data = await collect(await context());
  await mkdir(output, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'markdown-review-'));
  try {
    const home = join(scratch, 'home');
    await mkdir(home);
    // Whitelist the child's environment: no Actions commands, reporter token, or inherited config.
    const childEnv = {
      PATH: env.PATH, HOME: home, COPILOT_HOME: join(home, '.copilot'),
      XDG_CONFIG_HOME: join(home, '.config'), GITHUB_TOKEN: env.GITHUB_TOKEN,
      CI: 'true', NO_COLOR: '1', COPILOT_AUTO_UPDATE: 'false',
    };
    const { stdout: version } = await execute('copilot', ['--version'], { env: childEnv });
    assert(version.includes(CLI_VERSION), 'Unexpected Copilot CLI version');
    const args = [
      '--no-auto-update', '--no-custom-instructions', '--disable-builtin-mcps',
      '--available-tools=', '--deny-tool=shell', '--deny-tool=write', '--deny-tool=url',
      '--no-ask-user', '--no-color', '--stream=off', '--silent',
      '--prompt', promptFor(data.snapshot, data.policy, data.before, data.after),
    ];
    let response;
    try {
      response = await execute('copilot', args, {
        cwd: scratch, env: childEnv, timeout: 240000, maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      const diagnostic = String(error.stderr || error.message)
        .replaceAll(env.GITHUB_TOKEN, '[REDACTED]');
      await writeFile(join(output, 'cli-error.txt'), diagnostic);
      throw new Error('Copilot exited unsuccessfully or timed out; see cli-error.txt artifact');
    }
    await writeFile(join(output, 'model-response.txt'), response.stdout);
    const result = validateReview(response.stdout.trim(), data.snapshot, data.policy, data.after);
    await writeFile(join(output, 'review.json'), JSON.stringify({
      snapshot: data.snapshot, cli_version: CLI_VERSION, ...result,
    }, null, 2));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function finish() {
  let conclusion = 'failure';
  let title = 'Review failed closed';
  let summary;
  let annotations = [];
  try {
    const data = await collect(await context());
    const artifact = JSON.parse(await readFile(join(output, 'review.json'), 'utf8'));
    assert.deepEqual(artifact.snapshot, data.snapshot, 'Artifact snapshot mismatch');
    assert.equal(artifact.cli_version, CLI_VERSION, 'Artifact CLI version mismatch');
    const result = finalConclusion(
      { start: env.START_RESULT, review: env.REVIEW_RESULT },
      JSON.stringify(artifact.review), data.snapshot, data.policy, data.after,
    );
    conclusion = result.conclusion;
    title = conclusion === 'success' ? 'Policy satisfied' : 'Security standard violated';
    summary = `<pre>${escapeHtml(JSON.stringify(artifact, null, 2))}</pre>`;
    annotations = result.review.findings.map((finding) => ({
      path: finding.path, start_line: finding.line, end_line: finding.line,
      annotation_level: ['HIGH', 'CRITICAL'].includes(finding.severity) ? 'failure' : 'warning',
      title: `${finding.policy_id} (${finding.severity})`, message: finding.rationale,
    }));
  } catch (error) {
    summary = `No acceptable verdict was produced. <pre>${escapeHtml(error.message)}</pre>`;
  }
  await appendFile(env.GITHUB_STEP_SUMMARY,
    `## ${CHECK_NAME}: ${title}\n\n${summary}\n\n[Workflow evidence](${runUrl})\n`);
  // A reporter failure leaves the existing check pending, never successful.
  assert(/^\d+$/.test(env.CHECK_ID ?? ''), 'Start did not create a check; required check stays missing');
  const check = await api(`check-runs/${env.CHECK_ID}`);
  assert.equal(check.name, CHECK_NAME, 'Wrong check name');
  assert.equal(check.head_sha, env.EXPECTED_HEAD, 'Wrong check SHA');
  assert.equal(check.external_id, `${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`,
    'Wrong check run identity');
  await api(`check-runs/${env.CHECK_ID}`, 'PATCH', {
    status: 'completed', conclusion, completed_at: new Date().toISOString(),
    output: { title, summary, annotations }, details_url: runUrl,
  });
  if (conclusion !== 'success') process.exitCode = 1;
}

try {
  const command = process.argv[2];
  assert(['start', 'review', 'finish'].includes(command), 'Use start, review, or finish');
  await ({ start, review, finish })[command]();
} catch (error) {
  console.error(`Gate error: ${error.message}`);
  process.exitCode = 1;
}
