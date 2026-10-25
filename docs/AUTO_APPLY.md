# Workday auto-apply

`auto-apply-workday.mjs` fills a Workday application end to end with the tailored CV career-ops generated for that job.

What it does on each posting:

1. Opens the posting, clicks **Apply**, then **Apply Manually**.
2. Signs in with your one shared login. Every company's Workday is a separate account, so if sign-in fails it creates the account on that tenant with the same email and password and ticks the account terms box.
3. Walks every step (My Information, My Experience, Application Questions, Voluntary Disclosures, Self Identify). It uploads the tailored PDF, answers each question from `config/auto-apply.yml` and `config/profile.yml`, and ticks the terms, consent and acknowledgement boxes. It leaves SMS, marketing, job-alert and preferred-name opt-ins unticked.
4. Stops on the **Review** page and leaves the browser open. With `--submit` it clicks Submit, waits for the confirmation, and marks the tracker row `Applied` when you pass `--report`.

## Setup

```bash
cp config/auto-apply.example.yml config/auto-apply.yml   # your answers (gitignored)
```

Add the login to `.env` (gitignored):

```bash
WORKDAY_EMAIL=you@example.com
WORKDAY_PASSWORD=Your-Strong-Pass1!
```

Most tenants require at least 8 characters with uppercase, lowercase, a number and a special character. The script warns you before the run if the password falls short.

## Running

```bash
# One job: fill everything, stop at Review
node auto-apply-workday.mjs --url "https://acme.wd5.myworkdayjobs.com/..." --report 12

# Same, and submit
node auto-apply-workday.mjs --url "https://acme.wd5.myworkdayjobs.com/..." --report 12 --submit

# Many jobs, one per line: <url> [pdf] [report=N]
node auto-apply-workday.mjs --batch jobs.txt --submit
```

When you omit `--pdf`, `--report N` picks the newest tailored PDF for that report in `output/`.

## Questions the config doesn't cover

In a normal (visible, interactive) run, the script asks you in the terminal the first time it meets a required question it can't answer, shows the real options, and saves your answer to `data/auto-apply/learned-answers.json`. That question is answered automatically from then on.

With `--headless` or `--no-prompt`, it skips that job and logs it as `needs_input` with the question text. Add a `questions:` rule to `config/auto-apply.yml` and rerun.

## Records

`data/auto-apply/` (gitignored):

- `log.jsonl`: one line per attempt with its status. A URL already logged as `submitted` is skipped unless you pass `--force`.
- `learned-answers.json`: answers you typed in the terminal.
- `screenshots/`: the Review page, the confirmation page, and any page where a run got stuck.

Exit code 2 means at least one job did not end as submitted, ready for review, or already applied.

## Limits

- Workday only (`myworkdayjobs.com`, `myworkdaysite.com`).
- A tenant that sends a verification email for new accounts pauses the run until you click the link. In headless mode it logs `needs_verification` instead.
- CAPTCHA and SSO-only tenants are not handled. The job ends as `stuck` or `auth_failed` with a screenshot.
- Workday tenants customize their questions. The first run against a new company may stop to ask you something. Later runs reuse the answer.

## The daily run: find, tailor, export, apply, track

`daily-job-run.mjs` runs the whole loop in one command:

1. **Scan** for postings from the last `daily.since_days` (default 1): your tracked companies (`scan.mjs`) and every company on the ATSs in `daily.scan_full_ats` (`scan-ats-full.mjs`).
2. **Evaluate** the newest U.S. leads first, up to `daily.max_evaluations` per run. Leads in obviously non-U.S. places are skipped before any AI time is spent. For each lead, a headless agent (`claude -p`, or `codex exec`) runs the career-ops auto-pipeline: liveness, location, pay floors, blacklist and duplicate checks, the report, and, when the job scores at least `daily.min_score`, a tailored resume rendered with `--max-pages=1 --strict-pages`. Each lead is tried once.
3. **Export** every new tailored resume to `daily.export_dir` as `<resume_prefix><Job Title>.pdf`. Only one-page PDFs are copied; anything longer is reported instead. A newer resume for a job with the same title overwrites the older file. The first run copies only resumes made from that day on; `--export-all` copies the older ones too.
4. **Apply** with `auto-apply-workday.mjs --from-tracker` to Workday jobs, newest first, up to `daily.apply_limit`.
5. **Track** by rebuilding `Job-Tracker.csv` in the same folder from `data/applications.md`: date, company, role, score, status, whether it can be auto-applied, the resume file, and the job link. It opens in Excel. If Excel has it open, the run writes `Job-Tracker (latest).csv` instead.

```bash
node daily-job-run.mjs --dry-run      # show the plan, change nothing
node daily-job-run.mjs                # everything, stopping each application at Review
node daily-job-run.mjs --submit       # everything, submitting
```

The evaluation agent never gets blanket permissions, because job postings are written by strangers and can hide instructions. It may read files and fetch web pages, run this folder's own scripts as `node <script>.mjs` (never `node -e`, and never `auto-apply-workday.mjs` or `daily-job-run.mjs`), and edit files only under `reports/`, `output/`, `data/`, `jds/`, `batch/tracker-additions/`, `interview-prep/` and the temp folder, never the code it runs. Applying and submitting stay with the scripts you start yourself.

If an evaluation reports a permission it was denied that it really needs, add that one rule under `daily.extra_allowed_tools` (for example `- "Bash(git status:*)"`) rather than loosening everything.

### Run it on a schedule (Windows)

From a Command Prompt in the `career-ops` folder, this runs it every morning at 7:55:

```
schtasks /Create /SC DAILY /ST 07:55 /TN "career-ops daily" /TR "cmd /c cd /d \"%CD%\" && node daily-job-run.mjs --submit >> data\auto-apply\daily.log 2>&1"
```

Scheduled runs can't ask questions, so a job with a new question is skipped and logged as `needs_input`. Run `node auto-apply-workday.mjs --from-tracker` by hand now and then to answer those questions; each answer is remembered. Remove the schedule with `schtasks /Delete /TN "career-ops daily"`.
