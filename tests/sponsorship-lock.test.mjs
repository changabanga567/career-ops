// A U.S. citizen's visa/sponsorship answers are locked ahead of every config rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sponsorshipLock, createResolver } from '../lib/workday-answers.mjs';

test('every "will you require sponsorship" wording is No', () => {
  for (const q of [
    '4. Will you now, or in the future, require sponsorship by your employer to legally work in the country where this role is located? (i.e., Visa, SOFA, DOCPER) If this role is located in the United States, answer Yes/No based on your need for sponsorship to work in the United States.',
    'Will you now or in the future require sponsorship to work for Caterpillar in the country where the job is located?',
    'Will you now or in the future require employer-sponsored work authorization?',
    'Will you require Immigration Support to maintain work authorization?',
    'Do you now, or will you in the future, require a visa or any type of immigration support?',
    'Will you require any employer assistance with immigration-related matters?',
  ]) assert.equal(sponsorshipLock(q), 'No', q);
});

test('authorized without sponsorship and still-interested questions are Yes', () => {
  assert.equal(sponsorshipLock('Are you authorized to work in the US without a sponsor visa?'), 'Yes');
  assert.equal(sponsorshipLock('If this position is not eligible for sponsorship, are you still interested in being considered?'), 'Yes');
});

test('other countries and non-sponsorship questions are left to the rules', () => {
  assert.equal(sponsorshipLock('Do you have the right to work in the UK without a sponsorship?'), null);
  assert.equal(sponsorshipLock('Are you legally authorized to work in the United States?'), null);
  assert.equal(sponsorshipLock('If yes, please note your current visa status'), null);
});

test('the lock wins over a config rule that would say Yes', () => {
  const resolve = createResolver({
    config: { work_authorization: { needs_sponsorship: 'No' }, questions: [{ match: '(reside|live|located) (with)?in the (united states|u\\.?s\\.?)', answer: 'Yes' }] },
  });
  const r = resolve('Will you now or in the future require sponsorship to legally work in the country where this role is located? If this role is located in the United States, answer based on your need for sponsorship.');
  assert.equal(r.answer, 'No');
  assert.equal(r.source, 'lock');
});

test('a note saying "authorized without sponsorship" under the question does not flip the answer', () => {
  const q = 'Will you now or in the future require employer-sponsored work authorization or visa sponsorship to legally work in the United States?\n\nApplicants must be legally authorized to work in the United States without current or future employer sponsorship. At this time, WelbeHealth does not provide any employment-based visa sponsorship, including H-1B, TN, E-3, O-1, F-1 OPT/STEM OPT.';
  assert.equal(sponsorshipLock(q), 'No');
});

test('the same question with its "?" already stripped is still No', () => {
  const q = 'will you now or in the future require employer-sponsored work authorization or visa sponsorship to legally work in the united states applicants must be legally authorized to work in the united states without current or future employer sponsorship';
  assert.equal(sponsorshipLock(q), 'No');
  assert.equal(sponsorshipLock('are you legally authorized to work in the united states without the need for employer sponsorship'), 'Yes');
});
