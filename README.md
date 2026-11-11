# Mintorian.com

Bilal Ahmad's personal research website, including **Ask Mintorian**: a grounded AI research and collaboration assistant.

Ask Mintorian appears in the existing bottom-right page-action dock on every canonical page. Its interface is a lazily loaded, accessible dialog that works on desktop and mobile without changing the site's visual language.

## What is included

- A verified 54-record knowledge base covering research, publications, projects, education, experience, skills, awards, conference presentations, professional events, public recommendations, extracurricular interests, travel and contact routes.
- A Cloudflare Worker API with OpenAI Responses API tool calling and streamed answers.
- Six deterministic, read-only tools for profile search, publication search, project lookup, section lookup, contact options and calendar-integration status.
- Contact and meeting-request forms with server-side validation, honeypot protection and optional Resend delivery.
- Origin checks, request-size limits, pseudonymous rate limiting, safe error messages and deterministic prompt-injection refusal.
- Automated unit/integration tests plus a live-model evaluation suite.

The assistant cannot browse the web, alter site content, execute arbitrary actions or claim a meeting is booked. Every factual answer about Bilal must come from the version-controlled knowledge base in [`data/mintorian-knowledge.json`](data/mintorian-knowledge.json).

## Local setup

Requirements: Node.js 20 or newer and a current Python installation (only needed for the simple static-file server below).

1. Install the Worker development dependency:

   ```powershell
   npm install
   ```

2. Copy `worker/.env.example` to `worker/.env`, then add your OpenAI key:

   ```dotenv
   OPENAI_API_KEY=your_key_here
   ```

   `worker/.env` is ignored by Git. The browser never receives the key.

3. Start the API in one terminal:

   ```powershell
   npm run dev:api
   ```

4. Start the website in a second terminal:

   ```powershell
   python -m http.server 8000
   ```

5. Open `http://127.0.0.1:8000/`. On localhost the frontend automatically uses `http://127.0.0.1:8787` for the API.

If your static server uses another allowed port, set `data-api-base` on the assistant loader script or update `ALLOWED_ORIGINS` in `worker/wrangler.jsonc`.

## Model and privacy defaults

The default model is `gpt-5.6-luna` with reasoning effort set to `none` for the lowest reasoning overhead. Override it without changing code by setting `AI_MODEL` and `AI_REASONING_EFFORT` in the Worker environment.

Requests use the OpenAI Responses API with `store: false`, so OpenAI retains nothing.

Mintorian records one row per question in the `ask-mintorian-insights` D1 database: the question text, the search terms the model used, which verified records were returned, and whether the turn was grounded. It records no IP address, no session identifier and no assistant answer, and rows are deleted after 90 days by the Monday digest job. That row exists to show which questions the knowledge base cannot yet answer; do not extend it with anything that identifies a visitor.

So a conversation follows the visitor between pages, the widget saves it in the tab's `sessionStorage` under `ask-mintorian:session`: the last 40 messages, the follow-up suggestions and whether the panel was open. It stays in that browser tab, is never sent to the Worker, and clears when the tab closes. Contact and meeting form fields are deliberately not saved.

## Personal reminders

The same database holds a `reminders` table for reminders you set yourself. A cron every five minutes emails any that are due, through Resend, to `DIGEST_TO_EMAIL` (or `CONTACT_TO_EMAIL`). Add `--for wife` to send one to the address in the `REMINDER_TO_WIFE` secret instead; her replies go to you. Rows hold only the recipient key, never an address. Times without an offset are UK time. The script needs `npx wrangler login`.

```bash
npm run reminder -- add --at "2026-10-10 09:00" --title "Submit the review" --notes "Optional detail"
npm run reminder -- add --at "2026-10-10 17:00" --title "Pick up the parcel" --for wife
npm run reminder -- list
npm run reminder -- cancel <id>
npm run reminder -- import sessions.ics --before 1d,2h --dry-run
```

`import` turns each event in an `.ics` file into one reminder per lead time (`1d`, `2h`, `30m`). Floating and `Europe/London` times are read as UK time. Re-importing the same calendar adds only what is missing.

## Optional email delivery

The assistant remains useful with only `OPENAI_API_KEY`. Contact and meeting forms show a safe email fallback until these values are configured:

```dotenv
RESEND_API_KEY=re_...
CONTACT_TO_EMAIL=connect@mintorian.com
CONTACT_FROM_EMAIL="Mintorian Website <website@updates.mintorian.com>"
```

