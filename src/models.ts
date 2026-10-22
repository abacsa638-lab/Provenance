// SECTION 2: What a "source" looks like
// CORE sends back records with many optional, oddly named fields. This file turns each record
// into one tidy Source with the same shape every time, decides an "access label" (can the
// researcher read it, or only see its summary?), and formats a Chicago-style citation.
// NOTE: the field names come from third-party documentation and haven't been checked against
// the live API yet (that happens in Phase 1).

/** Plain-English answer to "can I read this?" */
export type AccessLabel =
  | "Full text available"
  | "Open PDF link"
  | "Abstract only"
  | "Metadata only";

export interface SourceLink {
  type: string;
  url: string;
}

export interface Source {
  coreId: string;
  title: string;
  authors: string[];
  year: number | null;
  publishedDate: string | null;
  abstract: string | null;
  doi: string | null;
  downloadUrl: string | null;
  fullTextUrls: string[];
  links: SourceLink[];
  documentType: string | null;
  publisher: string | null;
  journal: string | null;
  language: string | null;
  fieldOfStudy: string | null;
  /** True when CORE actually returned readable full text (not a placeholder). */
  hasFullText: boolean;
  access: AccessLabel;
  /** Best page for a human to open: the DOI, then a CORE display page, then the PDF. */
  landingUrl: string | null;
}

/** CORE puts this text in `fullText` when you search without an API key. */
export const FULL_TEXT_PLACEHOLDER = "Not available for public API users";

// ---------- small helpers that tolerate missing or odd data ----------

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed === "" ? null : trimmed;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Strips "https://doi.org/" and similar prefixes so DOIs are stored in one form. */
export function normaliseDoi(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const doi = raw.replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, "").trim();
  return doi.startsWith("10.") ? doi : null;
}

/** Returns real full text, or null for missing text and the keyless placeholder. */
export function usableFullText(value: unknown): string | null {
  const body = typeof value === "string" ? value.trim() : "";
  if (body === "" || body.startsWith(FULL_TEXT_PLACEHOLDER)) return null;
  return body;
}

function parseYear(record: Raw): number | null {
  const direct = record.yearPublished;
  if (typeof direct === "number" && Number.isInteger(direct)) return direct;
  const fromText = text(direct) ?? text(record.publishedDate);
  const match = fromText?.match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
  return match ? Number(match[1]) : null;
}

function parseAuthors(value: unknown): string[] {
  return list(value)
    .map((author) => (isObject(author) ? text(author.name) : text(author)))
    .filter((name): name is string => name !== null);
}

function parseLinks(value: unknown): SourceLink[] {
  return list(value)
    .filter(isObject)
    .map((link) => ({ type: text(link.type) ?? "link", url: text(link.url) ?? "" }))
    .filter((link) => link.url !== "");
}

function parseJournal(value: unknown): string | null {
  for (const journal of list(value)) {
    const title = isObject(journal) ? text(journal.title) : text(journal);
    if (title) return title;
  }
  return null;
}

function parseLanguage(value: unknown): string | null {
  return isObject(value) ? text(value.name) ?? text(value.code) : text(value);
}

function parseFieldOfStudy(value: unknown): string | null {
  return Array.isArray(value) ? text(value[0]) : text(value);
}

export function accessLabelFor(parts: {
  hasFullText: boolean;
  downloadUrl: string | null;
  fullTextUrls: string[];
  abstract: string | null;
}): AccessLabel {
  if (parts.hasFullText) return "Full text available";
  if (parts.downloadUrl || parts.fullTextUrls.length > 0) return "Open PDF link";
  if (parts.abstract) return "Abstract only";
  return "Metadata only";
}

// ---------- the main conversion ----------

/** Turns one raw CORE work record into a Source. Throws if the record has no ID. */
export function sourceFromCore(raw: unknown): Source {
  if (!isObject(raw)) throw new Error("CORE returned a record that isn't an object.");
  const coreId = text(raw.id);
  if (!coreId) throw new Error("CORE returned a record without an ID.");

  const links = parseLinks(raw.links);
  const doi = normaliseDoi(raw.doi);
  const downloadUrl = text(raw.downloadUrl);
  const fullTextUrls = list(raw.sourceFulltextUrls)
    .map(text)
    .filter((url): url is string => url !== null);
  const abstract = text(raw.abstract);
  const hasFullText = usableFullText(raw.fullText) !== null;
  const displayLink = links.find((link) => link.type === "display")?.url ?? null;

  return {
    coreId,
    title: text(raw.title) ?? "(untitled)",
    authors: parseAuthors(raw.authors),
    year: parseYear(raw),
    publishedDate: text(raw.publishedDate),
    abstract,
    doi,
    downloadUrl,
    fullTextUrls,
    links,
    documentType: text(raw.documentType),
    publisher: text(raw.publisher),
    journal: parseJournal(raw.journals),
    language: parseLanguage(raw.language),
    fieldOfStudy: parseFieldOfStudy(raw.fieldOfStudy),
    hasFullText,
    access: accessLabelFor({ hasFullText, downloadUrl, fullTextUrls, abstract }),
    landingUrl: (doi ? `https://doi.org/${doi}` : null) ?? displayLink ?? downloadUrl,
  };
}

// ---------- Chicago notes-bibliography citation ----------

/** "Jane Smith" -> "Smith, Jane". Names already written "Smith, Jane" are kept. */
function invertName(name: string): string {
  if (name.includes(",")) return name;
  const parts = name.split(" ");
  if (parts.length < 2) return name;
  const last = parts.pop();
  return `${last}, ${parts.join(" ")}`;
}

/** "Smith, Jane" -> "Jane Smith", for second and later authors. */
function naturalName(name: string): string {
  const [last, first] = name.split(",").map((part) => part.trim());
  return first ? `${first} ${last}` : name;
}

function formatAuthors(authors: string[]): string {
  if (authors.length === 0) return "";
  if (authors.length > 10) {
    // Chicago: list the first seven, then "et al."
    return `${[invertName(authors[0]), ...authors.slice(1, 7).map(naturalName)].join(", ")}, et al.`;
  }
  const [first, ...rest] = authors;
  const names = [invertName(first), ...rest.map(naturalName)];
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function isThesis(documentType: string | null): boolean {
  return /thesis|dissertation/i.test(documentType ?? "");
}

/** A Chicago-style bibliography entry. Missing pieces are left out, never invented. */
export function chicagoCitation(source: Source): string {
  const parts: string[] = [];
  const authors = formatAuthors(source.authors);
  if (authors) parts.push(authors.endsWith(".") ? authors : `${authors}.`);

  const title = source.title.replace(/[.\s]+$/, "");
  // "n.d." (no date) already ends in a full stop, so it's written without the trailing one.
  const year = source.year !== null ? String(source.year) : "n.d";

  if (isThesis(source.documentType)) {
    parts.push(`"${title}."`);
    parts.push(`Thesis${source.publisher ? `, ${source.publisher}` : ""}, ${year}.`);
  } else if (source.journal) {
    parts.push(`"${title}."`);
    parts.push(`${source.journal} (${year}).`);
  } else {
    parts.push(`"${title}."`);
    parts.push(source.publisher ? `${source.publisher}, ${year}.` : `${year}.`);
  }

  const link = source.doi ? `https://doi.org/${source.doi}` : source.landingUrl;
  if (link) parts.push(`${link}.`);
  return parts.join(" ");
}
