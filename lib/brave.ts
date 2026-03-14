const BRAVE_API_KEY = process.env.BRAVE_SEARCH_API_KEY!;

async function braveSearch(query: string): Promise<string> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': BRAVE_API_KEY
    }
  });

  if (!res.ok) {
    console.error('Brave search failed:', res.status);
    return 'Search unavailable';
  }

  const data = await res.json();
  const results = data.web?.results || [];
  
  return results
    .slice(0, 5)
    .map((r: { title: string; description?: string; url: string }) => `Title: ${r.title}\nDescription: ${r.description || ''}\nURL: ${r.url}`)
    .join('\n\n');
}

async function braveSearchMulti(queries: { key: string; query: string }[]): Promise<Record<string, string>> {
  const searches: Record<string, string> = {};
  const results = await Promise.allSettled(
    queries.map(async ({ key, query }) => {
      const result = await braveSearch(query);
      return { key, result };
    })
  );
  for (const r of results) {
    if (r.status === 'fulfilled') {
      searches[r.value.key] = r.value.result;
    }
  }
  return searches;
}

export async function runProductResearch(
  productName: string,
  productCategory: string,
  locale: string = 'en'
): Promise<Record<string, string>> {

  if (locale === 'ja') {
    // === 日本語モード: 大幅に拡大された日本語クエリ ===
    const queries = [
      // 市場性分析 (5クエリ)
      { key: 'market_overview_ja',    query: `${productName} 日本 ホームショッピング 市場 2024 2025` },
      { key: 'market_ranking_ja',     query: `${productName} 通販 売上 ランキング 市場規模` },
      { key: 'market_competition_ja', query: `${productName} 競合 比較 市場規模 シェア` },
      { key: 'market_reviews_ja',     query: `${productName} 消費者 口コミ レビュー 評判` },
      { key: 'market_trends_ja',      query: `${productName} ${productCategory} 業界 トレンド 動向 2024` },

      // ターゲット分析 (3クエリ)
      { key: 'demographics_target_ja', query: `${productName} ターゲット層 年齢 性別 消費者属性` },
      { key: 'demographics_data_ja',   query: `${productName} 購買者 データ 統計 調査` },
      { key: 'demographics_survey_ja', query: `${productName} 日本 消費者 調査 ニーズ` },

      // 季節性 (3クエリ)
      { key: 'seasonality_demand_ja',  query: `${productName} 季節 需要 売れ筋 時期` },
      { key: 'seasonality_trend_ja',   query: `${productName} 年間 トレンド 月別 季節変動` },
      { key: 'seasonality_peak_ja',    query: `${productName} ${productCategory} ピーク シーズン 売上` },

      // COGS / 仕入れ価格
      { key: 'cogs_wholesale_ja',  query: `${productName} 卸売 価格 仕入れ 問屋 コスト` },
      { key: 'cogs_alibaba_ja',    query: `${productName} wholesale price supplier alibaba aliexpress` },
      { key: 'cogs_margin_ja',     query: `${productName} 利益率 原価 マージン 販売価格` },

      // インフルエンサー分析
      { key: 'influencers_ja',     query: `${productName} インフルエンサー YouTube Instagram TikTok フォロワー` },
      { key: 'influencers_video_ja', query: `${productName} ${productCategory} YouTuber レビュー 紹介動画` },

      // コンテンツアイデア
      { key: 'content_viral_ja',   query: `${productName} バイラル コンテンツ 動画 企画 成功事例` },
      { key: 'content_strategy_ja', query: `${productName} ${productCategory} SNS マーケティング 戦略` },

      // 競合・ブランド分析
      { key: 'competitor_brands_ja', query: `${productName} 競合 ブランド 比較 価格帯 おすすめ` },
      { key: 'usp_ja',              query: `${productName} ホームショッピング 売れる 理由 特徴 強み` },
    ];

    return braveSearchMulti(queries);

  } else {
    // === English mode: original + expanded queries ===
    const queries = [
      { key: 'market_overview',    query: `${productName} ${productCategory} home shopping market trends 2024` },
      { key: 'market_size',        query: `${productName} market size revenue statistics 2024 2025` },
      { key: 'market_competition', query: `${productName} competitor brands comparison market share` },
      { key: 'consumer_reviews',   query: `${productName} consumer reviews ratings feedback` },
      { key: 'industry_trends',    query: `${productName} ${productCategory} industry trends forecast` },
      { key: 'target_demographics', query: `${productName} target audience demographics consumer profile` },
      { key: 'demographics_data',  query: `${productName} buyer statistics age gender income survey` },
      { key: 'seasonality',        query: `${productName} ${productCategory} seasonal demand peak sales months` },
      { key: 'seasonality_trend',  query: `${productName} annual trend monthly sales pattern` },
      { key: 'cogs_alibaba',       query: `${productName} wholesale price alibaba supplier cost` },
      { key: 'cogs_margin',        query: `${productName} profit margin retail price markup` },
      { key: 'influencers',        query: `${productName} ${productCategory} influencer marketing instagram youtube tiktok` },
      { key: 'influencer_channels', query: `${productName} review youtube channel subscribers` },
      { key: 'content_marketing',  query: `${productName} ${productCategory} viral content marketing social media strategy` },
      { key: 'content_ideas',      query: `${productName} content ideas successful campaigns examples` },
      { key: 'competitors',        query: `${productName} top brands competitors price range` },
      { key: 'usp',               query: `${productName} unique selling points home shopping success factors` },
    ];

    return braveSearchMulti(queries);
  }
}
