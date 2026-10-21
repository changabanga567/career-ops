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
