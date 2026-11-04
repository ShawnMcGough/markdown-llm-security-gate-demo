// One-time administrator setup. Uses the caller's gh login, never a workflow token.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { CHECK_NAME } from './core.mjs';

function gh(args, body) {
  const raw = execFileSync('gh', args, {
    encoding: 'utf8',
    input: body === undefined ? undefined : JSON.stringify(body),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  return JSON.parse(raw);
}

function assertContains(actual, expected) {
  if (expected !== null && typeof expected === 'object') {
    if (Array.isArray(expected)) assert.equal(actual.length, expected.length);
    for (const [key, value] of Object.entries(expected)) assertContains(actual[key], value);
  } else {
    assert.equal(actual, expected, 'Existing gate settings differ');
  }
}

const phase = process.argv[2];
assert(['stage', 'enable', 'inspect'].includes(phase), 'Use stage, enable, or inspect');
const repo = gh(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,visibility']);
assert.equal(repo.defaultBranchRef.name, 'main', 'Expected default branch main');
const endpoint = `repos/${repo.nameWithOwner}/rulesets`;
const existing = gh(['api', endpoint]);
if (phase === 'inspect') {
  for (const rule of existing) {
    console.log(JSON.stringify(gh(['api', `${endpoint}/${rule.id}`]), null, 2));
  }
} else {
  const app = gh(['api', 'apps/github-actions']);
  assert.equal(app.slug, 'github-actions');
  assert.equal(app.name, 'GitHub Actions');
  const enforcement = phase === 'enable' ? 'active' : 'disabled';
  const configs = [
    {
      name: 'Require Markdown and LLM review on main',
      target: 'branch', enforcement, bypass_actors: [],
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      rules: [
        { type: 'deletion' }, { type: 'non_fast_forward' },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 0,
            dismiss_stale_reviews_on_push: true,
            require_code_owner_review: true,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
          },
        },
        {
          type: 'required_status_checks',
          parameters: {
            required_status_checks: [{ context: CHECK_NAME, integration_id: app.id }],
            strict_required_status_checks_policy: true,
            do_not_enforce_on_create: false,
          },
        },
      ],
    },
  ];
  for (const config of configs) {
    const found = existing.find((r) => r.name === config.name);
    if (found) {
      const current = gh(['api', `${endpoint}/${found.id}`]);
      assert.equal(current.target, config.target, 'Existing ruleset has an unexpected target');
      if (current.enforcement === 'active') {
        assert.deepEqual(current.bypass_actors, [], 'Existing gate has bypass actors');
        // GitHub adds server-default parameters to the returned rules.
        assertContains(current.rules, config.rules);
        assertContains(current.conditions, config.conditions);
        console.log(`Already active: ${config.name} (${found.id})`);
        continue;
      }
    }
    const result = gh([
      'api', found ? `${endpoint}/${found.id}` : endpoint,
      '--method', found ? 'PUT' : 'POST', '--input', '-',
    ], config);
    assert.equal(result.enforcement, enforcement);
    assert.deepEqual(result.bypass_actors, []);
    console.log(`${result.enforcement}: ${result.name} (${result.id})`);
  }
}
