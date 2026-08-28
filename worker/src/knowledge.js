import knowledgeBase from "../../data/mintorian-knowledge.json" with { type: "json" };

export const KNOWLEDGE_CATEGORIES = Object.freeze(Object.keys(knowledgeBase.categoryCoverage));

const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "bilal", "did", "does",
  "for", "from", "has", "have", "he", "his", "how", "i", "in", "is", "it",
  "company", "employer", "job", "me", "of", "on", "or", "the", "their", "to",
  "was", "what", "which", "with", "work", "worked", "working"
]);

const EXPANSIONS = new Map([
  ["bess", "battery energy storage system"],
  ["ml", "machine learning"],
  ["ai", "artificial intelligence"],
  ["xai", "explainable artificial intelligence"],
  ["opf", "optimal power flow"],
  ["scopf", "security constrained optimal power flow"],
  ["dno", "distribution network operator"],
  ["pv", "photovoltaic solar"],
  ["cv", "curriculum vitae profile experience education"],
  ["phd", "doctorate doctoral research"],
  ["rhul", "royal holloway university london"]
]);

function normalise(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function queryTerms(query) {
  const base = normalise(query).split(/\s+/).filter(Boolean);
  const expanded = [];
  for (const term of base) {
    expanded.push(term);
    const extra = EXPANSIONS.get(term);
    if (extra) expanded.push(...extra.split(" "));
  }
  return [...new Set(expanded.filter(term => term.length > 1 && !STOP_WORDS.has(term)))];
}

function recordText(record) {
  return {
    title: normalise(record.title),
    summary: normalise(record.summary),
    details: normalise(record.details.join(" ")),
    keywords: normalise(record.keywords.join(" ")),
    category: normalise(record.category)
  };
}

function scoreRecord(record, terms, rawQuery) {
  const text = recordText(record);
  let score = 0;
  const phrase = normalise(rawQuery);

  if (phrase.length > 3 && text.title.includes(phrase)) score += 30;
  if (phrase.length > 3 && text.summary.includes(phrase)) score += 16;

  for (const term of terms) {
    if (text.title.includes(term)) score += 9;
    if (text.keywords.includes(term)) score += 7;
    if (text.summary.includes(term)) score += 4;
    if (text.details.includes(term)) score += 2;
    if (text.category.includes(term)) score += 2;
  }

  return score;
}

function publicRecord(record) {
  return {
    id: record.id,
    category: record.category,
    title: record.title,
    summary: record.summary,
    details: record.details,
    source: record.source,
    verification: record.status
  };
}

export function searchKnowledgeBase({ query, categories = [], limit = 5 } = {}) {
  const safeQuery = String(query || "").slice(0, 500);
  const terms = queryTerms(safeQuery);
  const requestedCategories = new Set(
    (Array.isArray(categories) ? categories : [])
      .map(category => String(category).toUpperCase())
      .filter(category => KNOWLEDGE_CATEGORIES.includes(category))
  );
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 5, 8));
  const candidates = knowledgeBase.records.filter(record =>
    requestedCategories.size === 0 || requestedCategories.has(record.category)
  );

  const ranked = candidates
    .map(record => ({ record, score: scoreRecord(record, terms, safeQuery) }))
    .filter(item => terms.length === 0 || item.score > 0)
    .sort((left, right) => right.score - left.score || left.record.title.localeCompare(right.record.title))
    .slice(0, cappedLimit)
    .map(item => publicRecord(item.record));

  return {
    query: safeQuery,
    verifiedAsOf: knowledgeBase.lastVerified,
    resultCount: ranked.length,
    results: ranked,
    coverage: requestedCategories.size
      ? Object.fromEntries([...requestedCategories].map(category => [category, knowledgeBase.categoryCoverage[category]]))
      : undefined,
    guidance: ranked.length
      ? "Use only these returned records for factual claims."
      : "No matching verified public record was found. Say that there is not enough verified information and do not speculate."
  };
}

export function searchPublications(args = {}) {
  return searchKnowledgeBase({ ...args, categories: ["PUBLICATIONS"] });
}

export function getProjectDetails({ project_name: projectName } = {}) {
  return searchKnowledgeBase({ query: projectName, categories: ["PROJECTS"], limit: 4 });
}

export function getProfileInformation({ section = "PROFILE" } = {}) {
  const category = KNOWLEDGE_CATEGORIES.includes(section) ? section : "PROFILE";
  return searchKnowledgeBase({ query: "", categories: [category], limit: 8 });
}

export function getContactOptions({ intent = "general" } = {}) {
  return {
    intent,
    contact: {
      type: "contact_form",
      label: "Send a message",
      emailFallback: "connect@mintorian.com"
    },
    meeting: {
      type: "meeting_request",
      label: "Request a meeting",
      bookingStatus: "request_only",
      note: "Live calendar availability is not configured. A meeting request is not a confirmed booking."
    }
  };
}

export function checkAvailability({ date_range: dateRange = "", timezone = "" } = {}) {
  return {
    available: null,
    configured: false,
    requestedDateRange: String(dateRange).slice(0, 200),
    requestedTimezone: String(timezone).slice(0, 100),
    message: "Live calendar availability is not configured. Do not infer availability or claim that a meeting is booked. Offer the meeting-request form or contact email instead."
  };
}

export function executeKnowledgeTool(name, args) {
  switch (name) {
    case "search_knowledge_base":
      return searchKnowledgeBase(args);
    case "search_publications":
      return searchPublications(args);
    case "get_project_details":
      return getProjectDetails(args);
    case "get_profile_information":
      return getProfileInformation(args);
    case "get_contact_options":
      return getContactOptions(args);
    case "check_availability":
      return checkAvailability(args);
    default:
      return {
        error: "unsupported_tool",
        guidance: "The requested tool is not available. Do not invent a result."
      };
  }
}

export function getNavigation() {
  return knowledgeBase.navigation.map(item => ({ ...item }));
}

export function getKnowledgeMetadata() {
  return {
    schemaVersion: knowledgeBase.schemaVersion,
    lastVerified: knowledgeBase.lastVerified,
    recordCount: knowledgeBase.records.length,
    categories: KNOWLEDGE_CATEGORIES
  };
}
