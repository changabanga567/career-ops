// Regression tests for pickOption on Salesforce-style option lists, where a negated
// answer shares most of its words with the affirmative option.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickOption } from '../lib/workday-answers.mjs';

const comms = ['Select One', 'Yes, I would like to receive communications about Salesforce and future opportunities', 'No, I would not like to receive communications'];

test('a negated answer never picks the affirmative option', () => {
  assert.equal(comms[pickOption('No, I would not like to receive communications', comms)], comms[2]);
  assert.equal(pickOption('No, I would not like to receive communications', comms.slice(0, 2)), -1);
  assert.equal(comms[pickOption('No', comms)], comms[2]);
});

test('a longer option that continues with "and ..." still matches a sentence answer', () => {
  const o = ['Select One', 'No, I do not have a disability and have not had one in the past', 'Yes, I have a disability'];
  assert.equal(o[pickOption('No, I do not have a disability', o)], o[1]);
});

test('a short field answer does not match a joined field', () => {
  const o = ['Select One', 'Computer Science & Mathematics', 'Computer and Information Science'];
  assert.equal(o[pickOption('Computer Science', o)], o[2]);
});
