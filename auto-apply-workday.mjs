#!/usr/bin/env node

/**
 * auto-apply-workday.mjs — fill (and optionally submit) Workday applications.
 *
 * Signs in to each Workday tenant with one shared login (or creates the
 * account with it), uploads the tailored CV PDF, answers every step from
 * config/auto-apply.yml + config/profile.yml, ticks the terms/consent boxes,
 * and walks the wizard to the Review page.
 *
 * By default it STOPS on the Review page and leaves the browser open so you
 * can read the application and press Submit yourself. Pass --submit to have
 * it click Submit. --submit is a flag for the user to pass on their own
 * command line; agents running career-ops modes never add it (AGENTS.md →
 * Ethical Use).
 *
 * Credentials come from the environment (.env in the data root):
 *   WORKDAY_EMAIL     login email (falls back to candidate.email in profile.yml)
 *   WORKDAY_PASSWORD  login password used on every tenant
 *
 * State under data/auto-apply/ (gitignored, user layer):
 *   log.jsonl              one line per attempt; used to skip jobs already submitted
 *   learned-answers.json   answers you typed for questions the config did not cover
 *   screenshots/           Review-page and confirmation screenshots
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { createInterface } from 'readline/promises';
import { fileURLToPath } from 'url';
import { loadYaml } from './lib/yaml-document.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';
import { resumeFileName } from './lib/daily-run.mjs';
import { getCareerOpsRoot, getProfilePath, resolveTrackerPath } from './path-resolver.mjs';
import { linkedReportNumbers, parseScore, parseTrackerRow, resolveColumns } from './tracker-parse.mjs';
import { freshLaunchOptions } from './apply-scope.mjs';
import { atsVendorOf } from './ats-vendor.mjs';
import {
  createResolver,
  isAgreementLabel,
  isOptInLabel,
  ALTERNATIVES,
  parseCvExperience,
  parseCvEducation,
  normalizeLabel,
  pickOption,
  workdayPasswordProblems,
} from './lib/workday-answers.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const STATE_DIR = join(DATA_ROOT, 'data', 'auto-apply');
const LOG_PATH = join(STATE_DIR, 'log.jsonl');
const LEARNED_PATH = join(STATE_DIR, 'learned-answers.json');
const SHOTS_DIR = join(STATE_DIR, 'screenshots');
const CONFIG_PATH = join(DATA_ROOT, 'config', 'auto-apply.yml');

const MAX_STEPS = 15;
const NAV_TIMEOUT = 45_000;

const USAGE = `Usage:
  node auto-apply-workday.mjs --url <workday job url> [--pdf output/cv.pdf | --report N] [options]
  node auto-apply-workday.mjs --batch jobs.txt [options]
  node auto-apply-workday.mjs --from-tracker [--limit N] [--min-score X] [options]

Fills a Workday application end to end and stops on the Review page.

  --url URL        Workday posting (myworkdayjobs.com / myworkdaysite.com)
  --pdf PATH       resume PDF to upload (inside output/)
  --report N       report number: links the tracker row and, without --pdf,
                   picks the newest tailored PDF for that report in output/
  --batch FILE     one job per line: <url> [pdf] [report=N]  (# comments ok)
  --from-tracker   every Evaluated Workday row in data/applications.md that
                   has a tailored PDF, newest first
  --limit N        with --from-tracker: at most N jobs this run
  --min-score X    with --from-tracker: skip rows scored below X (e.g. 4.0);
                   unscored (N/A) rows are not skipped
  --answers FILE   extra YAML list of {match, answer} rules for this run,
                   checked before config/auto-apply.yml (job-specific answers)
  --submit         click Submit on the Review page (default: stop and wait)
  --headless       run without a visible window (implies --no-prompt)
  --no-prompt      never ask in the terminal; a job with an unanswered
                   required question is skipped and logged as needs_input
  --force          apply even if the log says this URL was already submitted
  --dry-run        resolve jobs, PDFs and credentials, print the plan, exit
  --help, -h       show this message

Answers: config/auto-apply.yml (copy config/auto-apply.example.yml).
Login:   WORKDAY_EMAIL / WORKDAY_PASSWORD in .env.`;

// ── CLI ──────────────────────────────────────────────────────────────

export function parseCli(argv) {
  const opts = { jobs: [], submit: false, headless: false, prompt: true, force: false, dryRun: false, help: false, fromTracker: false, limit: null, minScore: null, answers: null };
  let url = null;
  let pdf = null;
  let report = null;
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
      case '--batch': batch = value(); break;
      case '--from-tracker': opts.fromTracker = true; break;
      case '--limit': opts.limit = Number(value()); break;
      case '--min-score': opts.minScore = Number(value()); break;
      case '--answers': opts.answers = value(); break;
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
  if (url) opts.jobs.push({ url, pdf, report });
  if (batch) opts.jobs.push(...parseBatchFile(readFileSync(resolve(DATA_ROOT, batch), 'utf-8')));
  if (opts.limit != null && !(Number.isInteger(opts.limit) && opts.limit > 0)) throw new Error('--limit must be a positive whole number');
  if (opts.minScore != null && Number.isNaN(opts.minScore)) throw new Error('--min-score must be a number');
  if (opts.jobs.length === 0 && !opts.fromTracker) throw new Error('give --url, --batch or --from-tracker');
  return opts;
}

export function parseBatchFile(text) {
  const jobs = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const job = { url: parts[0], pdf: null, report: null };
    for (const part of parts.slice(1)) {
      const m = /^report=(\d+)$/.exec(part);
      if (m) job.report = m[1];
      else job.pdf = part;
    }
    jobs.push(job);
  }
  return jobs;
}

// ── Inputs ───────────────────────────────────────────────────────────

async function loadEnv() {
  try {
    const { config } = await import('dotenv');
    config({ path: join(DATA_ROOT, '.env'), quiet: true });
    if (DATA_ROOT !== CODE_ROOT) config({ path: join(CODE_ROOT, '.env'), quiet: true });
  } catch {
    // dotenv is optional — fall back to process.env
  }
}

function readYamlFile(path, label) {
  if (!existsSync(path)) return {};
  try {
    const doc = loadYaml(readFileSync(path, 'utf-8')) ?? {};
    if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('expected a mapping');
    return doc;
  } catch (err) {
    throw new Error(`${label} is not valid YAML: ${err.message}`);
  }
}

function readLearned() {
  try {
    return JSON.parse(readFileSync(LEARNED_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveLearned(learned) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LEARNED_PATH, `${JSON.stringify(learned, null, 2)}\n`);
}

export function isWorkdayUrl(url) {
  return atsVendorOf(url) === 'workday';
}

/**
 * Tailored PDF for a report. data/pdf-index.tsv (written by generate-pdf.mjs)
 * is authoritative, since flat PDF names usually carry no report number; the
 * newest indexed row wins. Without an index hit, fall back to the newest
 * bundle cv/tailored/vNNN/cv.pdf or flat output/cv-*-NNN-*.pdf.
 */
export function findReportPdf(reportNum, outputDir = join(DATA_ROOT, 'output'), indexPath = join(DATA_ROOT, 'data', 'pdf-index.tsv')) {
  const num = Number(reportNum);
  if (existsSync(indexPath)) {
    const root = dirname(dirname(indexPath));
    const hits = readFileSync(indexPath, 'utf-8').split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split('\t'))
      .filter(([report, pdf, , , , kind]) => /^\d+$/.test(report ?? '') && Number(report) === num && pdf && !/-ats[-.]/.test(pdf) && (!kind || kind === 'cv'))
      .map(([, pdf]) => resolve(root, pdf))
      .filter((pdf) => existsSync(pdf));
    if (hits.length) return hits[hits.length - 1];
  }
  if (!existsSync(outputDir)) return null;
  const padded = String(reportNum).padStart(3, '0');
  const candidates = [];
  for (const name of readdirSync(outputDir)) {
    const full = join(outputDir, name);
    if (name.startsWith(`${padded}-`) && statSync(full).isDirectory()) {
      const tailored = join(full, 'cv', 'tailored');
      if (!existsSync(tailored)) continue;
      for (const version of readdirSync(tailored)) {
        const pdf = join(tailored, version, 'cv.pdf');
        if (existsSync(pdf)) candidates.push(pdf);
      }
    } else if (name.endsWith('.pdf') && new RegExp(`-${padded}-`).test(name) && !name.includes('-ats-')) {
      candidates.push(full);
    }
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function resolveJobPdf(job) {
  if (job.pdf) {
    const abs = resolve(DATA_ROOT, job.pdf);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`resume PDF not found: ${job.pdf}`);
    return abs;
  }
  if (job.report) {
    const found = findReportPdf(job.report);
    if (!found) throw new Error(`no tailored PDF found in output/ for report ${job.report} — generate it first or pass --pdf`);
    return found;
  }
  throw new Error('each job needs --pdf or --report');
}

