// tests/auto-apply-workday.test.mjs — question → answer rules and option
// matching used by auto-apply-workday.mjs. Pure functions; no browser.

import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createResolver,
  isAgreementLabel,
  pickOption,
  splitName,
  workdayPasswordProblems,
} from '../lib/workday-answers.mjs';
import { findReportPdf, isWorkdayUrl, parseBatchFile, parseCli, urlKey } from '../auto-apply-workday.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nWorkday auto-apply answers');

function check(name, fn) {
  try {
    fn();
    pass(name);
  } catch (err) {
    fail(`${name}: ${err.message}`);
  }
}

const profile = {
  candidate: { full_name: 'Sam Q Rivera', email: 'sam@example.com', phone: '555-0100', linkedin: 'linkedin.com/in/sam' },
  location: { city: 'Austin', country: 'United States', authorized_in: ['United States'], needs_sponsorship: false },
};
const config = {
  source: 'LinkedIn',
  personal: { state: 'Texas', postal_code: '78701' },
  eeo: { gender: 'Male', race: 'Asian', hispanic_or_latino: 'No', veteran: 'No', disability: 'Decline' },
  work: { desired_salary: '120000' },
  questions: [{ match: 'security clearance', answer: 'No' }, { match: 'how did you hear', answer: 'Company Website' }],
};
const resolve = createResolver({ config, profile, learned: { 'Favorite color?': 'Blue' }, now: new Date(2026, 0, 5) });
const answer = (label) => resolve(label)?.answer;

check('names split from full_name', () => {
  assert.deepEqual(splitName('Sam Q Rivera'), { first: 'Sam', last: 'Q Rivera' });
  assert.equal(answer('Legal First Name*'), 'Sam');
  assert.equal(answer('Last Name'), 'Q Rivera');
});

check('contact fields fall back to profile.yml', () => {
  assert.equal(answer('Email Address'), 'sam@example.com');
  assert.equal(answer('Phone Number'), '555-0100');
  assert.equal(answer('Phone Device Type'), 'Mobile');
  assert.equal(answer('City'), 'Austin');
  assert.equal(answer('State'), 'Texas');
  assert.equal(answer('Postal Code'), '78701');
});

check('user questions win over built-ins, learned answers are reused', () => {
  assert.equal(answer('How Did You Hear About Us?'), 'Company Website');
  assert.equal(answer('Do you hold an active security clearance?'), 'No');
  assert.equal(answer('favorite color?'), 'Blue');
});

check('sponsorship is not mistaken for authorization', () => {
  assert.equal(answer('Will you now or in the future require sponsorship for employment visa status?'), 'No');
  assert.equal(answer('Are you legally authorized to work in the United States?'), 'Yes');
});

check('EEO: hispanic before race, decline passes through', () => {
  assert.equal(answer('Are you Hispanic or Latino?'), 'No');
  assert.equal(answer('Race/Ethnicity'), 'Asian');
  assert.equal(answer('Gender'), 'Male');
  assert.equal(answer('Please select your veteran status'), 'No');
  assert.equal(answer('Disability Status'), 'Decline');
});

check('self-identify signature name and date', () => {
  assert.equal(answer('Name'), 'Sam Q Rivera');
  assert.equal(answer('Date'), '01/05/2026');
});

check('unknown questions stay unanswered; middle name is deliberately skipped', () => {
  assert.equal(resolve('Describe your ideal team'), null);
  assert.equal(resolve('Middle Name')?.source, 'skip');
});

check('pickOption: yes/no onto long Workday wording', () => {
  assert.equal(pickOption('Yes', ['Select One', 'Yes', 'No']), 1);
  assert.equal(pickOption('No', ['Yes, I am', 'No, I am not']), 1);
  const veteran = ['I identify as one or more of the classifications of protected veteran', 'I am not a protected veteran', "I don't wish to answer"];
  assert.equal(pickOption('No', veteran), 1);
  assert.equal(pickOption('Decline', veteran), 2);
  const disability = ['Yes, I have a disability (or previously had a disability)', 'No, I do not have a disability and have not had one in the past', 'I do not want to answer'];
  assert.equal(pickOption('No', disability), 1);
  assert.equal(pickOption('Decline', disability), 2);
});

