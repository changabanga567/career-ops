#!/usr/bin/env node

/**
 * auto-apply-ats.mjs — fill (and optionally submit) Greenhouse, Lever and
 * Ashby applications.
 *
 * These boards need no account: the form sits on the posting (Greenhouse) or
 * one click away (Lever /apply, Ashby /application). The driver uploads the
 * tailored CV PDF as "<resume_prefix><Job Title>.pdf", answers every question
 * from config/auto-apply.yml + config/profile.yml with the same resolver as
 * auto-apply-workday.mjs, ticks the terms/consent boxes, unticks SMS and
 * marketing opt-ins, and stops before Submit unless --submit is given.
 *
 * Greenhouse sometimes asks for a security code it emails to the candidate.
 * The run then waits up to --code-wait minutes for the code to appear in
 * data/auto-apply/codes/<company>.txt (typed by you, or by an agent that can
 * read your inbox).
 *
 * --submit is a flag for the user to pass on their own command line; agents
 * running career-ops modes never add it on their own (AGENTS.md → Ethical Use).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { createInterface } from 'readline/promises';
import { isMainModule } from './lib/is-main-module.mjs';
import { loadYaml } from './lib/yaml-document.mjs';
import { resumeFileName } from './lib/daily-run.mjs';
import { getProfilePath, resolveTrackerPath } from './path-resolver.mjs';
import { freshLaunchOptions } from './apply-scope.mjs';
import { atsVendorOf } from './ats-vendor.mjs';
import { validateReview, reviewFacts } from './lib/review-guard.mjs';
import { parseCvExperience } from './lib/workday-answers.mjs';
import { createResolver, isAgreementLabel, isOptInLabel, ALTERNATIVES, normalizeLabel, parseCvEducation, pickOption } from './lib/workday-answers.mjs';
import {
  alreadySubmitted, blacklistHit, findReportPdf, loadEnv, logResult, markApplied, markClosed, parseBatchFile, parseBlacklist,
  pause, readLearned, readYamlFile, reportUrl, resolveJobPdf, saveLearned, screenshot, selectTrackerJobs, tick,
  CONFIG_PATH, CONFIRM_RE, ALREADY_RE, DATA_ROOT,
} from './auto-apply-workday.mjs';

const VENDORS = new Set(['greenhouse', 'lever', 'ashby']);
const NAV_TIMEOUT = 45_000;
const CODES_DIR = join(DATA_ROOT, 'data', 'auto-apply', 'codes');

const USAGE = `Usage:
  node auto-apply-ats.mjs --url <greenhouse|lever|ashby job url> [--pdf output/cv.pdf | --report N] [--role "Job Title"] [options]
  node auto-apply-ats.mjs --batch jobs.txt [options]
  node auto-apply-ats.mjs --from-tracker [--limit N] [--min-score X] [options]

Fills a Greenhouse, Lever or Ashby application and stops before Submit.

  --url URL        posting on job-boards.greenhouse.io, jobs.lever.co or jobs.ashbyhq.com
  --pdf PATH       resume PDF to upload
  --report N       report number: links the tracker row and, without --pdf,
                   picks the newest tailored PDF for that report
  --role TITLE     job title used in the uploaded file name (default: tracker role)
  --batch FILE     one job per line: <url> [pdf] [report=N]  (# comments ok)
  --from-tracker   every Evaluated Greenhouse/Lever/Ashby row with a tailored PDF
  --limit N        with --from-tracker: at most N jobs this run
  --min-score X    with --from-tracker: skip rows scored below X
  --answers FILE   extra YAML list of {match, answer} rules for this run,
                   checked before config/auto-apply.yml (job-specific essays)
  --code-wait MIN  minutes to wait for an emailed security code (default 6)
  --parallel N     run N jobs at once (default 3 when nothing will be asked)
  --submit         click Submit (default: stop before it)
  --headless       run without a visible window (implies --no-prompt)
  --no-prompt      never ask in the terminal; unanswered required questions
                   make the job needs_input
  --force          apply even if the log says this URL was already submitted
  --dry-run        resolve jobs and PDFs, print the plan, exit
  --help, -h       show this message`;

export function isAtsUrl(url) {
  return VENDORS.has(atsVendorOf(url));
}

export function parseCli(argv) {
  const opts = { jobs: [], submit: false, headless: false, prompt: true, force: false, dryRun: false, help: false, fromTracker: false, limit: null, minScore: null, answers: null, codeWait: 6, parallel: null };
  let url = null;
  let pdf = null;
  let report = null;
  let role = null;
  let batch = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--url': url = value(); break;
      case '--pdf': pdf = value(); break;
      case '--report': report = value(); break;
      case '--role': role = value(); break;
      case '--batch': batch = value(); break;
      case '--from-tracker': opts.fromTracker = true; break;
      case '--limit': opts.limit = Number(value()); break;
      case '--min-score': opts.minScore = Number(value()); break;
      case '--answers': opts.answers = value(); break;
      case '--code-wait': opts.codeWait = Number(value()); break;
      case '--parallel': opts.parallel = Number(value()); break;
      case '--submit': opts.submit = true; break;
      case '--headless': opts.headless = true; opts.prompt = false; break;
      case '--no-prompt': opts.prompt = false; break;
      case '--force': opts.force = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new Error(`unknown option ${arg}`);
    }
  }
  if (opts.help) return opts;
  if (report != null && !/^\d+$/.test(report)) throw new Error('--report must be a number');
  if (url) opts.jobs.push({ url, pdf, report, role });
  if (batch) opts.jobs.push(...parseBatchFile(readFileSync(resolve(DATA_ROOT, batch), 'utf-8')));
  if (opts.limit != null && !(Number.isInteger(opts.limit) && opts.limit > 0)) throw new Error('--limit must be a positive whole number');
  if (opts.minScore != null && Number.isNaN(opts.minScore)) throw new Error('--min-score must be a number');
  if (!(opts.codeWait >= 0)) throw new Error('--code-wait must be a number of minutes');
  if (opts.parallel != null && !(Number.isInteger(opts.parallel) && opts.parallel >= 1 && opts.parallel <= 8)) throw new Error('--parallel must be a whole number from 1 to 8');
  if (opts.jobs.length === 0 && !opts.fromTracker) throw new Error('give --url, --batch or --from-tracker');
  return opts;
}

/** The URL that shows the application form: Lever …/apply, Ashby …/application, Greenhouse the posting itself. */
export function applicationUrl(url) {
  const vendor = atsVendorOf(url);
  const u = new URL(url);
  const path = u.pathname.replace(/\/$/, '');
  if (vendor === 'lever' && !/\/apply$/.test(path)) u.pathname = `${path}/apply`;
  if (vendor === 'ashby' && !/\/application$/.test(path)) u.pathname = `${path}/application`;
  return u.toString();
}

