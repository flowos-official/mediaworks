import { NextRequest, NextResponse } from 'next/server';
import { getServiceClient } from '@/lib/supabase';
import { extractProductInfo, synthesizeResearch } from '@/lib/gemini';
import { runProductResearch } from '@/lib/brave';

export const maxDuration = 300; // 5 minutes

export async function POST(request: NextRequest) {
  const { productId, fileBase64, mimeType, fileName, locale = 'en' } = await request.json();
  
  const supabase = getServiceClient();

  try {
    // Update status to analyzing
    await supabase
      .from('products')
      .update({ status: 'analyzing' })
      .eq('id', productId);

    // Step 1: Extract product info with Gemini (locale-aware)
    console.log(`[${productId}] Extracting product info (locale: ${locale})...`);
    const productInfo = await extractProductInfo(fileBase64, mimeType, fileName, locale);

    // Update product name and description
    await supabase
      .from('products')
      .update({
        name: productInfo.name,
        description: productInfo.description
      })
      .eq('id', productId);

    // Step 2: Run web research with Brave (locale-aware Japanese queries)
    console.log(`[${productId}] Running web research (locale: ${locale})...`);
    const searchResults = await runProductResearch(productInfo.name, productInfo.category, locale);

    // Step 3: Synthesize research with Gemini (locale-aware output)
    console.log(`[${productId}] Synthesizing research (locale: ${locale})...`);
    const research = await synthesizeResearch(productInfo, searchResults, locale);

    // Step 4: Save research results
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
          research,
          locale
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
    console.error(`[${productId}] Analysis failed:`, error);
    
    await supabase
      .from('products')
      .update({ status: 'failed' })
      .eq('id', productId);

    return NextResponse.json({ error: 'Analysis failed' }, { status: 500 });
  }
}
