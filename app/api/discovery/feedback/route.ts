import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";
import { requireUser } from "@/lib/auth/require-user";
import { invalidateDiscoveryAfterMutation } from "@/lib/discovery/cached";

export const maxDuration = 10;

type Action = "sourced" | "interested" | "rejected" | "duplicate";
const VALID_ACTIONS: Action[] = ["sourced", "interested", "rejected", "duplicate"];

const FIXED_REASONS = [
	"価格帯不適合",
	"カテゴリ過飽和",
	"既に放送中",
	"品質懸念",
	"その他",
];

function isValidReason(reason: string | undefined): boolean {
	if (!reason) return false;
	if (FIXED_REASONS.includes(reason)) return true;
	// Allow "その他: <custom text>" for free-form other reasons
	return reason.startsWith("その他") && reason.length <= 200;
}

interface FeedbackBody {
	productId: string;
	action: Action;
	reason?: string;
}

export async function POST(req: NextRequest) {
	const auth = await requireUser(["member", "admin"]);
	if ("error" in auth) return auth.error;

	let body: FeedbackBody;
	try {
		body = (await req.json()) as FeedbackBody;
	} catch {
		return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
	}

	if (!body.productId) {
		return NextResponse.json({ error: "productId required" }, { status: 400 });
	}
	if (!VALID_ACTIONS.includes(body.action)) {
		return NextResponse.json({ error: "invalid action" }, { status: 400 });
	}
	if (body.action === "rejected" && !isValidReason(body.reason)) {
		return NextResponse.json(
			{
				error:
					'reason required — must be one of fixed 5 values or start with "その他" for custom',
			},
			{ status: 400 },
		);
	}

	const sb = getServiceClient();

	const { data: product, error: prodErr } = await sb
		.from("discovered_products")
		.select("id")
		.eq("id", body.productId)
		.maybeSingle();

	if (prodErr) {
		return NextResponse.json({ error: prodErr.message }, { status: 500 });
	}
	if (!product) {
		return NextResponse.json({ error: "product not found" }, { status: 404 });
	}

	// Toggle-off is per-user: clicking the same action as YOUR own previous
	// most-recent action removes your mark. Two different users marking the
	// same action both get recorded (multi-user team feedback signal).
	const { data: myLast } = await sb
		.from("product_feedback")
		.select("action, created_at")
		.eq("discovered_product_id", body.productId)
		.eq("user_id", auth.user.id)
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle();

	const isOwnToggleOff = myLast?.action === body.action;
	const reason = body.action === "rejected" ? body.reason ?? null : null;
	const now = new Date().toISOString();

	if (isOwnToggleOff) {
		// Remove this user's same-action rows so their toggle-off is durable.
		await sb
			.from("product_feedback")
			.delete()
			.eq("discovered_product_id", body.productId)
			.eq("user_id", auth.user.id)
			.eq("action", body.action);

		// Recompute the team-shared state as the most recent surviving action.
		const { data: lastByAnyone } = await sb
			.from("product_feedback")
			.select("action, reason, created_at")
			.eq("discovered_product_id", body.productId)
			.order("created_at", { ascending: false })
			.limit(1)
			.maybeSingle();

		const { error: updErr } = await sb
			.from("discovered_products")
			.update({
				user_action: lastByAnyone?.action ?? null,
				action_reason: lastByAnyone?.reason ?? null,
				action_at: lastByAnyone?.created_at ?? null,
				updated_at: now,
			})
			.eq("id", body.productId);
		if (updErr) {
			return NextResponse.json({ error: updErr.message }, { status: 500 });
		}
		invalidateDiscoveryAfterMutation("feedback");
		return NextResponse.json({
			ok: true,
			action: "toggled_off",
			user_action: lastByAnyone?.action ?? null,
		});
	}

	const [insertRes, updRes] = await Promise.all([
		sb.from("product_feedback").insert({
			discovered_product_id: body.productId,
			action: body.action,
			reason,
			user_id: auth.user.id,
		}),
		sb
			.from("discovered_products")
			.update({ user_action: body.action, action_reason: reason, action_at: now })
			.eq("id", body.productId),
	]);

	if (insertRes.error) {
		console.warn(`[feedback] insert failed:`, insertRes.error.message);
	}
	if (updRes.error) {
		return NextResponse.json({ error: updRes.error.message }, { status: 500 });
	}

	invalidateDiscoveryAfterMutation("feedback");
	return NextResponse.json({
		ok: true,
		action: "set",
		user_action: body.action,
	});
}
