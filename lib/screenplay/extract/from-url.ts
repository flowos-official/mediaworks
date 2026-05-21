// lib/screenplay/extract/from-url.ts
import * as cheerio from "cheerio";
import { GEMINI_FLASH } from "@/lib/gemini-models";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { EXTRACT_SYSTEM_INSTRUCTION, parseBriefJson } from "./brief-prompt";
import type { ProductBrief } from "../types";

const MODEL = GEMINI_FLASH;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 3_000_000;          // 3 MB cap for the HTML body
const MAX_BODY_CHARS = 24_000;
const MAX_PROMPT_CHARS = 30_000;

// Image extraction caps
const MAX_IMAGES = 4;
const IMG_FETCH_TIMEOUT_MS = 10_000;
const IMG_MAX_BYTES = 2_500_000;      // 2.5 MB per image
const ALLOWED_IMG_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

// Heuristics to skip icons / logos / sprites.
const SKIP_IMG_PATTERNS = [
  /sprite/i, /icon/i, /favicon/i, /logo/i, /pixel/i, /tracker/i, /1x1/i,
  /\bspacer\b/i, /placeholder/i, /\bavatar\b/i,
];

let _genAI: GoogleGenerativeAI | null = null;
function getGenAI(): GoogleGenerativeAI {
  if (!_genAI) _genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
  return _genAI;
}

interface UrlSnapshot {
  url: string;
  finalUrl: string;
  title: string;
  description: string;
  headings: string[];
  body: string;
  imageUrls: string[];
}

interface FetchedImage {
  url: string;
  mimeType: string;
  base64: string;
}

