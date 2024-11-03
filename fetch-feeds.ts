import { format, subDays } from "date-fns";
import * as fs from "fs";
import { JSDOM } from "jsdom";
import { Browser, chromium } from "playwright";
import Parser from "rss-parser";
import { Readability } from "@mozilla/readability";

interface Article {
  articleTitle?: string;
  articleUrl?: string;
  articleDate?: string;
  articleContent?: string;
}

const rssFeeds = [
  "https://www.polygon.com/rss/index.xml",
  "https://insider-gaming.com/feed/",
  "https://kotaku.com/rss",
  "https://mobilegamer.biz/feed/",
  "https://techcrunch.com/feed/",
  "https://venturebeat.com/category/games/feed/",
  "https://www.eurogamer.net/feed",
  "https://www.gamesindustry.biz/feed/data",
  "https://www.gamesindustry.biz/feed/tag/topics/financials",
  "https://www.gamesindustry.biz/rss/gamesindustry_news_feed.rss",
  "https://www.gamesradar.com/feeds/articletype/news/",
  "https://www.theverge.com/rss/index.xml",
];

async function fetchRecentArticles(outputFile: string) {
  try {
    const browser = await chromium.launch();

    const allArticles: Article[] = [];
    const aWeekAgo = subDays(new Date(), 7);

    for (const url of rssFeeds) {
      await processFeed(url, allArticles, aWeekAgo, browser);
    }

    await browser.close();

    const jsonContent = JSON.stringify(
      allArticles.filter((article) => article.articleContent !== undefined),
      null,
      2
    );
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
  browser: Browser,
  date: string
): Promise<string | undefined> {
  console.log(`Haetaan artikkeli (${date.substring(0, 10)}): ${url}`);
  if (!url) {
    return undefined;
  }

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

    console.log("Ok!");
    return article?.textContent;
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    return undefined;
  }
}

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

async function processFeed(
  url: string,
  allArticles: Article[],
  aWeekAgo: Date,
  browser: Browser
) {
  try {
    let parser = new Parser();
    let feed = await parser.parseURL(url);

    const recentItems = feed.items.filter((item: any) => {
      const publishedDate = item.pubDate || item.isoDate;
      return publishedDate ? new Date(publishedDate) >= aWeekAgo : false;
    });

    await callInSequence(recentItems, 10, async (item) => {
      const articleDate = format(
        new Date(item.pubDate || item.isoDate || Date.now()),
        "yyyy-MM-dd HH:mm:ss"
      );

      const articleContent = await fetchArticleContent(
        item.link,
        browser,
        articleDate
      );

      allArticles.push({
        articleTitle: item.title,
        articleUrl: item.link,
        articleDate: articleDate,
        articleContent: articleContent,
      });
    });
  } catch (error: any) {
    console.error(`Virhe syötteestä ${url}: ${error.message}`);
  }
}

// Hae parametrit komentoriviltä
const outputFile = process.argv[2];

if (!outputFile) {
  console.error("Käyttö: npm run start <output-json-tiedosto>");
  process.exit(1);
}

fetchRecentArticles(outputFile);
