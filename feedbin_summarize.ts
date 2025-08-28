import * as fs from "fs";
import * as path from "path";
import OpenAI from "openai";

process.loadEnvFile();

type Article = {
  url: string;
  published?: string;
  extractedContent: string;
};

type Fact = {
  url: string;
  published?: string;
  isGamingRelated: boolean;
  categories: string[]; // e.g., ["layoffs", "earnings", "investment", "M&A", "trend", "policy", "regulation"]
  summary: string; // 1-3 sentences
  signals: string[]; // short bullet-like phrases
  companies: string[]; // detected company/org names
  regions: string[]; // markets/regions if mentioned
  confidence: number; // 0-1
};

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

if (!OPENAI_API_KEY) {
  console.error(
    "Missing OPENAI_API_KEY. Add it to your environment or .env (not committed)."
  );
  process.exit(1);
}

// Configurables
const OPENAI_MODEL = "gpt-5-mini";
const MAX_INPUT_TOKENS = 12000;
const MAX_OUTPUT_TOKENS = 3000;
const REQUEST_CONCURRENCY = 10;

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Rough token estimator: ~4 chars/token for English prose
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function ensureDir(_dirPath: string) {}

function loadArticles(): Article[] {
  const jsonPath = path.resolve("feedbin_articles.json");

  if (fs.existsSync(jsonPath)) {
    const raw = fs.readFileSync(jsonPath, "utf-8");
    const data = JSON.parse(raw) as any[];
    return data
      .map((row) => ({
        url: String(row.url),
        published: row.published ? String(row.published) : undefined,
        extractedContent: row.extractedContent
          ? String(row.extractedContent)
          : "",
      }))
      .filter((a) => a.url && a.extractedContent);
  }

  console.error(
    "No input files found. Run `yarn feedbin` to generate JSON first."
  );
  process.exit(1);
}

function batchArticles(articles: Article[]): Article[][] {
  const batches: Article[][] = [];
  let current: Article[] = [];
  let currentTokens = 0;

  const systemOverhead = 800; // allowance for instructions per request
  const maxInput = Math.max(
    3000,
    MAX_INPUT_TOKENS - systemOverhead - MAX_OUTPUT_TOKENS
  );

  for (const art of articles) {
    const approx = estimateTokens(art.extractedContent) + 50; // include url+meta
    if (currentTokens + approx > maxInput && current.length > 0) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(art);
    currentTokens += approx;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// JSON Schema for structured outputs (Facts array under root object { facts: [...] })
const FACT_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "url",
    "published",
    "isGamingRelated",
    "categories",
    "summary",
    "signals",
    "companies",
    "regions",
    "confidence",
  ],
  properties: {
    url: { type: "string" },
    published: { type: ["string", "null"] },
    isGamingRelated: { type: "boolean" },
    categories: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    signals: { type: "array", items: { type: "string" }, maxItems: 6 },
    companies: { type: "array", items: { type: "string" } },
    regions: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
} as const;

const FACTS_SCHEMA_OBJECT = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: { type: "array", items: FACT_ITEM_SCHEMA },
  },
} as const;

// Narrowed structural type for Responses API we rely on
type ResponsesCreateResult = {
  output_text?: string;
  output?: Array<{
    text?: string | { value?: string };
    content?: Array<
      string | { text?: string | { value?: string }; content?: string }
    >;
  }>;
};

type ResponsesInputMessage = {
  role: "system" | "user" | "assistant";
  content: Array<{ type: "input_text"; text: string }>;
};

function combineMessagesToInput(
  messages: ChatMessage[]
): ResponsesInputMessage[] {
  // Map to typed Responses API messages
  return messages.map((m) => ({
    role: m.role,
    content: [{ type: "input_text", text: m.content }],
  }));
}

