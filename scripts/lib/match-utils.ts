/**
 * Shared utilities for matching sales products to 台帳 Excel files
 */

import * as fs from "fs";
import * as path from "path";

export const TAICHO_FOLDERS = [
	"E:/japan/10_TXD提出資料/03_GIGAPODアップ済_台帳",
	"E:/japan/10_TXD提出資料",
	"E:/japan/詳細シート有",
];

/**
 * Normalize product name for matching:
 * - ALL katakana (full-width + half-width) → hiragana
 * - Full-width alphanumeric → half-width
 * - Remove brackets, spaces, common prefixes/suffixes
 */
export function normalize(s: string): string {
	let result = s;

	// Full-width katakana (U+30A1-30F6) → hiragana (U+3041-3096)
	result = result.replace(/[\u30A1-\u30F6]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) - 0x60));

	// Half-width katakana → hiragana
	const hwMap: Record<string, string> = {
		"ｱ":"あ","ｲ":"い","ｳ":"う","ｴ":"え","ｵ":"お",
		"ｶ":"か","ｷ":"き","ｸ":"く","ｹ":"け","ｺ":"こ",
		"ｻ":"さ","ｼ":"し","ｽ":"す","ｾ":"せ","ｿ":"そ",
		"ﾀ":"た","ﾁ":"ち","ﾂ":"つ","ﾃ":"て","ﾄ":"と",
		"ﾅ":"な","ﾆ":"に","ﾇ":"ぬ","ﾈ":"ね","ﾉ":"の",
		"ﾊ":"は","ﾋ":"ひ","ﾌ":"ふ","ﾍ":"へ","ﾎ":"ほ",
		"ﾏ":"ま","ﾐ":"み","ﾑ":"む","ﾒ":"め","ﾓ":"も",
		"ﾔ":"や","ﾕ":"ゆ","ﾖ":"よ",
		"ﾗ":"ら","ﾘ":"り","ﾙ":"る","ﾚ":"れ","ﾛ":"ろ",
		"ﾜ":"わ","ﾝ":"ん",
		"ｧ":"ぁ","ｨ":"ぃ","ｩ":"ぅ","ｪ":"ぇ","ｫ":"ぉ",
		"ｯ":"っ","ｬ":"ゃ","ｭ":"ゅ","ｮ":"ょ",
		"ｰ":"ー","ﾞ":"゛","ﾟ":"゜",
	};
	result = result.replace(/[\uFF65-\uFF9F]/g, (c) => hwMap[c] ?? c);

	// Combine dakuten
	result = result
		.replace(/か゛/g,"が").replace(/き゛/g,"ぎ").replace(/く゛/g,"ぐ").replace(/け゛/g,"げ").replace(/こ゛/g,"ご")
		.replace(/さ゛/g,"ざ").replace(/し゛/g,"じ").replace(/す゛/g,"ず").replace(/せ゛/g,"ぜ").replace(/そ゛/g,"ぞ")
		.replace(/た゛/g,"だ").replace(/ち゛/g,"ぢ").replace(/つ゛/g,"づ").replace(/て゛/g,"で").replace(/と゛/g,"ど")
		.replace(/は゛/g,"ば").replace(/ひ゛/g,"び").replace(/ふ゛/g,"ぶ").replace(/へ゛/g,"べ").replace(/ほ゛/g,"ぼ")
		.replace(/は゜/g,"ぱ").replace(/ひ゜/g,"ぴ").replace(/ふ゜/g,"ぷ").replace(/へ゜/g,"ぺ").replace(/ほ゜/g,"ぽ")
		.replace(/う゛/g,"ゔ");

	// Full-width alphanumeric → half-width
	result = result.replace(/[\uFF01-\uFF5E]/g, (c) =>
		String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

	// Remove noise
	result = result
		.replace(/[\s　【】\[\]()（）■□「」『』・×/／_\-＋+&＆]/g, "")
		.replace(/\d{4}\.\d{2}\.\d{2}/g, "")
		.replace(/(○|〇|◯|新台帳|台帳|提出|更新|商品台帳|商品カード|案内カード)/g, "")
		.replace(/oa未定/gi, "")
		.toLowerCase();

	return result;
}

/** Extract core product name — aggressive cleanup for matching */
function extractCoreName(productName: string): string {
	return normalize(productName)
		// Remove set/quantity patterns (hiragana after normalize)
		.replace(/\d*(本|足|枚|個|袋|缶|食|包|点|回分|日間|ml)(せっと|ぜっと|組)/g, "")
		.replace(/\d*(だーす|たーす)(せっと)?/g, "")
		.replace(/(せっと|とくべつせっと)/g, "")
		.replace(/(単品|単体)/g, "")
		// Remove common prefixes/modifiers
		.replace(/(期間限定|期間設定|条件変更|ものすた|かたろぐ|送料無料|じっくり|販売価格変更|別売|増量|決算|通常価格|卸価格変更|防災|防災かたろぐ)/g, "")
		.replace(/(txd|txd用|ごるふ)/g, "")
		.replace(/(ぼーる付|よびばってりー付)/g, "")
		// Remove leading/trailing numbers
		.replace(/^\d+/g, "")
		.replace(/\d+$/g, "")
		// Remove size indicators
		.replace(/(しんぐる|だぶる|s|m|l|ll|cm|㎝|kg)/g, "")
		.trim();
}

