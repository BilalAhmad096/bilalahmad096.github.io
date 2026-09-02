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
  assert.ok(metadata.recordCount >= 44);
  for (const category of [
    "PROFILE", "EDUCATION", "PHD", "RESEARCH", "PUBLICATIONS", "PROJECTS",
    "PROFESSIONAL_EXPERIENCE", "TECHNICAL_SKILLS", "AWARDS", "FELLOWSHIPS",
    "PRESENTATIONS", "RESEARCH_INTERESTS", "EVENTS", "RECOMMENDATIONS",
    "EXTRACURRICULAR", "CONTACT", "COLLABORATION"
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

test("professional events are retrievable with verified dates and funding context", () => {
  const dtu = searchKnowledgeBase({ query: "DTU PES summer school dates", categories: ["EVENTS"], limit: 3 });
  const ecr = searchKnowledgeBase({ query: "ECR net zero funding", categories: ["EVENTS"], limit: 3 });
  const gw4 = searchKnowledgeBase({ query: "GW4 Exeter conference", categories: ["EVENTS"], limit: 3 });

  assert.equal(dtu.results[0].id, "event-dtu-pes-summer-school-2026");
  assert.match(dtu.results[0].summary, /18 to 22 May 2026/i);
  assert.equal(ecr.results[0].id, "event-ecr-net-zero-2026");
  assert.match(ecr.results[0].details.join(" "), /Supergen Energy Networks Hub/i);
  assert.equal(gw4.results[0].id, "event-gw4-exeter-2025");
  assert.match(gw4.results[0].details.join(" "), /Bath, Bristol, Cardiff and Exeter/i);
});

test("public recommendations remain attributed and limited to published comments", () => {
  const result = searchKnowledgeBase({
    query: "recommendations about power systems leadership",
    categories: ["RECOMMENDATIONS"],
    limit: 4
  });
  const ids = result.results.map(record => record.id);

  assert.ok(ids.includes("recommendation-bhavesh-bhalja"));
  assert.ok(ids.includes("recommendation-saad-bin-arif"));
  assert.ok(result.results.every(record => record.verification === "verified_limited"));
});

test("clean-energy alignment and public profile links are retrievable", () => {
  const sdg = searchKnowledgeBase({ query: "SDG 7 clean energy", categories: ["RESEARCH"], limit: 3 });
  const contact = searchKnowledgeBase({ query: "GitHub Google Scholar", categories: ["CONTACT"], limit: 3 });

  assert.equal(sdg.results[0].id, "research-sdg7");
  assert.match(sdg.results[0].details.join(" "), /does not.*formal United Nations affiliation/i);
  assert.match(contact.results[0].details.join(" "), /github\.com\/BilalAhmad096/i);
  assert.match(contact.results[0].details.join(" "), /scholar\.google\.com/i);
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

test("the icSmartGrid presentation is retrievable and every category now has entries", () => {
  const section = getProfileInformation({ section: "PRESENTATIONS" });
  assert.equal(section.coverage.PRESENTATIONS, "verified_records_available");
  assert.equal(section.results[0].id, "presentation-icsmartgrid-2025");

  // The phrasing that returned nothing in production before the record existed.
  const asked = searchKnowledgeBase({ query: "Has he presented at any conferences?", categories: [], limit: 3 });
  assert.equal(asked.results[0].id, "presentation-icsmartgrid-2025");
  assert.match(asked.results[0].summary, /Third Best Paper/i);
  assert.match(asked.results[0].details.join(" "), /10\.1109\/icsmartgrid66138\.2025\.11071830/);
});

test("generic orientation questions fall back to the category the phrasing implies", () => {
  const work = searchKnowledgeBase({ query: "Where does Bilal work?", categories: [], limit: 3 });
  assert.equal(work.matchType, "orientation");
  assert.ok(work.resultCount > 0);
  assert.ok(work.results.every(record => record.category === "PROFESSIONAL_EXPERIENCE"));

  const qualifications = searchKnowledgeBase({ query: "What are his qualifications?", categories: [], limit: 3 });
  assert.equal(qualifications.matchType, "orientation");
  assert.ok(qualifications.results.every(record => record.category === "EDUCATION"));

  assert.equal(searchKnowledgeBase({ query: "How can I reach him?", limit: 3 }).results[0].id, "contact-public");
  assert.equal(searchKnowledgeBase({ query: "Is he available for work?", limit: 3 }).results[0].id, "collaboration-options");

  const profile = searchKnowledgeBase({ query: "Tell me about him", categories: [], limit: 3 });
  assert.equal(profile.results[0].id, "profile-summary");
  assert.match(profile.guidance, /named no specific topic/i);
});

test("orientation fallback never rescues a false premise", () => {
  // "worked" only hints at a category. "google" is the content term and matches nothing,
  // so the query must still refuse rather than fall back to the employment records.
  const google = searchKnowledgeBase({ query: "worked for Google", categories: ["PROFESSIONAL_EXPERIENCE"], limit: 5 });
  assert.equal(google.resultCount, 0);
  assert.equal(google.matchType, "none");

  const salary = searchKnowledgeBase({ query: "what is his salary", categories: [], limit: 5 });
  assert.equal(salary.resultCount, 0);
  assert.match(salary.guidance, /do not speculate/i);
});

test("rare terms outrank common ones when ranking retrieval results", () => {
  const gurobi = searchKnowledgeBase({ query: "Does he use Gurobi?", categories: [], limit: 3 });
  assert.equal(gurobi.matchType, "term");
  assert.equal(gurobi.results[0].id, "skills-power-systems");

  assert.equal(searchKnowledgeBase({ query: "ADRC converter control", limit: 3 }).results[0].id, "project-dc-microgrid");

  // "power" is in most records and "harduaganj" in exactly one: the rare term must win.
  const thermal = searchKnowledgeBase({ query: "power station Harduaganj", categories: [], limit: 3 });
  assert.equal(thermal.results[0].id, "experience-harduaganj");
});

test("newly aliased acronyms reach their records", () => {
  for (const [query, expectedId] of [
    ["MTDC microgrid", "project-dc-microgrid"],
    ["RWTH Aachen", "experience-rwth"],
    ["OCR handwritten text", "experience-hcl"],
    ["PwC internship", "experience-pwc"]
  ]) {
    const result = searchKnowledgeBase({ query, categories: [], limit: 3 });
    assert.ok(
      result.results.some(record => record.id === expectedId),
      `${query} did not retrieve ${expectedId}`
    );
  }
});
