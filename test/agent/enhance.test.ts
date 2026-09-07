import assert from 'node:assert/strict';
import test from 'node:test';

import { generateEnhancedTask } from '../../src/agent/enhance.js';

test('generateEnhancedTask structures brief user prompt with goal, scope, plan, and verification', () => {
  const enhanced = generateEnhancedTask('fix login failure in auth middleware');
  assert.equal(enhanced.original, 'fix login failure in auth middleware');
  assert.match(enhanced.goal, /fix login/i);
  assert.match(enhanced.scope, /auth/i);
  assert.ok(enhanced.plan.length >= 3);
  assert.ok(enhanced.verification.length >= 2);
  assert.match(enhanced.formattedMarkdown, /## Implementation Plan/);
  assert.match(enhanced.formattedMarkdown, /## Verification Criteria/);
});