check('pickOption: partial and token matches, no wild guesses', () => {
  assert.equal(pickOption('Asian', ['White (Not Hispanic or Latino)', 'Asian (Not Hispanic or Latino)', 'Two or More Races']), 1);
  assert.equal(pickOption('LinkedIn', ['Job Board', 'LinkedIn Jobs', 'Referral']), 1);
  assert.equal(pickOption('United States of America', ['Canada', 'United States of America', 'United Kingdom']), 1);
  assert.equal(pickOption('Mobile', ['Home', 'Mobile', 'Work']), 1);
  assert.equal(pickOption('Astronaut', ['Job Board', 'Referral']), -1);
  assert.equal(pickOption('', ['Yes']), -1);
});

check('agreement checkboxes are ticked, opt-ins are not', () => {
  assert.ok(isAgreementLabel('I have read and agree to the Terms and Conditions'));
  assert.ok(isAgreementLabel('I acknowledge the Privacy Notice'));
  assert.ok(isAgreementLabel('I consent to the processing of my data'));
  assert.ok(!isAgreementLabel('I have a preferred name'));
  assert.ok(!isAgreementLabel('I agree to receive text messages about my application'));
  assert.ok(!isAgreementLabel('Join our talent community'));
});

check('password policy check', () => {
  assert.deepEqual(workdayPasswordProblems('Str0ng!pass'), []);
  assert.ok(workdayPasswordProblems('weak').length >= 3);
});

check('CLI and batch parsing', () => {
  assert.ok(isWorkdayUrl('https://acme.wd5.myworkdayjobs.com/en-US/External/job/Austin/Engineer_R123'));
  assert.ok(!isWorkdayUrl('https://boards.greenhouse.io/acme/jobs/1'));
  const jobs = parseBatchFile('# list\nhttps://a.wd1.myworkdayjobs.com/x/job/1 output/a.pdf report=12\n\nhttps://b.wd5.myworkdayjobs.com/y/job/2 # note\n');
  assert.deepEqual(jobs, [
    { url: 'https://a.wd1.myworkdayjobs.com/x/job/1', pdf: 'output/a.pdf', report: '12' },
    { url: 'https://b.wd5.myworkdayjobs.com/y/job/2', pdf: null, report: null },
  ]);
  const opts = parseCli(['--url', 'https://a.wd1.myworkdayjobs.com/x/job/1', '--report', '7', '--submit', '--headless']);
  assert.equal(opts.submit, true);
  assert.equal(opts.prompt, false);
  assert.equal(opts.jobs[0].report, '7');
  assert.throws(() => parseCli(['--url']), /needs a value/);
  assert.throws(() => parseCli(['--bogus']), /unknown option/);
  assert.equal(parseCli(['--url', 'x']).submit, false, 'submit is opt-in');
});

check('apply/ and login suffixes collapse to one posting key', () => {
  assert.equal(
    urlKey('https://acme.wd5.myworkdayjobs.com/External/job/Austin/Eng_R1/apply/applyManually'),
    urlKey('https://acme.wd5.myworkdayjobs.com/External/job/Austin/Eng_R1/'),
  );
});

check('findReportPdf prefers the newest tailored bundle PDF', () => {
  const dir = mkdtempSync(join(tmpdir(), 'auto-apply-'));
  try {
    const v1 = join(dir, '012-acme-engineer', 'cv', 'tailored', 'v001');
    mkdirSync(v1, { recursive: true });
    writeFileSync(join(v1, 'cv.pdf'), 'a');
    writeFileSync(join(dir, 'cv-sam-012-acme-2026-01-01.pdf'), 'b');
    writeFileSync(join(dir, 'cv-sam-012-acme-ats-2026-01-02.pdf'), 'c');
    utimesSync(join(v1, 'cv.pdf'), new Date(2026, 0, 1), new Date(2026, 0, 1));
    assert.equal(findReportPdf(12, dir), join(dir, 'cv-sam-012-acme-2026-01-01.pdf'));
    assert.equal(findReportPdf(99, dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
