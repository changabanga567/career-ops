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

function str(value) {
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
export const BUILTIN_RULES = [
  { key: 'skip', test: /\b(middle name|extension|phone extension|address line 3)\b/ },
  { key: 'personal.preferred_name', test: /\bpreferred (first )?name\b/ },
  { key: 'personal.first_name', test: /\b(legal )?(first|given) name\b/ },
  { key: 'personal.last_name', test: /\b(last|family) name\b|\bsurname\b/ },
  { key: 'personal.phone_device_type', test: /\bphone (device )?type\b|\bdevice type\b/ },
  { key: 'personal.phone_country_code', test: /\b(country phone code|phone country|country code)\b/ },
  { key: 'personal.phone', test: /\b(phone|mobile|telephone|cell)( number)?\b/ },
  { key: 'personal.email', test: /\be-?mail( address)?\b/ },
  { key: 'personal.address_line_2', test: /\baddress line 2\b|\bapt|suite\b/ },
  { key: 'personal.address_line_1', test: /\baddress line 1\b|\bstreet( address)?\b|^address$/ },
  { key: 'personal.city', test: /^(city|town|city\/town)\b/ },
  { key: 'personal.state', test: /^(state|province|state\/province|region|state or province)\b/ },
  { key: 'personal.postal_code', test: /\b(postal|zip)( code)?\b/ },
  { key: 'personal.country', test: /^country\b|\bcountry\/territory\b|\bcountry of residence\b/ },
  { key: 'personal.linkedin', test: /\blinkedin\b/ },
  { key: 'personal.website', test: /\b(website|portfolio|personal url|github)\b/ },

  { key: 'source', test: /\bhow did you (hear|learn|find)\b|\bwhere did you (hear|learn|find)\b|^source\b|\breferral source\b/ },
  { key: 'previously_employed', test: /\b(previously|ever) (been )?(employed|worked)\b|\bformer (employee|worker)\b|\bworked (for|at|with) [a-z0-9 &'.-]+ (before|previously)\b|\bcurrent or former\b/ },

  { key: 'eeo.sexual_orientation', test: /\bsexual orientation\b/ },
  { key: 'eeo.transgender', test: /\btransgender\b/ },
  { key: 'eeo.hispanic_or_latino', test: /\bhispanic\b|\blatin[oax]\b/ },
  { key: 'eeo.race', test: /\brace\b|\bethnicit(y|ies)\b|\bethnic\b/ },
  { key: 'eeo.gender', test: /\bgender\b|^sex$|\bsex\b/ },
  { key: 'eeo.veteran', test: /\bveteran\b|\bmilitary\b|\barmed forces\b/ },
  { key: 'eeo.disability', test: /\bdisabilit(y|ies)\b|\bdisabled\b/ },

  { key: 'work_authorization.needs_sponsorship', test: /\bsponsor(ship)?\b|\bvisa\b|\bh-?1b\b/ },
  { key: 'work_authorization.authorized', test: /\bauthori[sz](ed|ation) to work\b|\bwork authori[sz]ation\b|\blegally (eligible|authori[sz]ed|permitted|able)\b|\bright to work\b|\beligible to work\b/ },
  { key: 'work_authorization.over_18', test: /\b18 years\b|\bage of 18\b|\bat least 18\b|\blegal (working )?age\b/ },

  { key: 'work.desired_salary', test: /\b(salary|compensation|pay) (expectation|requirement|range)s?\b|\bdesired (salary|pay|compensation)\b|\bexpected (salary|compensation)\b/ },
  { key: 'work.start_date', test: /\bstart date\b|\bavailable to start\b|\bearliest .*start\b|\bwhen can you start\b|\bnotice period\b/ },
  { key: 'work.relocate', test: /\brelocat/ },
  { key: 'work.onsite_ok', test: /\b(on-?site|in-?office|hybrid|commut)/ },
  { key: 'work.background_check', test: /\bbackground (check|screen)|\bdrug (test|screen)/ },
  { key: 'work.non_compete', test: /\bnon-?compete\b|\brestrictive covenant\b|\bnon-?solicit/ },
  { key: 'work.relatives', test: /\brelatives?\b|\bfamily members?\b.*\b(work|employ)/ },
  { key: 'work.government_official', test: /\b(government|public) official\b/ },
  { key: 'work.referred', test: /\b(were you|have you been) referred\b|\breferred by\b|\bemployee referral\b/ },

  { key: 'signature_name', test: /^(your )?(full )?name$|\bsignature\b/ },
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
      linkedin: str(personal.linkedin) || str(candidate.linkedin),
      website: str(personal.website) || str(candidate.portfolio_url) || str(candidate.github),
    },
    source: str(config.source),
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
export function createResolver({ config = {}, profile = {}, learned = {}, now, employer } = {}) {
  const answers = buildAnswerSet(config, profile, { now, employer });
  const userRules = compileUserRules(config.questions);
  const learnedMap = new Map(Object.entries(learned ?? {}).map(([k, v]) => [normalizeLabel(k), str(v)]));

  return function resolve(rawLabel) {
    const label = normalizeLabel(rawLabel);
    if (!label) return null;
    for (const rule of userRules) {
      if (rule.re.test(rawLabel) || rule.re.test(label)) return { answer: rule.answer, source: 'config', key: rule.re.source };
    }
    if (learnedMap.has(label)) return { answer: learnedMap.get(label), source: 'learned', key: label };
    for (const rule of BUILTIN_RULES) {
      if (!rule.test.test(label)) continue;
      if (rule.key === 'skip') return { answer: '', source: 'skip', key: 'skip' };
      const value = get(answers, rule.key);
      if (value) return { answer: value, source: 'builtin', key: rule.key };
      return null;
    }
    return null;
  };
}

const OPT_IN_RE = /\b(preferred name|text messag(e|es|ing)|sms|mms|marketing|newsletters?|job alerts?|talent community|promotional)\b/;

/** Opt-ins the candidate never asked for: SMS/text, marketing, job alerts, talent community, preferred name. */
export function isOptInLabel(label) {
  return OPT_IN_RE.test(normalizeLabel(label));
}

const AGREEMENT_RE = /\b(i agree|agree|acknowledge|consent|terms( and conditions| of (use|service))?|privacy (policy|notice|statement)|i certify|certif(y|ication)|attest|i confirm|i understand|i have read|read and understood|accept)\b/;

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

function tokens(s) {
  return normalizeLabel(s).split(' ').filter((t) => t.length > 1);
}

/**
 * Pick the option that best matches the desired answer.
 * Returns the index into `options`, or -1 when nothing is a credible match
 * (the caller then treats the question as unanswered instead of guessing).
 */
export function pickOption(desired, options) {
  const want = normalizeLabel(desired);
  if (!want || !Array.isArray(options) || options.length === 0) return -1;
  const opts = options.map((o) => normalizeLabel(o));
  const usable = (i) => opts[i] && !PLACEHOLDER_RE.test(opts[i]);

  const exact = opts.findIndex((o, i) => usable(i) && o === want);
  if (exact !== -1) return exact;

  if (YES.has(want) || NO.has(want)) {
    const prefix = YES.has(want) ? 'yes' : 'no';
    const i = opts.findIndex((o, idx) => usable(idx) && (o === prefix || o.startsWith(`${prefix} `) || o.startsWith(`${prefix},`)));
    if (i !== -1) return i;
    // "I am not a protected veteran" style: map yes/no onto negation words.
    const negated = (o) => /\b(not|no|don't|do not|am not|have not|none)\b/.test(o);
    const j = opts.findIndex((o, idx) => usable(idx) && !DECLINE_RE.test(o) && (prefix === 'no' ? negated(o) : !negated(o)));
    return j;
  }

  if (DECLINE_RE.test(want)) {
    const i = opts.findIndex((o, idx) => usable(idx) && DECLINE_RE.test(o));
    if (i !== -1) return i;
  }

  const starts = opts.findIndex((o, i) => usable(i) && (o.startsWith(want) || want.startsWith(o)));
  if (starts !== -1) return starts;

  const contains = opts.findIndex((o, i) => usable(i) && (` ${o} `.includes(` ${want} `) || ` ${want} `.includes(` ${o} `)));
  if (contains !== -1) return contains;

  const wantTokens = new Set(tokens(want));
  let best = -1;
  let bestScore = 0;
  opts.forEach((o, i) => {
    if (!usable(i)) return;
    const ot = new Set(tokens(o));
    let shared = 0;
    for (const t of wantTokens) if (ot.has(t)) shared++;
    const score = shared / Math.max(1, Math.min(wantTokens.size, ot.size));
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return bestScore >= 0.5 ? best : -1;
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
