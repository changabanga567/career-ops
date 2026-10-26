/**
 * review-guard.mjs — last check before an application is submitted.
 *
 * The Review page is what the employer receives. Reading it back and comparing it
 * with the candidate's own facts catches what slipped through field by field:
 * a year-only box that turned 2020 into "2002", a job date typed as 08 instead of
 * 05, a salary placeholder that fuzzy-matched a range. Any finding blocks Submit.
 *
 * validateReview(text, facts) -> string[]   (empty = safe to submit)
 *
 * facts: {
 *   experience: [{ title, company, start: {mm, yyyy}, end: {mm, yyyy} | null, current }],
 *   education:  { years: ['2020', '2024'], gpa: '3.7', schools: ['Florida International University', ...] },
 *   personal:   { first_name, last_name, email, phone, address_line_1, postal_code },
 *   salary:     '1',
 * }
 */

import { isOtherBachelor } from './workday-answers.mjs';

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const SECTION_RE = /^(My Information|My Experience|Work Experience|Education|Certifications|Languages|Skills|Resume\/CV|Resume|Websites|Social Network URLs|Application Questions.*|Voluntary Disclosures|Self Identify|Review|Terms and Conditions|Legal Name|Address|Phone|Email Address)$/i;
const EMPTY_RE = /^(no response|-|—)$/i;
// Years quoted in legal boilerplate, never answers.
const BOILERPLATE_YEAR_RE = /(act of|jobs for veterans act of|section \d+ of the rehabilitation act of)\s*(19|20)\d\d/i;

function linesOf(text) {
  return String(text ?? '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

/** Value printed under a label within lines[from..to): the next line that is not itself a label. */
function valueAfter(lines, label, from = 0, to = lines.length) {
  const re = label instanceof RegExp ? label : new RegExp(`^${label}\\*?$`, 'i');
  for (let i = from; i < to - 1; i++) {
    if (re.test(lines[i])) return lines[i + 1];
  }
  return null;
}

/** {from, to} for a block, whether printed as "From" / value / "To" / value or "From To" / "v1 v2". */
function fromTo(lines, a, b) {
  for (let i = a; i < b - 1; i++) {
    if (/^From[\s_|]+To( \(Actual or Expected\))?\*?$/i.test(lines[i])) {
      const vals = lines[i + 1].match(/(\d\d\/)?(19|20)\d\d|no response/gi) ?? [];
      return { from: vals[0] ?? null, to: vals[1] ?? null };
    }
  }
  return { from: valueAfter(lines, /^From\*?$/i, a, b), to: valueAfter(lines, /^To( \(Actual or Expected\))?\*?$/i, a, b) };
}

function blocks(lines, headRe) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!headRe.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !headRe.test(lines[j]) && !SECTION_RE.test(lines[j])) j++;
    out.push([i + 1, j]);
  }
  return out;
}

// "Computer and Information Science" is the same field; "Computer Science & Mathematics" adds one.
const FIELD_FILLER = new Set(['and', 'information', 'sciences', 'general', 'of', 'in']);
function sameField(value, field) {
  const want = norm(field).split(' ');
  const got = norm(value).split(' ');
  return want.every((w) => got.includes(w)) && got.every((w) => want.includes(w) || FIELD_FILLER.has(w));
}

const mmYYYY = (d) => (d ? `${d.mm}/${d.yyyy}` : null);

