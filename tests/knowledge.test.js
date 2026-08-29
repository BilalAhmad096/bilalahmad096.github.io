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
    "PRESENTATIONS", "RESEARCH_INTERESTS", "EXTRACURRICULAR", "CONTACT", "COLLABORATION"
  ]) {
    assert.ok(metadata.categories.includes(category), `missing ${category}`);
  }
});

test("sports and travel are retrievable without unsupported detail", () => {
  const result = searchKnowledgeBase({
    query: "extracurricular sports and travel",
    categories: ["EXTRACURRICULAR"],
    limit: 5
  });
  const sports = result.results.find(record => record.id === "extracurricular-sports");
  const travel = result.results.find(record => record.id === "extracurricular-travel");

  assert.match(sports.summary, /cricket, hockey, horse riding, swimming and snooker/i);
  assert.equal(sports.verification, "verified_limited");
  assert.match(travel.details.join(" "), /Germany.*United States.*Saudi Arabia.*Indonesia.*Sweden/i);
  assert.equal(travel.verification, "verified_limited");

  const unsupported = searchKnowledgeBase({
    query: "football",
    categories: ["EXTRACURRICULAR"],
    limit: 5
  });
  assert.equal(unsupported.resultCount, 0);
});

test("BESS and SCOPF aliases retrieve grounded research records", () => {
  const bess = searchKnowledgeBase({ query: "BESS reliability", categories: ["RESEARCH", "PHD"], limit: 5 });
  assert.ok(bess.results.some(record => /battery energy storage/i.test(record.summary)));

  const scopf = searchKnowledgeBase({ query: "SCOPF contingency screening", categories: [], limit: 5 });
  assert.ok(scopf.results.some(record => /SCOPF|security-constrained/i.test(`${record.title} ${record.summary}`)));
});

test("two current part-time full-stack roles are explicitly retrievable", () => {
  const result = searchKnowledgeBase({
    query: "two part-time full stack roles Dystil Just Jutz",
    categories: ["PROFILE", "PROFESSIONAL_EXPERIENCE"],
    limit: 5
  });
  const ids = result.results.map(record => record.id);
  assert.ok(ids.includes("profile-summary"));
  assert.ok(ids.includes("experience-dystil"));
  assert.ok(ids.includes("experience-just-jutz"));
  assert.match(result.results.find(record => record.id === "profile-summary").summary, /two part-time Full Stack Developer roles/i);
  assert.deepEqual(result.results.find(record => record.id === "experience-dystil").links, [
    { label: "Visit Dystil.AI", url: "https://dystil.ai/" }
  ]);
  assert.deepEqual(result.results.find(record => record.id === "experience-just-jutz").links, [
    { label: "Visit Just Jutz", url: "https://justjutz.com/" }
  ]);
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
