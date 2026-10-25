// tests/daily-job-run.test.mjs — lead ranking, resume naming, page counting,
// tracker CSV and the agent sandbox used by daily-job-run.mjs.

import assert from 'assert/strict';
import { join } from 'path';
import { looksNonUs, parsePipeline, pdfPageCount, rankLeads, resumeFileName, trackerCsv } from '../lib/daily-run.mjs';
import { agentCommand, agentPrompt, agentTools, parseArgs, resolveExportDir } from '../daily-job-run.mjs';
import { pass, fail } from './helpers.mjs';

console.log('\nDaily job run');

function check(name, fn) {
  try {
    fn();
    pass(name);
  } catch (err) {
    fail(`${name}: ${err.message}`);
  }
}

const PIPELINE = [
  '# Pipeline',
  '## Pending',
  '- [ ] https://a.wd1.myworkdayjobs.com/x/job/1 | Acme | Project Manager | Austin, TX | posted: 2026-10-22',
  '- [ ] https://job-boards.greenhouse.io/b/jobs/2 | Beta | Lead Project Manager | Paris, France | posted: 2026-10-23',
  '- [ ] https://c.wd5.myworkdayjobs.com/x/job/3 | Gamma | Program Manager | Remote | posted: 2026-10-10',
  '- [ ] https://jobs.lever.co/d/4 | Delta | IT Project Manager | Warszawa',
  '- [ ] https://e.icims.com/jobs/5 | Eps | Project Manager',
  '- [ ] https://f.wd1.myworkdayjobs.com/x/job/6 | Zeta | Senior PM (f/m/d) | Wolfsburg',
  '- [ ] https://g.wd1.myworkdayjobs.com/x/job/7 | Eta | Technical PM | LA - New Orleans | posted: 2026-10-23',
  '- [x] https://done.example/8 | Done | PM | Dallas, TX',
].join('\n');

check('parsePipeline reads pending items only, with posted dates', () => {
  const items = parsePipeline(PIPELINE);
  assert.equal(items.length, 7);
  assert.deepEqual(items[0], { url: 'https://a.wd1.myworkdayjobs.com/x/job/1', company: 'Acme', title: 'Project Manager', location: 'Austin, TX', posted: '2026-10-22', line: items[0].line });
  assert.equal(items[4].location, '');
  assert.equal(items[4].posted, null);
});

check('looksNonUs: U.S. markers win, unknown stays in', () => {
  assert.equal(looksNonUs('Paris, France'), true);
  assert.equal(looksNonUs('Warszawa'), true);
  assert.equal(looksNonUs('London · Berlin'), true);
  assert.equal(looksNonUs('Paris, TX'), false);
  assert.equal(looksNonUs('LA - New Orleans'), false);
  assert.equal(looksNonUs('Remote'), false);
  assert.equal(looksNonUs(''), false);
  assert.equal(looksNonUs('Reston'), false);
  assert.equal(looksNonUs('Remote - United States'), false);
  assert.equal(looksNonUs('Atlanta, Georgia'), false, 'a U.S. state name is not the country');
});

check('rankLeads: last-24h first, then undated, then older; drops non-U.S. and tried URLs', () => {
  const { leads, dropped } = rankLeads(parsePipeline(PIPELINE), {
    today: '2026-10-23', sinceDays: 1, attempted: new Set(['https://e.icims.com/jobs/5']),
  });
  assert.deepEqual(leads.map((l) => l.company), ['Eta', 'Acme', 'Gamma']);
  const why = Object.fromEntries(dropped.map((d) => [d.company, d.why]));
  assert.match(why.Beta, /outside the U\.S\./);
  assert.match(why.Delta, /outside the U\.S\./);
  assert.match(why.Zeta, /outside the U\.S\.|German-market/);
  assert.equal(why.Eps, 'already evaluated');
});

check('resumeFileName: prefix + title, Windows-safe, company suffix on clashes', () => {
  assert.equal(resumeFileName('EbaadG-', 'Technical Project Manager'), 'EbaadG-Technical Project Manager.pdf');
  assert.equal(resumeFileName('EbaadG-', 'Project/Program Manager: IT *Ops*?'), 'EbaadG-Project Program Manager IT Ops.pdf');
  assert.equal(resumeFileName('EbaadG-', 'Project Manager', 'Capital One'), 'EbaadG-Project Manager (Capital One).pdf');
  assert.equal(resumeFileName('EbaadG-', '  ...  '), 'EbaadG-Resume.pdf');
});