Before enabling production delivery, verify the sending subdomain (for example `updates.mintorian.com`) in Resend and publish the DNS records it provides. The meeting form sends a request only; it never presents unverified calendar availability or confirms a booking.

## Verification

Run the local checks and mocked test suite:

```powershell
npm run check
npm test
```

With the API running and an OpenAI key in `worker/.env`, run the 12 live behavior evaluations:

```powershell
npm run test:live
```

They cover research, PhD, publications, BESS overlap, clean-energy alignment, professional events, public recommendations, verified employment links, extracurricular interests and travel, a false employment premise, prompt injection and meeting-booking honesty. To evaluate a deployed API, set `MINTORIAN_API_BASE` and, if needed, `MINTORIAN_TEST_ORIGIN`.

Validate the production Worker bundle without deploying:

```powershell
npx wrangler deploy --dry-run --config worker/wrangler.jsonc
```

## Production deployment

1. Authenticate Wrangler and add secrets. Do not put production secrets in `wrangler.jsonc`:

   ```powershell
   npx wrangler login
   npx wrangler secret put OPENAI_API_KEY --config worker/wrangler.jsonc
   npx wrangler secret put RATE_LIMIT_SALT --config worker/wrangler.jsonc
   ```

   Add `RESEND_API_KEY`, `CONTACT_TO_EMAIL` and `CONTACT_FROM_EMAIL` the same way when enabling form delivery.

2. The production configuration already binds its distributed rate-limit namespace as `RATE_LIMIT_KV`. When deploying a copy into another Cloudflare account, create a replacement namespace and update the configuration automatically:

   ```powershell
   npx wrangler kv namespace create ask-mintorian-rate-limit --binding RATE_LIMIT_KV --update-config --config worker/wrangler.jsonc
   ```

3. Production uses `https://ask-mintorian-api.dystil-ai.workers.dev`. The loader can be pointed at another deployment using its `data-api-base` attribute if the endpoint changes.

4. Deploy:

   ```powershell
   npm run deploy:api
   ```

5. Confirm `/v1/health` reports the expected model and enabled integrations, then run `npm run test:live` against the deployed base URL.

For production, leave `ALLOWED_ORIGINS` restricted to the Mintorian domains and keep the KV binding enabled. Without KV, the Worker uses a best-effort in-memory limiter intended for local development only.

## Market Explorer

[`/tools/`](tools/index.html) lets visitors look up any company listed on India's
National Stock Exchange (NSE) or the US exchanges, NYSE and Nasdaq, by ticker,
name or ISIN, and links each one to its quote, chart and filings. The Professional
section of the Updates page links to it.

The page is static: it searches `data/markets/india.json` and `data/markets/us.json`
in the browser with [`js/lib/market-search.js`](js/lib/market-search.js). Those files
are rebuilt every Monday by the `Market listings` workflow in
[`.github/workflows/market-listings.yml`](.github/workflows/market-listings.yml), which
runs [`scripts/build-market-listings.mjs`](scripts/build-market-listings.mjs) and
commits any change. Its sources are all public:

- India: NSE's equity list (`EQUITY_L.csv`), with industries from the Nifty Total Market index.
- United States: Nasdaq Trader's two symbol directories, one for Nasdaq listings and one
  for other exchanges (kept to NYSE), with CIKs from the SEC. Only companies' shares are
  kept (ETFs, preferreds, warrants, units and notes are left out), and each company
  names the exchange it lists on, with its tier for Nasdaq.

### US financials

Each US company card also shows, each statement linked to the SEC filing it came from:

- **Income statement** (latest full year): revenue, cost of revenue, gross profit, R&D,
  SG&A, operating income, interest expense and income, income tax, net income.
- **Balance sheet** (latest quarter): total and current assets, cash, short-term
  investments, receivables, inventory, property and equipment, goodwill, total and
  current liabilities, total debt, shareholders' equity.
- **Cash flow** (latest full year): operating cash flow, capital expenditure, free cash
  flow, dividends paid, share buybacks.
- **Per share**: diluted and basic EPS, dividends per share, shares outstanding.
- **Ratios and growth**, worked out in the browser by
  [`js/lib/financials.js`](js/lib/financials.js): gross, operating and net margin,
  return on equity, debt to assets, current ratio, and revenue, net income and EPS
  growth on the year before. The same weekly workflow runs