async function callResponsesFacts(
  model: string,
  messages: ChatMessage[]
): Promise<string> {
  const input = combineMessagesToInput(messages);
  const body = {
    model,
    input,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    reasoning: { effort: "low" as const },
    text: {
      verbosity: "low" as const,
      format: {
        type: "json_schema" as const,
        name: "facts_list",
        schema: FACTS_SCHEMA_OBJECT,
        strict: true as const,
      },
    },
  };

  const parsed = await openai.responses.parse(body as any);

  const status: string | undefined = (parsed as any)?.status;
  const incompleteReason: string | undefined = (parsed as any)
    ?.incomplete_details?.reason;

  const op: any = (parsed as any)?.output_parsed;
  if (op) {
    return JSON.stringify(op);
  }

  const content = (parsed as any)?.output_text as string | undefined;
  if (content && content.trim()) return content;

  // No filesystem writes for empty responses
  if (status === "incomplete" && incompleteReason === "max_output_tokens") {
    throw new Error(
      `OpenAI: response incomplete due to max_output_tokens. Increase MAX_OUTPUT_TOKENS or reduce input size (e.g., lower MAX_INPUT_TOKENS, or smaller batch).`
    );
  }
  throw new Error("OpenAI: empty response (responses)");
}

function safeStringify(obj: unknown): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(
      obj,
      (key, value) => {
        if (typeof value === "object" && value !== null) {
          if (seen.has(value as object)) return "[Circular]";
          seen.add(value as object);
        }
        return value;
      },
      2
    );
  } catch {
    try {
      const fallback: any = {};
      if (obj && typeof obj === "object") {
        for (const k of Object.keys(obj as any)) {
          const v = (obj as any)[k];
          if (
            typeof v === "string" ||
            typeof v === "number" ||
            typeof v === "boolean"
          )
            fallback[k] = v;
        }
      }
      return JSON.stringify(fallback, null, 2);
    } catch {
      return "{}";
    }
  }
}

async function callOpenAIFacts(messages: ChatMessage[]): Promise<string> {
  const model = OPENAI_MODEL;
  try {
    return await callResponsesFacts(model, messages);
  } catch (err: any) {
    const status = err?.response?.status;
    const msg =
      err?.response?.data?.error?.message || err?.message || String(err);
    const type = err?.response?.data?.error?.type;
    const e = new Error(
      `OpenAI request failed (${
        status || "no-status"
      }) for model '${model}' via Responses API: ${msg} [type=${
        type || "unknown"
      }]`
    );
    // @ts-ignore
    e.cause = err;
    throw e;
  }
}

// Text responses (no schema), for chunk summaries and final report
async function callResponsesText(
  model: string,
  messages: ChatMessage[]
): Promise<string> {
  const input = combineMessagesToInput(messages);
  const resp = await openai.responses.create({
    model,
    input,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    reasoning: { effort: "low" },
    text: { verbosity: "low" },
  });
  const outputText = (resp as any)?.output_text as string | undefined;
  if (outputText && outputText.trim()) return outputText;
  const status: string | undefined = (resp as any)?.status;
  const incompleteReason: string | undefined = (resp as any)?.incomplete_details
    ?.reason;
  if (status === "incomplete" && incompleteReason === "max_output_tokens") {
    throw new Error(
      `OpenAI: response incomplete due to max_output_tokens during text generation. Consider reducing batch size or MAX_INPUT_TOKENS.`
    );
  }
  throw new Error("OpenAI: empty text response");
}

async function callOpenAIText(messages: ChatMessage[]): Promise<string> {
  const model = OPENAI_MODEL;
  try {
    return await callResponsesText(model, messages);
  } catch (err: any) {
    const status = err?.response?.status;
    const msg =
      err?.response?.data?.error?.message || err?.message || String(err);
    const type = err?.response?.data?.error?.type;
    const e = new Error(
      `OpenAI text request failed (${
        status || "no-status"
      }) for model '${model}': ${msg} [type=${type || "unknown"}]`
    );
    // @ts-ignore
    e.cause = err;
    throw e;
  }
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  tries = 5
): Promise<T> {
  let attempt = 0;
  let delayMs = 1500;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const status = err?.response?.status;
      const retriable = status === 429 || status >= 500 || !status;
      if (!retriable || attempt >= tries) {
        console.error(`${label} failed:`, err?.message || err);
        throw err;
      }
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs = Math.min(delayMs * 1.8, 15000);
    }
  }
}