/** Company slug from the board URL: job-boards.greenhouse.io/<slug>/jobs/…, jobs.lever.co/<slug>/…, jobs.ashbyhq.com/<slug>/… */
export function boardSlug(url) {
  try {
    return new URL(url).pathname.split('/').filter(Boolean)[0] ?? '';
  } catch {
    return '';
  }
}

const CLOSED_RE = /couldn['’]?t find anything here|job not found|no longer (open|available|accepting)|position has been (filled|closed)|this job (posting )?(is )?(closed|no longer)|page (you('re| are) looking for )?(was )?not found/i;
const DONE_RE = new RegExp(`${CONFIRM_RE.source}|application (was |has been )?(received|submitted)|thanks for applying|we('ve| have) received your application|your application (is )?(on its way|complete)`, 'i');
const CODE_RE = /security code|verification code|enter the code|code (was )?sent to/i;

// ── Field scanning (runs in the page) ────────────────────────────────

/**
 * Group the visible controls into questions and tag them with data-ca-q.
 * A question is a text box, a select, a combobox, a radio/checkbox group
 * sharing a name, a lone checkbox, a file input, or a row of Yes/No buttons.
 * Its label is found in the largest ancestor that holds no other question.
 */
function scanAtsFields() {
  const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const text = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  for (const old of document.querySelectorAll('[data-ca-q]')) old.removeAttribute('data-ca-q');

  const controls = [...document.querySelectorAll('input, select, textarea')].filter((e) => {
    if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(e.type)) return false;
    if (/recaptcha|captcha/i.test(`${e.name} ${e.id}`)) return false;
    if (/requiredInput/i.test(String(e.className))) return false; // Greenhouse's shadow validation inputs
    if (e.closest('.iti__dropdown-content')) return false;
    if (e.type === 'file') return true;
    return vis(e);
  });
  const groups = new Map();
  for (const e of controls) {
    const key = (e.type === 'radio' || e.type === 'checkbox') && e.name ? `${e.type}:${e.name}` : `el:${groups.size}:${e.id || e.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  // Ashby renders Yes/No questions as two buttons.
  const yesNo = [...document.querySelectorAll('button')].filter((b) => vis(b) && /^(yes|no)$/i.test(text(b)));
  const byParent = new Map();
  for (const b of yesNo) {
    if (!byParent.has(b.parentElement)) byParent.set(b.parentElement, []);
    byParent.get(b.parentElement).push(b);
  }
  for (const [parent, buttons] of byParent) groups.set(`buttons:${groups.size}`, buttons.map((b) => Object.assign(b, { _parent: parent })));

  const all = [...groups.values()];
  const owner = new Map();
  all.forEach((members, gi) => members.forEach((m) => owner.set(m, gi)));
  const ownsOnly = (el, gi) => [...owner.entries()].every(([m, g]) => g === gi || !el.contains(m));

  const optionText = (e) => {
    if (e.tagName === 'BUTTON') return text(e);
    const byFor = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`) : null;
    return text(byFor || e.closest('label')) || text(e.nextElementSibling) || e.value;
  };

  return all.map((members, idx) => {
    const first = members[0];
    let box = first.parentElement;
    while (box && box.parentElement && box.parentElement !== document.body && ownsOnly(box.parentElement, idx)) box = box.parentElement;
    for (const m of members) m.setAttribute('data-ca-q', String(idx));

    const isGroup = first.tagName === 'BUTTON' || ((first.type === 'radio' || first.type === 'checkbox') && members.length > 1);
    const optionLabels = new Set(isGroup ? members.map((m) => (m.id && document.querySelector(`label[for="${CSS.escape(m.id)}"]`)) || m.closest('label')).filter(Boolean) : []);
    let label = '';
    if (!isGroup && first.id && first.type !== 'checkbox') label = text(document.querySelector(`label[for="${CSS.escape(first.id)}"]`));
    if (!label && first.getAttribute('aria-labelledby')) label = first.getAttribute('aria-labelledby').split(/\s+/).map((id) => text(document.getElementById(id))).join(' ').trim();
    if (!label && box) {
      const picks = ['legend', '.application-label', '[class*="question-title"]', '[class*="question_title"]', 'label', '[id$="-label"]', '[class*="label"]'];
      for (const sel of picks) {
        const hit = [...box.querySelectorAll(sel)].find((l) => !optionLabels.has(l) && ![...members].some((m) => l.contains(m) && first.type !== 'checkbox') && text(l));
        if (hit) { label = text(hit); break; }
      }
    }
    // A lone checkbox: its own label is the statement being agreed to.
    let own = '';
    if (first.type === 'checkbox' && !isGroup) own = optionText(first);
    if (!label) label = own || first.getAttribute('aria-label') || first.placeholder || '';
    if (own && label !== own && !label.includes(own)) label = `${label} ${own}`;

    // File inputs sit under a button ("Attach"); the question is the container's first line ("Cover Letter *").
    if (first.type === 'file' && box) label = (box.innerText || '').split('\n').map((l) => l.trim()).find(Boolean) || label;
    const required = /[*✱]/.test(label) || members.some((m) => m.required || m.getAttribute('aria-required') === 'true');
    label = label.replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim();

    let kind;
    if (first.tagName === 'BUTTON') kind = 'buttons';
    else if (first.type === 'file') kind = 'file';
    else if (first.tagName === 'SELECT') kind = 'select';
    else if (first.tagName === 'TEXTAREA') kind = 'textarea';
    else if (first.type === 'radio') kind = 'radio';
    else if (first.type === 'checkbox') kind = isGroup ? 'checkboxes' : 'checkbox';
    else if (first.getAttribute('role') === 'combobox' || first.getAttribute('aria-autocomplete') || /select__input/.test(String(first.className))) kind = 'combobox';
    else kind = 'text';

    const options = kind === 'select' ? [...first.options].map((o) => o.text.trim())
      : ['radio', 'checkboxes', 'buttons'].includes(kind) ? members.map(optionText) : [];
    let value = '';
    if (kind === 'select') value = first.selectedIndex > 0 ? first.options[first.selectedIndex].text.trim() : '';
    else if (kind === 'radio' || kind === 'checkboxes') value = members.filter((m) => m.checked).map(optionText).join(', ');
    else if (kind === 'checkbox') value = first.checked ? 'checked' : '';
    else if (kind === 'combobox') value = text(first.closest('[class*="select__control"], [class*="container"]')?.querySelector('[class*="single-value"], [class*="singleValue"]')) || first.value;
    else if (kind !== 'file' && kind !== 'buttons') value = first.value;
    const meta = `${first.id} ${first.name} ${String(first.accept || '')}`;
    return { idx, kind, label, required, options, value, meta, count: members.length };
  });
}