[`scripts/build-us-financials.mjs`](scripts/build-us-financials.mjs) after the listings,
which reads the SEC's free XBRL "frames" API (`data.sec.gov`): one request returns one
figure for every company for one period, so about 300 requests cover the whole market.
It writes `data/markets/us-financials.json`, which the page loads the first time a US
company is opened.

Each statement is taken from a single period (the latest quarter a company reported
total assets for, and the latest year it reported net income or revenue for), so figures
are never mixed across quarters. Only US-dollar figures are read, so foreign companies
that report in another currency show no financials yet. Share prices, and so market
capitalisation and P/E, are not part of SEC filings and are not included.

### Live prices (US)

A US company card shows its latest price and the day's change, refreshed each minute
while the card is open, with market cap and P/E worked out from the SEC figures
(shares outstanding and last fiscal year's diluted EPS; market cap is left out for
companies with several share classes, and P/E after a loss).

The page asks the Worker's `GET /v1/quote?symbol=AAPL`
([`worker/src/quotes.js`](worker/src/quotes.js)), which calls Finnhub with the
`FINNHUB_API_KEY` Worker secret, so the key never reaches the browser. Quotes are cached
for a minute, calls to Finnhub share a per-minute budget kept below the free plan's 60
(`QUOTE_UPSTREAM_PER_MINUTE`, default 50), and each visitor is rate limited
(`QUOTE_RATE_LIMIT`, default 60 a minute). Check that your Finnhub plan allows prices to
be shown on a public website.

### Deploying the Worker from GitHub

The `Deploy Worker` workflow ([`.github/workflows/deploy-worker.yml`](.github/workflows/deploy-worker.yml))
tests and deploys the Worker whenever `worker/` changes on `main`, or by hand from the
Actions tab. Add two repository secrets under Settings → Secrets and variables → Actions:

- `CLOUDFLARE_API_TOKEN`: a Cloudflare API token made from the "Edit Cloudflare Workers"
  template, limited to this account.
- `FINNHUB_API_KEY`: stored as the Worker secret of the same name on each deploy.

Without the token the workflow stops without deploying. Secrets already on the Worker
are left as they are.

### Shariah screen (US)

Each US company is screened on the Hanafi conditions Mufti Muhammad Taqi Usmani sets
for owning shares, in *Principles of Shari'ah Governing Islamic Investment Funds* and
the equity-fund chapter of *An Introduction to Islamic Finance*. His four conditions are
that the main business be permissible; that the shareholder object to any interest
dealing rather than consent to it; that interest income be given away; and that the
shares be negotiable, which on the Hanafi view they are whatever the proportion of
liquid assets, so long as the illiquid part is "not in ignorable quantity" and the price
exceeds the liquid amount the share represents.

