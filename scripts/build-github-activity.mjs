// Regenerates data/github-activity.json, the file the commit-activity section on
// the home page reads.
//
// The site is served by GitHub Pages, so the browser must never hold a token and
// there is no server to proxy through. The data is therefore fetched here, in a
// scheduled GitHub Action, and committed as a static file.
//
//   node scripts/build-github-activity.mjs [--login <user>] [--out <path>]
//
// With GITHUB_TOKEN (or GH_TOKEN) in the environment it uses the GraphQL
// contributions API; without one it falls back to the public contributions
// calendar, which needs no credential.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fromGraphQl, fromPublicCalendar, serialise } from "./lib/github-contributions.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LOGIN = "BilalAhmad096";
const DEFAULT_OUT = "data/github-activity.json";
const USER_AGENT = "mintorian.com-activity-build";

const CALENDAR_QUERY = `query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays { date contributionCount contributionLevel }
        }
      }
    }
  }
}`;

function readArgs(argv) {
  const args = { login: process.env.GITHUB_ACTIVITY_LOGIN || DEFAULT_LOGIN, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--login") args.login = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  return args;
}

async function fetchFromGraphQl(login, token) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT
    },
    body: JSON.stringify({ query: CALENDAR_QUERY, variables: { login } })
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed with ${response.status} ${response.statusText}`);
  }

  return fromGraphQl(await response.json(), login);
}

async function fetchFromPublicCalendar(login) {
  const response = await fetch(`https://github.com/users/${encodeURIComponent(login)}/contributions`, {
    headers: { Accept: "text/html", "User-Agent": USER_AGENT }
  });

  if (!response.ok) {
    throw new Error(`Public calendar request failed with ${response.status} ${response.statusText}`);
  }

  return fromPublicCalendar(await response.text(), login);
}

async function collect(login) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  if (token) {
    try {
      return await fetchFromGraphQl(login, token);
    } catch (error) {
      // A missing scope or a transient API failure should not leave the site
      // showing stale data when an unauthenticated route is available.
      console.warn(`GraphQL calendar unavailable (${error.message}); using the public calendar.`);
    }
  }

  return fetchFromPublicCalendar(login);
}

async function main() {
  const { login, out } = readArgs(process.argv.slice(2));
  const target = resolve(REPO_ROOT, out);

  const activity = await collect(login);
  const contents = serialise(activity);
  const previous = await readFile(target, "utf8").catch(() => null);

  if (previous === contents) {
    console.log(`No change: ${out} already matches ${login}'s calendar.`);
    return;
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
  console.log(
    `Wrote ${out} from ${activity.source}: ${activity.totalContributions} contributions ` +
    `across ${activity.days.length} days (${activity.from} to ${activity.to}).`
  );
}

main().catch(error => {
  console.error(`Could not build the GitHub activity file: ${error.message}`);
  process.exitCode = 1;
});
