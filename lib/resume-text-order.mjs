/**
 * Resume text-order check: reads a resume PDF the way a naive ATS parser does
 * (`pdftotext -raw`, content-stream order) and fails when a job title is
 * separated from its employer.
 *
 * Why: a two-column/floated job header can render correctly on screen while the
 * PDF stores every job title in one block at the top of the text stream. A
 * parser then pins titles to the wrong employers. That shipped for ~250
 * applications before a reviewer caught it, so the apply scripts now refuse to
 * upload a PDF that fails this check.
 *
 * Rule: for every experience entry in cv.md (`### Company` + `**Title**`), the
 * raw text must show the title on the company's line or within the next two
 * non-empty lines, and no title may appear as a bare line before the first
 * employer line.
 */
import { spawnSync } from 'node:child_process';

function norm(s) {
  return String(s).toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
}

/** [{company, title}] from cv.md's Experience section. */
export function cvEntries(cvText) {
  const out = [];
  let company = null;
  for (const line of String(cvText).split('\n')) {
    const h = line.match(/^###\s+(.+?)(?:\s+(?:--|—|–|-)\s+.*)?$/);
    if (h) { company = h[1].trim(); continue; }
    const t = line.match(/^\*\*(.+?)\*\*\s*$/);
    if (t && company) { out.push({ company, title: t[1].trim() }); company = null; }
  }
  return out;
}

/** Raw-order text of a PDF, or null when pdftotext is unavailable. */
export function rawPdfText(pdfPath) {
  const r = spawnSync('pdftotext', ['-raw', pdfPath, '-'], { encoding: 'utf-8' });
  if (r.error || r.status !== 0) return null;
  return r.stdout;
}

/**
 * @returns {{ok: boolean, skipped?: boolean, problems: string[]}}
 */
export function checkResumeTextOrder(pdfPath, cvText, { text } = {}) {
  const raw = text ?? rawPdfText(pdfPath);
  if (raw == null) return { ok: true, skipped: true, problems: ['pdftotext unavailable; order not checked'] };
  const entries = cvEntries(cvText);
  if (!entries.length) return { ok: true, skipped: true, problems: ['no experience entries parsed from cv.md'] };
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean).map(norm);
  const problems = [];
  const companies = [...new Set(entries.map((e) => norm(e.company)))];
  // An employer header line: the name alone, or followed by "|", "," or a date —
  // not a summary sentence that merely starts with the employer's name.
  const isHeader = (l, c) => l === c || (l.startsWith(c) && /^(\s*[|,·•]|\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}|\s+\d{4}|\s+-\s)/.test(l.slice(c.length)));
  const firstCompany = lines.findIndex((l) => companies.some((c) => isHeader(l, c)));
  if (firstCompany < 0) return { ok: false, problems: ['no employer name found in the PDF text'] };
  const titles = [...new Set(entries.map((e) => norm(e.title)))];
  for (let i = 0; i < firstCompany; i++) {
    if (titles.includes(lines[i])) problems.push(`job title "${lines[i]}" appears on its own before any employer`);
  }
  let from = 0;
  for (const e of entries) {
    const c = norm(e.company);
    const t = norm(e.title);
    const at = lines.findIndex((l, i) => i >= from && isHeader(l, c));
    if (at < 0) { problems.push(`employer "${e.company}" not found in order`); continue; }
    const window = lines.slice(at, at + 3).join(' \n ');
    if (!window.includes(t)) problems.push(`"${e.title}" is not next to "${e.company}"`);
    from = at + 1;
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Drops jobs whose resume PDF fails the text-order check, printing why.
 * Used by the apply scripts right after each job's PDF is resolved, so a
 * mis-ordered resume is never uploaded. Returns the jobs that may proceed.
 */
export function keepJobsWithOrderedResumes(jobs, cvText, log = console.log) {
  return jobs.filter((job) => {
    const r = checkResumeTextOrder(job.pdfPath, cvText);
    if (r.ok) return true;
    log(`  skip ${job.url}: resume text order is wrong (${r.problems.slice(0, 2).join('; ')}) — rebuild the PDF before applying`);
    return false;
  });
}