// ── Widget fillers ───────────────────────────────────────────────────

const q = (idx) => `[data-ca-q="${idx}"]`;

function alternatives(answer) {
  return String(answer).split(ALTERNATIVES).map((a) => a.trim()).filter(Boolean);
}

/** pickOption, but refuse when several options fit equally ("Asian" vs "East Asian" / "South Asian"). */
export function pickUnambiguous(desired, options) {
  const i = pickOption(desired, options);
  if (i === -1) return -1;
  const want = normalizeLabel(desired);
  if (normalizeLabel(options[i]) === want) return i;
  const rest = options.map((o, j) => (j === i ? '' : o));
  const j = pickOption(desired, rest);
  if (j === -1) return i;
  const words = (s) => normalizeLabel(s).split(' ').length;
  return words(options[i]) === words(options[j]) && !/^(yes|no)\b/.test(want) ? -1 : i;
}

async function chooseFrom(options, answer) {
  for (const alt of alternatives(answer)) {
    const i = pickUnambiguous(alt, options);
    if (i !== -1) return i;
  }
  return -1;
}

async function openOptions(page) {
  return page.locator('[role="option"]:visible, .select__option:visible').allInnerTexts().catch(() => []);
}

/** Every meaningful word of the answer appears in the option ("Florida International University" ≠ "Alliant International University"). */
export function strongMatch(desired, option) {
  const words = (x) => normalizeLabel(x).replace(/'/g, '').split(' ').filter((w) => w.length > 2 && !/^\+?\d+$/.test(w) && !['the', 'and', 'for', 'degree'].includes(w));
  const covers = (a, b) => a.length > 0 && a.every((w) => b.some((h) => h === w || h.startsWith(w)));
  const want = words(desired);
  const have = words(option);
  // Either side may carry extra words: "United States of America" vs "United States +1".
  return covers(want, have) || (have.length >= 2 && covers(have, want));
}

function pickCombo(alt, opts, field, { fuzzy = true } = {}) {
  // Short fixed lists (Yes/No, Gender) take the normal fuzzy pick; long or searched lists need every word.
  if (fuzzy && opts.length <= 12) return pickUnambiguous(alt, opts);
  const exact = opts.findIndex((o) => normalizeLabel(o) === normalizeLabel(alt));
  if (exact !== -1) return exact;
  // Shortest full match: "United States" → "United States of America", not "… Minor Outlying Islands".
  const strong = opts.map((o, i) => ({ o, i })).filter(({ o }) => strongMatch(alt, o)).sort((a, b) => a.o.length - b.o.length);
  if (strong.length) return strong[0].i;
  return field.key === 'personal.location' ? 0 : -1;
}

async function fillCombobox(page, field, answer) {
  const input = page.locator(q(field.idx)).first();
  const alts = alternatives(answer);
  await input.click({ force: true });
  await pause(400, 700);
  let opts = await openOptions(page);
  let i = -1;
  for (const alt of alts) {
    if (!opts.length) break;
    i = pickCombo(alt, opts, field);
    if (i !== -1) break;
  }
  if (i === -1) {
    // Async lists (school, location) fill only after typing.
    for (const alt of alts) {
      await input.fill('');
      await input.pressSequentially(alt.slice(0, 40), { delay: 40 });
      await pause(1200, 1600);
      opts = await openOptions(page);
      if (!opts.length) continue;
      i = pickCombo(alt, opts, field, { fuzzy: false });
      if (i !== -1) break;
    }
  }
  if (i === -1) {
    await input.fill('').catch(() => {});
    await page.keyboard.press('Escape').catch(() => {});
    return false;
  }
  await page.locator('[role="option"]:visible, .select__option:visible').nth(i).click();
  await pause();
  return true;
}

async function fillLocationText(page, field, answer) {
  const input = page.locator(q(field.idx)).first();
  await input.fill('');
  await input.pressSequentially(alternatives(answer)[0], { delay: 40 });
  await pause(1500, 2000);
  // Lever suggests places under the box; the first one is the typed city.
  const suggestion = page.locator('.dropdown-results > div:visible, .location-dropdown li:visible, [role="option"]:visible').first();
  if (await suggestion.count()) await suggestion.click().catch(() => {});
  await pause();
  return true;
}

async function applyField(page, field, answer, ctx) {
  const loc = page.locator(q(field.idx));
  switch (field.kind) {
    case 'text':
      if (field.key === 'personal.location' && ctx.vendor === 'lever') return fillLocationText(page, field, answer);
      await loc.first().fill(alternatives(answer)[0]);
      return true;
    case 'textarea':
      await loc.first().fill(alternatives(answer)[0]);
      return true;
    case 'select': {
      const i = await chooseFrom(field.options, answer);
      if (i === -1) return false;
      await loc.first().selectOption({ index: i });
      return true;
    }
    case 'combobox':
      return fillCombobox(page, field, answer);
    case 'radio':
    case 'buttons': {
      const i = await chooseFrom(field.options, answer);
      if (i === -1) return false;
      const target = loc.nth(i);
      if (field.kind === 'radio') await tick(target);
      else await target.click();
      return true;
    }
    case 'checkboxes': {
      let any = false;
      for (const alt of alternatives(answer)) {
        const i = pickUnambiguous(alt, field.options);
        if (i === -1) continue;
        await tick(loc.nth(i));
        any = true;
        break;
      }
      return any;
    }
    case 'checkbox': {
      const want = /^(yes|true|checked|i agree|agree)$/i.test(alternatives(answer)[0]);
      const box = loc.first();
      if ((await box.isChecked().catch(() => false)) !== want) {
        if (want) await tick(box);
        else await box.uncheck({ force: true }).catch(() => box.click({ force: true }));
      }
      return true;
    }
    default:
      return false;
  }
}

const AFFIRM = ['Yes', 'I agree', 'I acknowledge', 'I confirm', 'I accept', 'Acknowledged', 'Agree', 'Accept', 'I have read', 'Confirm'].join(ALTERNATIVES);

function answerFor(field, ctx) {
  const hit = ctx.resolve(field.label);
  if (hit) return { ...hit, key: hit.key };
  if (field.kind === 'checkbox') {
    if (isOptInLabel(field.label)) return { answer: 'No', source: 'opt-in', key: 'opt-in' };
    if (isAgreementLabel(field.label) && ctx.config.behavior?.accept_agreements !== false) return { answer: 'Yes', source: 'agreement', key: 'agreement' };
  }
  // Opt-in questions get "No" only where No is a choice; a text box (preferred name) stays blank.
  if (isOptInLabel(field.label)) return ['text', 'textarea'].includes(field.kind) ? { answer: '', source: 'skip', key: 'opt-in' } : { answer: 'No', source: 'opt-in', key: 'opt-in' };
  if (isAgreementLabel(field.label) && ctx.config.behavior?.accept_agreements !== false) return { answer: AFFIRM, source: 'agreement', key: 'agreement' };
  return null;
}

function isCoverInput(field) {
  return /cover/i.test(`${field.label} ${field.meta}`);
}

/** A cover letter rendered for this report: output/*-<NNN>-*cover*.pdf, newest first. */
function findCoverPdf(report) {
  if (report == null) return null;
  const dir = join(DATA_ROOT, 'output');
  if (!existsSync(dir)) return null;
  const padded = String(report).padStart(3, '0');
  const hits = readdirSync(dir).filter((n) => n.endsWith('.pdf') && /cover/i.test(n) && n.includes(`-${padded}-`)).map((n) => join(dir, n));
  hits.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return hits[0] ?? null;
}

async function uploadCover(page, fields, ctx) {
  const target = fields.find((f) => f.kind === 'file' && isCoverInput(f));
  if (!target) return null;
  if (ctx.coverPath) {
    const name = resumeFileName(ctx.prefix, `Cover Letter - ${ctx.role}`);
    await page.locator(q(target.idx)).first().setInputFiles({ name, mimeType: 'application/pdf', buffer: readFileSync(ctx.coverPath) });
    ctx.say(`  uploaded ${name}`);
    return null;
  }
  // Never invent a letter: the candidate's own reasons are needed (modes/cover.md).
  return target.required ? 'Cover letter (required) — none written for this job yet' : null;
}

function isResumeInput(field) {
  return /resume|\bcv\b|_systemfield_resume/i.test(`${field.label} ${field.meta}`) && !/cover/i.test(`${field.label} ${field.meta}`);
}

async function uploadResume(page, fields, ctx) {
  const target = fields.find((f) => f.kind === 'file' && isResumeInput(f));
  if (!target) return false;
  await page.locator(q(target.idx)).first().setInputFiles({ name: ctx.uploadName, mimeType: 'application/pdf', buffer: readFileSync(ctx.pdfPath) });
  ctx.say(`  uploaded ${ctx.uploadName}`);
  // Lever and Ashby parse the resume and prefill some fields; let that finish first.
  await pause(3000, 4000);
  return true;
}

async function fillForm(page, ctx) {
  const unanswered = [];
  const done = new Set();
  for (let pass = 0; pass < 2; pass++) {
    const fields = await page.evaluate(scanAtsFields);
    for (const field of fields) {
      if (field.kind === 'file' || !field.label) continue;
      const id = `${field.kind}:${normalizeLabel(field.label)}`;
      let hit = answerFor(field, ctx);
      if (!hit) {
        if (field.required && !field.value && !unanswered.some((u) => u.startsWith(field.label))) unanswered.push(field.label);
        continue;
      }
      if (hit.source === 'skip' || !hit.answer) {
        if (field.required && !field.value && !unanswered.some((u) => u.startsWith(field.label))) unanswered.push(field.label);
        continue;
      }
      field.key = hit.key;
      if (done.has(id) && field.value) continue;
      // Leave prefilled text alone unless it contradicts the configured answer.
      if (field.value && ['text', 'textarea'].includes(field.kind) && normalizeLabel(field.value) === normalizeLabel(alternatives(hit.answer)[0])) { done.add(id); continue; }
      let ok = await applyField(page, field, hit.answer, ctx).catch((err) => { ctx.say(`  ! ${field.label.slice(0, 60)}: ${err.message.split('\n')[0]}`); return false; });
      // A long legal statement can trip a narrower rule ("…may be terminated…"); it is still a statement to acknowledge.
      if (!ok && hit.source !== 'agreement' && isAgreementLabel(field.label) && ctx.config.behavior?.accept_agreements !== false) {
        hit = { answer: field.kind === 'checkbox' ? 'Yes' : AFFIRM, source: 'agreement', key: 'agreement' };
        ok = await applyField(page, field, hit.answer, ctx).catch(() => false);
      }
      if (ok) {
        if (!done.has(id)) ctx.say(`  ${field.label.slice(0, 70)} → ${alternatives(hit.answer)[0].slice(0, 60)}`);
        done.add(id);
        const i = unanswered.findIndex((u) => u.startsWith(field.label));
        if (i !== -1) unanswered.splice(i, 1);
      } else if (field.required && !unanswered.some((u) => u.startsWith(field.label))) {
        unanswered.push(field.options.length ? `${field.label} [options: ${field.options.slice(0, 8).join(' / ')}]` : field.label);
      }
      await pause(120, 300);
    }
    // Conditional questions appear after earlier answers; scan once more.
    await pause(600, 900);
  }
  return unanswered;
}

async function askMissing(page, unanswered, ctx) {
  if (!ctx.prompt || unanswered.length === 0) return unanswered;
  for (const label of unanswered) {
    if (/^cover letter/i.test(label)) continue;
    const reply = (await ctx.ask(`  ? ${label}\n    answer (blank to skip): `)).trim();
    if (reply) ctx.learned[label.replace(/ \[options:.*$/, '')] = reply;
  }
  saveLearned(ctx.learned);
  ctx.refreshResolver();
  return fillForm(page, ctx);
}

async function findSubmit(page) {
  const candidates = page.locator('button:visible, input[type="submit"]:visible');
  const count = await candidates.count();
  for (let i = 0; i < count; i++) {
    const el = candidates.nth(i);
    const label = ((await el.innerText().catch(() => '')) || (await el.getAttribute('value').catch(() => '')) || '').trim();
    if (/^submit( (your )?application)?$/i.test(label) || /^apply( now)?$/i.test(label)) return el;
  }
  return null;
}

async function formErrors(page) {
  return page.evaluate(() => {
    const text = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim();
    const vis = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
    const msgs = [...document.querySelectorAll('[class*="error" i], [role="alert"], [aria-live="assertive"]')].filter(vis).map(text).filter((t) => t && t.length < 200);
    return [...new Set(msgs)].slice(0, 8);
  }).catch(() => []);
}

async function waitForCode(page, ctx) {
  const file = join(CODES_DIR, `${ctx.slug}.txt`);
  mkdirSync(CODES_DIR, { recursive: true });
  if (existsSync(file)) unlinkSync(file);
  ctx.say(`  CODE NEEDED: the board emailed a security code to ${ctx.email}. Put it in ${file.replace(`${DATA_ROOT}/`, '')} (waiting ${ctx.codeWait} min)`);
  const deadline = Date.now() + ctx.codeWait * 60_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const code = readFileSync(file, 'utf-8').trim();
      if (code) {
        unlinkSync(file);
        return code;
      }
    }
    if (ctx.prompt) return (await ctx.ask('  security code: ')).trim();
    await pause(3000, 3000);
  }
  return '';
}

