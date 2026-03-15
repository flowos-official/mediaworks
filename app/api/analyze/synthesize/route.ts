import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { type ProductInfo, synthesizeResearch } from '@/lib/gemini';
import { runProductResearch } from '@/lib/brave';

export const maxDuration = 300; // 5 minutes for synthesis

export async function POST(request: NextRequest) {
  const { productId, productInfo, locale = 'en' } = await request.json() as {
    productId: string;
    productInfo: ProductInfo;
    locale?: string;
  };
  
  const supabase = getServiceClient();

  try {
    // Update status to analyzing (synthesis phase)
    await supabase
      .from('products')
      .update({ status: 'analyzing' })
      .eq('id', productId);

    // Step 1: Run web research with Brave (locale-aware)
    console.log(`[${productId}] Running web research (locale: ${locale})...`);
    const searchResults = await runProductResearch(productInfo.name, productInfo.category, locale);

    // Step 2: Synthesize research with Gemini Pro (locale-aware)
    console.log(`[${productId}] Synthesizing research (locale: ${locale})...`);
    const research = await synthesizeResearch(productInfo, searchResults, locale);

    // Step 3: Save research results
    const { error: researchError } = await supabase
      .from('research_results')
      .insert({
        product_id: productId,
        marketability_score: research.marketability_score,
        marketability_description: research.marketability_description,
        demographics: research.demographics,
        seasonality: research.seasonality,
        cogs_estimate: research.cogs_estimate,
        influencers: research.influencers,
        content_ideas: research.content_ideas,
        raw_json: {
          product_info: productInfo,
          search_results: searchResults,
          research
        }
      });

    if (researchError) {
      throw researchError;
    }

    // Update product status to completed
    await supabase
      .from('products')
      .update({ status: 'completed' })
      .eq('id', productId);

    console.log(`[${productId}] Analysis completed`);
    return NextResponse.json({ success: true });

  } catch (error) {
    console.error(`[${productId}] Synthesis failed:`, error);
    
    await supabase
      .from('products')
      .update({ status: 'failed' })
      .eq('id', productId);

    return NextResponse.json({ error: 'Synthesis failed' }, { status: 500 });
  }
}
