import knowledgeBase from "../../data/mintorian-knowledge.json" with { type: "json" };

export const KNOWLEDGE_CATEGORIES = Object.freeze(Object.keys(knowledgeBase.categoryCoverage));

const STOP_WORDS = new Set([
  "a", "about", "all", "an", "and", "any", "are", "as", "at", "be", "been", "bilal",
  "both", "can", "could", "did", "do", "does", "for", "from", "get", "give", "has",
  "have", "he", "her", "him", "his", "how", "i", "in", "into", "is", "it", "its",
  "just", "know", "like", "make", "many", "may", "me", "might", "much", "must",
  "need", "of", "on", "or", "our", "out", "over", "please", "say", "see", "should",
  "show", "some", "such", "tell", "than", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "those", "to", "under", "us", "use", "used",
  "uses", "was", "we", "were", "what", "when", "where", "whether", "which", "while",
  "who", "whom", "whose", "why", "will", "with", "would", "you", "your"
]);

// Generic words that reveal what a visitor is asking about without themselves being
// evidence for anything. They never contribute to the text score - "worked for Google"
// must not retrieve employment records on the strength of "worked" alone - but they do
// tell us which category to show when a question carries no content-bearing term at all.
const INTENT_HINTS = new Map([
  ["available", ["COLLABORATION", "CONTACT"]],
  ["availability", ["COLLABORATION", "CONTACT"]],
  ["background", ["PROFILE"]],
  ["based", ["CONTACT", "PROFILE"]],
  ["career", ["PROFESSIONAL_EXPERIENCE"]],
  ["collaborate", ["COLLABORATION"]],
  ["collaboration", ["COLLABORATION"]],
  ["company", ["PROFESSIONAL_EXPERIENCE"]],
  ["contact", ["CONTACT"]],
  ["degree", ["EDUCATION"]],
  ["degrees", ["EDUCATION"]],
  ["educated", ["EDUCATION"]],
  ["email", ["CONTACT"]],
  ["employer", ["PROFESSIONAL_EXPERIENCE"]],
  ["employment", ["PROFESSIONAL_EXPERIENCE"]],
  ["expertise", ["TECHNICAL_SKILLS", "RESEARCH_INTERESTS"]],
  ["hire", ["COLLABORATION", "PROFESSIONAL_EXPERIENCE"]],
  ["hiring", ["COLLABORATION", "PROFESSIONAL_EXPERIENCE"]],
  ["job", ["PROFESSIONAL_EXPERIENCE"]],
  ["jobs", ["PROFESSIONAL_EXPERIENCE"]],
  ["located", ["CONTACT", "PROFILE"]],
  ["location", ["CONTACT", "PROFILE"]],
  ["qualification", ["EDUCATION"]],
  ["qualifications", ["EDUCATION"]],
  ["qualified", ["EDUCATION"]],
  ["reach", ["CONTACT"]],
  ["role", ["PROFESSIONAL_EXPERIENCE"]],
  ["roles", ["PROFESSIONAL_EXPERIENCE"]],
  ["studied", ["EDUCATION"]],
  ["studies", ["EDUCATION"]],
  ["study", ["EDUCATION"]],
  ["tool", ["TECHNICAL_SKILLS"]],
  ["tools", ["TECHNICAL_SKILLS"]],
  ["work", ["PROFESSIONAL_EXPERIENCE"]],
  ["worked", ["PROFESSIONAL_EXPERIENCE"]],
  ["working", ["PROFESSIONAL_EXPERIENCE"]]
]);

const DEFAULT_ORIENTATION_CATEGORIES = ["PROFILE", "CONTACT"];

const EXPANSIONS = new Map([
  ["bess", "battery energy storage system"],
  ["ml", "machine learning"],
  ["ai", "artificial intelligence"],
  ["xai", "explainable artificial intelligence"],
  ["opf", "optimal power flow"],
  ["scopf", "security constrained optimal power flow"],
  ["dno", "distribution network operator"],
  ["dtu", "technical university denmark"],
  ["ecr", "early career researcher"],
  ["epsrc", "engineering physical sciences research council"],
  ["gw4", "bath bristol cardiff exeter"],
  ["pes", "power energy systems"],
  ["pv", "photovoltaic solar"],
  ["sdg", "sustainable development goal"],
  ["cv", "curriculum vitae profile experience education"],
  ["phd", "doctorate doctoral research"],
  ["rhul", "royal holloway university london"],
  ["adrc", "active disturbance rejection control converter"],
  ["amu", "aligarh muslim university"],
  ["dab", "dual active bridge converter"],
  ["daad", "german academic exchange fellowship"],
  ["hcl", "hcl technologies technical lead"],
  ["i2ct", "international conference convergent technology pune"],
  ["icsmartgrid", "international conference smart grid"],
  ["iit", "indian institute technology roorkee"],
  ["iitr", "indian institute technology roorkee"],
  ["ijrer", "international journal renewable energy research"],
  ["lsc", "london school commerce fellowship"],
  ["mhrd", "ministry human resource development fellowship"],
  ["mppt", "maximum power point tracking"],
  ["mtdc", "multi terminal direct current microgrid"],
  ["ocr", "optical character recognition handwritten text extraction"],
  ["pwc", "pricewaterhousecoopers"],
  ["rwth", "rwth aachen university"],
  ["supergen", "supergen energy networks hub"],
  ["ta", "teaching assistant"],
  ["ursa", "university research studentship award bath"]
]);

