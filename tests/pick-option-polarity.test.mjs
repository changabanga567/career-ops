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

test('numeric answers never land on a range with different numbers', () => {
  assert.equal(pickOption('3 - 5 years', ['0 to 3 years', '5 to 7 years']), -1);
  assert.equal(pickOption('3 - 5 years', ['0 to 3 years', '3 to 5 years']), 1);
  assert.equal(pickOption('3-5 years', ['1-3 years', '3-5 years']), 1);
});

test('personal fields never answer questions about other people or long questions', async () => {
  const { createResolver } = await import('../lib/workday-answers.mjs');
  const r = createResolver({ config: { personal: { phone: '5551234567', email: 'sam@example.com', last_name: 'Rivera' } } });
  assert.equal(r('Phone Number')?.answer, '5551234567');
  assert.equal(r('List three business references (previous supervisors); include name, title, phone number and email address.'), null);
  assert.equal(r('Do you have experience contacting customers via phone when email is not available?'), null);
  assert.equal(r('If you marked Yes to having previously worked here, please list your email'), null);
});

test('"=" answers match exactly, never a longer different major', () => {
  assert.equal(pickOption('=Computer Science', ['Advanced Computer Science', 'Computer Science']), 1);
  assert.equal(pickOption('=Computer Science', ['Advanced Computer Science']), -1);
});