Usmani fixes no percentage himself, so the thresholds are the six criteria of the
[KMI-30 index methodology](https://www.psx.com.pk/psx/themes/psx/uploads/KMI_30-Index-(New-Broucher).pdf),
whose companies are screened by Al Meezan, under the Shariah board he chairs. Where the
SEC figures are coarser than KMI's definitions, the screen takes the stricter reading:
all cash counts as interest-bearing (KMI counts only interest-bearing deposits), every
security counts as liquid (KMI counts shares in compliant companies as illiquid), and
interest income is set against revenue alone (KMI adds other income). The rules live in
[`js/lib/shariah-screen.js`](js/lib/shariah-screen.js), shared by the build and the page:

- **Business activity**, from the company's SEC industry code (SIC):
  conventional banking, lending, securities dealing and insurance, investment funds,
  alcohol, film and cinemas, and recorded music fail; REITs, hotels, amusement and
  recreation, and meat packing need review, because the code covers both kinds of
  company. Tobacco and weapons need review too: neither Usmani's conditions nor KMI name
  them as forbidden, and scholars differ on both. So does a group's **generic** code, which the SEC often assigns in
  place of the specific one: Brown-Forman and Coca-Cola are both filed under 2080
  (beverages) and Live Nation under 7900 rather than 7990, so passing those would label
  a distiller halal. Broadcasting and streaming (4832, 4833, 4841, 7841) need review for
  the same reason: the 1987 classification put film and music on 7812–7833 and 3652,
  which still catch a studio or a cinema chain, but the SEC files Netflix under video
  rental, from its DVD-by-post days, and Comcast under cable television although it owns
  a film studio. Poultry slaughtering (2015) needs review too: KMI rules out selling
  haram meat as well as pork, and US poultry is not, as a rule, slaughtered the Islamic way.
- **Illiquid assets ÷ total assets** at least 25%, liquid being cash, the securities it
  is parked in, and receivables — a debt owed in money is money. This is the numeric
  form of "not in ignorable quantity".
- **Interest-bearing debt ÷ total assets** below 37%. Finance leases and preference
  shares count as debt, as KMI defines it. Debt is never assumed to be zero: when it
  cannot be read, total liabilities (which debt cannot exceed) under the limit still
  prove a pass, and short-term debt alone over it proves a failure; otherwise the
  company cannot be screened.
- **Cash and interest-bearing securities ÷ total assets** below 33%, KMI's figure,
  counting short-term investments and long-term debt securities.
- **Interest income ÷ revenue** below 5%. Where interest income is not reported on its
  own it is bounded the same way as debt: positive net interest (earned less paid) at
  or over 5% proves a failure, and interest and other income together under 5% prove a
  pass. Where neither settles it, the test is left out and the card says so. The same
  share is shown as the dividend purification rate ("up to" or "at least" when it
  comes from a bound), with Usmani's note that purifying capital gains in the same
  proportion is the more cautious view.
- **Market price vs net liquid assets per share**, the price having to exceed
  `(liquid assets − total liabilities) ÷ shares`. This needs a live price, so only the
  card runs it, once the quote arrives; the weekly build leaves it out. Usmani calls a
  failure here "merely a theoretical possibility", so where the price, the share count or
  the liabilities are missing it is left out rather than counted unknown.

A company is *Shariah compliant* when it passes all of them, *not compliant* when it
fails any, *needs review* when only its industry is unclear, *not enough data* when the
filings leave a figure unreadable, and *no SEC figures to screen* when there is no
balance sheet at all — mostly funds, trusts and foreign filers, kept separate so the
genuine data gaps stay visible. Over the 5,585 listed companies that comes out at
roughly 1,590 compliant, 2,610 not, 850 with nothing to screen, 430 short of a figure
and 105 needing review.

Known limits. The industry code shows only a company's main business, so revenue from a
non-permissible side line is not caught — KMI's 5% test counts that income too, which
needs segment data the SEC frames do not carry. About 1,000 of the compliant companies
report no interest income figure, so their 5% test has not run. Two further generic codes are left passing rather than
flagged, for want of a better signal: 2000 (food, which may include pork) and 5900
(retail, which covers pawn lending and adult titles); the companies under them that are
clearly out fail the financial tests anyway. Standards also differ between scholars, and
AAOIFI and the Dow Jones Islamic index measure debt against market capitalisation rather
than total assets, which is markedly more permissive — Coca-Cola's debt is 38.5% of its
assets but 10.1% of its market cap.

The weekly workflow runs [`scripts/build-us-industries.mjs`](scripts/build-us-industries.mjs),
which caches each company's SIC code from the SEC (`data/markets/us-industries.json`;
new companies plus a few hundred re-checks a week), then
[`scripts/build-us-screening.mjs`](scripts/build-us-screening.mjs), which writes each
company's status and industry to `data/markets/us-screening.json` for the search
results. The card works the screen out again to show each check.

To rebuild locally (needs network access to those sites):

```powershell
npm run build:markets
npm run build:industries
npm run build:financials
npm run build:screening
```

## GitHub commit activity

The home page carries a contribution calendar under **Commit Activity**. The site is
static on GitHub Pages, so the browser holds no credential and calls no API: it reads
`data/github-activity.json` from this repository.

That file is rebuilt daily by the `GitHub activity` workflow in
[`.github/workflows/github-activity.yml`](.github/workflows/github-activity.yml), which
runs [`scripts/build-github-activity.mjs`](scripts/build-github-activity.mjs) and commits
the result. The workflow uses the automatic `GITHUB_TOKEN` that Actions mints for each
run, so no repository secret has to be created or rotated. If that token is missing or
lacks the scope, the script falls back to the public contributions calendar at
`https://github.com/users/<login>/contributions`, which needs no credential.

The login comes from `github.repository_owner`, so nothing is hardcoded to one account.
Run it by hand from the Actions tab (**Run workflow**) or locally:

```powershell
npm run build:activity
```

The workflow needs `contents: write`, which it requests itself. If the repository is set
to *Read repository contents permission* under **Settings → Actions → General → Workflow
permissions**, that request still applies; the setting only changes the default.

## GB grid strip

The home page carries a live band under **About**: current carbon intensity, the
past 24 hours, the national generation mix and transmission-metered output.

Unlike the calendar above, this one is genuinely live. Both feeds send
`Access-Control-Allow-Origin: *`, so the browser calls them directly and the page
stays static with no key, no build step and no Worker in the path:

- `api.carbonintensity.org.uk`, intensity now, `pt24h` history and the national
  mix. Its mix includes embedded solar and small wind, so its **shares** are the
  headline.
- `data.elexon.co.uk`, half-hourly metered output in MW. Elexon meters
  transmission only, so its totals exclude that embedded generation. The two are
  rendered in separate blocks, labelled as such, and never added together.

Each feed is settled independently, so the strip still renders on whichever ones
answered. It re-reads every five minutes, but only while the tab is in front.

The seven fuel colours in `css/custom.css` are a validated categorical set: they
were assigned in the fixed segment order used by `js/grid-now.js` and checked
pair by pair for colour-vision separation, including the orders left over when a
fuel reads zero and its neighbours meet. That is also why the bar is never sorted
by share, and why it draws seven segments while the details table under it lists
all nine fuels the feed reports. Re-run that check before changing any of them.

## Research page

`/research/` collects the interactive work. It is a list of projects: each one is
an `<article class="project">` with its own anchor, so adding the next is
appending a block, and the divider rule keeps the first from wearing a rule above
nothing. The page shell (`.section-research`, `.project`) lives in `custom.css`
with the other section styles; a project's own component styles live beside it,
as `css/contingency.css` does.

This page replaced the Flexible Future Power Networks Group page, which has been
retired from the site. `/researchgroup/`, `/contingency/` and the two legacy
`pages/researchgroup*` paths are now redirect stubs, since GitHub Pages has no
server-side redirects and those URLs were published. `/contingency/` points at
`/research/#contingency` so shared links still land on the demonstration itself.

### Project 01 - contingency screening

An interactive N-1 screen on the IEEE 14-bus test system. Trip any line and a
full Newton-Raphson AC power flow re-solves in the browser - one base case plus
twenty single-outage cases per interaction, a few milliseconds in total, so
nothing is precomputed.

The solver is in [`js/lib/powerflow.js`](js/lib/powerflow.js) and is the part that
has to be right. [`tests/powerflow.test.js`](tests/powerflow.test.js) checks it
against the case's own published IEEE solution (agreeing to 0.0013 pu and 0.02
degrees), against the known 13.39 MW of base-case losses, and on the physics that
should hold regardless: the slack picks up generation, load and losses exactly;
lossless transformers lose nothing; PV buses hold their setpoint.

It is deliberately the **classical** screen - the active-power performance
index - and says so. It makes no claim about the learned, explainable ranking that
the research is actually about. What it does show is why that research exists:
raise demand past about 110% and the index starts misordering, sinking outages
that cause real overloads below ones that cause none. That failure is called
masking, and it is pinned down by a test rather than asserted in prose.

Two things about the data are worth knowing, and both are stated on the page:

- **Ratings are assumed.** The IEEE case lists every branch limit as 0, so the
  ratings in `data/case14.json` are ours - round values above base-case flow, set
  so the intact network is secure with margin and some outages are not.
- **The voltage band is widened to 0.94-1.10 pu.** The case states 1.06 while
  scheduling generators at 1.07 and 1.09, so its own published solution breaches
  that limit at buses 6, 7 and 8. Widening it means a violation on the page is
  caused by the outage rather than by the data.

Generation does not re-dispatch and generator VAr limits are not enforced, the
latter matching the default the reference solution was produced under.

## Main files

- `js/assistant-loader.js`, lightweight page integration and API-base selection.
- `js/ask-mintorian.js`, dialog, streaming chat, forms and accessible interactions.
- `css/ask-mintorian.css`, responsive component styles.
- `data/mintorian-knowledge.json`, verified, auditable source records.
- `worker/src/`, API, model orchestration, retrieval, email delivery and security controls.
- `js/github-activity.js`, contribution calendar rendering, tooltips and keyboard navigation.
- `js/grid-now.js`, live grid strip: feed parsing, the mix bar and the 24-hour sparkline.
- `js/lib/powerflow.js`, Newton-Raphson AC power flow, N-1 screen and the severity index.
- `js/contingency.js`, the demonstration's one-line diagram, interaction and ranked table.
- `data/case14.json`, IEEE 14-bus case, converted from MATPOWER, with assumed ratings.
- `scripts/build-github-activity.mjs`, daily rebuild of `data/github-activity.json`.
- `tests/`, retrieval, security, agent, Worker, activity-calendar, grid-strip, power-flow and live-model evaluation coverage.
