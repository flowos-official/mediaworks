/**
 * Shared library for parsing 台帳 Excel files
 * Used by: scripts/import-product-details.ts, scripts/extract-product-images.ts,
 *          app/api/products/upload-taicho/route.ts
 */

import * as XLSX from "xlsx";
import AdmZip from "adm-zip";
import * as path from "path";

// ---------------------------------------------------------------------------
// Cell readers
// ---------------------------------------------------------------------------

function cell(ws: XLSX.WorkSheet, ref: string): string {
	const c = ws[ref];
	if (!c) return "";
	return String(c.v ?? "").trim();
}

function cellNum(ws: XLSX.WorkSheet, ref: string): number | null {
	const c = ws[ref];
	if (!c || c.v == null) return null;
	const n = Number(c.v);
	return isNaN(n) ? null : n;
}

// ---------------------------------------------------------------------------
// Parse product details from a 台帳 Excel buffer
// ---------------------------------------------------------------------------

export function parseTaichoBuffer(
	buffer: Buffer,
	productCode: string,
	fileName?: string,
): Record<string, unknown> | null {
	try {
		const wb = XLSX.read(buffer, { type: "buffer" });
		const sheets = wb.SheetNames;

		const s1Name = sheets.find((s) => s.includes("商品概要"));
		if (!s1Name) return null;

		const s1 = wb.Sheets[s1Name];
		const s2 = wb.Sheets[sheets.find((s) => s.includes("商品補足")) ?? ""];
		const s3 = wb.Sheets[sheets.find((s) => s.includes("配送") || s.includes("WEB")) ?? ""];
		const s4 = wb.Sheets[sheets.find((s) => s.includes("社外秘")) ?? ""];

		const isYes = (v: string) => v === "〇" || v === "○";
		const or = (a: string, b: string) => a || b || null;
		const s5 = wb.Sheets[sheets.find((s) => s.includes("社内システム") || s.includes("システム入力")) ?? ""];
		const sDetail = wb.Sheets[sheets.find((s) => s === "詳細") ?? ""];

		// ===== Sheet 1: 商品概要 =====
		const productName = cell(s1, "E4") || cell(s1, "E3");
		const productNameKana = cell(s1, "E3");
		const categoryTxd1 = cell(s1, "Y4");
		const categoryTxd2 = cell(s1, "Y5");
		const supplier = cell(s1, "AG4");
		const txdManager = cell(s1, "AG5");
		const productGrNumber = cell(s1, "Y3");
		const salesChannels = {
			tv: isYes(cell(s1, "Y2")),
			ec: isYes(cell(s1, "AB2")),
			paper: isYes(cell(s1, "AE2")),
			other: isYes(cell(s1, "AH2")),
		};
		const description = cell(s1, "S8");

		const setContents: string[] = [];
		for (let r = 12; r <= 20; r++) {
			const v = cell(s1, `T${r}`);
			if (v) setContents.push(v);
		}

		const skus: Array<Record<string, unknown>> = [];
		for (let r = 22; r <= 37; r++) {
			const name = cell(s1, `E${r}`);
			if (!name) continue;
			skus.push({
				name,
				color: cell(s1, `P${r}`),
				size: cell(s1, `T${r}`),
				price_incl: cellNum(s1, `X${r}`),
				price_excl: cellNum(s1, `AB${r}`),
				shipping: cellNum(s1, `AE${r}`),
			});
		}

		// Additional Sheet 1 fields
		const materials = cell(s1, "B39");
		const sizeW = cell(s1, "V39");
		const sizeD = cell(s1, "AA39");
		const sizeH = cell(s1, "AF39");
		const sizeWt = cell(s1, "AI39");
		const productSize = (sizeW || sizeD || sizeH)
			? `幅${sizeW || "-"}×奥${sizeD || "-"}×高${sizeH || "-"}cm${sizeWt ? `, ${sizeWt}kg` : ""}`
			: null;
		const contentVolume = cell(s1, "S44");
		const mfgCountryS1 = cell(s1, "E45");
		const salesCompany = cell(s1, "V46");
		const hasManual = cell(s1, "E47");
		const hasWarranty = cell(s1, "L47");
		const expiryInfo = cell(s1, "AB47");
		const productForm = cell(s1, "E48") === "〇" ? cell(s1, "F48") : (cell(s1, "J48") ? "組立式" : "");

		// Web description (rows 50-70)
		const webDescParts: string[] = [];
		for (let r = 49; r <= 70; r++) {
			const v = cell(s1, `B${r}`);
			if (v && v.length > 2) webDescParts.push(v);
		}
		const webDescription = webDescParts.join("\n");

		// ===== Sheet 2: 商品補足 =====
		let returnPolicy = "";
		let exchangePolicy = "";
		let careInstructions = "";
		const usageNotes: string[] = [];
		const faq: Array<Record<string, string>> = [];
		let emergencyTreatment = "";
		let intendedUse = "";
		let notForUse = "";
		let usageAmount = "";
		let shelfLife = "";
		let returnCriteria = "";

		if (s2) {
			returnPolicy = cell(s2, "L8");
			exchangePolicy = cell(s2, "L10");
			careInstructions = cell(s2, "L13");
			// Usage notes: scan all odd rows from 15 to 27
			for (let r = 15; r <= 27; r += 2) {
				const v = cell(s2, `L${r}`);
				if (v && v !== "-") usageNotes.push(v);
			}
			emergencyTreatment = cell(s2, "L25");
			// FAQ: scan rows 28-48 for Q&A pairs
			for (let r = 28; r <= 48; r += 2) {
				const q = cell(s2, `B${r}`);
				const a = cell(s2, `L${r}`);
				if (q && q !== "-" && a && a !== "-") {
					faq.push({ question: q, answer: a });
				}
			}
			intendedUse = cell(s2, "L32");
			notForUse = cell(s2, "L34");
			usageAmount = cell(s2, "L38");
			shelfLife = cell(s2, "L41");
			returnCriteria = cell(s2, "L49");
		}

		// ===== Sheet 3: 配送・WEB =====
		let shippingCompany = "";
		let packageSize = "";
		let packageWeight: number | null = null;
		const janCodes: string[] = [];
		let wrapping = "";
		let makerPartNumber = "";
		let shippingNotes = "";
		let packageType = "";
		let webSalesInfo: Record<string, unknown> | null = null;

		if (s3) {
			shippingCompany = cell(s3, "E25");
			const w = cellNum(s3, "F28");
			const d = cellNum(s3, "J28");
			const h = cellNum(s3, "N28");
			if (w || d || h) packageSize = `${w ?? "-"}×${d ?? "-"}×${h ?? "-"}`;
			packageWeight = cellNum(s3, "S28");
			packageType = cell(s3, "Y28");
			for (let r = 8; r <= 16; r++) {
				const jan = cell(s3, `X${r}`);
				if (jan) janCodes.push(jan);
			}
			wrapping = cell(s3, "AF8");
			makerPartNumber = cell(s3, "AB8");
			shippingNotes = cell(s3, "Y25");

			// WEB登録情報
			const webEnabled = cell(s3, "E41");
			const webName = cell(s3, "L41");
			const webCategory = cell(s3, "F43");
			if (webEnabled || webName) {
				webSalesInfo = {
					enabled: isYes(webEnabled),
					web_product_name: webName || null,
					category: webCategory || null,
					coupon: cell(s3, "H44") || null,
					point_target: cell(s3, "R44") || null,
					point_usage: cell(s3, "Z44") || null,
					point_rate: cell(s3, "AH44") || null,
				};
			}
		}

		// ===== Sheet 4: 社外秘情報 =====
		let costPrice: number | null = null;
		let wholesaleRate: number | null = null;
		let manufacturer = "";
		let manufacturerCountry = "";
		let supplierContact: Record<string, string> = {};
		let salesPeriod: Record<string, unknown> | null = null;
		let orderUnit = "";
		let leadTime = "";
		let orderContact: Record<string, string> | null = null;
		let inquiryContact: Record<string, string> | null = null;
		let supplierAddress = "";
		let returnDestination: Record<string, string> | null = null;
		let shipperInfo: Record<string, string> | null = null;

		if (s4) {
			costPrice = cellNum(s4, "AB8");
			wholesaleRate = cellNum(s4, "AF8");

			// Sales period
			const startY = cell(s4, "E25");
			const startM = cell(s4, "I25");
			const endY = cell(s4, "T25");
			const endM = cell(s4, "X25");
			const endD = cell(s4, "AB25");
			if (startY) {
				salesPeriod = {
					start: `${startY}年${startM || "?"}月`,
					end: endY !== "2099" ? `${endY}年${endM}月${endD}日` : "無期限",
				};
			}

			orderUnit = cell(s4, "E26") ? `${cell(s4, "E26")}${cell(s4, "H26")}` : "";
			const ltDays = cell(s4, "I27");
			leadTime = ltDays ? `発注後${ltDays}営業日` : "";

			// Supplier contact (営業部門)
			const company = cell(s4, "E30");
			const person = cell(s4, "S32");
			const tel = cell(s4, "H33");
			const faxVal = cell(s4, "S33");
			const email = cell(s4, "AD32");
			if (company) supplierContact = { company, person, tel, fax: faxVal, email };

			// Order destination (発注書送付先)
			const ordDept = cell(s4, "H34");
			const ordPerson = cell(s4, "S34");
			const ordTel = cell(s4, "H35");
			const ordFax = cell(s4, "S35");
			const ordEmail = cell(s4, "AD34");
			if (ordDept || ordPerson) {
				orderContact = { department: ordDept, person: ordPerson, tel: ordTel, fax: ordFax, email: ordEmail };
			}

			// Inquiry contact (問合せ先)
			const inqDept = cell(s4, "H36");
			const inqPerson = cell(s4, "S36");
			const inqTel = cell(s4, "H37");
			const inqFax = cell(s4, "S37");
			const inqEmail = cell(s4, "AD36");
			if (inqDept || inqPerson) {
				inquiryContact = { department: inqDept, person: inqPerson, tel: inqTel, fax: inqFax, email: inqEmail };
			}

			// Address
			const zip = cell(s4, "F38");
			const addr = cell(s4, "E39");
			if (zip || addr) supplierAddress = `〒${zip} ${addr}`;

			// Return destination (返品商品送付先)
			const retCompany = cell(s4, "E41");
			const retPerson = cell(s4, "S43");
			const retTel = cell(s4, "H44");
			const retZip = cell(s4, "F45");
			const retAddr = cell(s4, "E46");
			if (retCompany) {
				returnDestination = { company: retCompany, person: retPerson, tel: retTel, address: `〒${retZip} ${retAddr}` };
			}

			// Shipper (出荷元)
			const shipCompany = cell(s4, "E48");
			const shipPerson = cell(s4, "S50");
			const shipTel = cell(s4, "H50") || cell(s4, "H51");
			const shipEmail = cell(s4, "AD50");
			if (shipCompany) {
				shipperInfo = { company: shipCompany, person: shipPerson, tel: shipTel, email: shipEmail };
			}
		}

		// Detail sheet (製造発売元)
		if (sDetail) {
			const mfr = cell(sDetail, "I15");
			if (mfr) manufacturer = mfr;
			const country = cell(sDetail, "C9") || cell(sDetail, "I9");
			if (country && country.length <= 10) manufacturerCountry = country;
		}
		// Fallback: Sheet 1 manufacturing country
		if (!manufacturerCountry && mfgCountryS1) manufacturerCountry = mfgCountryS1;

		// ===== Sheet 5: 社内システム入力用 =====
		let paymentMethods: Record<string, boolean> | null = null;
		let shippingFees: Record<string, unknown> | null = null;
		let subscriptionInfo: Record<string, unknown> | null = null;

		if (s5) {
			paymentMethods = {
				cash_on_delivery: isYes(cell(s5, "V6")),
				credit: isYes(cell(s5, "Z6")),
				deferred: isYes(cell(s5, "AD6")),
				no_charge: isYes(cell(s5, "AH6")),
			};

			const tvShipping = cellNum(s5, "F30");
			const ecShipping = cellNum(s5, "V30");
			if (tvShipping || ecShipping) {
				shippingFees = {
					tv_shipping: tvShipping,
					ec_shipping: ecShipping,
					tv_deferred_fee: cellNum(s5, "Z7"),
					ec_cod_fee: cellNum(s5, "V32"),
					ec_deferred_fee: cellNum(s5, "V34"),
				};
			}

			const subCycle = cell(s5, "Z22");
			if (subCycle && subCycle !== "-") {
				subscriptionInfo = {
					cycle: subCycle,
					price: cellNum(s5, "Z23"),
					initial_price: cellNum(s5, "Z25"),
				};
			}
		}

		const dateMatch = (fileName ?? "").match(/(\d{4})[.\-](\d{2})[.\-](\d{2})/);
		const fileDate = dateMatch
			? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
			: null;

		return {
			product_code: productCode,
			product_name: productName || productCode,
			product_name_kana: productNameKana || null,
			category_txd1: categoryTxd1 || null,
			category_txd2: categoryTxd2 || null,
			supplier: supplier || null,
			txd_manager: txdManager || null,
			sales_channels: salesChannels,
			description: description || null,
			set_contents: setContents.length > 0 ? setContents : null,
			skus: skus.length > 0 ? skus : null,
			return_policy: returnPolicy || null,
			exchange_policy: exchangePolicy || null,
			care_instructions: careInstructions || null,
			usage_notes: usageNotes.length > 0 ? usageNotes : null,
			faq: faq.length > 0 ? faq : null,
			shipping_company: shippingCompany || null,
			package_size: packageSize || null,
			package_weight: packageWeight,
			jan_codes: janCodes.length > 0 ? janCodes : null,
			wrapping: wrapping || null,
			manufacturer: manufacturer || null,
			manufacturer_country: manufacturerCountry || null,
			cost_price: costPrice,
			wholesale_rate: wholesaleRate,
			supplier_contact: Object.keys(supplierContact).length > 0 ? supplierContact : null,
			source_file: fileName ? path.basename(fileName) : null,
			file_date: fileDate,
			// New fields
			product_gr_number: productGrNumber || null,
			materials: materials || null,
			product_size: productSize,
			content_volume: contentVolume || null,
			manufacturing_country: manufacturerCountry || mfgCountryS1 || null,
			sales_company: salesCompany || null,
			has_manual: hasManual || null,
			has_warranty: hasWarranty || null,
			expiry_info: expiryInfo || null,
			product_form: productForm || null,
			web_description: webDescription || null,
			emergency_treatment: emergencyTreatment || null,
			intended_use: intendedUse || null,
			not_for_use: notForUse || null,
			usage_amount: usageAmount || null,
			shelf_life: shelfLife || null,
			return_criteria: returnCriteria || null,
			maker_part_number: makerPartNumber || null,
			shipping_notes: shippingNotes || null,
			package_type: packageType || null,
			web_sales_info: webSalesInfo,
			sales_period: salesPeriod,
			order_unit: orderUnit || null,
			lead_time: leadTime || null,
			order_contact: orderContact,
			inquiry_contact: inquiryContact,
			supplier_address: supplierAddress || null,
			return_destination: returnDestination,
			shipper_info: shipperInfo,
			payment_methods: paymentMethods,
			shipping_fees: shippingFees,
			subscription_info: subscriptionInfo,
		};
	} catch (err) {
		console.error(`  Error parsing taicho:`, (err as Error).message);
		return null;
	}
}