function toBatchPromptItems(batch: Article[]): string {
  return batch
    .map((a, idx) => {
      const pub = a.published ? `published: ${a.published}` : "";
      return [
        `BEGIN ARTICLE ${idx + 1}`,
        `url: ${a.url}`,
        pub,
        "content:",
        a.extractedContent,
        `END ARTICLE ${idx + 1}`,
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

async function extractFactsInBatches(articles: Article[]): Promise<Fact[]> {
  const batches = batchArticles(articles);
  console.log(
    `Articles: ${articles.length}. Batches: ${batches.length}. Model: ${OPENAI_MODEL}`
  );

  const queue = batches.map((batch, i) => ({ batch, index: i + 1 }));
  const results: Fact[][] = [];
  let active = 0;

  async function worker() {
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      active++;
      const { batch, index } = item;
      const promptItems = toBatchPromptItems(batch);

      const system: ChatMessage = {
        role: "system",
        content:
          "You are an analyst extracting structured facts from news. Respond ONLY with minified JSON (no code block). The JSON must be an array of objects with keys: url, published, isGamingRelated, categories, summary, signals, companies, regions, confidence. Keep summaries factual and concise.",
      };
      const user: ChatMessage = {
        role: "user",
        content: `From the articles, extract facts with this guidance:\n- isGamingRelated: true only if the news relates to the games/gaming/entertainment industry broadly (business, platforms, studios, publishers, markets, policy).\n- categories: choose any that apply from [\"layoffs\",\"earnings\",\"investment\",\"M&A\",\"trend\",\"policy\",\"regulation\",\"partnership\",\"infrastructure\",\"platform\"].\n- summary: 1-3 sentences, neutral tone, no opinions.\n- signals: 2-5 short bullet-like phrases indicating why this matters (e.g., \"console price pressure\").\n- companies: list of company or org names involved (strings).\n- regions: markets/regions if mentioned (e.g., \"US\", \"EU\", \"China\").\n- published: include the article's published ISO timestamp if available, otherwise use null.\n- confidence: number 0-1.\n- IMPORTANT: Return the result in an object with a top-level \"facts\" array that conforms strictly to the provided JSON schema.\n\n${promptItems}`,
      };

      const label = `facts batch ${index}/${batches.length}`;
      const content = await withRetry(
        () => callOpenAIFacts([system, user]),
        label
      );
      try {
        const parsedJson = JSON.parse(content);
        const parsed: Fact[] = Array.isArray(parsedJson)
          ? (parsedJson as Fact[])
          : (parsedJson?.facts as Fact[]);
        results.push(parsed);
        console.log(`${label}: ok (${parsed.length} facts)`);
      } catch (e) {
        console.error(`${label}: JSON parse failed.`);
        throw e;
      }
      active--;
    }
  }

  const workers = Array.from({ length: Math.max(1, REQUEST_CONCURRENCY) }, () =>
    worker()
  );
  await Promise.all(workers);
  return results.flat();
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function computeTimeWindow(facts: Fact[]): string {
  const dates = facts
    .map((f) => (f.published ? Date.parse(f.published) : NaN))
    .filter((n) => !isNaN(n))
    .sort((a, b) => a - b);
  if (!dates.length) return "the last week";
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return `${fmt(dates[0])} to ${fmt(dates[dates.length - 1])}`;
}

function buildExecutivePrompt(timeWindow: string): string {
  return [
    "You are a senior games industry analyst. Produce a weekly, executive-ready report strictly from the provided items (no outside facts, no guessing, no hallucinations).",
    "",
    "Audience: Reaktor — a global consultancy that serves the games industry (we don’t develop games; we build digital products and services around it for studios, publishers, and ecosystem providers). We want to grow globally in this sector.",
    "",
    "Scope:",
    "- Consider only items relevant to the gaming industry (games, platforms, publishers, studios, distribution, tooling, regulations, monetization, etc.).",
    "- Prioritize macro/industry-wide signals: earnings, interim reports, layoffs, investments, acquisitions, divestitures, strategy shifts, platform policy changes, major partnerships, or tech moves.",
    "- Ignore individual game release notes unless there is a clear, reported financial or strategic impact for a studio/publisher/platform.",
    "",
    "You are analyzing a CSV-derived dataset of last week’s news articles with columns: url, published (ISO), extractedContent. Base all analysis only on extractedContent. Cover the entire dataset.",
    `Time window to reference: ${timeWindow}.`,
    "",
    "Output format (Markdown only):",
    "- Start with one sentence stating the week/time window and what you analyzed.",
    "- Then a numbered list of the top 1–5 most important highlights/trends. Each item:",
    "  - is concise but insight-dense (what happened, why it matters, who is impacted, likely implications for the industry),",
    "  - ends with one or more citations to the provided item urls, formatted as [source](url).",
    "- End with a synthesis (max 2 short paragraphs) on what these developments mean for Reaktor’s business development (where we could help, e.g., platform strategy, data, live-ops, tooling, infrastructure, personalization, experimentation, commerce, analytics, AI enablement, etc.).",
    "",
    "Rules:",
    "- Use only the provided items; do not add external knowledge.",
    "- Be precise and cautious: if a conclusion is uncertain based on the text, say so explicitly.",
    "- De-duplicate: merge highly similar items into one point with multiple [source](url) links.",
    "- English language, professional tone.",
  ].join("\n");
}

async function reduceToReport(facts: Fact[]): Promise<string> {
  // Hierarchical reduce to fit small contexts: chunk facts -> per-chunk mini summaries -> final merge
  const chunks = chunkArray(facts, 80); // tune chunk size by experience

  const miniSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const part = chunks[i];
    const system: ChatMessage = {
      role: "system",
      content:
        "You are an analyst creating a concise brief from structured facts. Be precise, do not invent. Output Markdown only.",
    };
    const user: ChatMessage = {
      role: "user",
      content: `You will receive structured facts (JSON).\n\nTask: Create a short bullet summary focusing ONLY on gaming-industry-related items (isGamingRelated=true).\n- Highlight business-wide themes (earnings, layoffs, investments, M&A, trends).\n- Provide 3-6 bullets, each with a short title and a \"[source]\" link to the most representative URL from the chunk.\n- Keep it under 250 words.\n\nFacts JSON:\n${JSON.stringify(
        part
      )}`,
    };
    const md = await withRetry(
      () => callOpenAIText([system, user]),
      `reduce chunk ${i + 1}/${chunks.length}`
    );
    miniSummaries.push(md);
  }

  const combinedFactsNote = `The following are partial summaries created from the dataset in chunks. Merge them into a single weekly brief.`;

  const system: ChatMessage = {
    role: "system",
    content:
      "You are a precise analyst. Output Markdown, no extra prose outside the brief.",
  };
  const timeWindow = computeTimeWindow(facts);
  const execPrompt = buildExecutivePrompt(timeWindow);
  const user: ChatMessage = {
    role: "user",
    content: `${execPrompt}\n\n${combinedFactsNote}\n\nChunk briefs:\n${miniSummaries
      .map((s, i) => `---\n[Chunk ${i + 1}]\n${s}`)
      .join("\n\n")}\n\nProduce the final brief now in Markdown only.`,
  };

  const finalMd = await withRetry(
    () => callOpenAIText([system, user]),
    "final reduce"
  );
  return finalMd;
}

async function main() {
  try {
    const articles = loadArticles();
    console.log(`Loaded ${articles.length} articles`);

    const facts = await extractFactsInBatches(articles);
    const finalReport = await reduceToReport(facts);
    const outPath = path.resolve("feedbin_summary.md");
    fs.writeFileSync(outPath, finalReport, "utf-8");
    console.log(`Wrote final summary: ${outPath}`);
  } catch (err) {
    console.error("Summarization failed:", err);
    process.exit(1);
  }
}

main();
