import test from "node:test";
import assert from "node:assert/strict";
import {
  getKnowledgeMetadata,
  getProfileInformation,
  searchKnowledgeBase,
  searchPublications
} from "../worker/src/knowledge.js";

test("knowledge base exposes verified records and all required categories", () => {
  const metadata = getKnowledgeMetadata();
  assert.ok(metadata.recordCount >= 25);
  for (const category of [
    "PROFILE", "EDUCATION", "PHD", "RESEARCH", "PUBLICATIONS", "PROJECTS",
    "PROFESSIONAL_EXPERIENCE", "TECHNICAL_SKILLS", "AWARDS", "FELLOWSHIPS",
    "PRESENTATIONS", "RESEARCH_INTERESTS", "CONTACT", "COLLABORATION"
  ]) {
    assert.ok(metadata.categories.includes(category), `missing ${category}`);
  }
});

test("BESS and SCOPF aliases retrieve grounded research records", () => {
  const bess = searchKnowledgeBase({ query: "BESS reliability", categories: ["RESEARCH", "PHD"], limit: 5 });
  assert.ok(bess.results.some(record => /battery energy storage/i.test(record.summary)));

  const scopf = searchKnowledgeBase({ query: "SCOPF contingency screening", categories: [], limit: 5 });
  assert.ok(scopf.results.some(record => /SCOPF|security-constrained/i.test(`${record.title} ${record.summary}`)));
});

test("publication search returns exact verified DOI details", () => {
  const result = searchPublications({ query: "machine learning power flow Python", limit: 3 });
  assert.equal(result.results[0].id, "publication-icsmartgrid-2025");
  assert.match(result.results[0].details.join(" "), /10\.1109\/icsmartgrid66138\.2025\.11071830/);
});

test("false-premise employers and invented awards return no verified match", () => {
  const google = searchKnowledgeBase({ query: "worked for Google", categories: ["PROFESSIONAL_EXPERIENCE"], limit: 5 });
  const nobel = searchKnowledgeBase({ query: "Nobel Prize", categories: ["AWARDS"], limit: 5 });
  assert.equal(google.resultCount, 0);
  assert.equal(nobel.resultCount, 0);
  assert.match(google.guidance, /do not speculate/i);
});

test("presentations are explicitly marked as having no verified entries", () => {
  const result = getProfileInformation({ section: "PRESENTATIONS" });
  assert.equal(result.resultCount, 0);
  assert.equal(result.coverage.PRESENTATIONS, "no_verified_entries");
});