// ---------------------------------------------------------------------------
// Extract images from a 台帳 Excel buffer
// ---------------------------------------------------------------------------

export type ExtractedImage = {
	sheetName: string | null;
	fileName: string;
	mimeType: string;
	data: Buffer;
};

const MIME_MAP: Record<string, string> = {
	jpeg: "image/jpeg",
	jpg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	bmp: "image/bmp",
	emf: "image/emf",
	wmf: "image/wmf",
	tiff: "image/tiff",
	tif: "image/tiff",
	wdp: "image/vnd.ms-photo",
};

export function extractImages(buffer: Buffer): ExtractedImage[] {
	const zip = new AdmZip(buffer);
	const entries = zip.getEntries();
	const images: ExtractedImage[] = [];

	// Build sheet-to-drawing mapping and drawing-to-image mapping
	const sheetToDrawing = new Map<string, string>(); // sheet rels file → drawing file
	const drawingToImages = new Map<string, string[]>(); // drawing rels file → image paths
	const sheetNames = new Map<number, string>(); // sheet index → sheet name

	// Parse workbook.xml for sheet names
	const workbookEntry = zip.getEntry("xl/workbook.xml");
	if (workbookEntry) {
		const xml = workbookEntry.getData().toString("utf-8");
		const sheetMatches = xml.matchAll(/<sheet\s+name="([^"]+)"/g);
		let idx = 1;
		for (const m of sheetMatches) {
			sheetNames.set(idx, m[1]);
			idx++;
		}
	}

	// Parse sheet rels to find drawings
	for (const entry of entries) {
		const sheetRelsMatch = entry.entryName.match(
			/xl\/worksheets\/_rels\/sheet(\d+)\.xml\.rels$/,
		);
		if (sheetRelsMatch) {
			const sheetIdx = parseInt(sheetRelsMatch[1]);
			const xml = entry.getData().toString("utf-8");
			const drawingMatch = xml.match(/Target="\.\.\/drawings\/(drawing\d+\.xml)"/);
			if (drawingMatch) {
				const drawingName = drawingMatch[1];
				sheetToDrawing.set(
					sheetNames.get(sheetIdx) ?? `Sheet${sheetIdx}`,
					drawingName,
				);
			}
		}
	}

	// Parse drawing rels to find images
	for (const entry of entries) {
		const drawingRelsMatch = entry.entryName.match(
			/xl\/drawings\/_rels\/(drawing\d+\.xml)\.rels$/,
		);
		if (drawingRelsMatch) {
			const drawingName = drawingRelsMatch[1];
			const xml = entry.getData().toString("utf-8");
			const imgMatches = xml.matchAll(/Target="\.\.\/media\/([^"]+)"/g);
			const imgNames: string[] = [];
			for (const m of imgMatches) {
				imgNames.push(m[1]);
			}
			drawingToImages.set(drawingName, imgNames);
		}
	}

	// Build reverse mapping: image filename → sheet name
	const imageToSheet = new Map<string, string>();
	for (const [sName, drawingName] of sheetToDrawing) {
		const imgs = drawingToImages.get(drawingName) ?? [];
		for (const img of imgs) {
			imageToSheet.set(img, sName);
		}
	}

	// Extract all images from xl/media/
	for (const entry of entries) {
		if (!entry.entryName.startsWith("xl/media/")) continue;
		const imgFileName = path.basename(entry.entryName);
		const ext = imgFileName.split(".").pop()?.toLowerCase() ?? "";
		const mimeType = MIME_MAP[ext];
		if (!mimeType) continue; // skip unknown formats

		images.push({
			sheetName: imageToSheet.get(imgFileName) ?? null,
			fileName: imgFileName,
			mimeType,
			data: entry.getData(),
		});
	}

	return images;
}