async function enterCode(page, code) {
  // Greenhouse: one box per character, or a single field.
  const boxes = page.locator('input[id^="security-input"], input[name*="security" i], input[autocomplete="one-time-code"], input[aria-label*="code" i], input[maxlength="1"]:visible');
  const n = await boxes.count();
  if (n > 1) {
    for (let i = 0; i < Math.min(n, code.length); i++) await boxes.nth(i).fill(code[i]);
  } else if (n === 1) {
    await boxes.first().fill(code);
  } else {
    return false;
  }
  return true;
}

async function waitOutcome(page, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const body = await page.locator('body').innerText().catch(() => '');
    if (DONE_RE.test(body) || /\/(thanks|confirmation)\b/.test(page.url())) return 'done';
    if (CODE_RE.test(body) && (await page.locator('input[id^="security-input"], input[maxlength="1"]:visible, input[autocomplete="one-time-code"]').count())) return 'code';
    await pause(800, 1000);
  }
  return 'timeout';
}

export async function runAtsJob(browser, job, ctx) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(applicationUrl(job.url), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    await pause(1200, 1800);
    const landing = await page.locator('body').innerText().catch(() => '');
    if (ALREADY_RE.test(landing)) return { status: 'already_applied' };
    // Greenhouse sends a closed posting back to the board with ?error=true.
    if (CLOSED_RE.test(landing) || /[?&]error=true/.test(page.url())) return { status: 'closed', screenshot: await screenshot(page, job.url, 'closed') };
    if (ctx.vendor === 'greenhouse') {
      const apply = page.getByRole('button', { name: /^apply( for this job| now)?$/i }).first();
      if (await apply.isVisible().catch(() => false)) { await apply.click(); await pause(800, 1200); }
    }
    const fields = await page.evaluate(scanAtsFields);
    if (!fields.length) return { status: 'error', errors: ['no application form on the page'], screenshot: await screenshot(page, job.url, 'error') };
    if (!(await uploadResume(page, fields, ctx))) ctx.say('  ! no resume upload field found');

    const coverMissing = await uploadCover(page, fields, ctx);
    let unanswered = await fillForm(page, ctx);
    if (coverMissing) unanswered.push(coverMissing);
    unanswered = await askMissing(page, unanswered, ctx);
    if (unanswered.length) return { status: 'needs_input', questions: unanswered, screenshot: await screenshot(page, job.url, 'needs-input') };

    if (!ctx.submit) {
      const shot = await screenshot(page, job.url, 'review');
      if (ctx.headless) return { status: 'ready_for_review', screenshot: shot };
      await ctx.ask('  Filled. Review it in the browser and submit yourself, then press Enter here… ');
      return { status: 'ready_for_review', screenshot: shot };
    }

    // These forms have no Review page: read back every filled answer as "label / value" and check it
    // against cv.md and the profile before anything is sent.
    const snapshot = await page.evaluate(() => {
      const out = [];
      const labelOf = (el) => {
        const id = el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        const box = el.closest('fieldset, .field, .application-question, [class*="question"], [class*="field"], li, div');
        return (id?.innerText || el.getAttribute('aria-label') || box?.querySelector('label, legend')?.innerText || el.name || '').replace(/\s+/g, ' ').trim();
      };
      for (const el of document.querySelectorAll('input:not([type=hidden]):not([type=file]):not([type=submit]), select, textarea')) {
        if (!el.getClientRects().length) continue;
        let v = '';
        if (el.type === 'checkbox' || el.type === 'radio') { if (!el.checked) continue; v = (document.querySelector(`label[for="${CSS.escape(el.id || '')}"]`)?.innerText || el.value || 'Yes'); }
        else if (el.tagName === 'SELECT') v = el.selectedOptions?.[0]?.innerText || '';
        else v = el.value || '';
        if (!String(v).trim()) continue;
        out.push(labelOf(el), String(v).replace(/\s+/g, ' ').trim());
      }
      return out.join('\n');
    }).catch(() => '');
    const guardIssues = ctx.facts ? validateReview(snapshot, ctx.facts) : ['review guard has no facts (cv.md missing)'];
    if (guardIssues.length) {
      ctx.say(`  ✋ review guard blocked Submit: ${guardIssues.join(' · ')}`);
      return { status: 'review_blocked', errors: guardIssues, screenshot: await screenshot(page, job.url, 'review-blocked') };
    }

    const submit = await findSubmit(page);
    if (!submit) return { status: 'error', errors: ['no Submit button found'], screenshot: await screenshot(page, job.url, 'error') };
    await submit.scrollIntoViewIfNeeded().catch(() => {});
    await submit.click();
    let outcome = await waitOutcome(page);
    if (outcome === 'code') {
      const code = await waitForCode(page, ctx);
      if (!code) return { status: 'needs_code', errors: ['no security code arrived in time'], screenshot: await screenshot(page, job.url, 'needs-code') };
      if (!(await enterCode(page, code))) return { status: 'error', errors: ['could not find the security-code boxes'], screenshot: await screenshot(page, job.url, 'error') };
      const again = await findSubmit(page);
      if (again) await again.click().catch(() => {});
      outcome = await waitOutcome(page);
    }
    if (outcome === 'done') return { status: 'submitted', screenshot: await screenshot(page, job.url, 'submitted') };
    const errors = await formErrors(page);
    const captcha = /captcha/i.test(errors.join(' ')) || (await page.locator('iframe[src*="hcaptcha"][title*="challenge" i]:visible, iframe[src*="recaptcha"][title*="challenge" i]:visible').count()) > 0;
    return { status: captcha ? 'captcha' : 'not_confirmed', errors, screenshot: await screenshot(page, job.url, captcha ? 'captcha' : 'not-confirmed') };
  } catch (err) {
    return { status: 'error', errors: [err.message.split('\n')[0]], screenshot: await screenshot(page, job.url, 'error') };
  } finally {
    if (!ctx.keepOpen) await context.close().catch(() => {});
  }
}

