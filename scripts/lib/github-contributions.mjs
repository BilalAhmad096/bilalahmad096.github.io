// Pure transforms behind the GitHub commit-activity data file.
//
// Two sources produce the same shape:
//   * the GraphQL contributionsCollection, used whenever a token is available
//     (in GitHub Actions that is the automatic GITHUB_TOKEN, never a secret we
//     have to store), and
//   * the public /users/<login>/contributions calendar, which needs no
//     credential at all and keeps the build working if the token is missing or
//     lacks the scope.
//
// Nothing here performs I/O, so the parsing rules stay testable.

const LEVEL_BY_NAME = new Map([
  ["NONE", 0],
  ["FIRST_QUARTILE", 1],
  ["SECOND_QUARTILE", 2],
  ["THIRD_QUARTILE", 3],
  ["FOURTH_QUARTILE", 4]
]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class ContributionParseError extends Error {}

/**
 * GitHub buckets a day into one of four filled levels. When a source gives the
 * level we keep it; otherwise we reproduce the quartile split ourselves so both
 * paths shade the calendar the same way.
 */
export function levelFor(count, busiestCount) {
  if (count <= 0) return 0;
  if (busiestCount <= 0) return 1;
  return Math.min(4, Math.max(1, Math.ceil((count / busiestCount) * 4)));
}

function assertDays(days) {
  if (!Array.isArray(days) || days.length === 0) {
    throw new ContributionParseError("no contribution days were found");
  }
  return days;
}

function finalise({ login, days, totalContributions, source }) {
  const ordered = assertDays(days)
    .filter(day => DATE_PATTERN.test(day.date))
    .sort((a, b) => a.date.localeCompare(b.date));

  assertDays(ordered);

  const busiestCount = ordered.reduce((busiest, day) => Math.max(busiest, day.count), 0);
  const total = Number.isInteger(totalContributions)
    ? totalContributions
    : ordered.reduce((sum, day) => sum + day.count, 0);

  return {
    schema: 1,
    source,
    login,
    profileUrl: `https://github.com/${login}`,
    from: ordered[0].date,
    to: ordered.at(-1).date,
    totalContributions: total,
    busiestCount,
    days: ordered.map(day => ({
      date: day.date,
      count: day.count,
      level: Number.isInteger(day.level) ? day.level : levelFor(day.count, busiestCount)
    }))
  };
}

/** Reads the calendar out of a GraphQL contributionsCollection response. */
export function fromGraphQl(payload, login) {
  if (payload?.errors?.length) {
    throw new ContributionParseError(payload.errors.map(error => error.message).join("; "));
  }

  const calendar = payload?.data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) {
    throw new ContributionParseError("the response carried no contribution calendar");
  }

  const days = (calendar.weeks ?? []).flatMap(week => (week.contributionDays ?? []).map(day => ({
    date: day.date,
    count: day.contributionCount ?? 0,
    level: LEVEL_BY_NAME.get(day.contributionLevel)
  })));

  return finalise({
    login,
    days,
    totalContributions: calendar.totalContributions,
    source: "graphql"
  });
}

// The public calendar puts the date and level on each <td> and the exact count
// in the matching <tool-tip>, so the two have to be joined on the cell id.
const CELL_PATTERN = /<td\b[^>]*class="[^"]*ContributionCalendar-day[^"]*"[^>]*>/g;
const TOOLTIP_PATTERN = /<tool-tip\b[^>]*\bfor="([^"]+)"[^>]*>([\s\S]*?)<\/tool-tip>/g;
const TOTAL_PATTERN = /id="js-contribution-activity-description"[^>]*>\s*([\d,]+)\s*\n?\s*contribution/i;

function attribute(tag, name) {
  // Attributes are space separated, so requiring the space keeps "data-level"
  // from also matching inside a longer neighbouring attribute name.
  const match = tag.match(new RegExp(` ${name}="([^"]*)"`));
  return match ? match[1] : null;
}

function countFromTooltip(text) {
  const decoded = text.replace(/&nbsp;/g, " ").trim();
  if (/^no contributions/i.test(decoded)) return 0;
  const match = decoded.match(/^([\d,]+)\s+contribution/i);
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

/** Reads the calendar out of the public contributions page. */
export function fromPublicCalendar(html, login) {
  const counts = new Map();
  for (const [, cellId, text] of html.matchAll(TOOLTIP_PATTERN)) {
    const count = countFromTooltip(text);
    if (count !== null) counts.set(cellId, count);
  }

  const days = [];
  for (const match of html.matchAll(CELL_PATTERN)) {
    const tag = match[0];
    const date = attribute(tag, "data-date");
    if (!date) continue;

    const cellId = attribute(tag, "id");
    const count = counts.get(cellId);
    const level = Number(attribute(tag, "data-level"));

    days.push({
      date,
      // A day whose tooltip we could not read still belongs on the calendar; the
      // level alone places it, and dropping it would leave a hole in the grid.
      count: Number.isInteger(count) ? count : 0,
      level: Number.isInteger(level) ? level : undefined
    });
  }

  const totalMatch = html.match(TOTAL_PATTERN);

  return finalise({
    login,
    days,
    totalContributions: totalMatch ? Number(totalMatch[1].replace(/,/g, "")) : undefined,
    source: "public-calendar"
  });
}

/**
 * One day per line. The file is regenerated by a scheduled job and committed, so
 * a diff that shows only the days that moved is worth the custom serialiser.
 */
export function serialise(activity) {
  const { days, ...summary } = activity;
  const head = Object.entries(summary)
    .map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`)
    .join("\n");
  const rows = days
    .map(day => `    {"date": "${day.date}", "count": ${day.count}, "level": ${day.level}}`)
    .join(",\n");

  return `{\n${head}\n  "days": [\n${rows}\n  ]\n}\n`;
}
