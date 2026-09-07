# Mintorian.com

Bilal Ahmad's personal research website, including **Ask Mintorian**: a grounded AI research and collaboration assistant.

Ask Mintorian appears in the existing bottom-right page-action dock on every canonical page. Its interface is a lazily loaded, accessible dialog that works on desktop and mobile without changing the site's visual language.

## What is included

- A verified 44-record knowledge base covering research, publications, projects, education, experience, skills, awards, conference presentations, professional events, public recommendations, extracurricular interests, travel and contact routes.
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

- `api.carbonintensity.org.uk` — intensity now, `pt24h` history and the national
  mix. Its mix includes embedded solar and small wind, so its **shares** are the
  headline.
- `data.elexon.co.uk` — half-hourly metered output in MW. Elexon meters
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

## Contingency screening demonstration

`/contingency/` carries an interactive N-1 screen on the IEEE 14-bus test system.
Trip any line and a full Newton-Raphson AC power flow re-solves in the browser -
one base case plus twenty single-outage cases per interaction, a few milliseconds
in total, so nothing is precomputed.

The solver is in [`js/lib/powerflow.js`](js/lib/powerflow.js) and is the part that
has to be right. [`tests/powerflow.test.js`](tests/powerflow.test.js) checks it
against the case's own published IEEE solution (agreeing to 0.0013 pu and 0.02
degrees), against the known 13.39 MW of base-case losses, and on the physics that
should hold regardless: the slack picks up generation, load and losses exactly;
lossless transformers lose nothing; PV buses hold their setpoint.

The page is deliberately the **classical** screen - the active-power performance
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

- `js/assistant-loader.js` — lightweight page integration and API-base selection.
- `js/ask-mintorian.js` — dialog, streaming chat, forms and accessible interactions.
- `css/ask-mintorian.css` — responsive component styles.
- `data/mintorian-knowledge.json` — verified, auditable source records.
- `worker/src/` — API, model orchestration, retrieval, email delivery and security controls.
- `js/github-activity.js` — contribution calendar rendering, tooltips and keyboard navigation.
- `js/grid-now.js` — live grid strip: feed parsing, the mix bar and the 24-hour sparkline.
- `js/lib/powerflow.js` — Newton-Raphson AC power flow, N-1 screen and the severity index.
- `js/contingency.js` — the demonstration's one-line diagram, interaction and ranked table.
- `data/case14.json` — IEEE 14-bus case, converted from MATPOWER, with assumed ratings.
- `scripts/build-github-activity.mjs` — daily rebuild of `data/github-activity.json`.
- `tests/` — retrieval, security, agent, Worker, activity-calendar, grid-strip, power-flow and live-model evaluation coverage.
