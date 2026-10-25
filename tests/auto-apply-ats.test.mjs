// tests/auto-apply-ats.test.mjs — URL handling, CLI and option matching for
// the Greenhouse / Lever / Ashby driver (auto-apply-ats.mjs).

import assert from 'assert/strict';
import { applicationUrl, boardSlug, isAtsUrl, parseCli, pickUnambiguous, strongMatch } from '../auto-apply-ats.mjs';
import { createResolver } from '../lib/workday-answers.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nAuto-apply (Greenhouse / Lever / Ashby)');

function check(name, fn) {
  try {
    fn();
    pass(name);
  } catch (err) {
    fail(`${name}: ${err.message}`);
  }
}

check('recognizes the three boards and nothing else', () => {
  assert.ok(isAtsUrl('https://job-boards.greenhouse.io/acme/jobs/123'));
  assert.ok(isAtsUrl('https://jobs.lever.co/acme/abc-def'));
  assert.ok(isAtsUrl('https://jobs.ashbyhq.com/acme/abc-def'));
  assert.ok(!isAtsUrl('https://acme.wd5.myworkdayjobs.com/site/job/x'));
});

check('application URL: Lever /apply, Ashby /application, Greenhouse unchanged', () => {
  assert.equal(applicationUrl('https://jobs.lever.co/acme/abc'), 'https://jobs.lever.co/acme/abc/apply');
  assert.equal(applicationUrl('https://jobs.lever.co/acme/abc/apply'), 'https://jobs.lever.co/acme/abc/apply');
  assert.equal(applicationUrl('https://jobs.ashbyhq.com/acme/abc/'), 'https://jobs.ashbyhq.com/acme/abc/application');
  assert.equal(applicationUrl('https://job-boards.greenhouse.io/acme/jobs/1'), 'https://job-boards.greenhouse.io/acme/jobs/1');
  assert.equal(boardSlug('https://job-boards.greenhouse.io/acme/jobs/1'), 'acme');
});

check('CLI: --url with --role and --answers; --headless implies no prompt', () => {
  const opts = parseCli(['--url', 'https://jobs.lever.co/a/b', '--pdf', 'x.pdf', '--role', 'Project Manager', '--answers', 'a.yml', '--headless']);
  assert.equal(opts.jobs[0].role, 'Project Manager');
  assert.equal(opts.answers, 'a.yml');
  assert.equal(opts.prompt, false);
  assert.throws(() => parseCli([]), /--url/);
});

check('ambiguous options are refused rather than guessed', () => {
  assert.equal(pickUnambiguous('Asian', ['East Asian', 'South Asian', 'White']), -1);
  assert.equal(pickUnambiguous('Male', ['Male', 'Female']), 0);
  assert.equal(pickUnambiguous('No', ['Yes', 'No']), 1);
});

check('long lists need every word: no "Alliant International University" for FIU', () => {
  assert.equal(strongMatch('Florida International University', 'Alliant International University'), false);
  assert.equal(strongMatch('Florida International University', 'Florida International University'), true);
  assert.equal(strongMatch('United States of America', 'United States +1'), true);
  assert.equal(strongMatch('United States of America', 'American Samoa +1'), false);
});

check('resolver: location, full legal name, start date, current employee', () => {
  const resolve = createResolver({
    config: { personal: { first_name: 'Ada', last_name: 'Lovelace', city: 'Arlington', state: 'Texas' }, work: { start_date: 'Immediately' } },
  });
  assert.equal(resolve('Current location').answer, 'Arlington, Texas');
  assert.equal(resolve('Full legal name').answer, 'Ada Lovelace');
  assert.equal(resolve('Please provide the date you can start.').answer, 'Immediately');
  assert.equal(resolve('Are you currently an employee with Acme (applying as an internal candidate)?').answer, 'No');
  assert.equal(resolve('Are you a referral from a current employee?'), null, 'no referral answer configured');
});