function trackerJobs(opts) {
  const trackerPath = resolveTrackerPath(DATA_ROOT);
  if (!existsSync(trackerPath)) throw new Error(`tracker not found: ${trackerPath}`);
  const { jobs, skipped } = selectTrackerJobs(readFileSync(trackerPath, 'utf-8'), { reportUrl, findPdf: (n) => findReportPdf(n) }, { minScore: opts.minScore, accept: isAtsUrl });
  for (const s of skipped) console.log(`  skip ${s}`);
  return opts.limit ? jobs.slice(0, opts.limit) : jobs;
}

function readAnswersFile(path) {
  if (!path) return [];
  const doc = loadYaml(readFileSync(resolve(DATA_ROOT, path), 'utf-8'));
  const list = Array.isArray(doc) ? doc : doc?.questions;
  if (!Array.isArray(list)) throw new Error(`${path}: expected a list of {match, answer}`);
  return list;
}

/** Title from the report header ("# Evaluation: Company — Role") when the tracker gave none. */
function reportRole(num) {
  if (num == null) return '';
  const dir = join(DATA_ROOT, 'reports');
  if (!existsSync(dir)) return '';
  const file = readdirSync(dir).find((n) => n.startsWith(`${String(num).padStart(3, '0')}-`) && n.endsWith('.md'));
  if (!file) return '';
  const head = readFileSync(join(dir, file), 'utf-8').split('\n')[0];
  return /[—-]\s*(.+)$/.exec(head)?.[1]?.trim() ?? '';
}