/** Extract keywords (3+ char sequences of hiragana/kanji/alpha) from a core name */
function extractKeywords(coreName: string): string[] {
	// Split on numbers and short connectors, keep chunks >= 3 chars
	const chunks = coreName.split(/[\d]+/).filter((s) => s.length >= 3);
	return chunks;
}

export type FileEntry = {
	normalizedName: string;
	coreName: string;
	filePath: string;
	fileDate: string;
};

/** Extract product name from 台帳 filename */
function extractProductFromFilename(fileName: string): string {
	let name = fileName.replace(/\.\w+$/, "");
	// Remove date prefix patterns
	name = name.replace(/^\d{6}_/, "");
	name = name.replace(/^\d{4}\.\d{2}\.\d{2}_/, "");
	name = name.replace(/^999999_/, "");
	name = name.replace(/^OA未定_/, "");
	name = name.replace(/^確認用）/, "");
	// Remove date suffix: "_台帳_2025.11.28更新" etc.
	name = name.replace(/_台帳.*$/, "");
	name = name.replace(/_新台帳.*$/, "");
	name = name.replace(/_提出.*$/, "");
	name = name.replace(/_商品台帳.*$/, "");
	name = name.replace(/_商品カード.*$/, "");
	name = name.replace(/_案内カード.*$/, "");
	// Remove trailing date patterns
	name = name.replace(/_\d{2}\.\d{2}\.\d{2}.*$/, "");
	// Remove markers
	name = name.replace(/[■□]/g, "");
	return name.trim();
}

/** Scan 台帳 folders and return all files with normalized + core product names */
export function scanTaichoFiles(
	folders: string[] = TAICHO_FOLDERS,
): FileEntry[] {
	const entries: FileEntry[] = [];

	for (const folder of folders) {
		if (!fs.existsSync(folder)) continue;

		const scanDir = (dir: string) => {
			let dirEntries;
			try {
				dirEntries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of dirEntries) {
				if (entry.isDirectory()) {
					scanDir(path.join(dir, entry.name));
				} else if (
					(entry.name.endsWith(".xlsx") || entry.name.endsWith(".xlsm")) &&
					!entry.name.startsWith("~$")
				) {
					const filePath = path.join(dir, entry.name);
					const productName = extractProductFromFilename(entry.name);
					const normalizedName = normalize(productName);
					const coreName = extractCoreName(productName);

					const dateMatch = entry.name.match(/(\d{4})[.\-](\d{2})[.\-](\d{2})/);
					const fileDate = dateMatch
						? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
						: "2000-01-01";

					if (coreName.length >= 3) {
						entries.push({ normalizedName, coreName, filePath, fileDate });
					}
				}
			}
		};

		scanDir(folder);
	}

	// Sort newest first
	entries.sort((a, b) => b.fileDate.localeCompare(a.fileDate));

	return entries;
}

/** Check if two normalized names match by core content inclusion */
export function isSimilar(salesName: string, fileName: string): boolean {
	const a = extractCoreName(salesName);
	const b = extractCoreName(fileName);

	if (a.length < 3 || b.length < 3) return false;
	if (a.includes(b) || b.includes(a)) return true;

	return false;
}

/** Load .env.local or .env into process.env */
export function loadEnv() {
	const candidates = [".env.local", ".env"];
	const envPath = candidates
		.map((f) => path.resolve(process.cwd(), f))
		.find((p) => fs.existsSync(p));
	if (!envPath) {
		console.error("ERROR: No .env.local or .env found.");
		process.exit(1);
	}
	const content = fs.readFileSync(envPath, "utf-8");
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		const val = trimmed.slice(eqIdx + 1).trim();
		if (!process.env[key]) process.env[key] = val;
	}
}

/** Find the best matching file for a sales product name */
export function findBestMatch(
	salesName: string,
	entries: FileEntry[],
): string | null {
	const salesCore = extractCoreName(salesName);
	if (salesCore.length < 3) return null;

	// Pass 1: exact core match
	for (const entry of entries) {
		if (salesCore === entry.coreName) {
			return entry.filePath;
		}
	}

	// Pass 2: core inclusion match (either direction)
	let bestMatch: string | null = null;
	let bestLen = 0;

	for (const entry of entries) {
		if (entry.coreName.includes(salesCore)) {
			if (salesCore.length > bestLen) {
				bestLen = salesCore.length;
				bestMatch = entry.filePath;
			}
		} else if (salesCore.includes(entry.coreName) && entry.coreName.length >= 4) {
			if (entry.coreName.length > bestLen) {
				bestLen = entry.coreName.length;
				bestMatch = entry.filePath;
			}
		}
	}

	if (bestMatch) return bestMatch;

	// Pass 3: keyword overlap — extract keywords from sales name, find files sharing keywords
	const salesKeywords = extractKeywords(salesCore);
	if (salesKeywords.length === 0) return null;

	let bestKeywordMatch: string | null = null;
	let bestKeywordScore = 0;

	for (const entry of entries) {
		const fileKeywords = extractKeywords(entry.coreName);
		let matchedLen = 0;

		for (const sk of salesKeywords) {
			for (const fk of fileKeywords) {
				if (sk.includes(fk) || fk.includes(sk)) {
					matchedLen += Math.min(sk.length, fk.length);
				}
			}
		}

		// Require at least 4 chars matched and 50%+ of sales keywords covered
		if (matchedLen >= 4 && matchedLen > bestKeywordScore && matchedLen >= salesCore.length * 0.4) {
			bestKeywordScore = matchedLen;
			bestKeywordMatch = entry.filePath;
		}
	}

	return bestKeywordMatch;
}
