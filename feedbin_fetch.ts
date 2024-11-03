import axios from "axios";
import { subDays } from "date-fns";
import { htmlToText } from "html-to-text";
import { Parser } from "json2csv";
import * as dotenv from "dotenv";
import * as fs from "fs";

dotenv.config();

if (!process.env.FEEDBIN_USERNAME || !process.env.FEEDBIN_PASSWORD) {
  throw new Error(
    "FEEDBIN_USERNAME ja FEEDBIN_PASSWORD pitää olla määritelty .env tiedostossa"
  );
}

const config = {
  username: process.env.FEEDBIN_USERNAME,
  password: process.env.FEEDBIN_PASSWORD,
};

interface FeedbinEntry {
  id: number;
  feed_id: number;
  title: string;
  author: string;
  summary: string;
  content: string;
  url: string;
  extracted_content_url: string;
  published: string;
  created_at: string;
  extractedContent?: string;
}

interface FeedbinTagging {
  id: number;
  name: string;
  feed_id: number;
}

interface FeedbinExtractedContent {
  title: string;
  content: string;
  author: string;
  date_published: string;
  lead_image_url: string;
  dek: string;
  next_page_url: string;
  url: string;
  domain: string;
  excerpt: string;
  word_count: number;
  direction: string;
  total_pages: number;
  rendered_pages: number;
}

const weekAgo = subDays(new Date(), 7).toISOString();

const callInSequence = async <T>(
  list: T[],
  concurrency: number,
  fnc: (arg: T) => Promise<any>
) => {
  const queue = [...list];
  const promises: Promise<void>[] = [];

  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item) {
        await fnc(item);
      }
    }
  };

  for (let i = 0; i < concurrency; i++) {
    promises.push(worker());
  }

  await Promise.all(promises);
};

async function fetchFeedbinUrl<T>(url: string, params?: any): Promise<T> {
  try {
    const response = await axios.get(url, {
      auth: { username: config.username, password: config.password },
      params,
    });

    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(`Feedbin API error "${url}": ${error.message}`);
    }
    throw error;
  }
}

// Hakee kaikki tagit ja niihin liittyvät feed ID:t
async function fetchTags(tagNames: string[]): Promise<number[]> {
  try {
    const response = await fetchFeedbinUrl<FeedbinTagging[]>(
      "https://api.feedbin.com/v2/taggings.json"
    );

    return response
      .filter((tag) => tagNames.includes(tag.name))
      .flatMap((tag) => tag.feed_id);
  } catch (error) {
    throw error;
  }
}

// Hakee kaikki viimeisen 7 päivän aikana julkaistut artikkelit feed ID:n perusteella
async function fetchEntries(feedIds: number[]): Promise<FeedbinEntry[]> {
  try {
    const response = await fetchFeedbinUrl<FeedbinEntry[]>(
      "https://api.feedbin.com/v2/entries.json",
      {
        since: weekAgo,
        per_page: 5000,
      }
    );

    return response.filter((entry) => feedIds.includes(entry.feed_id));
  } catch (error) {
    throw error;
  }
}

async function fetchEntryContent(
  entries: FeedbinEntry[]
): Promise<FeedbinEntry[]> {
  try {
    const entriesWithContent: FeedbinEntry[] = await Promise.all(
      entries.map(async (entry) => {
        try {
          const response = await fetchFeedbinUrl<FeedbinExtractedContent>(
            entry.extracted_content_url
          );
          const text = htmlToText(response.content, {
            wordwrap: false,
          }).replace(/\n/g, " ");
          return { ...entry, extractedContent: text };
        } catch (error) {
          return { ...entry, extractedContent: undefined };
        }
      })
    );

    return entriesWithContent;
  } catch (error) {
    throw error;
  }
}

function saveToFile(outputFile: string, data: any) {
  const jsonContent = JSON.stringify(data, null, 2);
  fs.writeFileSync(outputFile, jsonContent, "utf-8");
  console.log(`Artikkelit tallennettu tiedostoon: ${outputFile}`);
}

function saveToCSV(outputFile: string, data: any) {
  const fields = ["url", "published", "extractedContent"];
  const opts = { fields };
  try {
    const parser = new Parser(opts);
    const csv = parser.parse(data);
    fs.writeFileSync(outputFile, csv, "utf-8");
    console.log(`Artikkelit tallennettu CSV-tiedostoon: ${outputFile}`);
  } catch (err) {
    console.error("CSV-tiedoston tallennus epäonnistui:", err);
  }
}

// Pääfunktio
async function main(): Promise<any> {
  try {
    const tagNames = ["Games Industry"];
    const taggedFeedIds = await fetchTags(tagNames);
    console.log("Löydettiin feedejä:", taggedFeedIds.length);
    const entries = await fetchEntries(taggedFeedIds);
    console.log("Haettiin artikkeleita:", entries.length);

    const entriesWithContent = await fetchEntryContent(entries);
    const onlyWithContent = entriesWithContent.filter(
      (entry) => entry.extractedContent !== undefined
    );

    console.log("Haettiin contenttia artikkeleihin:", onlyWithContent.length);
    console.log(
      "Epäonnistuneita contenttihakuja:",
      entriesWithContent.length - onlyWithContent.length
    );

    saveToCSV("feedbin_articles.csv", onlyWithContent);
    saveToFile("feedbin_articles.json", onlyWithContent);
  } catch (error) {
    console.error("Virhe:", error);
  }
}

main();
