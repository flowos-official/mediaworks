import { requireUser } from "@/lib/auth/require-user";
import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import crypto from "node:crypto";
import {
	analyzeCompetitorFit,
	type CompetitorSlotInput,
} from "@/lib/competitor-fit/analyze";
import { inferOperatorFitCategory } from "@/lib/competitor-fit/category-backfill";

export const maxDuration = 120;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;
const CACHE_TTL_DAYS = 14;

function slotKey(channel: string, productName: string, airDate: string): string {
	const h = crypto
		.createHash("md5")
		.update(`${productName.trim().toLowerCase()}|${airDate}`)
		.digest("hex");
	return `${channel.toLowerCase()}|${h}`;
}

function isStr(v: unknown): v is string {
	return typeof v === "string" && v.trim().length > 0;
}

export async function POST(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	const body = await req.json().catch(() => ({}));
	const channel = isStr(body.channel) ? body.channel.trim() : "";
	const productName = isStr(body.productName) ? body.productName.trim() : "";
	const airDate = isStr(body.airDate) ? body.airDate.trim() : "";
	const startTime = isStr(body.startTime) ? body.startTime.trim() : null;
	let category = isStr(body.category) ? body.category.trim() : null;
	const priceText = isStr(body.priceText) ? body.priceText.trim() : null;
	const description = isStr(body.description) ? body.description.trim() : null;
	const sourceUrl = isStr(body.sourceUrl) ? body.sourceUrl.trim() : null;
	const forceRefresh = body.refresh === true;

	if (!channel || !productName || !airDate) {
		return NextResponse.json(
			{ error: "channel, productName, airDate required" },
			{ status: 400 },
		);
	}
	if (!ISO_DATE.test(airDate)) {
		return NextResponse.json({ error: "airDate must be YYYY-MM-DD" }, { status: 400 });
	}
	if (startTime && !TIME_RE.test(startTime)) {
		return NextResponse.json({ error: "startTime must be HH:MM[:SS]" }, { status: 400 });
	}

	const sb = getServiceClient();
	const key = slotKey(channel, productName, airDate);
	if (!category) {
		category = await inferOperatorFitCategory(sb, {
			channel,
			product_name: productName,
			air_date: airDate,
		});
	}

	if (!forceRefresh) {
		const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 24 * 3600 * 1000).toISOString();
		const { data: cached } = await sb
			.from("competitor_fit_analyses")
			.select(
				"id, fit_score, summary, recommended_timing, recommended_channel, differentiation, risks, confidence, created_at",
			)
			.eq("slot_key", key)
			.gte("created_at", cutoff)
			.order("created_at", { ascending: false })
			.limit(1)
			.maybeSingle();
		if (cached) {
			return NextResponse.json({
				cached: true,
				analysis: {
					fitScore: cached.fit_score,
					summary: cached.summary,
					recommendedTiming: cached.recommended_timing,
					recommendedChannel: cached.recommended_channel,
					differentiation: cached.differentiation,
					risks: cached.risks,
					confidence: cached.confidence,
				},
				generatedAt: cached.created_at,
			});
		}
	}

	const slot: CompetitorSlotInput = {
		channel,
		productName,
		category,
		priceText,
		airDate,
		startTime: startTime && startTime.length === 5 ? `${startTime}:00` : startTime,
		description,
		sourceUrl,
	};

	let analysis;
	try {
		analysis = await analyzeCompetitorFit(slot);
	} catch (err) {
		console.error("[analyze-fit] gemini failed:", err);
		const message = err instanceof Error ? err.message : String(err);
		return NextResponse.json(
			{ error: `analysis failed: ${message}` },
			{ status: 502 },
		);
	}

	const { data: inserted, error: insertErr } = await sb
		.from("competitor_fit_analyses")
		.insert({
			slot_key: key,
			channel,
			product_name: productName,
			category,
			price_text: priceText,
			air_date: airDate,
			start_time: slot.startTime,
			source_url: sourceUrl,
			fit_score: analysis.fitScore,
			summary: analysis.summary,
			recommended_timing: analysis.recommendedTiming,
			recommended_channel: analysis.recommendedChannel,
			differentiation: analysis.differentiation,
			risks: analysis.risks,
			confidence: analysis.confidence,
			generated_by: auth.user.id,
		})
		.select("created_at")
		.maybeSingle();

	if (insertErr) {
		console.warn("[analyze-fit] persist failed (non-fatal):", insertErr.message);
	}

	return NextResponse.json({
		cached: false,
		analysis,
		generatedAt: inserted?.created_at ?? new Date().toISOString(),
	});
}
