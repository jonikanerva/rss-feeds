import * as fs from "fs";
import * as xml2js from "xml2js";
import Parser from "rss-parser";
import { JSDOM } from 'jsdom';
import { chromium } from "playwright";
import { Readability } from "@mozilla/readability";
import { format, subDays } from "date-fns";

declare global {
  interface Window {
    Readability: typeof Readability;
  }
}

interface Article {
  title?: string;
  link?: string;
  published?: string;
  summary?: string;
  content?: string;
  article?: string;
}

async function fetchRecentArticles(opmlFile: string, outputFile: string) {
  try {
    const browser = await chromium.launch();

    const opmlContent = fs.readFileSync(opmlFile, "utf-8");
    const parser = new xml2js.Parser();
    const opml = await parser.parseStringPromise(opmlContent);
    const outlines = opml.opml.body[0].outline;

    const allArticles: Article[] = [];
    const aWeekAgo = subDays(new Date(), 7);

    for (const outline of outlines) {
      if (outline.outline) {
        for (const subOutline of outline.outline) {
          await processFeed(subOutline, allArticles, aWeekAgo, browser);
        }
      } else {
        await processFeed(outline, allArticles, aWeekAgo, browser);
      }
    }

    await browser.close();

    const jsonContent = JSON.stringify(allArticles, null, 2);
    fs.writeFileSync(outputFile, jsonContent, "utf-8");
    console.log(`Artikkelit tallennettu tiedostoon: ${outputFile}`);
    process.exit(0);
  } catch (error) {
    console.error("Virhe:", error);
    process.exit(1);
  }
}

async function fetchArticleContent(
  url: string | undefined,
  browser: any,
  date: string
): Promise<string | undefined> {
  console.log(`Haetaan artikkeli (${date.substring(0,10)}): ${url}`);

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { timeout: 120000 });

    const domContent = await page.evaluate(() => {
      return document.documentElement.outerHTML;
    });

    const dom = new JSDOM(domContent);
    const reader = new Readability(dom.window.document);
    const article = reader.parse() || undefined;
    await context.close();

    console.log('Ok!')
    return article?.textContent;

  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    return undefined;
  }
}

const callInSequence = async <T>(
  list: T[],
  concurrency: number,
  fnc: (arg: T) => Promise<any>,
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

async function processFeed(
  outline: any,
  allArticles: Article[],
  aWeekAgo: Date,
  browser: any
) {
  if (outline.$.xmlUrl) {
    try {
      let parser = new Parser();
      let feed = await parser.parseURL(outline.$.xmlUrl);

      const recentItems = feed.items.filter((item: any) => {
        const publishedDate = item.pubDate || item.isoDate;
        return publishedDate ? new Date(publishedDate) >= aWeekAgo : false;
      });

      await callInSequence(recentItems, 10, async (item) => {
        const publishedDate = item.pubDate || item.isoDate || new Date().toISOString();
        const articleDate = new Date(publishedDate);
        const articleContent = await fetchArticleContent(item.link, browser, publishedDate);

        allArticles.push({
          title: item.title,
          link: item.link,
          published: format(articleDate, "yyyy-MM-dd HH:mm:ss"),
          summary: item.contentSnippet,
          content: item.content,
          article: articleContent,
        });
      });
    } catch (error: any) {
      console.error(`Virhe syötteestä ${outline.$.xmlUrl}: ${error.message}`);
    }
  }
}

// Hae parametrit komentoriviltä
const opmlFile = process.argv[2];
const outputFile = process.argv[3];

if (!opmlFile || !outputFile) {
  console.error("Käyttö: npm run start <opml-tiedosto> <json-tiedosto>");
  process.exit(1);
}

fetchRecentArticles(opmlFile, outputFile);
