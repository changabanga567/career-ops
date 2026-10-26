// Regression tests for lib/review-guard.mjs, modelled on Review pages that were
// actually submitted with wrong data: education years cut to "2002", a job start
// typed as 08/2022 instead of 05/2022, and a "1" salary placeholder that matched a range.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReview, reviewFacts } from '../lib/review-guard.mjs';
import { parseCvExperience } from '../lib/workday-answers.mjs';

const CV = `# CV
## Work Experience
### Acme -- Austin
**Project Manager**
Feb. 2025 – Present
### Beta Traders -- Miami
**Project Manager**
May 2022 – Feb. 2024
## Education
State University
Bachelor of Science, Computer Science (Feb. 2020 – Feb. 2024) | GPA: 3.7
`;
const facts = reviewFacts({
  cvText: CV,
  experience: parseCvExperience(CV),
  personal: { first_name: 'Sam', last_name: 'Rivera', email: 'sam@example.com', phone: '5551234567' },
  salary: '1',
});

const page = ({ eduFrom = '2020', eduTo = '2024', jobFrom = '05/2022', salary = '1', gpa = '3.7', degree = 'Bachelors', field = 'Computer Science', sideBySide = false } = {}) => [
  'My Information', 'Legal Name', 'First Name', 'Sam', 'Last Name', 'Rivera', 'Email Address', 'sam@example.com',
  'Phone', '+1 (555) 1234567 (Mobile)',
  'My Experience', 'Work Experience 1', 'Job Title', 'Project Manager', 'Company', 'Acme', 'I currently work here', 'Yes', 'From', '02/2025',
  'Work Experience 2', 'Job Title', 'Project Manager', 'Company', 'Beta Traders',
  ...(sideBySide ? ['From _To', `${jobFrom} 02/2024`] : ['From', jobFrom, 'To', '02/2024']),
  'Education', 'Education 1', 'School or University', 'State University', 'Degree', degree, 'Field of Study', field, 'Overall Result (GPA)', gpa,
  ...(sideBySide ? ['From _To (Actual or Expected)', `${eduFrom} ${eduTo}`] : ['From', eduFrom, 'To (Actual or Expected)', eduTo]),
  'Resume/CV', 'SamR-Project Manager.pdf',
  'Application Questions', 'What are your salary expectations for this role?*', salary,
  'Voluntary Disclosures', 'contractor subject to the Vietnam Era Veterans’ Readjustment Assistance Act of 1974, as amended by the Jobs for Veterans Act of 2002',
].join('\n');

test('a correct Review page passes', () => {
  assert.deepEqual(validateReview(page(), facts), []);
  assert.deepEqual(validateReview(page({ sideBySide: true }), facts), []);
});

test('education years cut to 2002 block Submit (both layouts)', () => {
  assert.ok(validateReview(page({ eduFrom: '2002', eduTo: '2002' }), facts).some((i) => /education From shows "2002"/.test(i)));
  assert.ok(validateReview(page({ eduFrom: '2002', eduTo: '2002', sideBySide: true }), facts).some((i) => /education To shows "2002"/.test(i)));
});

test('a job date that differs from cv.md blocks Submit', () => {
  const issues = validateReview(page({ jobFrom: '08/2022' }), facts);
  assert.ok(issues.some((i) => /Beta Traders: From shows 08\/2022, cv.md says 05\/2022/.test(i)), issues.join('\n'));
  assert.ok(validateReview(page({ jobFrom: '08/2022', sideBySide: true }), facts).length > 0);
});

test('a salary range instead of the placeholder blocks Submit', () => {
  assert.ok(validateReview(page({ salary: '$100,000 - $120,000' }), facts).some((i) => /salary answer/.test(i)));
});

test('a wrong GPA blocks Submit', () => {
  assert.ok(validateReview(page({ gpa: '37' }), facts).some((i) => /GPA shows "37"/.test(i)));
});

test('a job not in cv.md blocks Submit', () => {
  const text = page().replace('Company\nAcme', 'Company\nGlobex');
  assert.ok(validateReview(text, facts).some((i) => /not a cv.md job/.test(i)));
});

test('reviewFacts reads schools, years and GPA from cv.md', () => {
  assert.deepEqual(facts.education.years.sort(), ['2020', '2024']);
  assert.equal(facts.education.gpa, '3.7');
  assert.ok(facts.education.schools.includes('State University'));
});

test('a different bachelor degree or field blocks Submit', () => {
  for (const degree of ['BA', 'Bachelor of Arts (BA)', 'Bachelors in Progress', 'Bachelor of Education', 'B.S.M.E. - Bachelor of Science in Mechanical Engineering']) {
    assert.ok(validateReview(page({ degree }), facts).some((i) => /degree shows/.test(i)), degree);
  }
  for (const degree of ['BS', "Bachelor's Degree", 'Bachelor of Science (BS)', 'BA, BS / Bachelor']) {
    assert.deepEqual(validateReview(page({ degree }), facts), [], degree);
  }
  assert.ok(validateReview(page({ field: 'Business Administration' }), facts).some((i) => /field of study/.test(i)));
  assert.ok(validateReview(page({ field: 'COMPUTER SCIENCE & MATHEMATICS' }), facts).some((i) => /field of study/.test(i)));
  assert.deepEqual(validateReview(page({ field: 'Computer and Information Science' }), facts), []);
});

test('a salary range passes only when it holds the JD pay midpoint', () => {
  const withJd = { ...facts, salaryTarget: 118500 };
  assert.deepEqual(validateReview(page({ salary: '$110,001+' }), withJd), []);
  assert.deepEqual(validateReview(page({ salary: '100,000 - 119,999' }), withJd), []);
  assert.ok(validateReview(page({ salary: '$90,001-$100,000' }), withJd).some((i) => /salary answer/.test(i)));
  assert.ok(validateReview(page({ salary: '$110,001+' }), facts).some((i) => /salary answer/.test(i)));
});