export function validateReview(text, facts) {
  const lines = linesOf(text);
  const issues = [];

  // Work history: every entry shown must be one of the CV's jobs with the CV's exact dates.
  for (const [a, b] of blocks(lines, /^Work Experience \d+$/i)) {
    const title = valueAfter(lines, 'Job Title', a, b);
    const company = valueAfter(lines, 'Company', a, b);
    const { from, to } = fromTo(lines, a, b);
    if (!title && !company) continue;
    const job = (facts.experience ?? []).find((j) => norm(j.title) === norm(title) && norm(j.company) === norm(company));
    if (!job) { issues.push(`work experience "${title} @ ${company}" is not a cv.md job`); continue; }
    if (from && !EMPTY_RE.test(from) && from !== mmYYYY(job.start)) issues.push(`${job.title} @ ${job.company}: From shows ${from}, cv.md says ${mmYYYY(job.start)}`);
    if (!job.current && to && !EMPTY_RE.test(to) && to !== mmYYYY(job.end)) issues.push(`${job.title} @ ${job.company}: To shows ${to}, cv.md says ${mmYYYY(job.end)}`);
  }

  // Education: only the CV's schools, years and GPA.
  const edu = facts.education ?? {};
  for (const [a, b] of blocks(lines, /^Education \d+$/i)) {
    const { from, to } = fromTo(lines, a, b);
    for (const [k, v] of [['From', from], ['To', to]]) {
      if (!v || EMPTY_RE.test(v)) continue;
      const y = (v.match(/(19|20)\d\d/) || [])[0];
      if (!y || !(edu.years ?? []).includes(y)) issues.push(`education ${k} shows "${v}", cv.md years are ${(edu.years ?? []).join('/')}`);
    }
    for (let i = a; i < b; i++) {
      const l = lines[i];
      if (/^(Overall Result \(GPA\)|GPA)\*?$/i.test(l) && lines[i + 1] && !EMPTY_RE.test(lines[i + 1]) && edu.gpa && lines[i + 1] !== edu.gpa) {
        issues.push(`GPA shows "${lines[i + 1]}", cv.md says ${edu.gpa}`);
      }
      const next = lines[i + 1];
      if (/^(Degree|Degree Type|Level of Education)\*?$/i.test(l) && next && !EMPTY_RE.test(next) && isOtherBachelor(next)) {
        issues.push(`degree shows "${next}", cv.md says Bachelor of Science`);
      }
      if (/^(Field of Study|Major|Area of Study)\*?$/i.test(l) && next && !EMPTY_RE.test(next) && edu.fields?.length
        && !edu.fields.some((f) => sameField(next, f))) {
        issues.push(`field of study shows "${next}", cv.md says ${edu.fields.join(' / ')}`);
      }
      if (/^School or University\*?$/i.test(l) && lines[i + 1] && !EMPTY_RE.test(lines[i + 1]) && edu.schools?.length
        && !edu.schools.some((s) => norm(s) === norm(lines[i + 1]))) {
        issues.push(`school shows "${lines[i + 1]}", not a cv.md school`);
      }
    }
  }

  // Identity.
  const p = facts.personal ?? {};
  const first = valueAfter(lines, /^(Legal )?First Name\*?$/i);
  const last = valueAfter(lines, /^(Legal )?Last Name\*?$/i);
  if (first && p.first_name && norm(first) !== norm(p.first_name)) issues.push(`first name shows "${first}"`);
  if (last && p.last_name && norm(last) !== norm(p.last_name)) issues.push(`last name shows "${last}"`);
  const emails = [...String(text).matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)].map((m) => m[0].toLowerCase());
  if (p.email && emails.some((e) => e !== p.email.toLowerCase() && !/workday|noreply|no-reply|careers|recruit|talent|privacy|hr@|jobs@|accommodat|ada@|eeo/.test(e))) {
    issues.push(`unexpected email on the page: ${emails.filter((e) => e !== p.email.toLowerCase()).join(', ')}`);
  }
  const phoneLine = valueAfter(lines, /^Phone( Number)?\*?$/i);
  if (phoneLine && p.phone && /\d{7,}/.test(phoneLine.replace(/\D/g, '')) && !phoneLine.replace(/\D/g, '').endsWith(p.phone.replace(/\D/g, ''))) {
    issues.push(`phone shows "${phoneLine}"`);
  }

  // Salary answers stay the placeholder (never a picked range or another number).
  for (let i = 0; i < lines.length - 1; i++) {
    const q = lines[i];
    if (!/salary|compensation|pay rate amount|desired pay|wage|ote expectations|minimum pay/i.test(q)) continue;
    if (/type|frequency|higher than|currency|range for this|range is|posted|transparency|disclos/i.test(q)) continue;
    const v = lines[i + 1];
    if (EMPTY_RE.test(v) || SECTION_RE.test(v) || v.length > 40) continue; // a long line is more question text, not the answer
    if (/\$|\d{2,}/.test(v.replace(/^1$/, '')) && v.trim() !== String(facts.salary ?? '1')) issues.push(`salary answer "${v}" for "${q.slice(0, 60)}"`);
  }

  // Stray years in short answer lines (a date that lost its digits looks like this).
  for (let i = 1; i < lines.length; i++) {
    const v = lines[i];
    if (v.length > 12 || BOILERPLATE_YEAR_RE.test(lines[i - 1] + ' ' + v)) continue;
    const y = (v.match(/^(?:\d\d\/)?(?:\d\d\/)?((?:19|20)\d\d)$/) || [])[1];
    if (y && Number(y) < 2020 && !(facts.experience ?? []).some((j) => j.start?.yyyy === y || j.end?.yyyy === y)) {
      issues.push(`year ${v} under "${lines[i - 1].slice(0, 50)}"`);
    }
  }
  return [...new Set(issues)];
}

/** Facts for validateReview from cv.md text, the parsed experience and config.personal. */
export function reviewFacts({ cvText = '', experience = [], personal = {}, salary = '1' } = {}) {
  const schools = [];
  const years = new Set();
  const fields = [];
  let gpa = null;
  const eduStart = cvText.search(/^##\s*Education/im);
  if (eduStart >= 0) {
    const edu = cvText.slice(eduStart).split(/\n##\s/)[0];
    for (const line of edu.split('\n')) {
      if (/university|college|institute|school/i.test(line) && !/^\s*-/.test(line)) schools.push(line.replace(/^#+\s*/, '').trim());
      for (const y of line.match(/\b(19|20)\d\d\b/g) ?? []) years.add(y);
      const f = line.match(/Bachelor of Science,\s*([A-Za-z ]+?)\s*(\(|\||$)/i);
      if (f) fields.push(f[1].trim());
      const g = line.match(/GPA:?\s*([0-9.]+)/i);
      if (g) gpa = g[1];
    }
  }
  return { experience, education: { schools, years: [...years], gpa, fields }, personal, salary: String(salary) };
}
