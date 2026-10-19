'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const content = fs.readFileSync(path.join(root, 'install/content.js'), 'utf8');
const sidepanel = fs.readFileSync(path.join(root, 'install/sidepanel.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'install/manifest.json'), 'utf8'));

// Exercise the actual pure completion gate extracted from the production source.
const match = content.match(/function canAcceptAnswerCompletion\(state\) \{([\s\S]*?)\n  \}/);
assert.ok(match, 'production completion gate exists');
const canAccept = new Function('state', match[1]);
const base = {
  answer: 'A sufficiently long answer', answerLength: 27,
  echoedPrompt: false, sameAsBefore: false, generating: false,
  continuationPending: false, stableFor: 5000, idleFor: 20000,
  requiredIdleMs: 3000, requireFreshPrompt: true, freshPromptConfirmed: true
};
assert.equal(canAccept({ ...base }), true, 'stable, fresh, non-generating answer can be accepted');
assert.equal(canAccept({ ...base, generating: true }), false, 'active generation cannot be accepted');
assert.equal(canAccept({ ...base, continuationPending: true }), false, 'visible continue-generation control blocks completion');
assert.equal(canAccept({ ...base, idleFor: 2999 }), false, 'quiet window must be satisfied');
assert.equal(canAccept({ ...base, freshPromptConfirmed: false }), false, 'answer must belong to the current prompt');
assert.equal(canAccept({ ...base, echoedPrompt: true }), false, 'prompt echo cannot be accepted');
assert.equal(canAccept({ ...base, answerLength: 3 }), false, 'tiny UI fragments cannot be accepted');

// Release-contract checks: strict explicit continuation control, bounded retries,
// longer final-task deadline, and failure rather than accepting a pending response.
assert.match(content, /function findContinueGeneratingControlForAnswer\(answer, promptCoreSig = '', turnMarkerSig = ''\)/);
assert.match(content, /continue generating\|continue response\|continue answering\|继续生成\|继续生成回答\|继续回答\|继续输出/i);
assert.match(content, /const maxContinuationAttempts = 2/);
assert.match(content, /continuationAttempts < maxContinuationAttempts/);
assert.match(content, /continuationPending: !!continueControlNow/);
assert.match(content, /const continueControlNow = answer \? findContinueGeneratingControlForAnswer/);
assert.doesNotMatch(content, /const continueControlNow = findContinueGeneratingControl\(\)/);
// v0.10.9：静默门槛由 8s 提升到 15s（最后一轮 20s），断言随之更新。
assert.match(content, /generationWasObserved \? 3000 : 15000/);
assert.match(content, /Math\.max\(baseIdleMs, finalTurn \? 20000 : 0\)/);
assert.match(sidepanel, /isFinalTurn \? 900000 : 600000/);
assert.match(sidepanel, /responseTimeoutMs \+ 15000/);
assert.ok(manifest.version.localeCompare('0.10.4') >= 0, '版本应不低于 0.10.4');
assert.match(fs.readFileSync(path.join(root, 'install/sidepanel.html'), 'utf8'), /0\.9\.6/);

console.log('v0.9.5 regression tests passed: 7 completion-gate cases + release-contract checks.');
