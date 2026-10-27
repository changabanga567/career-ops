import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
/**
 * workday-answers.mjs — question → answer resolution for auto-apply-workday.mjs.
 *
 * Pure functions only (no browser, no fs) so the matching rules can be tested
 * on their own. The driver hands in a field label and the option texts it saw
 * on the page; this module decides what to answer and which option to click.
 *
 * Resolution order for a label:
 *   1. config `questions:` rules (user regexes, first match wins)
 *   2. learned answers (exact normalized label the user answered before)
 *   3. built-in rules below, which read the structured config sections
 */

/** Lower-case, fold quotes/dashes, strip the required-asterisk and punctuation. */
export function normalizeLabel(text) {
  return String(text ?? '')
    .replace(/[‘’“”]/g, "'")
    .replace(/[–—]/g, '-')
    .replace(/\*/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9'/+&-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitName(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Separator for "try these answers in order" (config lists become "a || b || c"). */
export const ALTERNATIVES = ' || ';

function str(value) {
  if (Array.isArray(value)) return value.map(str).filter(Boolean).join(ALTERNATIVES);
  if (value === true) return 'Yes';
  if (value === false) return 'No';
  if (value == null) return '';
  return String(value).trim();
}

function todayMDY(now = new Date()) {
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${now.getFullYear()}`;
}

/**
 * Built-in rules. Order matters: more specific labels come first so
 * "Will you require sponsorship" never falls through to "authorized to work",
 * and "Hispanic or Latino" is answered before the broader race/ethnicity rule.
 * `from` is a dotted path into the merged answers object (see buildAnswerSet).
 */
const THIRD_PARTY_RE = /\breferences?\b|\bsupervisors?\b|\bemergency contact\b|\breferr(ed|er|al|ing)\b|\brelatives?\b|\bspouse\b|\bmanager'?s\b|\bhousehold members?\b/;

export const BUILTIN_RULES = [
  // Anchored: "…change or extension of immigration status" is a sponsorship question, not a phone extension.
  { key: 'skip', test: /^(middle (name|initial)|ext|extension|phone extension|address line 3)$/ },
  { key: 'personal.preferred_name', test: /\bpreferred (first )?name\b/ },
  { key: 'personal.first_name', test: /\b(legal )?(first|given) name\b/ },
  { key: 'personal.last_name', test: /\b(last|family) name\b|\bsurname\b/ },
  { key: 'personal.phone_device_type', test: /\bphone (device )?type\b|\bdevice type\b/ },
  { key: 'personal.phone_country_code', test: /\b(country phone code|phone country|country code)\b/ },
  { key: 'personal.phone', test: /\b(phone|mobile|telephone|cell)( number)?\b/ },
  { key: 'personal.email', test: /\be-?mail( address)?\b/ },
  { key: 'personal.full_address', test: /^(home|mailing|residential|permanent|current)( mailing)? address\b|^what is your (current |home |mailing )?address\b/ },
  { key: 'personal.address_line_2', test: /\baddress line 2\b|^(apt|apartment|suite|unit)\b/ },
  { key: 'personal.address_line_1', test: /\baddress line 1\b|\bstreet( address)?\b|^address$/ },
  { key: 'personal.city', test: /^(city|town|city\/town)\b/ },
  { key: 'personal.state', test: /^(state|province|state\/province|region|state or province)\b/ },
  { key: 'personal.postal_code', test: /\b(postal|zip)( code)?\b/ },
  { key: 'personal.location', test: /^(current )?location( \(city\)| city)?$|^where are you (currently )?(located|based)$|^city,? state$/ },
  { key: 'personal.country', test: /^country\b|\bcountry\/territory\b|\bcountry of residence\b/ },
  { key: 'personal.linkedin', test: /\blinkedin\b/ },
  { key: 'personal.website', test: /\b(website|portfolio|personal url|github)\b/ },

  { key: 'source', test: /\bhow did you (hear|learn|find)\b|\bwhere did you (hear|learn|find)\b|^source\b|\breferral source\b/ },
  { key: 'current_employee', test: /\b(are you )?current(ly)? (an )?employee (with|of|at)\b|\binternal candidate\b|\bexisting [a-z0-9&'.-]+ employee\b/ },
  { key: 'previously_employed', test: /\b(previously|ever) (been )?(employed|worked|work(ed)? for|work(ed)? at)\b|\bformer (employee|worker)\b|\bworked (for|at|with) [a-z0-9 &'.-]+ (before|previously)\b|\bcurrent or former\b|\bprevious (?:[a-z&'.-]+ ){0,4}(employee|worker)\b|\bexperience working (at|for)\b/ },

  { key: 'eeo.sexual_orientation', test: /\bsexual orientation\b/ },
  { key: 'eeo.transgender', test: /\btransgender\b/ },
  { key: 'eeo.hispanic_or_latino', test: /\bhispanic\b|\blatin[oax]\b/ },
  { key: 'eeo.race', test: /\brace\b|\bethnicit(y|ies)\b|\bethnic\b/ },
  { key: 'eeo.gender', test: /\bgender\b|^sex$|\bsex\b/ },
  { key: 'eeo.veteran', test: /\bveterans?\b|\bmilitary\b|\barmed forces\b/ },
  { key: 'eeo.disability', test: /\bdisabilit(y|ies)\b|\bdisabled\b/ },

  { key: 'work_authorization.needs_sponsorship', test: /\bsponsor(ship)?\b|\bvisa\b|\bh-?1b\b/ },
  { key: 'work_authorization.authorized', test: /\bauthori[sz](ed|ation) to work\b|\bwork authori[sz]ation\b|\blegally (eligible|authori[sz]ed|permitted|able)\b|\bright to work\b|\beligible to work\b/ },
  { key: 'work_authorization.over_18', test: /\b18 years\b|\bage of 18\b|\bat least 18\b|\blegal (working )?age\b/ },

  { key: 'work.desired_salary', test: /\b(salary|compensation|pay) (expectation|requirement|range)s?\b|\bdesired (salary|pay|compensation)\b|\bexpected (salary|compensation)\b/ },
  { key: 'work.start_date', test: /\bstart date\b|\bavailable to start\b|\bearliest .*start\b|\bwhen can you start\b|\bdate you (can|could) start\b|\bnotice period\b/ },
  { key: 'work.relocate', test: /\brelocat/ },
  { key: 'work.onsite_ok', test: /\b(on-?site|in-?office|hybrid|commut)/ },
  { key: 'work.background_check', test: /\bbackground (check|screen)|\bdrug (test|screen)/ },
  { key: 'work.non_compete', test: /\bnon-?compete\b|\brestrictive covenant\b|\bnon-?solicit/ },
  { key: 'work.relatives', test: /\brelatives?\b|\bfamily members?\b.*\b(work|employ)|\brelated (person|people|individual)\b/ },
  { key: 'work.government_official', test: /\b(government|public) official\b/ },
  { key: 'work.referred', test: /\b(were you|have you been) referred\b|\breferred by\b|\bemployee referral\b|\breferral from\b/ },

  { key: 'education.school', test: /^(school|school or university|university|college|institution)( name)?$/ },
  { key: 'education.degree', test: /^(degree|degree type|highest degree|level of education)$/ },
  { key: 'education.field', test: /^(field of study|major|area of study|discipline)$/ },
  { key: 'signature_name', test: /^(your )?(full )?(legal )?name$|^what is your (full |legal |full legal )?name\b|\bsignature\b|\btyp(e|ing) your (full )?(legal )?name\b/ },
  { key: 'signature_date', test: /^date$|\btoday'?s date\b|\bdate signed\b/ },
];

/** Loose employer match: "The Home Depot" matches the Workday tenant "homedepot". */
export function sameEmployer(a, b) {
  const key = (s) => String(s ?? '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
  const x = key(a);
  const y = key(b);
  if (x.length < 3 || y.length < 3) return false;
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
}

/**
 * Merge config/auto-apply.yml with config/profile.yml defaults into one flat
 * answer object the rules read from. `employer` is the company being applied
 * to; it flips "previously worked here" to Yes for employers listed in
 * config `previously_employed_at`.
 */
export function buildAnswerSet(config = {}, profile = {}, { now = new Date(), employer = '' } = {}) {
  const candidate = profile.candidate ?? {};
  const location = profile.location ?? {};
  const name = splitName(candidate.full_name);
  const personal = config.personal ?? {};
  const workAuth = config.work_authorization ?? {};
  const fullName = str(personal.full_name) || [str(personal.first_name) || name.first, str(personal.last_name) || name.last].filter(Boolean).join(' ');

  return {
    personal: {
      first_name: str(personal.first_name) || name.first,
      last_name: str(personal.last_name) || name.last,
      preferred_name: str(personal.preferred_name),
      email: str(personal.email) || str(candidate.email),
      phone: str(personal.phone) || str(candidate.phone),
      phone_device_type: str(personal.phone_device_type) || 'Mobile',
      phone_country_code: str(personal.phone_country_code),
      address_line_1: str(personal.address_line_1),
      address_line_2: str(personal.address_line_2),
      city: str(personal.city) || str(location.city),
      state: str(personal.state),
      postal_code: str(personal.postal_code),
      country: str(personal.country) || str(location.country),
      full_address: [str(personal.address_line_1), str(personal.city) || str(location.city), [str(personal.state), str(personal.postal_code)].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      location: str(personal.location) || [str(personal.city) || str(location.city), str(personal.state)].filter(Boolean).join(', '),
      linkedin: str(personal.linkedin) || str(candidate.linkedin),
      website: str(personal.website) || str(candidate.portfolio_url) || str(candidate.github),
    },
    source: str(config.source),
    current_employee: str(config.current_employee) || 'No',
    previously_employed: (Array.isArray(config.previously_employed_at) && employer && config.previously_employed_at.some((e) => sameEmployer(e, employer)))
      ? 'Yes'
      : (str(config.previously_employed) || 'No'),
    eeo: Object.fromEntries(Object.entries(config.eeo ?? {}).map(([k, v]) => [k, str(v)])),
    work_authorization: {
      authorized: str(workAuth.authorized) || (Array.isArray(location.authorized_in) && location.authorized_in.length ? 'Yes' : ''),
      needs_sponsorship: str(workAuth.needs_sponsorship) || (location.needs_sponsorship === undefined ? '' : str(Boolean(location.needs_sponsorship))),
      over_18: str(workAuth.over_18) || 'Yes',
    },
    work: Object.fromEntries(Object.entries(config.work ?? {}).map(([k, v]) => [k, str(v)])),
    education: config.education ?? {},
    signature_name: fullName,
    signature_date: todayMDY(now),
  };
}

function compileUserRules(questions) {
  if (!Array.isArray(questions)) return [];
  return questions
    .filter((q) => q && q.match != null && q.answer != null)
    .map((q) => {
      let re;
      try {
        re = new RegExp(String(q.match), 'i');
      } catch (err) {
        throw new Error(`auto-apply.yml questions: invalid regex ${JSON.stringify(q.match)} (${err.message})`);
      }
      return { re, answer: str(q.answer) };
    });
}

/**
 * Build a resolver: (label) => { answer, source, key } | null.
 * `answer === ''` with source 'skip' means "deliberately leave blank".
 */

/**
 * Posted pay in a job description, annualized: { min, max, target } or null.
 * Used only for salary questions that offer nothing but ranges: the user's rule is
 * "see what their pay scale shows on the JD and base it off that" (2026-10-26).
 */
export function jdPayRange(text) {
  // "105.000.00" is a typo'd 105,000.00: a dot used as the thousands separator before cents.
  const t = String(text ?? '').replace(/–|—/g, '-').replace(/\b(\d{2,3})\.(\d{3})\.(\d{2})\b/g, '$1,$2.$3');
  const num = (v) => { const k = /k$/i.test(v); const n = Number(v.replace(/[,k\s]/gi, '')); return k ? n * 1000 : n; };
  const hourly = /\$\s?(\d{2,3}(?:\.\d{1,2})?)\s*(?:-|to)\s*\$?\s?(\d{2,3}(?:\.\d{1,2})?)\s*(?:\/\s*h(?:ou)?r|per hour|an hour|hourly)/i.exec(t);
  const annual = /\$\s?(\d{2,3}(?:,\d{3})+(?:\.\d\d)?|\d{2,3}(?:\.\d+)?\s?[kK])\s*(?:-|to|and)\s*\$?\s?(\d{2,3}(?:,\d{3})+(?:\.\d\d)?|\d{2,3}(?:\.\d+)?\s?[kK])/.exec(t);
  // Labeled pairs: "Minimum Pay Range : $75K ... Maximum Pay Range : $81K" (Ryder and other Workday tenants).
  const amt = String.raw`\$?\s?(\d{2,3}(?:,\d{3})+(?:\.\d\d)?|\d{2,3}(?:\.\d+)?\s?[kK]|\d{5,6}(?:\.\d\d)?)`;
  const lo = new RegExp(String.raw`min(?:imum)?\s+(?:pay|salary|base pay)(?:\s+range)?\s*:?\s*` + amt, 'i').exec(t);
  const hi = new RegExp(String.raw`max(?:imum)?\s+(?:pay|salary|base pay)(?:\s+range)?\s*:?\s*` + amt, 'i').exec(t);
  let min; let max;
  if (annual) { min = num(annual[1]); max = num(annual[2]); }
  else if (lo && hi) { min = num(lo[1]); max = num(hi[1]); }
  else if (hourly) { min = Number(hourly[1]) * 2080; max = Number(hourly[2]) * 2080; }
  else return null;
  if (!(min >= 15000 && max >= min && max <= 1000000)) return null;
  return { min, max, target: Math.round((min + max) / 2) };
}

/** [low, high] of a salary option ("$90,001-$100,000", "Under $20,000", "$140,000+", "100K - 120K"), or null. */
export function bracketRange(option) {
  const o = String(option ?? '').replace(/–|—/g, '-');
  const raw = [...o.matchAll(/\$?\s?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?([kK])?/g)];
  // "$100 - $110k": a trailing k applies to the bare number before it too.
  const k = raw.some((m) => m[2]);
  const vals = raw.map((m) => { const n = Number(m[1].replace(/,/g, '')); return m[2] || (k && n < 1000) ? n * 1000 : n; }).filter((n) => n >= 1000);
  if (!vals.length) return null;
  if (/under|less than|below|up to/i.test(o)) return [0, vals[0]];
  if (vals.length === 1 && /\+|above|over|more|greater/i.test(o)) return [vals[0], Infinity];
  if (vals.length >= 2) return [vals[0], vals[1]];
  return null;
}

/** Index of the option whose range holds `target`, or -1. */
export function bracketIndex(target, options) {
  const opts = options ?? [];
  const hit = opts.findIndex((o) => { const r = bracketRange(o); return r && target >= r[0] && target <= r[1]; });
  if (hit !== -1) return hit;
  // Split questions ("between $20k and $100k ... if higher, select Other"): Other when no range here holds the target.
  const ranges = opts.map(bracketRange).filter(Boolean);
  return ranges.length ? opts.findIndex((o) => /^other$/i.test(String(o).trim())) : -1;
}

/** Pay midpoint posted in report NNN's archived JD (reports/NNN-*.md), or null. */
export function reportPayTarget(dataRoot, report) {
  if (report == null) return null;
  const dir = join(dataRoot, 'reports');
  if (!existsSync(dir)) return null;
  const pad = String(report).padStart(3, '0');
  const file = readdirSync(dir).find((n) => n.startsWith(`${pad}-`) && n.endsWith('.md'));
  if (!file) return null;
  const text = readFileSync(join(dir, file), 'utf-8');
  const at = text.search(/^## Job Description/m);
  return jdPayRange(at >= 0 ? text.slice(at) : text)?.target ?? null;
}

const DESIRED_PAY_RE = /salary|compensation|\bpay\b|wage/;
const NOT_DESIRED_PAY_RE = /frequency|type|currency|higher than|current|most recent|previous|prior|last|minimum required|history/;

export function createResolver({ config = {}, profile = {}, learned = {}, now, employer, education = null, salaryTarget = null } = {}) {
  const answers = buildAnswerSet({ ...config, education: { ...(education ?? {}), ...(config.education ?? {}) } }, profile, { now, employer });
  const userRules = compileUserRules(config.questions);
  const learnedMap = new Map(Object.entries(learned ?? {}).map(([k, v]) => [normalizeLabel(k), str(v)]));

  // A range-only salary question takes the range that holds the JD's posted pay midpoint ("1" stays first for open fields).
  const withBracket = (label, hit) => {
    if (!hit || !salaryTarget || !DESIRED_PAY_RE.test(label) || NOT_DESIRED_PAY_RE.test(label)) return hit;
    if (String(hit.answer).split(ALTERNATIVES)[0].trim() !== '1') return hit;
    return { ...hit, answer: `${hit.answer}${ALTERNATIVES}bracket:${salaryTarget}` };
  };
  // "{next_business_day}" becomes tomorrow's weekday date (MM/DD/YYYY), for start-date boxes that need a date.
  const fillTokens = (hit) => {
    if (!hit || !/\{(next_business_day|today)\}/.test(String(hit.answer))) return hit;
    const fmt = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
    const today = new Date(now ?? Date.now());
    const d = new Date(today);
    do d.setDate(d.getDate() + 1); while (d.getDay() === 0 || d.getDay() === 6);
    return { ...hit, answer: String(hit.answer).replace(/\{next_business_day\}/g, fmt(d)).replace(/\{today\}/g, fmt(today)) };
  };
  return function resolve(rawLabel) {
    return fillTokens(withBracket(normalizeLabel(rawLabel), resolveRaw(rawLabel)));
  };
  function resolveRaw(rawLabel) {
    const label = normalizeLabel(rawLabel);
    if (!label) return null;
    for (const rule of userRules) {
      if (rule.re.test(rawLabel) || rule.re.test(label)) return { answer: rule.answer, source: 'config', key: rule.re.source };
    }
    if (learnedMap.has(label)) return { answer: learnedMap.get(label), source: 'learned', key: label };
    for (const rule of BUILTIN_RULES) {
      if (!rule.test.test(label)) continue;
      // The candidate's own name/phone/email/address never answer a question about someone else.
      // Nor do they answer conditional follow-ups or long questions that merely mention a phone or email:
      // personal fields are short labels ("Phone Number", "What is your current address?").
      if (rule.key.startsWith('personal.') && (THIRD_PARTY_RE.test(label) || /^if (you )?(marked|answered|selected|checked) /.test(label) || label.split(/\s+/).length > 8)) return null;
      if (rule.key === 'skip') return { answer: '', source: 'skip', key: 'skip' };
      const value = get(answers, rule.key);
      if (value) return { answer: value, source: 'builtin', key: rule.key };
      return null;
    }
    return null;
  }
}

const OPT_IN_RE = /\b(preferred name|text messag(e|es|ing)|sms|mms|marketing|newsletters?|job alerts?|talent community|promotional|notification updates|message and data rates)\b/;

/** Opt-ins the candidate never asked for: SMS/text, marketing, job alerts, talent community, preferred name. */
export function isOptInLabel(label) {
  return OPT_IN_RE.test(normalizeLabel(label));
}

const AGREEMENT_RE = /\b(i agree|agree|acknowledge|consent|terms( and conditions| of (use|service))?|privacy (policy|notice|statement)|i certify|certif(y|ication)|attest|i confirm|i understand|i have read|read and understood|accept|i (hereby )?declare|true and (accurate|correct|complete)|signify your acceptance|acceptance of the)\b/;

/** True for "I agree / acknowledge / consent / have read the terms" style checkboxes. */
export function isAgreementLabel(label) {
  const n = normalizeLabel(label);
  if (!n) return false;
  // Never tick opt-ins that change what the candidate is disclosing or receiving.
  if (isOptInLabel(n)) return false;
  return AGREEMENT_RE.test(n);
}

const YES = new Set(['yes', 'y', 'true']);
const NO = new Set(['no', 'n', 'false']);
const DECLINE_RE = /\b(decline|prefer not|do not wish|don't wish|choose not|not (wish|want) to|rather not|i don't want)\b/;
const PLACEHOLDER_RE = /^(select one|select|choose|choose one|--+|please select|none selected)$/;

// Words that say nothing about which option is meant ("Associates Degree" vs "Bachelor's Degree").
const STOPWORDS = new Set(['degree', 'degrees', 'level', 'the', 'of', 'and', 'in', 'or', 'an', 'my', 'am', 'have', 'other', 'type', 'program']);

function tokens(s) {
  return normalizeLabel(s).replace(/'/g, '').split(' ').filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Pick the option that best matches the desired answer.
 * Returns the index into `options`, or -1 when nothing is a credible match
 * (the caller then treats the question as unanswered instead of guessing).
 */
/**
 * A bachelor's option that names a different degree than cv.md's B.S. in Computer Science
 * ("Bachelor of Arts", "BA", "Bachelors of Social Work", "Bachelors in Progress", "B.S.M.E.").
 * Options that also offer a plain B.S. ("BA, BS / Bachelor") are fine.
 */
export function isOtherBachelor(option) {
  const o = String(option ?? '').toLowerCase();
  if (/\bb\.?\s?s\.?\b(?!\.?\s?m)|bachelor'?s? of science\b(?! in (?!computer))/.test(o)) return false;
  return /\bb\.?a\.?\b|\barts?\b|bachelor'?s? (of|in) education|\bb\.?\s?ed\b|social work|engineering|\bb\.?s\.?\s?m|nursing|music|professional studies|management|business|in progress|pursuing|incomplete|some college|\bassociate/.test(o);
}

export function pickOption(desired, options) {
  const bracket = /^bracket:(\d+)$/i.exec(String(desired ?? '').trim());
  if (bracket) return bracketIndex(Number(bracket[1]), options);
  // "=Computer Science": exact (normalized) match only, so "Advanced Computer Science" is never taken for it.
  const exactOnly = /^=\s*(.+)$/.exec(String(desired ?? '').trim());
  if (exactOnly) {
    const w = normalizeLabel(exactOnly[1]);
    return (options ?? []).findIndex((o) => normalizeLabel(o) === w);
  }
  const want = normalizeLabel(desired);
  if (!want || !Array.isArray(options) || options.length === 0) return -1;
  // "and ..." exclusions apply to short answers (a field name); "No, I do not have a disability" may continue with "and ...".
  const shortWant = want.split(' ').length <= 3;
  const opts = options.map((o) => normalizeLabel(o));
  const bachelor = /\bbachelor|^b\.?s\.?$/.test(want);
  // Polarity: "No, I would not like to receive communications" shares most words with the Yes option; never cross them.
  const negative = (t) => /^(no|not|none|decline)\b|\b(not|never|don't|do not|won't|would not|wouldn't|no longer)\b/.test(t);
  const affirmative = (t) => /^yes\b/.test(t);
  const wantNeg = negative(want);
  const wantYes = affirmative(want);
  const samePolarity = (o) => !((wantNeg && affirmative(o)) || (wantYes && negative(o)) || (wantNeg !== negative(o) && /\b(would|like|wish|want|receive|contact|consent|agree)\b/.test(o)));
  // Numbers must agree: "3 - 5 years" may never land on "0 to 3 years" through a shared word or digit.
  const nums = (t) => (String(t).match(/\d+(?:\.\d+)?/g) ?? []);
  const wantNums = nums(want);
  const sameNumbers = (o) => !wantNums.length || !nums(o).length || wantNums.every((n) => nums(o).includes(n));
  const usable = (i) => opts[i] && !PLACEHOLDER_RE.test(opts[i]) && !(bachelor && isOtherBachelor(options[i])) && (opts[i] === want || (samePolarity(opts[i]) && sameNumbers(opts[i])));

  const exact = opts.findIndex((o, i) => usable(i) && o === want);
  // A bare number (the salary placeholder "1") must never fuzzy-match a range like "$100,000 - $120,000".
  if (/^\d+$/.test(want)) return exact;
  if (exact !== -1) return exact;

  if (YES.has(want) || NO.has(want)) {
    const prefix = YES.has(want) ? 'yes' : 'no';
    const hits = opts.map((o, idx) => (usable(idx) && (o === prefix || o.startsWith(`${prefix} `) || o.startsWith(`${prefix},`) || o.startsWith(`${prefix}/`)) ? idx : -1)).filter((idx) => idx !== -1);
    // Several "Yes, up to N%" bands: a plain Yes means the widest one (the candidate travels 100%).
    if (prefix === 'yes' && hits.length > 1 && hits.every((idx) => /\d+\s*%/.test(options[idx]))) {
      const pct = (idx) => Math.max(...[...String(options[idx]).matchAll(/(\d+)\s*%/g)].map((m) => Number(m[1])));
      return hits.reduce((a, b) => (pct(b) > pct(a) ? b : a));
    }
    const i = hits[0] ?? -1;
    if (i !== -1) return i;
    // "I am not a protected veteran" style. Only an option that OPENS with a
    // negation counts as "No": "I identify as a veteran, just not a protected
    // veteran" mentions "not" but is a yes. "Yes" never falls back to a guess.
    if (prefix === 'yes') return -1;
    const opensNegated = (o) => /^(no|not|none|i am not|i'm not|i do not|i don't|i have not|i haven't|i was not|i have never|never)\b/.test(o);
    return opts.findIndex((o, idx) => usable(idx) && !DECLINE_RE.test(o) && opensNegated(o));
  }

  if (DECLINE_RE.test(want)) {
    const i = opts.findIndex((o, idx) => usable(idx) && DECLINE_RE.test(o));
    if (i !== -1) return i;
  }

  // "Computer Science and Mathematics" adds a field; it is not "Computer Science".
  const starts = opts.findIndex((o, i) => usable(i) && ((o.startsWith(want) && !(shortWant && (o.startsWith(`${want} and `) || o.startsWith(`${want} & `)))) || want.startsWith(`${o} `)));
  if (starts !== -1) return starts;

  // "Computer Science & Mathematics" contains "Computer Science" but is a different field.
  const joined = (o) => shortWant && new RegExp(`(^| )(and|&) ${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)|(^| )${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (and|&) `).test(o);
  const contains = opts.findIndex((o, i) => usable(i) && !joined(o) && (` ${o} `.includes(` ${want} `) || ` ${want} `.includes(` ${o} `)));
  if (contains !== -1) return contains;

  const wantTokens = new Set(tokens(want));
  let best = -1;
  let bestScore = 0;
  opts.forEach((o, i) => {
    if (!usable(i) || (shortWant && (o.startsWith(`${want} and `) || o.startsWith(`${want} & `)))) return;
    const ot = new Set(tokens(o));
    let shared = 0;
    for (const t of wantTokens) if (ot.has(t)) shared++;
    // Most of the answer's own words must appear: "Career Site" is not "Career fair".
    const score = wantTokens.size ? shared / wantTokens.size : 0;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return bestScore >= 0.67 ? best : -1;
}

/** Workday password policy (most tenants): 8+ chars, upper, lower, digit, special. */
export function workdayPasswordProblems(password) {
  const p = String(password ?? '');
  const problems = [];
  if (p.length < 8) problems.push('at least 8 characters');
  if (!/[A-Z]/.test(p)) problems.push('an uppercase letter');
  if (!/[a-z]/.test(p)) problems.push('a lowercase letter');
  if (!/\d/.test(p)) problems.push('a number');
  if (!/[^A-Za-z0-9]/.test(p)) problems.push('a special character');
  return problems;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function parseMonthYear(text) {
  const m = /([A-Za-z]{3,9})\.?\s+(\d{4})/.exec(text) || /(\d{1,2})\/(\d{4})/.exec(text);
  if (!m) {
    const y = /\b(19|20)\d{2}\b/.exec(text);
    return y ? { mm: '01', yyyy: y[0] } : null;
  }
  const month = /^\d+$/.test(m[1]) ? Number(m[1]) : MONTHS[m[1].toLowerCase().slice(0, 4)] ?? MONTHS[m[1].toLowerCase().slice(0, 3)];
  if (!month) return null;
  return { mm: String(month).padStart(2, '0'), yyyy: m[2] };
}

/**
 * Jobs from cv.md's experience section, newest first as written:
 *   ### Company -- Location   /   **Title**   /   Feb. 2025 – Present
 * Returns [{ company, title, start: {mm,yyyy}, end: {mm,yyyy}|null, current }].
 */
export function parseCvExperience(cvText) {
  const lines = String(cvText ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+(work |professional )?experience|^##\s+(employment|work) history/i.test(l.trim()));
  if (start === -1) return [];
  const jobs = [];
  let job = null;
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (/^##\s/.test(line)) break;
    const head = /^###\s+(.+?)(?:\s+(?:--|—|–|-)\s+.*)?$/.exec(line);
    if (head) {
      job = { company: head[1].trim(), title: '', start: null, end: null, current: false, bullets: [] };
      jobs.push(job);
      continue;
    }
    if (!job) continue;
    const title = /^\*\*(.+?)\*\*$/.exec(line);
    if (title && !job.title) { job.title = title[1].trim(); continue; }
    if (line.startsWith('- ')) { job.bullets.push(line.slice(2).trim()); continue; }
    if (line && job.bullets.length && !line.startsWith('**') && !/^###/.test(line) && job.start) {
      // cv.md wraps long bullets onto the next line.
      job.bullets[job.bullets.length - 1] += ` ${line}`;
      continue;
    }
    if (!job.start && /\b(19|20)\d{2}\b/.test(line) && !line.startsWith('-')) {
      const [from, to = ''] = line.split(/\s+[–—-]\s+|\s+to\s+/i);
      job.start = parseMonthYear(from);
      job.current = /present|current|now/i.test(to);
      job.end = job.current ? null : parseMonthYear(to);
    }
  }
  return jobs.filter((j) => j.company && j.title && j.start);
}

const DEGREE_ALTERNATIVES = [
  [/\b(bachelor|b\.?s\.?|b\.?a\.?)\b/i, ["Bachelor's Degree", 'Bachelors Degree', 'Bachelor Degree', 'Bachelor of Science', "Bachelor's", 'Bachelors', 'BS', 'B.S.']],
  [/\bmaster/i, ["Master's Degree", 'Masters Degree', "Master's", 'Masters', 'MS']],
  [/\bassociate/i, ["Associate's Degree", 'Associates Degree', "Associate's"]],
  [/\b(ph\.?d|doctor)/i, ['Doctorate', 'PhD', 'Doctoral Degree']],
];

/**
 * Highest degree in cv.md's Education section, written as alternating
 * "School" / "Degree, Field" lines. Programs without a degree word are skipped.
 * Returns { school, degree, field } with degree as ordered fallbacks, or null.
 */
export function parseCvEducation(cvText) {
  const lines = String(cvText ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+education/i.test(l.trim()));
  if (start === -1) return null;
  const body = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (/^##\s/.test(line)) break;
    if (line && !line.startsWith('-')) body.push(line.replace(/^#+\s*/, '').replace(/\*\*/g, ''));
  }
  for (let i = 0; i + 1 < body.length; i++) {
    const hit = DEGREE_ALTERNATIVES.find(([re]) => re.test(body[i + 1]));
    if (!hit) continue;
    const [, ...rest] = body[i + 1].split(/,\s*/);
    // "Computer Science (Feb. 2020 – Feb. 2024) | GPA: 3.7" → "Computer Science": dates and GPA are not the field.
    const field = (rest.join(', ').trim() || (/\b(?:in|of)\s+([A-Z][\w &]+)$/.exec(body[i + 1])?.[1] ?? ''))
      .split('|')[0].replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
    return { school: body[i], degree: hit[1].join(ALTERNATIVES), field };
  }
  return null;
}