export function isLikelyPublicHttpUrl(input: string): boolean {
  try {
    const u = new URL(input);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if (!host || host === "localhost") return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

async function fetchHtml(url: string): Promise<{ html: string; finalUrl: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`URL fetch timeout ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        // Many JP shopping pages 403 default UAs. Use a common desktop UA.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "ja,en;q=0.8",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    if (!res.ok) throw new Error(`URLの取得に失敗 (HTTP ${res.status})`);
    const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ctype && !ctype.includes("html") && !ctype.includes("text") && !ctype.includes("xml")) {
      throw new Error(`HTMLではないコンテンツです: ${ctype}`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error("レスポンスボディがありません");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total > MAX_BYTES) {
          // Stop reading further; what we have is enough.
          try { await reader.cancel(); } catch { /* ignore */ }
          break;
        }
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    // Best-effort decode (most JP sites are UTF-8 today; fallback to latin1).
    let html: string;
    try { html = new TextDecoder("utf-8", { fatal: false }).decode(buf); }
    catch { html = buf.toString("latin1"); }
    return { html, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

export function summarizeHtml(html: string, requestUrl: string, finalUrl: string): UrlSnapshot {
  const $ = cheerio.load(html);
  // Strip noise.
  $("script, style, noscript, svg, iframe, link, meta[name=viewport]").remove();
  const title = ($("meta[property='og:title']").attr("content") || $("title").text() || "").trim().slice(0, 300);
  const description = (
    $("meta[property='og:description']").attr("content") ||
    $("meta[name='description']").attr("content") ||
    ""
  ).trim().slice(0, 1000);

  const headings: string[] = [];
  $("h1, h2, h3").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t && t.length <= 300) headings.push(t);
  });

  // Prefer <main>, fall back to <article>, then <body>.
  const main = $("main").first();
  const article = $("article").first();
  const root = main.length ? main : article.length ? article : $("body");
  const bodyText = root.text().replace(/\s+/g, " ").trim().slice(0, MAX_BODY_CHARS);

  // Image candidates: og:image first, then prominent <img> inside the main root.
  const candidates: string[] = [];
  const push = (raw: string | undefined) => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("data:")) return;
    let resolved: string;
    try { resolved = new URL(trimmed, finalUrl).toString(); } catch { return; }
    if (SKIP_IMG_PATTERNS.some((re) => re.test(resolved))) return;
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

  push($("meta[property='og:image']").attr("content"));
  push($("meta[property='og:image:url']").attr("content"));
  push($("meta[property='og:image:secure_url']").attr("content"));
  push($("meta[name='twitter:image']").attr("content"));
  push($("link[rel='image_src']").attr("href"));

  root.find("img").each((_, el) => {
    if (candidates.length >= MAX_IMAGES * 3) return false;
    const $el = $(el);
    // Skip obviously tiny / decorative images by declared dimensions.
    const w = Number($el.attr("width") || "0");
    const h = Number($el.attr("height") || "0");
    if ((w > 0 && w < 80) || (h > 0 && h < 80)) return;
    const src =
      $el.attr("src") ||
      $el.attr("data-src") ||
      $el.attr("data-original") ||
      ($el.attr("srcset") || "").split(",").pop()?.trim().split(/\s+/)[0];
    push(src);
  });

  return {
    url: requestUrl,
    finalUrl,
    title,
    description,
    headings: headings.slice(0, 60),
    body: bodyText,
    imageUrls: candidates.slice(0, MAX_IMAGES * 3),
  };
}

async function fetchImage(url: string): Promise<FetchedImage | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("image fetch timeout")), IMG_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
    if (!res.ok) return null;
    const ctype = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_IMG_MIME.has(ctype)) return null;
    const lenHeader = Number(res.headers.get("content-length") || "0");
    if (lenHeader && lenHeader > IMG_MAX_BYTES) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > IMG_MAX_BYTES) { try { await reader.cancel(); } catch {} return null; }
        chunks.push(value);
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { url, mimeType: ctype, base64: buf.toString("base64") };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchImagesParallel(urls: string[]): Promise<FetchedImage[]> {
  // Try up to 3x the cap, keep the first MAX_IMAGES that succeed.
  const settled = await Promise.allSettled(urls.map(fetchImage));
  const out: FetchedImage[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) {
      out.push(r.value);
      if (out.length >= MAX_IMAGES) break;
    }
  }
  return out;
}

function buildPrompt(s: UrlSnapshot, imageCount: number): string {
  const lines: string[] = [];
  lines.push(`URL: ${s.url}`);
  if (s.finalUrl && s.finalUrl !== s.url) lines.push(`Final URL: ${s.finalUrl}`);
  lines.push("");
  if (s.title) lines.push(`Title: ${s.title}`);
  if (s.description) lines.push(`Meta description: ${s.description}`);
  if (s.headings.length) {
    lines.push("");
    lines.push("Headings:");
    for (const h of s.headings) lines.push(`- ${h}`);
  }
  lines.push("");
  lines.push("Body text:");
  lines.push(s.body);
  if (imageCount > 0) {
    lines.push("");
    lines.push(`このリクエストには、ページから抽出した商品画像が ${imageCount} 枚添付されています。`);
    lines.push("画像から読み取れる素材感・形状・色・同梱物などを description / notes に反映してください。");
  }
  let prompt = lines.join("\n");
  if (prompt.length > MAX_PROMPT_CHARS) {
    prompt = prompt.slice(0, MAX_PROMPT_CHARS) + "\n\n…(長すぎたため打ち切り)";
  }
  return prompt;
}

export interface UrlExtractResult {
  brief: ProductBrief;
  imageCount: number;
  finalUrl: string;
}

export async function extractBriefFromUrl(url: string): Promise<UrlExtractResult> {
  if (!isLikelyPublicHttpUrl(url)) {
    throw new Error("有効な http/https の公開 URL を入力してください");
  }
  const { html, finalUrl } = await fetchHtml(url);
  const snapshot = summarizeHtml(html, url, finalUrl);
  if (!snapshot.title && !snapshot.body) {
    throw new Error("URL から抽出できるテキストが見つかりませんでした");
  }
  const images = snapshot.imageUrls.length > 0 ? await fetchImagesParallel(snapshot.imageUrls) : [];

  const model = getGenAI().getGenerativeModel({
    model: MODEL,
    generationConfig: { responseMimeType: "application/json" },
    systemInstruction: EXTRACT_SYSTEM_INSTRUCTION,
  });

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: buildPrompt(snapshot, images.length) },
  ];
  for (const img of images) {
    parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } });
  }
  const result = await model.generateContent(parts);
  const brief = parseBriefJson(result.response.text());
  return { brief, imageCount: images.length, finalUrl };
}