async function main() {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(`auto-apply-ats: ${err.message}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  await loadEnv();
  const config = readYamlFile(CONFIG_PATH, 'config/auto-apply.yml');
  const profile = readYamlFile(getProfilePath(), 'config/profile.yml');
  const extra = readAnswersFile(opts.answers);
  const runConfig = { ...config, questions: [...extra, ...(config.questions ?? [])] };
  if (opts.fromTracker) opts.jobs.push(...trackerJobs(opts));
  const blacklistPath = join(DATA_ROOT, 'data', 'blacklist.md');
  const blacklist = existsSync(blacklistPath) ? parseBlacklist(readFileSync(blacklistPath, 'utf-8')) : [];
  opts.jobs = opts.jobs.filter((job) => {
    const hit = blacklistHit(blacklist, { company: job.company || boardSlug(job.url), url: job.url });
    if (hit) console.log(`  skip ${job.company || job.url}: on your blacklist (${hit.company})`);
    return !hit;
  });
  if (opts.jobs.length === 0) {
    console.log('No Greenhouse/Lever/Ashby jobs to apply to.');
    return;
  }
  for (const job of opts.jobs) {
    if (!isAtsUrl(job.url)) throw new Error(`not a Greenhouse, Lever or Ashby URL: ${job.url}`);
    job.pdfPath = resolveJobPdf(job);
    job.role = job.role || reportRole(job.report) || 'Resume';
  }
  const prefix = config.daily?.resume_prefix ?? '';
  console.log(`${opts.jobs.length} job(s) · ${opts.submit ? 'WILL SUBMIT' : 'stops before Submit'}`);
  for (const job of opts.jobs) console.log(`  ${job.url}\n    resume ${job.pdfPath.replace(`${DATA_ROOT}/`, '')} as ${resumeFileName(prefix, job.role)}${job.report ? ` · report ${job.report}` : ''}`);
  if (opts.dryRun) return;

  const rl = opts.prompt ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const cvPath = join(DATA_ROOT, 'cv.md');
  const ctx = {
    config: runConfig,
    submit: opts.submit,
    headless: opts.headless,
    prompt: opts.prompt && Boolean(process.stdin.isTTY),
    codeWait: opts.codeWait,
    email: config.personal?.email || profile.candidate?.email || '',
    learned: readLearned(),
    education: existsSync(cvPath) ? parseCvEducation(readFileSync(cvPath, 'utf-8')) : null,
    facts: existsSync(cvPath) ? reviewFacts({
      cvText: readFileSync(cvPath, 'utf-8'),
      experience: parseCvExperience(readFileSync(cvPath, 'utf-8')),
      personal: config.personal ?? {},
      salary: String([].concat(config.work?.desired_salary ?? '1')[0]),
    }) : null,
    keepOpen: !opts.headless && !opts.submit,
    say: (msg) => console.log(msg),
    ask: (question) => (rl ? rl.question(question) : Promise.resolve('')),
  };
  ctx.refreshResolver = () => { ctx.resolve = createResolver({ config: runConfig, profile, learned: ctx.learned, employer: ctx.employer, education: ctx.education }); };

  const { chromium } = await import('playwright');
  const browser = await chromium.launch(freshLaunchOptions({ headless: opts.headless }));
  const summary = [];
  // Asking in the terminal needs one job at a time; otherwise several boards run side by side.
  const parallel = ctx.prompt || ctx.keepOpen ? 1 : (opts.parallel ?? 3);
  if (parallel > 1) console.log(`running ${parallel} jobs at a time`);
  const processJob = async (job) => {
    const slug = boardSlug(job.url);
    const say = parallel > 1 ? (msg) => console.log(`[${slug}] ${String(msg).trimStart()}`) : (msg) => console.log(msg);
    say(parallel > 1 ? `▶ ${job.url}` : `\n▶ ${job.url}`);
    if (!opts.force && alreadySubmitted(job.url)) {
      say('  already submitted (data/auto-apply/log.jsonl) — skipping; --force to redo');
      summary.push({ url: job.url, status: 'skipped_duplicate' });
      return;
    }
    const jctx = {
      ...ctx,
      say,
      vendor: atsVendorOf(job.url),
      slug,
      employer: job.company || slug,
      pdfPath: job.pdfPath,
      uploadName: resumeFileName(prefix, job.role),
      prefix,
      role: job.role,
      // Resume only: the candidate does not send cover letters (2026-10-25).
      coverPath: null,
    };
    jctx.refreshResolver = () => { jctx.resolve = createResolver({ config: runConfig, profile, learned: jctx.learned, employer: jctx.employer, education: jctx.education }); };
    jctx.refreshResolver();
    const result = await runAtsJob(browser, job, jctx);
    const via = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby' }[jctx.vendor];
    if (result.status === 'submitted' && job.report) result.tracker = markApplied(job.report, result.screenshot, via);
    if (result.status === 'closed' && job.report) result.tracker = markClosed(job.report);
    logResult({ url: job.url, report: job.report ?? null, pdf: job.pdfPath, vendor: jctx.vendor, ...result });
    summary.push({ url: job.url, ...result });
    say(`  → ${result.status}${result.questions ? `: ${result.questions.join(' · ')}` : ''}${result.errors?.length ? `: ${result.errors.join(' · ')}` : ''}`);
    if (result.tracker) say(`  ${result.tracker}`);
  };
  try {
    const queue = [...opts.jobs];
    await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, async () => {
      while (queue.length) await processJob(queue.shift());
    }));
  } finally {
    rl?.close();
    if (!ctx.keepOpen) await browser.close().catch(() => {});
  }

  console.log('\nSummary');
  for (const s of summary) console.log(`  ${s.status.padEnd(18)} ${s.url}`);
  if (summary.some((s) => s.status === 'needs_input')) console.log('\nAdd answers for the questions above to config/auto-apply.yml → questions: (or --answers FILE), then rerun.');
  if (summary.some((s) => !['submitted', 'ready_for_review', 'already_applied', 'skipped_duplicate', 'closed'].includes(s.status))) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`auto-apply-ats: ${err.message}`);
    process.exitCode = 1;
  });
}
