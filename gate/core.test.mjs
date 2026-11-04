import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  finalConclusion, promptFor, responseFromEvents, reviewId, rulesFrom, validateChanges, validateReview,
} from './core.mjs';

const policy = readFileSync(new URL('../SECURITY_STANDARD.md', import.meta.url), 'utf8');
const snapshot = { head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40) };
const source = 'first line\nsecond line\n';
const valid = () => ({
  schema_version: 1, review_id: reviewId(snapshot), review_complete: true,
  files: [{
    path: 'app.py',
    assessments: rulesFrom(policy).map((rule) => ({
      policy_id: rule.id, status: 'pass', rationale: 'Fixture assessment, not live LLM evidence.',
    })),
  }],
  findings: [],
});
const validate = (value) => validateReview(JSON.stringify(value), snapshot, policy, source);

test('complete clean review passes', () => {
  assert.equal(validate(valid()).conclusion, 'success');
});

test('a policy violation fails without application scanning', () => {
  const review = valid();
  review.files[0].assessments[0].status = 'fail';
  review.findings.push({
    policy_id: 'SEC-001', path: 'app.py', line: 2, severity: 'HIGH',
    rationale: 'Fixture SQL injection finding.',
  });
  assert.equal(validate(review).conclusion, 'failure');
});

for (const [name, mutate] of [
  ['incomplete review', (r) => { r.review_complete = false; }],
  ['stale snapshot', (r) => { r.review_id = 'stale'; }],
  ['missing files', (r) => { r.files = []; }],
  ['wrong file', (r) => { r.files[0].path = 'other.py'; }],
  ['missing rule', (r) => { r.files[0].assessments.pop(); }],
  ['duplicate rule', (r) => { r.files[0].assessments[1] = r.files[0].assessments[0]; }],
  ['unsubstantiated failure', (r) => { r.files[0].assessments[0].status = 'fail'; }],
  ['empty rationale', (r) => { r.files[0].assessments[0].rationale = ''; }],
  ['extra field', (r) => { r.verdict = 'pass'; }],
  ['wrong schema', (r) => { r.schema_version = 2; }],
  ['invalid findings', (r) => { r.findings = null; }],
]) {
  test(`fails closed: ${name}`, () => {
    const review = valid();
    mutate(review);
    assert.throws(() => validate(review));
  });
}

for (const [name, changes] of [
  ['severity downgrade', { severity: 'LOW' }],
  ['unknown rule', { policy_id: 'SEC-999' }],
  ['invalid line', { line: 0 }],
  ['line beyond EOF', { line: 3 }],
  ['wrong location', { path: 'elsewhere.py' }],
]) {
  test(`rejects finding: ${name}`, () => {
    const review = valid();
    review.files[0].assessments[0].status = 'fail';
    review.findings.push({
      policy_id: 'SEC-001', path: 'app.py', line: 1, severity: 'HIGH',
      rationale: 'Fixture finding.', ...changes,
    });
    assert.throws(() => validate(review));
  });
}

for (const raw of ['', 'null', '{}', '```json\n{}\n```', '{broken', '{}\n{}']) {
  test(`rejects malformed or empty output: ${JSON.stringify(raw)}`, () => {
    assert.throws(() => validateReview(raw, snapshot, policy, source));
  });
}

for (const status of ['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', undefined]) {
  test(`a ${status} model job cannot pass`, () => {
    assert.throws(() => finalConclusion(
      { start: 'success', review: status }, JSON.stringify(valid()), snapshot, policy, source,
    ));
  });
}

test('failed start cannot pass even with valid model output', () => {
  assert.throws(() => finalConclusion(
    { start: 'failure', review: 'success' }, JSON.stringify(valid()), snapshot, policy, source,
  ));
});

test('tampering, deletions, renames, and incomplete listings fail closed', () => {
  validateChanges([{ filename: 'app.py', status: 'modified' }], 1);
  for (const file of [
    { filename: 'SECURITY_STANDARD.md', status: 'modified' },
    { filename: '.github/workflows/forged.yml', status: 'added' },
    { filename: 'gate/run.mjs', status: 'modified' },
    { filename: 'app.py', status: 'removed' },
    { filename: 'app.py', status: 'renamed', previous_filename: 'old.py' },
  ]) assert.throws(() => validateChanges([file], 1));
  assert.throws(() => validateChanges([{ filename: 'app.py', status: 'modified' }], 2));
});

test('prompt contains actual policy and inert before/after source, not branch outcomes', () => {
  const prompt = promptFor(snapshot, policy, 'old', 'new');
  assert(prompt.includes(policy));
  assert(prompt.includes('"before":"1: old","after":"1: new"'));
  assert(prompt.includes(reviewId(snapshot)));
});

const cliEvents = () => [
  { type: 'assistant.message_delta', data: { deltaContent: 'not the complete response' } },
  { type: 'assistant.message', data: { content: JSON.stringify(valid()) } },
  { type: 'assistant.turn_end', data: { turnId: 'fixture' } },
  { type: 'result', exitCode: 0 },
];
const jsonl = (events) => events.map((event) => JSON.stringify(event)).join('\n') + '\n';

test('extracts unrendered assistant text from a successful JSONL stream', () => {
  const raw = responseFromEvents(jsonl(cliEvents()));
  assert.equal(raw, JSON.stringify(valid()));
  assert.equal(validateReview(raw, snapshot, policy, source).conclusion, 'success');
});

for (const [name, mutate] of [
  ['missing completion', (events) => events.pop()],
  ['failed completion', (events) => { events.at(-1).exitCode = 1; }],
  ['duplicate completion', (events) => events.push({ type: 'result', exitCode: 0 })],
  ['trailing event', (events) => events.push({ type: 'assistant.idle' })],
  ['missing complete message', (events) => events.splice(1, 1)],
  ['multiple messages', (events) => events.unshift(events[1])],
  ['tool request', (events) => { events[1].data.toolRequests = [{ name: 'shell' }]; }],
  ['tool execution', (events) => events.unshift({ type: 'tool.execution_start' })],
  ['session error', (events) => events.unshift({ type: 'session.error' })],
  ['missing content', (events) => { delete events[1].data.content; }],
]) {
  test(`rejects CLI transport: ${name}`, () => {
    const events = cliEvents();
    mutate(events);
    assert.throws(() => responseFromEvents(jsonl(events)));
  });
}

test('rejects malformed transport and does not repair malformed model JSON', () => {
  for (const raw of ['', 'not json', 'null', '{}', '{"type":"result"']) {
    assert.throws(() => responseFromEvents(raw));
  }
  const events = cliEvents();
  events[1].data.content = '{"review_id":"hard\nwrapped"}';
  const raw = responseFromEvents(jsonl(events));
  assert.equal(raw, events[1].data.content);
  assert.throws(() => validateReview(raw, snapshot, policy, source));
});