function normalise(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Records are static, so normalise every field once at module load rather than on every
// query. `haystack` backs the document-frequency count below and keeps it consistent with
// the substring semantics the field scores use.
const RECORD_INDEX = knowledgeBase.records.map(record => {
  const text = {
    title: normalise(record.title),
    summary: normalise(record.summary),
    details: normalise(record.details.join(" ")),
    keywords: normalise(record.keywords.join(" ")),
    category: normalise(record.category)
  };
  return {
    record,
    text,
    haystack: `${text.title} ${text.summary} ${text.details} ${text.keywords} ${text.category}`
  };
});

const FIELD_WEIGHTS = Object.freeze({
  title: 9,
  keywords: 7,
  summary: 4,
  details: 2,
  category: 2
});

function queryTerms(query) {
  const base = normalise(query).split(/\s+/).filter(Boolean);
  const expanded = [];
  const intents = new Set();

  for (const term of base) {
    const hinted = INTENT_HINTS.get(term);
    if (hinted) {
      for (const category of hinted) intents.add(category);
      continue;
    }
    expanded.push(term);
    const extra = EXPANSIONS.get(term);
    if (extra) expanded.push(...extra.split(" "));
  }

  return {
    terms: [...new Set(expanded.filter(term => term.length > 1 && !STOP_WORDS.has(term)))],
    intents: [...intents].filter(category => KNOWLEDGE_CATEGORIES.includes(category))
  };
}

// A term matching thirty records is far weaker evidence than one matching two. Without
// this weighting a common word can outrank an exact tool or institution name, which is how
// "Where did he study?" used to rank a conference paper above the education records.
function inverseDocumentFrequency(term, cache) {
  const cached = cache.get(term);
  if (cached !== undefined) return cached;

  let frequency = 0;
  for (const entry of RECORD_INDEX) {
    if (entry.haystack.includes(term)) frequency += 1;
  }
  const weight = Math.log(1 + RECORD_INDEX.length / (1 + frequency));
  cache.set(term, weight);
  return weight;
}

function scoreRecord(entry, terms, rawQuery, idfCache) {
  const { text } = entry;
  let score = 0;
  const phrase = normalise(rawQuery);

  if (phrase.length > 3 && text.title.includes(phrase)) score += 30;
  if (phrase.length > 3 && text.summary.includes(phrase)) score += 16;

  for (const term of terms) {
    const idf = inverseDocumentFrequency(term, idfCache);
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
      if (text[field].includes(term)) score += weight * idf;
    }
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
    links: Array.isArray(record.links)
      ? record.links.map(link => ({ label: link.label, url: link.url }))
      : undefined,
    verification: record.status
  };
}

export function searchKnowledgeBase({ query, categories = [], limit = 5 } = {}) {
  const safeQuery = String(query || "").slice(0, 500);
  const { terms, intents } = queryTerms(safeQuery);
  const requestedCategories = new Set(
    (Array.isArray(categories) ? categories : [])
      .map(category => String(category).toUpperCase())
      .filter(category => KNOWLEDGE_CATEGORIES.includes(category))
  );
  const cappedLimit = Math.max(1, Math.min(Number(limit) || 5, 8));

  // A question built entirely from function words ("What is his background?") leaves no
  // term to score, so fall back to the category its phrasing implies rather than refusing.
  // This deliberately does not fire when the query does carry content terms that simply
  // match nothing: "worked for Google" must still return no verified record.
  const orientation = terms.length === 0 && requestedCategories.size === 0;
  const effectiveCategories = orientation
    ? new Set(intents.length ? intents : DEFAULT_ORIENTATION_CATEGORIES)
    : requestedCategories;

  const candidates = RECORD_INDEX.filter(entry =>
    effectiveCategories.size === 0 || effectiveCategories.has(entry.record.category)
  );

  // Orientation results all score zero, so lead with the category the question named
  // first: "Is he available for work?" should open on collaboration, not on a 2017 internship.
  const intentRank = orientation && intents.length
    ? new Map(intents.map((category, index) => [category, index]))
    : null;

  const idfCache = new Map();
  const ranked = candidates
    .map(entry => ({ entry, score: scoreRecord(entry, terms, safeQuery, idfCache) }))
    .filter(item => terms.length === 0 || item.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (intentRank) {
        const leftRank = intentRank.get(left.entry.record.category) ?? Number.MAX_SAFE_INTEGER;
        const rightRank = intentRank.get(right.entry.record.category) ?? Number.MAX_SAFE_INTEGER;
        if (leftRank !== rightRank) return leftRank - rightRank;
      }
      return left.entry.text.title.localeCompare(right.entry.text.title);
    })
    .slice(0, cappedLimit)
    .map(item => publicRecord(item.entry.record));

  const coverageCategories = requestedCategories.size ? requestedCategories : effectiveCategories;

  return {
    query: safeQuery,
    verifiedAsOf: knowledgeBase.lastVerified,
    resultCount: ranked.length,
    matchType: ranked.length === 0 ? "none" : orientation ? "orientation" : "term",
    results: ranked,
    coverage: coverageCategories.size
      ? Object.fromEntries([...coverageCategories].map(category => [category, knowledgeBase.categoryCoverage[category]]))
      : undefined,
    guidance: ranked.length
      ? orientation
        ? "The question named no specific topic, so these are general records for the area its phrasing implies. Use them only if they genuinely answer the question, and say there is not enough verified information otherwise."
        : "Use only these returned records for factual claims."
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