// ── Tracker + blacklist ──────────────────────────────────────────────

const companyKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Rows of data/blacklist.md: | Company | Since | Scope | Reason |. */
export function parseBlacklist(text) {
  const rules = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const [company, , scope] = line.split('|').slice(1).map((c) => c.trim());
    if (!company || /^-+$/.test(company) || company.toLowerCase() === 'company') continue;
    rules.push({ company, scope: (scope || 'company').toLowerCase() });
  }
  return rules;
}

/** The rule that blocks this job, or null. The Workday tenant slug stands in for a missing company name. */
export function blacklistHit(rules, { company, url }) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { /* no host */ }
  const names = [companyKey(company), companyKey(host.split('.')[0])].filter(Boolean);
  for (const rule of rules) {
    if (rule.scope === 'domain') {
      const d = rule.company.toLowerCase().replace(/\.$/, '');
      if (host && (host === d || host.endsWith(`.${d}`))) return rule;
    } else if (names.includes(companyKey(rule.company))) {
      return rule;
    }
  }
  return null;
}

/**
 * Evaluated rows of the tracker whose URL passes `accept` (Workday by default), newest first.
 * io.reportUrl(num) → the report's **URL:** (or null); io.findPdf(num) → PDF path or null.
 */
export function selectTrackerJobs(trackerText, io, { minScore = null, accept = isWorkdayUrl } = {}) {
  const lines = String(trackerText ?? '').split(/\r?\n/);
  const colmap = resolveColumns(lines);
  const jobs = [];
  const skipped = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row || row.status.trim().toLowerCase() !== 'evaluated') continue;
    const report = linkedReportNumbers(row.report, row.notes)[0];
    const url = row.url || (report != null ? io.reportUrl(report) : null);
    const label = `#${row.num} ${row.company}`;
    if (!url || !accept(url)) continue;
    const score = /\d/.test(row.score) ? parseScore(row.score) : null;
    // Unscored rows (N/A) were prepared without a numeric evaluation; only a
    // real score below the bar skips a job.
    if (minScore != null && score != null && score < minScore) { skipped.push(`${label}: score ${row.score} < ${minScore}`); continue; }
    const pdf = report != null ? io.findPdf(report) : null;
    if (!pdf) { skipped.push(`${label}: no tailored PDF yet`); continue; }
    jobs.push({ url, pdf, report: report != null ? String(report) : null, company: row.company, role: row.role, date: row.date, num: row.num });
  }
  jobs.sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.num - a.num);
  return { jobs, skipped };
}

function reportUrl(num) {
  const dir = join(DATA_ROOT, 'reports');
  if (!existsSync(dir)) return null;
  const padded = String(num).padStart(3, '0');
  const file = readdirSync(dir).find((name) => name.startsWith(`${padded}-`) && name.endsWith('.md'));
  if (!file) return null;
  const m = /^\*\*URL:\*\*\s*<?(https?:\/\/[^\s>)]+)/m.exec(readFileSync(join(dir, file), 'utf-8'));
  return m ? m[1] : null;
}

/** Role per report number from the tracker, for jobs given by --url/--batch (upload file name). */
function trackerRoles() {
  const trackerPath = resolveTrackerPath(DATA_ROOT);
  if (!existsSync(trackerPath)) return new Map();
  const lines = readFileSync(trackerPath, 'utf-8').split(/\r?\n/);
  const colmap = resolveColumns(lines);
  const roles = new Map();
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    const report = row && linkedReportNumbers(row.report, row.notes)[0];
    if (report != null && row.role) roles.set(String(report), row.role);
  }
  return roles;
}

function trackerJobs(opts) {
  const trackerPath = resolveTrackerPath(DATA_ROOT);
  if (!existsSync(trackerPath)) throw new Error(`tracker not found: ${trackerPath}`);
  const { jobs, skipped } = selectTrackerJobs(readFileSync(trackerPath, 'utf-8'), { reportUrl, findPdf: (n) => findReportPdf(n) }, { minScore: opts.minScore });
  for (const s of skipped) console.log(`  skip ${s}`);
  return opts.limit ? jobs.slice(0, opts.limit) : jobs;
}

function credentials(profile, config) {
  const email = (process.env.WORKDAY_EMAIL || config.account?.email || profile.candidate?.email || '').trim();
  const password = process.env.WORKDAY_PASSWORD || '';
  if (!email) throw new Error('set WORKDAY_EMAIL in .env (or candidate.email in config/profile.yml)');
  if (!password) throw new Error('set WORKDAY_PASSWORD in .env');
  return { email, password };
}

// ── Log ──────────────────────────────────────────────────────────────

function urlKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/(apply|login)(\/.*)?$/i, '').replace(/\/$/, '')}`;
  } catch {
    return url;
  }
}

function alreadySubmitted(url) {
  if (!existsSync(LOG_PATH)) return false;
  const key = urlKey(url);
  return readFileSync(LOG_PATH, 'utf-8').split('\n').some((line) => {
    try {
      const entry = JSON.parse(line);
      return entry.status === 'submitted' && urlKey(entry.url) === key;
    } catch {
      return false;
    }
  });
}

function logResult(entry) {
  mkdirSync(STATE_DIR, { recursive: true });
  appendFileSync(LOG_PATH, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

async function screenshot(page, url, tag) {
  mkdirSync(SHOTS_DIR, { recursive: true });
  const host = (() => { try { return new URL(url).hostname.split('.')[0]; } catch { return 'job'; } })();
  const file = join(SHOTS_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${host}-${tag}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  // The page markup beside the picture, so a new tenant layout can be diagnosed without re-running.
  if (tag !== 'review' && tag !== 'submitted') {
    const html = await page.content().catch(() => '');
    if (html) writeFileSync(file.replace(/\.png$/, '.html'), html);
  }
  return file;
}

// ── Page helpers ─────────────────────────────────────────────────────

const pause = (min = 150, max = 450) => new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));

const aid = (id) => `[data-automation-id="${id}"]`;

async function visible(locator) {
  return locator.first().isVisible().catch(() => false);
}

/** Workday lays a transparent click_filter div over its buttons; force-click lands on it as a real user would. */
async function clickAid(page, ids) {
  for (const id of [].concat(ids)) {
    const loc = page.locator(aid(id)).first();
    if (await visible(loc)) {
      await loc.click({ force: true });
      return true;
    }
  }
  return false;
}

async function settle(page) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  // Cookie banners hide the step's buttons on some tenants.
  const cookies = page.locator(aid('legalNoticeAcceptButton')).first();
  if (await cookies.isVisible().catch(() => false)) await cookies.click({ force: true }).catch(() => {});
  // Workday shows applyFlowLoadingPage (or a spinner) while a step loads; real tenants take 10s+.
  for (const id of ['applyFlowLoadingPage', 'loadingSpinner']) {
    await page.locator(aid(id)).first().waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  }
  await pause(600, 1000);
}

async function pageText(page) {
  return page.locator('body').innerText().catch(() => '');
}

const CONFIRM_RE = /application (has been |was )?(successfully )?submitted|thank you for (applying|your application|your interest)|successfully applied/i;
const ALREADY_RE = /you('ve| have) already applied|already submitted an application/i;
const WORKDAY_GLITCH_RE = /something went wrong[\s\S]{0,80}refresh the page/i;
const CLOSED_RE = /page you are looking for (doesn['’]?t|does not) exist|job (posting )?(is )?no longer (available|accepting)|this (job|position|posting|requisition) (has been |is )?(closed|filled|removed|expired)|no longer accepting applications/i;
const VERIFY_RE = /verify your (email|account)|verification (email|link)|check your (email|inbox)|activate your account/i;
const AUTH_ERROR_RE = /wrong email|incorrect|invalid (email|password|credentials)|doesn'?t match|not (found|recognized)|account (is )?locked|no account/i;

async function errorTexts(page) {
  const texts = await page.locator(`${aid('errorMessage')}, ${aid('errorBanner')}, [role="alert"]`).allInnerTexts().catch(() => []);
  // Fields Workday marks invalid, by their question label, so a stuck step says what blocked it.
  const invalid = await page.evaluate(() => [...document.querySelectorAll('[aria-invalid="true"]')]
    .map((el) => el.closest('[data-automation-id^="formField-"]')?.querySelector('label, legend')?.innerText?.replace(/\s+/g, ' ').trim() || el.getAttribute('aria-label') || el.id)
    .filter(Boolean)).catch(() => []);
  const nextDisabled = await page.locator(`${aid('bottom-navigation-next-button')}, ${aid('pageFooterNextButton')}`).first()
    .evaluate((el) => el.disabled || el.getAttribute('aria-disabled') === 'true').catch(() => false);
  return [...new Set([...texts.map((t) => t.trim()).filter(Boolean), ...invalid.map((l) => `invalid: ${l}`), ...(nextDisabled ? ['Next button disabled'] : [])])];
}

async function onAuthStep(page) {
  if (await visible(page.locator(`${aid('signInContent')}, input${aid('password')}`))) return true;
  const active = await page.locator(aid('progressBarActiveStep')).first().innerText().catch(() => '');
  return /sign\s*in|create account/i.test(active);
}

/** Past the sign-in step: the wizard is showing a real application step. */
async function onApplicationStep(page) {
  if (await onAuthStep(page)) return false;
  return (await visible(page.locator(aid('progressBar')))) || (await visible(page.locator(`${aid('bottom-navigation-next-button')}, ${aid('pageFooterNextButton')}`)));
}

/** Wait until the page shows either a sign-in/create-account form or an application step. */
async function waitForAuthOrStep(page, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await visible(page.locator(`input${aid('password')}, ${aid('SignInWithEmailButton')}`))) return 'auth';
    if (await onApplicationStep(page)) return 'step';
    await pause(500, 700);
  }
  return 'timeout';
}

// ── Start + authenticate ─────────────────────────────────────────────

async function startApplication(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await settle(page);
  const landing = await pageText(page);
  if (ALREADY_RE.test(landing)) return 'already_applied';
  if (CLOSED_RE.test(landing)) return 'closed';
  if (!(await onApplicationStep(page)) && !(await visible(page.locator(`${aid('email')}, ${aid('signInSubmitButton')}`)))) {
    // A saved draft turns "Apply" into "Continue Application".
    const clicked = (await clickAid(page, ['adventureButton', 'continueButton']))
      || (await page.getByRole('button', { name: /^(apply( now)?|continue application)$/i }).first().click({ timeout: 5000 }).then(() => true, () => false))
      || (await page.getByRole('link', { name: /^apply( now)?$/i }).first().click({ timeout: 5000 }).then(() => true, () => false));
    if (!clicked) {
      if (CLOSED_RE.test(await pageText(page))) return 'closed';
      throw new Error('could not find the Apply button — is the posting still open?');
    }
    await settle(page);
  }
  // "Start Your Application" modal.
  await clickAid(page, ['applyManually', 'useMyLastApplication', 'autofillWithResume']);
  await settle(page);
  if (ALREADY_RE.test(await pageText(page))) return 'already_applied';
  return 'started';
}

/** Type like a person: some tenants (KION) ignore values set without key events and never send the login. */
async function typeInto(locator, value) {
  await locator.click({ force: true });
  await locator.fill('');
  await locator.pressSequentially(value, { delay: 35 });
  await locator.press('Tab').catch(() => {});
  if ((await locator.inputValue().catch(() => value)) !== value) await locator.fill(value);
}

async function fillCredentials(page, creds, { confirm = false } = {}) {
  await typeInto(page.locator(`input${aid('email')}`).first(), creds.email);
  await pause();
  await typeInto(page.locator(`input${aid('password')}`).first(), creds.password);
  if (confirm) {
    await pause();
    await typeInto(page.locator(`input${aid('verifyPassword')}`).first(), creds.password);
  }
  await pause();
}

async function waitAuthOutcome(page) {
  // Real tenants can take 20s+ to load the first step after sign-in.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await onApplicationStep(page)) return 'ok';
    // Some tenants (KION) answer a new account by sending you to a stand-alone sign-in page.
    if (await visible(page.locator(aid('SignInWithEmailButton'))) && !(await visible(page.locator(`input${aid('password')}`)))) return 'signin';
    const text = await pageText(page);
    if (VERIFY_RE.test(text)) return 'verify';
    const authErrors = await page.locator(`${aid('errorMessage')}, ${aid('errorBanner')}`).allInnerTexts().catch(() => []);
    if (authErrors.some((t) => t.trim()) || (await onAuthStep(page) && AUTH_ERROR_RE.test(text))) return 'error';
    await pause(700, 1000);
  }
  return (await onApplicationStep(page)) ? 'ok' : 'timeout';
}

/** After an auth attempt that did not report ok, let the page finish loading and look again. */
async function signedInAfterAll(page) {
  await settle(page);
  return (await waitForAuthOrStep(page, 20_000)) === 'step';
}

/** Tenants with Apple/Google/LinkedIn sign-in hide the email form behind "Sign in with email". */
async function revealEmailForm(page) {
  if (await clickAid(page, 'SignInWithEmailButton')) {
    await page.locator(`input${aid('email')}`).first().waitFor({ timeout: 15_000 }).catch(() => {});
  }
}

async function signIn(page, creds) {
  await revealEmailForm(page);
  if (!(await visible(page.locator(aid('signInSubmitButton'))))) {
    await clickAid(page, ['signInLink', 'utilityButtonSignIn']);
    await settle(page);
    await page.locator(aid('signInSubmitButton')).first().waitFor({ timeout: 15_000 }).catch(() => {});
  }
  if (!(await visible(page.locator(`input${aid('password')}`)))) return 'no_form';
  await fillCredentials(page, creds);
  await clickAid(page, 'signInSubmitButton');
  return waitAuthOutcome(page);
}

async function createAccount(page, creds) {
  await revealEmailForm(page);
  if (!(await visible(page.locator(`input${aid('verifyPassword')}`)))) {
    await clickAid(page, ['createAccountLink']);
    await settle(page);
    await page.locator(`input${aid('verifyPassword')}`).first().waitFor({ timeout: 15_000 }).catch(() => {});
  }
  if (!(await visible(page.locator(`input${aid('verifyPassword')}`)))) return 'no_form';
  await fillCredentials(page, creds, { confirm: true });
  const terms = page.locator(`input${aid('createAccountCheckbox')}`).first();
  if (await terms.count()) await tick(terms).catch(() => {});
  await clickAid(page, 'createAccountSubmitButton');
  return waitAuthOutcome(page);
}

async function authenticate(page, creds, ctx) {
  if ((await waitForAuthOrStep(page)) === 'step') return;
  let outcome = await signIn(page, creds);
  if (outcome === 'ok' || await signedInAfterAll(page)) return;
  ctx.say(`  sign-in ${outcome}; creating an account on this tenant`);
  outcome = await createAccount(page, creds);
  if (outcome === 'ok') return;
  if (outcome === 'signin') {
    ctx.say('  account created; signing in');
    outcome = await signIn(page, creds);
    if (outcome === 'ok') return;
    // Signed in on the stand-alone page: it may land on the candidate home, so reopen the job.
    if (outcome !== 'error' && ctx.reopen) {
      await ctx.reopen();
      const where = await waitForAuthOrStep(page);
      if (where === 'step') return;
      if (where === 'auth' && (await signIn(page, creds)) === 'ok') return;
    }
  }
  if (await signedInAfterAll(page)) return;
  if (outcome === 'verify') {
    if (!ctx.prompt) throw Object.assign(new Error('this tenant wants the new account verified by email'), { status: 'needs_verification' });
    await ctx.ask(`  Workday sent a verification email to ${creds.email}. Click the link, then press Enter here… `);
    await signIn(page, creds);
    if (await onApplicationStep(page)) return;
  }
  const errors = await errorTexts(page);
  throw Object.assign(new Error(`could not sign in or create an account (${errors.join(' | ') || outcome})`), { status: 'auth_failed' });
}

// ── Form scanning ────────────────────────────────────────────────────

/**
 * Tag every visible question container with data-ca-field and describe it.
 * Runs in the page. Workday wraps each question in data-automation-id="formField-*";
 * EEO pages sometimes use bare fieldsets, so those count too.
 */
function scanFieldsInPage() {
  const isVisible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const text = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const labelFor = (input) => {
    if (input.id) {
      const l = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (l) return text(l);
    }
    const wrap = input.closest('label');
    if (wrap) return text(wrap);
    return input.getAttribute('aria-label') || text(input.parentElement);
  };
  // Clear tags from an earlier scan: after a re-render two containers could carry one index.
  for (const old of document.querySelectorAll('[data-ca-field]')) old.removeAttribute('data-ca-field');
  // Work-experience entries belong to fillWorkExperience; a job's "Location" is not the candidate's.
  const WORK_FIELDS = new Set(['formField-jobTitle', 'formField-companyName', 'formField-location', 'formField-roleDescription', 'formField-startDate', 'formField-endDate', 'formField-currentlyWorkHere']);
  const all = [...document.querySelectorAll('[data-automation-id^="formField-"], fieldset')].filter(isVisible)
    .filter((el) => !WORK_FIELDS.has(el.getAttribute('data-automation-id')));
  const containers = all.filter((el) => {
    if (el.tagName === 'FIELDSET') {
      return !el.closest('[data-automation-id^="formField-"]') && !el.querySelector('[data-automation-id^="formField-"]');
    }
    return !el.parentElement.closest('[data-automation-id^="formField-"]');
  });
  return containers.map((el, idx) => {
    el.setAttribute('data-ca-field', String(idx));
    const labelEl = el.querySelector('[data-automation-id="formLabel"], legend') || el.querySelector('label');
    let label = text(labelEl);
    const required = /\*/.test(label) || !!el.querySelector('[aria-required="true"], [required]');
    label = label.replace(/\*/g, '').trim();
    const field = { idx, label, required, kind: 'unknown', value: '', options: [], error: text(el.querySelector('[data-automation-id="errorMessage"], [role="alert"]')) };

    const radios = [...el.querySelectorAll('input[type="radio"]')];
    const boxes = [...el.querySelectorAll('input[type="checkbox"]')];
    const listboxBtn = el.querySelector('button[aria-haspopup="listbox"]');
    const prompt = el.querySelector('[data-automation-id="multiselectInputContainer"], input[data-uxi-widget-type="selectinput"], [data-automation-id="promptIcon"]');
    const month = el.querySelector('[data-automation-id="dateSectionMonth-input"]');
    const select = el.querySelector('select');
    const area = el.querySelector('textarea');
    const input = el.querySelector('input:not([type="hidden"]):not([type="radio"]):not([type="checkbox"]):not([type="file"])');

    if (el.querySelector('input[type="file"]')) field.kind = 'file';
    else if (radios.length) {
      field.kind = 'radio';
      field.options = radios.map(labelFor);
      const checked = radios.find((r) => r.checked);
      field.value = checked ? labelFor(checked) : '';
    } else if (boxes.length > 1) {
      field.kind = 'checkboxes';
      field.options = boxes.map(labelFor);
      field.value = boxes.filter((b) => b.checked).map(labelFor).join(', ');
    } else if (boxes.length === 1) {
      field.kind = 'checkbox';
      const own = labelFor(boxes[0]);
      if (!label || label === own) label = own;
      else label = `${label} ${own}`;
      field.label = label;
      field.value = boxes[0].checked ? 'checked' : '';
    } else if (month) {
      field.kind = 'date';
      const part = (name) => el.querySelector(`[data-automation-id="dateSection${name}-input"]`)?.value || '';
      field.value = [part('Month'), part('Day'), part('Year')].filter(Boolean).join('/');
    } else if (listboxBtn) {
      field.kind = 'dropdown';
      const current = text(listboxBtn);
      field.value = /^(select one|select|choose)$/i.test(current) ? '' : current;
    } else if (prompt) {
      field.kind = 'prompt';
      field.value = [...el.querySelectorAll('[data-automation-id="selectedItem"], [data-automation-id="promptSelectionLabel"]')].map(text).join(', ');
    } else if (select) {
      field.kind = 'select';
      field.options = [...select.options].map((o) => o.text.trim());
      field.value = select.selectedIndex > 0 ? select.options[select.selectedIndex].text.trim() : '';
    } else if (area) {
      field.kind = 'textarea';
      field.value = area.value;
    } else if (input) {
      field.kind = 'text';
      field.value = input.value;
      if (!field.label) field.label = input.getAttribute('aria-label') || input.placeholder || '';
    }
    return field;
  });
}

// ── Widget drivers ───────────────────────────────────────────────────

async function visibleOptions(page) {
  const loc = page.locator('[role="listbox"]:not([data-automation-id="selectedItemList"]) [role="option"]:visible, [data-automation-id="promptOption"]:visible');
  const texts = (await loc.allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, ' ').trim());
  return { loc, texts };
}

async function fillDropdown(page, box, answer) {
  const button = box.locator('button[aria-haspopup="listbox"]').first();
  // Selected-value chips of prompt widgets ("United States of America (+1)") are also role=listbox: ignore them.
  const LIST = '[role="listbox"]:not([data-automation-id="selectedItemList"])';
  const OPTION = `${LIST} [role="option"]:visible`;
  const listOpen = () => page.locator(OPTION).count().then((n) => n > 0, () => false);
  // The previous dropdown's list can still be on screen while it closes; wait it out first.
  const anyList = page.locator(`${LIST}:visible`);
  if (await anyList.count()) {
    await page.keyboard.press('Escape').catch(() => {});
    await anyList.first().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
  }
  // A click can toggle a half-open list shut; make sure this one is open before reading it.
  for (let attempt = 0; attempt < 3 && !(await listOpen()); attempt++) {
    await button.click({ timeout: 8000 }).catch(() => button.click({ force: true }).catch(() => {}));
    await pause(300, 600);
  }
  const choices = String(answer).split(ALTERNATIVES).map((c) => c.trim()).filter(Boolean);
  const read = async () => {
    const loc = page.locator(OPTION);
    return { loc, texts: (await loc.allInnerTexts().catch(() => [])).map((t) => t.replace(/\s+/g, ' ').trim()) };
  };
  const pick = (texts) => {
    for (const c of choices) {
      const i = pickOption(c, texts);
      if (i !== -1) return i;
    }
    return -1;
  };
  let { loc, texts } = await read();
  let i = pick(texts);
  const seen = new Set(texts);
  // Long lists may render only the options near the current value: scroll through the rest.
  const list = page.locator(`${LIST}:visible`).last();
  for (let top = 0; i === -1 && (await list.count()); top += 250) {
    const more = await list.evaluate((el, y) => {
      let s = el;
      while (s && s.scrollHeight <= s.clientHeight) s = s.parentElement;
      if (!s) return false;
      s.scrollTop = y;
      return s.scrollTop + s.clientHeight < s.scrollHeight;
    }, top).catch(() => false);
    await pause(150, 250);
    ({ loc, texts } = await read());
    texts.forEach((t) => seen.add(t));
    i = pick(texts);
    if (!more) break;
  }
  if (i === -1) {
    await page.keyboard.press('Escape');
    return { ok: false, options: [...seen] };
  }
  // Click by text, not position: the list can re-render between reading and clicking,
  // so look the option up again by its visible text right before the click.
  const want = texts[i];
  try {
    const now = await read();
    const j = now.texts.indexOf(want);
    if (j === -1) throw new Error('option moved');
    const target = now.loc.nth(j);
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: 8000 });
  } catch {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, options: [...seen] };
  }
  await anyList.first().waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
  // Verify the dropdown shows what was meant (its label may carry extra text around it).
  const shown = normalizeLabel(await button.innerText().catch(() => ''));
  if (shown && !shown.includes(normalizeLabel(want))) return { ok: false, options: [...seen], error: `picked "${shown}" instead of "${want}"` };
  return { ok: true, chose: want };
}

/** True once a prompt widget really holds a value ("1 item selected", a pill, or a non-empty selection label). */
async function promptHasSelection(box) {
  const aria = await box.locator(aid('promptAriaInstruction')).first().innerText().catch(() => '');
  if (/\b([1-9]\d*) items? selected/i.test(aria)) return true;
  if (await box.locator(aid('selectedItem')).count()) return true;
  const label = await box.locator(aid('promptSelectionLabel')).first().innerText().catch(() => '');
  return Boolean(label.trim());
}

/** Workday "prompt" widgets (How did you hear, Country phone code…): search, pick, descend at most 3 levels. */
async function fillPrompt(page, box, answer) {
  const input = box.locator('input').first();
  await input.click();
  await input.fill(answer);
  await page.keyboard.press('Enter');
  await pause(700, 1000);
  let { loc, texts } = await visibleOptions(page);
  if (texts.length === 0) {
    await input.fill('');
    await input.click();
    await pause(500, 800);
    ({ loc, texts } = await visibleOptions(page));
  }
  for (let depth = 0; depth < 3 && texts.length; depth++) {
    const i = pickOption(answer, texts);
    const pick = i === -1 && depth > 0 && texts.length === 1 ? 0 : i;
    if (pick === -1) {
      await page.keyboard.press('Escape');
      return { ok: false, options: texts };
    }
    const chose = texts[pick];
    await loc.nth(pick).click();
    await pause(700, 1000);
    if (await promptHasSelection(box)) {
      await page.keyboard.press('Escape').catch(() => {});
      return { ok: true, chose };
    }
    ({ loc, texts } = await visibleOptions(page));
  }
  await page.keyboard.press('Escape').catch(() => {});
  return { ok: false, options: texts };
}

async function fillRadio(box, answer, options) {
  const i = pickOption(answer, options);
  if (i === -1) return { ok: false, options };
  await tick(box.locator('input[type="radio"]').nth(i));
  return { ok: true, chose: options[i] };
}

async function fillCheckboxes(box, answer, options) {
  const i = pickOption(answer, options);
  if (i === -1) return { ok: false, options };
  await tick(box.locator('input[type="checkbox"]').nth(i));
  return { ok: true, chose: options[i] };
}

function parseDate(answer) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(answer).trim());
  if (!m) return null;
  return { mm: m[1].padStart(2, '0'), dd: m[2].padStart(2, '0'), yyyy: m[3] };
}

async function fillDate(box, answer) {
  const d = parseDate(answer);
  if (!d) return { ok: false };
  const hasDay = await box.locator(`input${aid('dateSectionDay-input')}`).count();
  await typeDateDigits(box, hasDay ? `${d.mm}${d.dd}${d.yyyy}` : `${d.mm}${d.yyyy}`);
  return { ok: true, chose: answer };
}

async function fillText(page, box, kind, answer) {
  const loc = box.locator(kind === 'textarea' ? 'textarea' : 'input:not([type="hidden"])').first();
  await loc.fill(answer);
  await page.keyboard.press('Tab').catch(() => {});
  return { ok: true, chose: answer };
}

/** Tick a checkbox or radio. Some Workday boxes ignore .check(); click the box (then its label) instead. */
async function tick(locator) {
  try {
    await locator.check({ force: true });
    return;
  } catch {
    // fall through to clicking
  }
  await locator.click({ force: true }).catch(() => {});
  if (await locator.isChecked().catch(() => false)) return;
  const id = await locator.getAttribute('id').catch(() => null);
  if (id) await locator.page().locator(`label[for="${id}"]`).first().click({ force: true }).catch(() => {});
}

/** An answer may list fallbacks ("Career Site || Company Website || LinkedIn"); use the first one the form accepts. */
async function applyAnswer(page, field, answer) {
  const choices = String(answer).split(ALTERNATIVES).map((c) => c.trim()).filter(Boolean);
  if (choices.length <= 1 || ['text', 'textarea', 'date', 'checkbox'].includes(field.kind)) return applyOneAnswer(page, field, choices[0] ?? '');
  // A dropdown tries every acceptable answer against one open list.
  if (field.kind === 'dropdown') return applyOneAnswer(page, field, answer);
  let last = { ok: false };
  for (const choice of choices) {
    last = await applyOneAnswer(page, field, choice);
    if (last.ok) return last;
  }
  return last;
}

async function applyOneAnswer(page, field, answer) {
  const box = page.locator(`[data-ca-field="${field.idx}"]`);
  switch (field.kind) {
    case 'text': case 'textarea': return fillText(page, box, field.kind, answer);
    case 'dropdown': return fillDropdown(page, box, answer);
    case 'prompt': return fillPrompt(page, box, answer);
    case 'radio': return fillRadio(box, answer, field.options);
    case 'checkboxes': return fillCheckboxes(box, answer, field.options);
    case 'date': return fillDate(box, answer);
    case 'select': {
      const i = pickOption(answer, field.options);
      if (i === -1) return { ok: false, options: field.options };
      await box.locator('select').first().selectOption({ index: i });
      return { ok: true, chose: field.options[i] };
    }
    case 'checkbox': {
      if (/^(yes|true|checked|y)$/i.test(answer)) await tick(box.locator('input[type="checkbox"]').first());
      return { ok: true, chose: answer };
    }
    default: return { ok: false };
  }
}

// ── One wizard page ──────────────────────────────────────────────────

async function uploadResume(page, pdfPath, ctx) {
  const input = page.locator('input[type="file"]').first();
  if (!(await input.count())) return false;
  const already = await page.locator(`${aid('file-upload-item')}, ${aid('file-upload-successful')}`).count();
  if (already && ctx.uploaded) return false;
  // A saved draft keeps the resume from an earlier run; remove it so only the current tailored PDF is attached.
  for (let n = 0; n < 5; n++) {
    const del = page.locator(`${aid('file-upload-item')} ${aid('delete-file')}`).first();
    if (!(await del.isVisible().catch(() => false))) break;
    await del.click({ force: true });
    await pause(800, 1200);
    ctx.say('  removed a previously attached file');
  }
  // Upload under the candidate's own name ("EbaadG-Program Manager.pdf"), which recruiters see, not the internal output name.
  const name = ctx.uploadName || basename(pdfPath);
  await input.setInputFiles({ name, mimeType: 'application/pdf', buffer: readFileSync(pdfPath) });
  ctx.uploaded = true;
  ctx.say(`  uploaded ${pdfPath.replace(`${DATA_ROOT}/`, '')}`);
  await page.locator(`${aid('file-upload-successful')}, ${aid('file-upload-item')}`).first().waitFor({ timeout: 30_000 }).catch(() => {});
  await settle(page);
  return true;
}

async function askUser(field, ctx) {
  const opts = field.options?.length ? `\n    options: ${field.options.join(' | ')}` : '';
  const answer = (await ctx.ask(`  ? "${field.label}"${opts}\n    your answer (blank = skip this job): `)).trim();
  return answer;
}

// ── Work experience (from cv.md) ─────────────────────────────────────

const WX = {
  title: '[data-automation-id="formField-jobTitle"] input, input[id$="--jobTitle"]',
  company: '[data-automation-id="formField-companyName"] input, input[id$="--companyName"]',
  current: '[data-automation-id="formField-currentlyWorkHere"] input[type="checkbox"], input[type="checkbox"][id$="--currentlyWorkHere"]',
  location: '[data-automation-id="formField-location"] input, input[id$="--location"]',
  description: '[data-automation-id="formField-roleDescription"] textarea, textarea[id$="--roleDescription"]',
  start: '[data-automation-id="formField-startDate"]',
  end: '[data-automation-id="formField-endDate"]',
};

/**
 * Type into one Workday date section. The real <input> sits under a visible
 * "MM"/"DD"/"YYYY" display div, so focus it by clicking the display (or the
 * input itself with force) and type on the keyboard.
 */
async function typeDateSection(scope, section, value) {
  const input = scope.locator(`input${aid(`dateSection${section}-input`)}`).first();
  if (!(await input.count())) return false;
  const display = scope.locator(aid(`dateSection${section}-display`)).first();
  if (await display.count()) await display.click({ force: true }).catch(() => {});
  else await input.click({ force: true }).catch(() => {});
  await input.focus().catch(() => {});
  await input.page().keyboard.type(value, { delay: 60 });
  return true;
}

/**
 * Type a whole Workday date in one go: focus the first section and type every
 * digit, letting Workday advance month → day → year itself. Clicking into each
 * section separately scrambled the digits on a live tenant (10/25/2026 → 02/02/2006).
 */
async function typeDateDigits(scope, digits) {
  if (!(await scope.locator(`input${aid('dateSectionMonth-input')}`).count())) return false;
  const page = scope.page();
  await typeDateSection(scope, 'Month', '');
  await page.keyboard.type(digits, { delay: 90 });
  await page.keyboard.press('Tab').catch(() => {});
  return true;
}

async function typeMonthYear(scope, date) {
  if (!date) return false;
  const year = scope.locator(`input${aid('dateSectionYear-input')}`).first();
  if (!(await year.count())) return false;
  if ((await year.inputValue().catch(() => '')).trim()) return true;
  return typeDateDigits(scope, `${date.mm}${date.yyyy}`);
}

/** City for a past job from config work_history.locations ("Company | Title" first, then "Company"). */
function jobLocation(config, job) {
  const map = config?.work_history?.locations ?? {};
  return String(map[`${job.company} | ${job.title}`] ?? map[job.company] ?? '').trim();
}

/**
 * Fill Workday's Work Experience section from cv.md: one entry per job,
 * newest first, adding entries with the section's Add button as needed.
 * Entries that already have a job title (Workday's resume parse) are left as they are.
 */
async function fillWorkExperience(page, ctx) {
  const jobs = ctx.experience ?? [];
  if (!jobs.length) return 0;
  const titleInputs = page.locator(WX.title);
  const addButton = page.getByRole('button', { name: /^\s*add( another)?\s*$/i });
  // The Add button that belongs to the Work Experience section.
  const sectionAdd = page.locator('xpath=//*[self::h2 or self::h3 or self::h4 or self::legend][normalize-space()="Work Experience"]/ancestor::*[.//button][1]//button')
    .filter({ hasText: /^\s*add( another)?\s*$/i }).first();
  const hasSection = (await titleInputs.count()) > 0 || (await sectionAdd.isVisible().catch(() => false));
  if (!hasSection) return 0;
  let filled = 0;
  for (let i = 0; i < jobs.length; i++) {
    if ((await titleInputs.count()) <= i) {
      const add = (await sectionAdd.isVisible().catch(() => false)) ? sectionAdd : addButton.last();
      if (!(await add.isVisible().catch(() => false))) break;
      await add.click({ force: true });
      await page.waitForFunction((n) => document.querySelectorAll('[data-automation-id="formField-jobTitle"] input, input[id$="--jobTitle"]').length > n, i, { timeout: 10_000 }).catch(() => {});
      await pause(500, 800);
      if ((await titleInputs.count()) <= i) break;
    }
    const titleInput = titleInputs.nth(i);
    // The entry is the nearest ancestor that holds exactly this one job-title field.
    const entry = titleInput.locator('xpath=ancestor::*[count(.//input[contains(@id,"--jobTitle")] | .//*[@data-automation-id="formField-jobTitle"]//input) = 1][last()]');
    const job = jobs[i];
    const fillIfEmpty = async (selector, value) => {
      const box = entry.locator(selector).first();
      if (!value || !(await box.count()) || (await box.inputValue().catch(() => '')).trim()) return false;
      await box.fill(value).catch(() => {});
      return true;
    };
    const description = job.bullets?.length ? job.bullets.map((b) => `• ${b}`).join('\n').slice(0, 2000) : '';
    if ((await titleInput.inputValue().catch(() => '')).trim()) {
      // An entry Workday or an earlier run filled: only complete its empty optional parts.
      const added = [await fillIfEmpty(WX.location, jobLocation(ctx.config, job)), await fillIfEmpty(WX.description, description)];
      if (added.some(Boolean)) ctx.say(`  work experience ${i + 1}: completed location/description`);
      continue;
    }
    await titleInput.fill(job.title);
    await entry.locator(WX.company).first().fill(job.company).catch(() => {});
    await fillIfEmpty(WX.location, jobLocation(ctx.config, job));
    await fillIfEmpty(WX.description, description);
    if (job.current) await tick(entry.locator(WX.current).first()).catch(() => {});
    await typeMonthYear(entry.locator(WX.start).first(), job.start);
    if (!job.current) await typeMonthYear(entry.locator(WX.end).first(), job.end);
    await page.keyboard.press('Tab').catch(() => {});
    filled++;
    ctx.say(`  work experience ${i + 1}: ${job.title}, ${job.company} (${job.start.mm}/${job.start.yyyy}–${job.current ? 'present' : `${job.end?.mm}/${job.end?.yyyy}`})`);
    await pause();
  }
  // Blank entries past the CV's jobs (left by an interrupted earlier attempt) block Next: delete them.
  for (let i = (await titleInputs.count()) - 1; i >= jobs.length; i--) {
    const entry = titleInputs.nth(i).locator('xpath=ancestor::*[count(.//input[contains(@id,"--jobTitle")] | .//*[@data-automation-id="formField-jobTitle"]//input) = 1][last()]');
    const empty = !(await titleInputs.nth(i).inputValue().catch(() => '')).trim() && !(await entry.locator(WX.company).first().inputValue().catch(() => '')).trim();
    if (!empty) continue;
    const del = entry.getByRole('button', { name: /delete/i }).first();
    if (await del.isVisible().catch(() => false)) {
      await del.click({ force: true });
      ctx.say(`  work experience ${i + 1}: removed empty entry`);
      await pause(500, 800);
    }
  }
  return filled;
}

/** Fill every question on the current step. Returns labels still unanswered and required. */
async function fillPage(page, ctx) {
  const unanswered = [];
  // Two passes: answering one question (country, "previous worker") often reveals others.
  for (let pass = 0; pass < 2; pass++) {
    const fields = await page.evaluate(scanFieldsInPage);
    for (const field of fields) {
      if (field.kind === 'file' || field.kind === 'unknown') continue;
      if (field.value && field.kind === 'date') {
        const mine = ctx.resolve(field.label);
        const d = mine?.answer ? parseDate(mine.answer) : null;
        const want = d ? [d.mm, d.dd, d.yyyy] : null;
        const have = field.value.split('/');
        if (!want || (have.length === 3 && have[0].padStart(2, '0') === want[0] && have[1].padStart(2, '0') === want[1] && have[2] === want[2])) continue;
        ctx.say(`  ! "${field.label.slice(0, 50)}" was ${field.value}, correcting`);
      } else if (field.value && field.kind !== 'checkbox') {
        // Keep a value Workday or an earlier run filled, unless it contradicts our answer (a draft can hold a wrong pick).
        const mine = ['dropdown', 'radio', 'select'].includes(field.kind) ? ctx.resolve(field.label) : null;
        const wanted = mine?.answer ? mine.answer.split(ALTERNATIVES) : [];
        if (!wanted.length || wanted.some((w) => pickOption(w, [field.value]) !== -1)) continue;
        ctx.say(`  ! "${field.label.slice(0, 50)}" was "${field.value}", correcting`);
      } else if (field.value) continue;
      if (field.kind === 'checkbox') {
        const resolved = ctx.resolve(field.label);
        if ((ctx.config.behavior?.accept_agreements !== false && isAgreementLabel(field.label)) || /^(yes|true)$/i.test(resolved?.answer ?? '')) {
          await tick(page.locator(`[data-ca-field="${field.idx}"] input[type="checkbox"]`).first());
          ctx.say(`  ✓ ${field.label.slice(0, 80)}`);
          await pause();
        }
        continue;
      }
      // Self-ID pages label groups generically ("Please check one of the boxes
      // below"); the option texts are what say the question is about disability.
      const resolved = ctx.resolve(field.label)
        ?? (field.options.length ? ctx.resolve(`${field.label} ${field.options.join(' ')}`) : null);
      if (resolved?.source === 'skip' && !(field.required && !field.value)) continue;
      if (!resolved || resolved.source === 'skip') {
        if (field.required && pass === 1) unanswered.push(field);
        continue;
      }
      const result = await applyAnswer(page, field, resolved.answer);
      if (result.ok) ctx.say(`  ${field.label.slice(0, 60)} → ${String(result.chose).slice(0, 60)}`);
      else if (field.required && pass === 1) unanswered.push({ ...field, options: result.options ?? field.options, tried: resolved.answer });
      else if (!result.ok) ctx.say(`  ! no option matched "${resolved.answer}" for "${field.label.slice(0, 60)}"`);
      await pause();
    }
  }

  const stillOpen = [];
  for (const field of unanswered) {
    if (field.kind === 'dropdown') {
      // Read the real choices: shown before asking, and logged when nobody can be asked.
      const box = page.locator(`[data-ca-field="${field.idx}"]`);
      await box.locator('button[aria-haspopup="listbox"]').first().click().catch(() => {});
      await pause(300, 500);
      field.options = (await visibleOptions(page)).texts;
      await page.keyboard.press('Escape').catch(() => {});
    }
    if (!ctx.prompt) {
      const opts = (field.options ?? []).filter(Boolean);
      stillOpen.push(opts.length ? `${field.label} [options: ${opts.slice(0, 80).join(' / ')}]` : field.label);
      continue;
    }
    const answer = await askUser(field, ctx);
    if (!answer) {
      stillOpen.push(field.label);
      continue;
    }
    const result = await applyAnswer(page, field, answer);
    if (result.ok) {
      ctx.learned[field.label] = answer;
      saveLearned(ctx.learned);
      ctx.refreshResolver();
    } else {
      stillOpen.push(field.label);
    }
  }
  return stillOpen;
}

/** Untick any SMS / marketing / job-alert / preferred-name box, whatever ticked it. Runs before every Save and Submit. */
async function clearOptIns(page, ctx) {
  const boxes = page.locator('input[type="checkbox"]:checked');
  const n = await boxes.count();
  for (let i = n - 1; i >= 0; i--) {
    const box = boxes.nth(i);
    const label = await box.evaluate((el) => {
      const own = (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el.closest('label');
      const field = el.closest('[data-automation-id^="formField-"]');
      return [field?.querySelector('[data-automation-id="formLabel"], legend')?.innerText, own?.innerText, el.getAttribute('aria-label')].filter(Boolean).join(' ');
    }).catch(() => '');
    if (label && isOptInLabel(label)) {
      await box.uncheck({ force: true }).catch(() => box.click({ force: true }).catch(() => {}));
      ctx.say(`  ✗ unticked opt-in: ${label.replace(/\s+/g, ' ').slice(0, 70)}`);
    }
  }
}

async function findSubmit(page) {
  for (const id of ['bottom-navigation-next-button', 'pageFooterNextButton']) {
    const loc = page.locator(aid(id)).first();
    if (await visible(loc) && /submit/i.test(await loc.innerText().catch(() => ''))) return loc;
  }
  const byRole = page.getByRole('button', { name: /^submit( application)?$/i }).first();
  return (await visible(byRole)) ? byRole : null;
}

async function nextDisabled(page) {
  return page.locator(`${aid('pageFooterNextButton')}, ${aid('bottom-navigation-next-button')}`).first()
    .evaluate((el) => el.disabled || el.getAttribute('aria-disabled') === 'true').catch(() => false);
}

/** A reopened draft can keep Save disabled until a field is edited: retype one filled text box. */
async function enableNext(page) {
  for (let t = 0; t < 10 && (await nextDisabled(page)); t++) await pause(800, 1000);
  if (!(await nextDisabled(page))) return;
  const boxes = page.locator('[data-automation-id^="formField-"] input[type="text"]:visible');
  for (let i = 0; i < Math.min(await boxes.count(), 5); i++) {
    const box = boxes.nth(i);
    const value = await box.inputValue().catch(() => '');
    if (!value) continue;
    await box.click({ force: true }).catch(() => {});
    await box.fill('').catch(() => {});
    await box.pressSequentially(value, { delay: 30 }).catch(() => {});
    await box.press('Tab').catch(() => {});
    await pause(800, 1200);
    if (!(await nextDisabled(page))) return;
  }
}

async function clickNext(page) {
  await enableNext(page);
  if (await clickAid(page, ['pageFooterNextButton', 'bottom-navigation-next-button'])) return true;
  const btn = page.getByRole('button', { name: /^(save and continue|next|continue)$/i }).first();
  if (await visible(btn)) {
    await btn.click({ force: true });
    return true;
  }
  return false;
}

async function stepName(page) {
  const active = page.locator(`${aid('progressBarActiveStep')}, [aria-current="step"]`).first();
  const name = (await active.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  if (name) return name;
  return (await page.locator('h2').first().innerText().catch(() => '')).trim();
}

// ── One job ──────────────────────────────────────────────────────────

async function runJob(browser, job, ctx) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 940 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  ctx.uploaded = false;
  ctx.uploadName = job.role ? resumeFileName(ctx.config.daily?.resume_prefix ?? '', job.role) : null;
  const keepOpen = () => !ctx.headless && ctx.prompt;
  try {
    const started = await startApplication(page, job.url);
    if (started === 'already_applied') return { status: 'already_applied' };
    if (started === 'closed') return { status: 'closed', screenshot: await screenshot(page, job.url, 'closed') };
    ctx.reopen = () => startApplication(page, job.url);
    await authenticate(page, ctx.creds, ctx);
    await settle(page);

    let lastStep = '';
    let repeats = 0;
    let refreshes = 0;
    for (let i = 0; i < MAX_STEPS; i++) {
      const text = await pageText(page);
      if (CONFIRM_RE.test(text)) return { status: 'submitted', screenshot: await screenshot(page, job.url, 'submitted') };
      // Workday's own "Something went wrong — please refresh the page": it keeps
      // each saved step, so a reload resumes where the application left off.
      if (WORKDAY_GLITCH_RE.test(text)) {
        if (refreshes >= 2) return { status: 'stuck', errors: ['Workday kept showing "Something went wrong"'], screenshot: await screenshot(page, job.url, 'workday-error') };
        refreshes++;
        ctx.say('  Workday error page — reopening the application');
        // A plain reload can leave an empty shell or a form whose Next stays disabled:
        // start again from the posting, which resumes the saved draft.
        await startApplication(page, job.url).catch(() => {});
        await settle(page);
        if (await onAuthStep(page)) await authenticate(page, ctx.creds, ctx);
        i--;
        continue;
      }
      if (ALREADY_RE.test(text)) return { status: 'already_applied' };

      const name = await stepName(page);
      if (name !== lastStep) ctx.say(` step: ${name || '(unnamed)'}`);
      repeats = name === lastStep ? repeats + 1 : 0;
      if (repeats >= 2) {
        const errors = await errorTexts(page);
        return { status: 'stuck', step: name, errors, screenshot: await screenshot(page, job.url, 'stuck') };
      }
      lastStep = name;

      // Real tenants render a step's questions seconds after the step loads.
      await page.locator(`[data-automation-id^="formField-"], input[type="file"], ${aid('pageFooterNextButton')}, ${aid('bottom-navigation-next-button')}`)
        .first().waitFor({ timeout: 45_000 }).catch(() => {});
      await pause(2000, 3000);
      await uploadResume(page, job.pdfPath, ctx);
      await fillWorkExperience(page, ctx);
      const open = await fillPage(page, ctx);
      if (open.length) {
        return { status: 'needs_input', step: name, questions: open, screenshot: await screenshot(page, job.url, 'needs-input') };
      }

      await clearOptIns(page, ctx);
      const submit = await findSubmit(page);
      if (submit) {
        const shot = await screenshot(page, job.url, 'review');
        if (!ctx.submit) {
          if (keepOpen()) await ctx.ask('  Review page reached. Check it in the browser, submit there if you want, then press Enter… ');
          return { status: 'ready_for_review', screenshot: shot };
        }
        await submit.click({ force: true });
        await settle(page);
        for (let t = 0; t < 20; t++) {
          if (CONFIRM_RE.test(await pageText(page)) || (await visible(page.locator(aid('congratulationsPopup'))))) {
            return { status: 'submitted', screenshot: await screenshot(page, job.url, 'submitted') };
          }
          await pause(700, 900);
        }
        return { status: 'submit_unconfirmed', errors: await errorTexts(page), screenshot: await screenshot(page, job.url, 'submit-unconfirmed') };
      }

      // Let Workday commit the last field before saving the step.
      await page.keyboard.press('Tab').catch(() => {});
      await clearOptIns(page, ctx);
      await pause(1500, 2500);
      if (WORKDAY_GLITCH_RE.test(await pageText(page))) { i--; continue; }
      if (!(await clickNext(page))) {
        return { status: 'stuck', step: name, errors: ['no Next/Save and Continue button'], screenshot: await screenshot(page, job.url, 'stuck') };
      }
      await settle(page);
    }
    return { status: 'stuck', errors: [`more than ${MAX_STEPS} steps`] };
  } catch (err) {
    return { status: err.status || 'error', errors: [err.message], screenshot: await screenshot(page, job.url, 'error') };
  } finally {
    await context.close().catch(() => {});
  }
}

function markClosed(report) {
  const r = spawnSync(process.execPath, [join(CODE_ROOT, 'set-status.mjs'), '--report', String(report), 'Discarded', '--note', 'posting closed (auto-apply found it gone)'], { encoding: 'utf-8' });
  return r.status === 0 ? 'tracker: marked Discarded (posting closed)' : `tracker not updated: ${(r.stderr || r.stdout).trim().split('\n')[0]}`;
}

function markApplied(report, shot, via = 'Workday') {
  // Dated receipt wording, so receipt-based ledgers (e.g. a daily-progress reconciler) count it.
  const note = `Applied ${localToday()} via ${via} auto-apply; employer success receipt confirmed (application submitted)${shot ? `; screenshot ${shot.replace(`${DATA_ROOT}/`, '')}` : ''}`;
  const r = spawnSync(process.execPath, [join(CODE_ROOT, 'set-status.mjs'), '--report', String(report), 'Applied', '--note', note], { encoding: 'utf-8' });
  return r.status === 0 ? 'tracker updated' : `tracker not updated: ${(r.stderr || r.stdout).trim().split('\n')[0]}`;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (err) {
    console.error(`auto-apply-workday: ${err.message}\n\n${USAGE}`);
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  await loadEnv();
  const config = readYamlFile(CONFIG_PATH, 'config/auto-apply.yml');
  if (opts.answers) {
    const extra = loadYaml(readFileSync(resolve(DATA_ROOT, opts.answers), 'utf-8'));
    const list = Array.isArray(extra) ? extra : extra?.questions;
    if (!Array.isArray(list)) throw new Error(`${opts.answers}: expected a list of {match, answer}`);
    config.questions = [...list, ...(config.questions ?? [])];
  }
  if (!existsSync(CONFIG_PATH)) console.warn('warning: config/auto-apply.yml not found — copy config/auto-apply.example.yml and fill in your answers');
  const profile = readYamlFile(getProfilePath(), 'config/profile.yml');
  if (opts.fromTracker) opts.jobs.push(...trackerJobs(opts));
  const blacklistPath = join(DATA_ROOT, 'data', 'blacklist.md');
  const blacklist = existsSync(blacklistPath) ? parseBlacklist(readFileSync(blacklistPath, 'utf-8')) : [];
  opts.jobs = opts.jobs.filter((job) => {
    const hit = blacklistHit(blacklist, job);
    if (hit) console.log(`  skip ${job.company || job.url}: on your blacklist (${hit.company})`);
    return !hit;
  });
  if (opts.jobs.length === 0) {
    console.log('No Workday jobs to apply to.');
    return;
  }
  const roles = opts.jobs.some((job) => !job.role && job.report) ? trackerRoles() : new Map();
  for (const job of opts.jobs) {
    if (!isWorkdayUrl(job.url)) throw new Error(`not a Workday URL: ${job.url}`);
    job.pdfPath = resolveJobPdf(job);
    job.role = job.role || roles.get(String(job.report)) || null;
  }

  const creds = credentials(profile, config);
  const pwProblems = workdayPasswordProblems(creds.password);
  if (pwProblems.length) console.warn(`warning: most Workday tenants reject this password at sign-up; it needs ${pwProblems.join(', ')}`);

  console.log(`${opts.jobs.length} job(s) · login ${creds.email} · ${opts.submit ? 'WILL SUBMIT' : 'stops at Review'}`);
  for (const job of opts.jobs) console.log(`  ${job.url}\n    resume ${job.pdfPath.replace(`${DATA_ROOT}/`, '')}${job.role ? ` as ${resumeFileName(config.daily?.resume_prefix ?? '', job.role)}` : ''}${job.report ? ` · report ${job.report}` : ''}`);
  if (opts.dryRun) return;

  const rl = opts.prompt ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const ctx = {
    config,
    creds,
    submit: opts.submit,
    headless: opts.headless,
    prompt: opts.prompt && Boolean(process.stdin.isTTY),
    learned: readLearned(),
    experience: existsSync(join(DATA_ROOT, 'cv.md')) ? parseCvExperience(readFileSync(join(DATA_ROOT, 'cv.md'), 'utf-8')) : [],
    education: existsSync(join(DATA_ROOT, 'cv.md')) ? parseCvEducation(readFileSync(join(DATA_ROOT, 'cv.md'), 'utf-8')) : null,
    say: (msg) => console.log(msg),
    ask: (q) => (rl ? rl.question(q) : Promise.resolve('')),
  };
  ctx.refreshResolver = () => { ctx.resolve = createResolver({ config, profile, learned: ctx.learned, employer: ctx.employer, education: ctx.education }); };
  ctx.refreshResolver();

  const { chromium } = await import('playwright');
  const browser = await chromium.launch(freshLaunchOptions({ headless: opts.headless }));
  const summary = [];
  try {
    for (const job of opts.jobs) {
      console.log(`\n▶ ${job.url}`);
      if (!opts.force && alreadySubmitted(job.url)) {
        console.log('  already submitted (data/auto-apply/log.jsonl) — skipping; --force to redo');
        summary.push({ url: job.url, status: 'skipped_duplicate' });
        continue;
      }
      ctx.employer = job.company || (() => { try { return new URL(job.url).hostname.split('.')[0]; } catch { return ''; } })();
      ctx.refreshResolver();
      let result = await runJob(browser, job, ctx);
      // A draft reopened after a Workday error page can keep Save disabled for the rest of that
      // browser session; a clean session resumes it normally.
      if (result.status === 'stuck' && (result.errors ?? []).some((e) => /next button disabled|no next/i.test(e))) {
        console.log('  stuck in this session — retrying once in a fresh browser session');
        await pause(3000, 5000);
        result = await runJob(browser, job, ctx);
      }
      if (result.status === 'submitted' && job.report) result.tracker = markApplied(job.report, result.screenshot);
      if (result.status === 'closed' && job.report) result.tracker = markClosed(job.report);
      logResult({ url: job.url, report: job.report ?? null, pdf: job.pdfPath, ...result });
      summary.push({ url: job.url, ...result });
      console.log(`  → ${result.status}${result.questions ? `: ${result.questions.join(' · ')}` : ''}${result.errors?.length ? `: ${result.errors.join(' · ')}` : ''}`);
      if (result.tracker) console.log(`  ${result.tracker}`);
      await pause(1500, 3000);
    }
  } finally {
    rl?.close();
    await browser.close().catch(() => {});
  }

  console.log('\nSummary');
  for (const s of summary) console.log(`  ${s.status.padEnd(18)} ${s.url}`);
  const needInput = summary.filter((s) => s.status === 'needs_input');
  if (needInput.length) console.log('\nAdd answers for the questions above to config/auto-apply.yml → questions:, then rerun.');
  if (summary.some((s) => !['submitted', 'ready_for_review', 'already_applied', 'skipped_duplicate', 'closed'].includes(s.status))) process.exitCode = 2;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`auto-apply-workday: ${err.message}`);
    process.exitCode = 1;
  });
}

export {
  normalizeLabel, urlKey, runJob, authenticate, fillPage, startApplication, settle,
  loadEnv, readYamlFile, readLearned, saveLearned, resolveJobPdf, reportUrl, alreadySubmitted, logResult, screenshot,
  markApplied, markClosed, tick, pause, CONFIG_PATH, DATA_ROOT, CODE_ROOT, CONFIRM_RE, ALREADY_RE,
};