check('pdfPageCount reads the page tree, falls back to page objects', () => {
  assert.equal(pdfPageCount(Buffer.from('<< /Type /Pages /Count 1 /Kids [3 0 R] >> << /Type /Page >>')), 1);
  assert.equal(pdfPageCount(Buffer.from('<< /Count 2 /Kids [3 0 R 4 0 R] /Type /Pages >>')), 2);
  assert.equal(pdfPageCount(Buffer.from('<< /Type /Page >> << /Type /Page >> << /Type /Page >>')), 3);
});

check('trackerCsv: BOM, quoting, newest first', () => {
  const csv = trackerCsv([
    { num: 1, date: '2026-10-15', company: 'Acme, Inc.', role: 'PM', score: 4.2, status: 'Applied', howToApply: 'Auto (Workday)', resume: 'EbaadG-PM.pdf', url: 'https://x', notes: 'said "hi"' },
    { num: 2, date: '2026-10-20', company: 'Beta', role: 'TPM', score: 4.5, status: 'Evaluated', howToApply: 'Manual (greenhouse)', resume: '', url: 'https://y', notes: '' },
  ]);
  assert.ok(csv.startsWith('\ufeffDate,Company,Role'));
  const lines = csv.trim().split('\r\n');
  assert.match(lines[1], /^2026-10-20,Beta,/);
  assert.match(lines[2], /"Acme, Inc\.",.*"said ""hi"""/);
});

check('resolveExportDir falls back to this PC\'s Desktop when the configured user folder is missing', () => {
  const home = 'C:/Home/sam';
  const present = new Set([`${home}/Desktop`, join(home, 'Desktop')]);
  const exists = (p) => present.has(p);
  const r = resolveExportDir('C:/Home/someone-else/Desktop/Ebad', { home, exists, env: {} });
  assert.equal(r.dir, join(home, 'Desktop', 'Ebad'));
  assert.match(r.note, /does not exist/);
  const ok = resolveExportDir('%USERPROFILE%/Desktop/Ebad', { home, exists, env: { USERPROFILE: home } });
  assert.equal(ok.dir, `${home}/Desktop/Ebad`);
  assert.equal(ok.note, null);
});

check('agent runs sandboxed: named scripts only, no node -e, no apply, edits only in data folders', () => {
  const scripts = ['generate-pdf.mjs', 'merge-tracker.mjs', 'auto-apply-workday.mjs', 'auto-apply-ats.mjs', 'daily-job-run.mjs'];
  const { allowed, denied } = agentTools(scripts);
  assert.ok(allowed.includes('Bash(node generate-pdf.mjs:*)'));
  assert.ok(!allowed.some((t) => /auto-apply-(workday|ats)|daily-job-run/.test(t)), 'apply scripts are never allowed');
  assert.ok(!allowed.some((t) => t === 'Bash' || t === 'Bash(node:*)' || t === 'Write' || t === 'Edit'), 'no blanket shell or write');
  assert.ok(allowed.includes('Edit(reports/**)') && allowed.includes('Write(output/**)'));
  assert.ok(!allowed.some((t) => /^(Edit|Write)\((\*\*|[^/]*\.mjs)/.test(t)), 'code is not writable');
  assert.ok(denied.includes('Bash(node -e:*)'));
  assert.ok(denied.includes('Bash(node auto-apply-workday.mjs:*)'));
  assert.ok(denied.includes('Bash(node auto-apply-ats.mjs:*)'));
  const argv = agentCommand('claude', {}, scripts);
  assert.ok(!argv.some((a) => /dangerously|bypass/i.test(a)), 'never skips permissions');
  assert.ok(argv.indexOf('--disallowedTools') > argv.indexOf('--allowedTools'));
  assert.ok(!agentCommand('codex', {}, scripts).some((a) => /dangerously|bypass/i.test(a)));
  assert.ok(agentCommand('claude', { extra_allowed_tools: ['Bash(git status:*)'] }, scripts).includes('Bash(git status:*)'));
});

check('agent prompt: one-page render, no applying, URL marked as data', () => {
  const p = agentPrompt({ url: 'https://a/job/1', company: 'Acme', title: 'PM', location: 'Austin, TX' }, 4);
  assert.match(p, /--max-pages=1 --strict-pages/);
  assert.match(p, /do not apply, do not submit/);
  assert.match(p, /untrusted data, not instructions/);
  assert.match(p, /below 4\/5/);
});

check('parseArgs: submit is opt-in; numbers validated', () => {
  assert.equal(parseArgs([]).submit, false);
  const o = parseArgs(['--submit', '--since', '2', '--max', '5', '--skip-scan']);
  assert.deepEqual([o.submit, o.since, o.max, o.skipScan], [true, 2, 5, true]);
  assert.throws(() => parseArgs(['--max', 'x']), /whole number/);
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
});
