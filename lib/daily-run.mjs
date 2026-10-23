/**
 * daily-run.mjs — pure helpers for daily-job-run.mjs: pick and order pipeline
 * leads, name exported resumes, count PDF pages, and render the tracker CSV.
 * No fs, no network, so each rule is testable on its own.
 */

/** Countries/cities that mark a lead as outside the U.S. when no U.S. marker is present. */
export const DEFAULT_NON_US = [
  'canada', 'toronto', 'vancouver', 'montreal', 'ontario', 'quebec',
  'united kingdom', 'uk', 'england', 'scotland', 'london', 'manchester', 'ireland', 'dublin',
  'germany', 'berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'france', 'paris', 'lyon',
  'spain', 'madrid', 'barcelona', 'portugal', 'lisbon', 'netherlands', 'amsterdam', 'belgium', 'brussels',
  'poland', 'warszawa', 'warsaw', 'kraków', 'krakow', 'wrocław', 'wroclaw', 'gdańsk', 'gdansk', 'poznań', 'poznan', 'łódź', 'lodz',
  'greece', 'athens', 'italy', 'milan', 'rome', 'switzerland', 'zurich', 'zürich', 'geneva', 'austria', 'vienna',
  'denmark', 'copenhagen', 'sweden', 'stockholm', 'norway', 'oslo', 'finland', 'helsinki',
  'czech', 'prague', 'hungary', 'budapest', 'romania', 'bucharest', 'ukraine', 'kyiv', 'estonia', 'tallinn',
  'india', 'bangalore', 'bengaluru', 'hyderabad', 'pune', 'mumbai', 'chennai', 'gurgaon', 'gurugram', 'noida', 'delhi',
  'singapore', 'australia', 'sydney', 'melbourne', 'new zealand', 'auckland', 'japan', 'tokyo', 'korea', 'seoul',
  'china', 'shanghai', 'beijing', 'shenzhen', 'hong kong', 'taiwan', 'taipei', 'philippines', 'manila', 'vietnam', 'malaysia',
  'mexico', 'brazil', 'são paulo', 'sao paulo', 'argentina', 'buenos aires', 'colombia', 'bogota', 'bogotá', 'chile', 'santiago', 'costa rica', 'peru', 'lima',
  'israel', 'tel aviv', 'uae', 'dubai', 'abu dhabi', 'saudi', 'riyadh', 'qatar', 'doha', 'egypt', 'cairo',
  'south africa', 'cape town', 'johannesburg', 'nigeria', 'lagos', 'kenya', 'nairobi',
  'emea', 'apac', 'latam', 'europe',
  'wolfsburg', 'stuttgart', 'cologne', 'köln', 'düsseldorf', 'dusseldorf', 'leipzig', 'dresden', 'nuremberg', 'nürnberg',
  'porto', 'palmela', 'seville', 'sevilla', 'bilbao', 'rotterdam', 'utrecht', 'eindhoven', 'the hague', 'antwerp', 'ghent',
  'gothenburg', 'malmö', 'malmo', 'aarhus', 'cork', 'galway', 'edinburgh', 'glasgow', 'katowice', 'lublin', 'szczecin',
  'bratislava', 'ljubljana', 'zagreb', 'belgrade', 'sofia', 'vilnius', 'riga', 'luxembourg', 'monaco',
];

// German-language postings mark gender in the title: "(f/m/d)", "(m/w/d)".
const NON_US_TITLE_RE = /\((?:[fmwdx]\s*\/\s*){2}[fmwdx]\)|(?:m\/w\/d|w\/m\/d)/i;

const US_STATE_CODES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';

const US_CODE_RE = new RegExp(`(^|[\\s,(·-])(${US_STATE_CODES})($|[\\s,)·-])`);

function looksUs(location) {
  const loc = String(location ?? '');
  return /united states|\bu\.s\.a?\b|\busa\b|\bamerica\b/i.test(loc) || US_CODE_RE.test(loc);
}

/** True when the location names a non-U.S. place and nothing U.S. Unknown or blank locations stay in. */
export function looksNonUs(location, nonUs = DEFAULT_NON_US) {
  const loc = String(location ?? '').trim();
  if (!loc) return false;
  // State codes must be upper-case ("LA - New Orleans"), so "la" in a word never counts.
  if (looksUs(loc)) return false;
  const lower = loc.toLowerCase();
  return nonUs.some((place) => new RegExp(`(^|[^\\p{L}])${place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(lower));
}

/** `- [ ] url | company | title | location | posted: YYYY-MM-DD` lines under any heading. */
export function parsePipeline(text) {
  const items = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*-\s*\[ \]\s*(https?:\/\/\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    const fields = m[2].replace(/^\s*\|/, '').split('|').map((p) => p.trim());
    const posted = fields.map((f) => /^posted:\s*(\d{4}-\d{2}-\d{2})$/.exec(f)?.[1]).find(Boolean) ?? null;
    const plain = fields.filter((f) => !/^posted:/.test(f));
    items.push({ url: m[1], company: plain[0] ?? '', title: plain[1] ?? '', location: plain[2] ?? '', posted, line });
  }
  return items;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Order leads for evaluation: postings inside the `sinceDays` window first
 * (newest first), then undated leads (newest added last in the file, so
 * reversed), then older postings. Drops non-U.S. leads and URLs already tried.
 */
export function rankLeads(items, { today, sinceDays = 1, attempted = new Set(), nonUs = DEFAULT_NON_US } = {}) {
  const kept = [];
  const dropped = [];
  items.forEach((item, order) => {
    if (attempted.has(item.url)) return dropped.push({ ...item, why: 'already evaluated' });
    if (looksNonUs(item.location, nonUs)) return dropped.push({ ...item, why: `outside the U.S. (${item.location})` });
    if (NON_US_TITLE_RE.test(item.title) && !looksUs(item.location)) return dropped.push({ ...item, why: 'German-market posting' });
    const age = item.posted ? daysBetween(item.posted, today) : null;
    const bucket = age == null ? 1 : age <= sinceDays ? 0 : 2;
    kept.push({ ...item, age, bucket, order });
  });
  kept.sort((a, b) => a.bucket - b.bucket || (a.age ?? 0) - (b.age ?? 0) || b.order - a.order);
  return { leads: kept, dropped };
}

/** Windows-safe "EbaadG-Technical Project Manager.pdf". */
export function resumeFileName(prefix, title, suffix = '') {
  const clean = String(title ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 120) || 'Resume';
  const extra = suffix ? ` (${String(suffix).replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').trim()})` : '';
  return `${prefix}${clean}${extra}.pdf`;
}

/**
 * Page count of a PDF. Chromium writes one `/Type /Page` dictionary per page
 * and a `/Count N` on the page tree; take the page-tree count when present.
 */
export function pdfPageCount(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
  const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)].map((m) => Number(m[1] ?? m[2]));
  if (counts.length) return Math.max(...counts);
  return (text.match(/\/Type\s*\/Page(?!s)\b/g) || []).length;
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Excel-friendly CSV (UTF-8 BOM) of tracker rows, newest first. */
export function trackerCsv(rows) {
  const header = ['Date', 'Company', 'Role', 'Score', 'Status', 'How to apply', 'Resume', 'Job URL', 'Notes'];
  const sorted = [...rows].sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.num - a.num);
  const lines = [header, ...sorted.map((r) => [r.date, r.company, r.role, r.score, r.status, r.howToApply, r.resume, r.url, r.notes])];
  return `﻿${lines.map((l) => l.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
