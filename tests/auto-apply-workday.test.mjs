// tests/auto-apply-workday.test.mjs — question → answer rules and option
// matching used by auto-apply-workday.mjs. Pure functions; no browser.

import assert from 'assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseCvExperience,
  createResolver,
  isAgreementLabel,
  pickOption,
  splitName,
  workdayPasswordProblems,
} from '../lib/workday-answers.mjs';
import { blacklistHit, findReportPdf, isWorkdayUrl, parseBatchFile, parseBlacklist, parseCli, selectTrackerJobs, urlKey } from '../auto-apply-workday.mjs';
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

check('previously_employed_at flips the answer for that employer only', () => {
  const cfg = { previously_employed: 'No', previously_employed_at: ['The Home Depot', 'Amazon'] };
  const at = (employer) => createResolver({ config: cfg, profile, employer })('Have you previously worked for this company?')?.answer;
  assert.equal(at('homedepot'), 'Yes');
  assert.equal(at('The Home Depot'), 'Yes');
  assert.equal(at('Boeing'), 'No');
  assert.equal(at(''), 'No');
});

check('a list answer becomes ordered fallbacks', () => {
  const r = createResolver({ config: { source: ['Career Site', 'Company Website', 'LinkedIn'] }, profile });
  assert.equal(r('How did you hear about us?')?.answer, 'Career Site || Company Website || LinkedIn');
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
    const noIndex = join(dir, 'missing.tsv');
    assert.equal(findReportPdf(12, dir, noIndex), join(dir, 'cv-sam-012-acme-2026-01-01.pdf'));
    assert.equal(findReportPdf(99, dir, noIndex), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('pdf-index.tsv links flat PDFs with no report number in the name', () => {
  const root = mkdtempSync(join(tmpdir(), 'auto-apply-idx-'));
  try {
    mkdirSync(join(root, 'data'));
    mkdirSync(join(root, 'output'));
    for (const f of ['cv-sam-acme.pdf', 'cv-sam-acme-one-page.pdf', 'cv-sam-acme-ats-2026.pdf']) writeFileSync(join(root, 'output', f), 'x');
    writeFileSync(join(root, 'data', 'pdf-index.tsv'), [
      '# report\tpdf\thtml\tformat\tdate\tkind',
      '071\toutput/cv-sam-acme.pdf\tx.html\tletter\t2026-10-16\tcv',
      '071\toutput/cv-sam-acme-one-page.pdf\tx.html\tletter\t2026-10-16\tcv',
      '071\toutput/cv-sam-acme-ats-2026.pdf\tx.html\tletter\t2026-10-16\tcv',
      '072\toutput/gone.pdf\tx.html\tletter\t2026-10-16\tcv',
    ].join('\n'));
    const idx = join(root, 'data', 'pdf-index.tsv');
    assert.equal(findReportPdf(71, join(root, 'output'), idx), join(root, 'output', 'cv-sam-acme-one-page.pdf'));
    assert.equal(findReportPdf(72, join(root, 'output'), idx), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check('blacklist: company, domain, and Workday tenant slug', () => {
  const rules = parseBlacklist('| Company | Since | Scope | Reason |\n|---|---|---|---|\n\n| Amazon | 2026-10-15 | company | no |\n\n| amazon.jobs | 2026-10-15 | domain | no |\n| Alegeus | 2026-10-15 | company | skip |');
  assert.equal(rules.length, 3);
  assert.equal(blacklistHit(rules, { company: 'Amazon', url: 'https://x.wd1.myworkdayjobs.com/a' })?.company, 'Amazon');
  assert.equal(blacklistHit(rules, { url: 'https://www.amazon.jobs/en/jobs/1' })?.company, 'amazon.jobs');
  assert.equal(blacklistHit(rules, { url: 'https://alegeus.wd1.myworkdayjobs.com/x/job/1' })?.company, 'Alegeus');
  assert.equal(blacklistHit(rules, { company: 'Boeing', url: 'https://boeing.wd1.myworkdayjobs.com/x' }), null);
  assert.equal(blacklistHit(rules, { url: 'https://notamazon.jobs/x' }), null);
});

check('selectTrackerJobs: Evaluated Workday rows with a PDF, newest first, score gate', () => {
  const tracker = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|---|---|---|---|---|---|---|---|',
    '| 1 | 2026-10-15 | Acme | PM | 4.5/5 | Evaluated | ✅ | [001](../reports/001-acme.md) | |',
    '| 2 | 2026-10-16 | Globex | PM | 3.0/5 | Evaluated | ✅ | [002](../reports/002-globex.md) | |',
    '| 3 | 2026-10-17 | Initech | PM | 4.2/5 | Applied | ✅ | [003](../reports/003-initech.md) | |',
    '| 4 | 2026-10-17 | Hooli | PM | 4.8/5 | Evaluated | ✅ | [004](../reports/004-hooli.md) | |',
    '| 5 | 2026-10-18 | Umbrella | PM | 4.9/5 | Evaluated | ❌ | [005](../reports/005-umbrella.md) | |',
    '| 6 | 2026-10-18 | Stark | PM | 4.9/5 | Evaluated | ✅ | [006](../reports/006-stark.md) | |',
    '| 7 | 2026-10-14 | Wayne | PM | N/A | Evaluated | ✅ | [007](../reports/007-wayne.md) | |',
  ].join('\n');
  const urls = { 1: 'https://acme.wd5.myworkdayjobs.com/a/job/1', 2: 'https://globex.wd1.myworkdayjobs.com/g/job/2', 3: 'https://initech.wd1.myworkdayjobs.com/i/job/3', 4: 'https://hooli.wd1.myworkdayjobs.com/h/job/4', 5: 'https://umbrella.wd1.myworkdayjobs.com/u/job/5', 7: 'https://wayne.wd1.myworkdayjobs.com/w/job/7', 6: 'https://boards.greenhouse.io/stark/jobs/6' };
  const io = { reportUrl: (n) => urls[n], findPdf: (n) => (n === 5 ? null : `output/${n}.pdf`) };
  const all = selectTrackerJobs(tracker, io);
  assert.deepEqual(all.jobs.map((j) => j.report), ['4', '2', '1', '7']);
  assert.deepEqual(all.skipped, ['#5 Umbrella: no tailored PDF yet']);
  const gated = selectTrackerJobs(tracker, io, { minScore: 4.0 });
  assert.deepEqual(gated.jobs.map((j) => j.company), ['Hooli', 'Acme', 'Wayne'], 'N/A is not below the bar');
  assert.ok(gated.skipped.some((s) => s.startsWith('#2 Globex')));
});

check('--from-tracker needs no --url; --limit validated', () => {
  const opts = parseCli(['--from-tracker', '--limit', '5', '--min-score', '4']);
  assert.equal(opts.fromTracker, true);
  assert.equal(opts.limit, 5);
  assert.equal(opts.minScore, 4);
  assert.throws(() => parseCli(['--from-tracker', '--limit', '0']), /positive/);
});

check('parseCvExperience reads jobs, titles, dates and "Present" from cv.md', () => {
  const cv = [
    '# CV', '## Professional Summary', 'text', '## Work Experience',
    '### Acme -- Austin, TX', '**Project Manager**', 'Feb. 2025 – Present', '- did things in 2023',
    '### Beta Corp', '**Operations Manager**', 'Sept. 2021 – Jan. 2025',
    '## Skills', '### NotAJob', '**x**', '2020 – 2021',
  ].join('\n');
  assert.deepEqual(parseCvExperience(cv), [
    { company: 'Acme', title: 'Project Manager', start: { mm: '02', yyyy: '2025' }, end: null, current: true },
    { company: 'Beta Corp', title: 'Operations Manager', start: { mm: '09', yyyy: '2021' }, end: { mm: '01', yyyy: '2025' }, current: false },
  ]);
  assert.deepEqual(parseCvExperience('# CV\nno experience heading'), []);
});
