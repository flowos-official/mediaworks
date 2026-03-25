import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/supabase";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ code: string }> },
) {
	const { code } = await params;
	const supabase = getServiceClient();

	const { data, error } = await supabase
		.from("product_images")
		.select("*")
		.eq("product_code", code)
		.order("sort_order", { ascending: true });

	if (error) {
		return NextResponse.json({ error: error.message }, { status: 500 });
	}

	return NextResponse.json({ images: data ?? [] });
}
