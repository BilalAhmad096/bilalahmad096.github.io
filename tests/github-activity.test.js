import test from "node:test";
import assert from "node:assert/strict";
import {
  ContributionParseError,
  fromGraphQl,
  fromPublicCalendar,
  levelFor,
  serialise
} from "../scripts/lib/github-contributions.mjs";

const graphQlPayload = {
  data: {
    user: {
      contributionsCollection: {
        contributionCalendar: {
          totalContributions: 7,
          weeks: [
            {
              contributionDays: [
                { date: "2026-03-01", contributionCount: 0, contributionLevel: "NONE" },
                { date: "2026-03-02", contributionCount: 5, contributionLevel: "FOURTH_QUARTILE" }
              ]
            },
            {
              contributionDays: [
                { date: "2026-03-03", contributionCount: 2, contributionLevel: "SECOND_QUARTILE" }
              ]
            }
          ]
        }
      }
    }
  }
};

// Trimmed to the two facts the parser needs from each cell: the <td> carries the
// date and the level, and the matching <tool-tip> carries the exact count.
const publicCalendarHtml = `
  <h2 tabindex="-1" id="js-contribution-activity-description" class="f4">
      1,204
      contributions
        in the last year
  </h2>
  <td tabindex="0" data-date="2026-03-01" id="day-0" data-level="0" role="gridcell" class="ContributionCalendar-day"></td>
  <td tabindex="0" data-date="2026-03-02" id="day-1" data-level="4" role="gridcell" class="ContributionCalendar-day"></td>
  <td tabindex="0" data-date="2026-03-03" id="day-2" data-level="2" role="gridcell" class="ContributionCalendar-day"></td>
  <tool-tip for="day-0" class="sr-only">No contributions on March 1st.</tool-tip>
  <tool-tip for="day-1" class="sr-only">5 contributions on March 2nd.</tool-tip>
  <tool-tip for="day-2" class="sr-only">1 contribution on March 3rd.</tool-tip>
`;

test("quartile levels match GitHub's own banding", () => {
  assert.equal(levelFor(0, 20), 0);
  assert.equal(levelFor(1, 20), 1);
  assert.equal(levelFor(5, 20), 1);
  assert.equal(levelFor(6, 20), 2);
  assert.equal(levelFor(20, 20), 4);
  // A single busiest day of one contribution still has to land somewhere.
  assert.equal(levelFor(1, 1), 4);
  assert.equal(levelFor(3, 0), 1);
});

test("the GraphQL calendar flattens into ordered days with its own levels", () => {
  const activity = fromGraphQl(graphQlPayload, "BilalAhmad096");

  assert.equal(activity.source, "graphql");
  assert.equal(activity.login, "BilalAhmad096");
  assert.equal(activity.profileUrl, "https://github.com/BilalAhmad096");
  assert.equal(activity.totalContributions, 7);
  assert.equal(activity.busiestCount, 5);
  assert.equal(activity.from, "2026-03-01");
  assert.equal(activity.to, "2026-03-03");
  assert.deepEqual(activity.days, [
    { date: "2026-03-01", count: 0, level: 0 },
    { date: "2026-03-02", count: 5, level: 4 },
    { date: "2026-03-03", count: 2, level: 2 }
  ]);
});

test("a GraphQL error is reported rather than written out as an empty calendar", () => {
  assert.throws(
    () => fromGraphQl({ errors: [{ message: "Bad credentials" }] }, "BilalAhmad096"),
    error => error instanceof ContributionParseError && /Bad credentials/.test(error.message)
  );
  assert.throws(
    () => fromGraphQl({ data: { user: null } }, "BilalAhmad096"),
    ContributionParseError
  );
});

test("the public calendar joins each cell to its tooltip count", () => {
  const activity = fromPublicCalendar(publicCalendarHtml, "BilalAhmad096");

  assert.equal(activity.source, "public-calendar");
  assert.equal(activity.totalContributions, 1204);
  assert.deepEqual(activity.days, [
    { date: "2026-03-01", count: 0, level: 0 },
    { date: "2026-03-02", count: 5, level: 4 },
    { date: "2026-03-03", count: 1, level: 2 }
  ]);
});

test("a calendar page with no day cells fails instead of emptying the section", () => {
  assert.throws(() => fromPublicCalendar("<p>Not found</p>", "BilalAhmad096"), ContributionParseError);
});

test("the written file keeps one day per line so daily commits stay readable", () => {
  const contents = serialise(fromGraphQl(graphQlPayload, "BilalAhmad096"));

  assert.deepEqual(JSON.parse(contents), fromGraphQl(graphQlPayload, "BilalAhmad096"));
  assert.match(contents, /\n    \{"date": "2026-03-02", "count": 5, "level": 4\},\n/);
  assert.equal(contents.endsWith("}\n"), true);
});
