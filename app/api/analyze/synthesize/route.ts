import { NextRequest, NextResponse } from "next/server";
import { hasInternalSecret } from "@/lib/auth/require-user";
import {
	ProductResearchSynthesisError,
	synthesizeProductResearch,
} from "@/lib/research/synthesize-product";

export const maxDuration = 300; // Vercel Pro max (800s)

export async function POST(request: NextRequest) {
	if (!hasInternalSecret(request)) {
		return NextResponse.json({ error: "unauthorized" }, { status: 401 });
	}

	const { productId } = await request.json();

	if (!productId) {
		return NextResponse.json({ error: "productId required" }, { status: 400 });
	}

	try {
		return NextResponse.json(await synthesizeProductResearch(productId));
	} catch (error) {
		if (error instanceof ProductResearchSynthesisError) {
			return NextResponse.json({ error: error.message }, { status: error.status });
		}
		return NextResponse.json(
			{ error: "Synthesis failed" },
			{ status: 500 },
		);
	}
}
