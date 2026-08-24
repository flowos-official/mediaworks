export const APP_FEATURES = [
  'firmAnalytics',
  'broadcastCalendar',
  'productDiscovery',
  'strategy',
  'selectionPipeline',
  'research',
  'koreaMarketInsights',
  'screenplays',
  'adminOperations',
  'guide',
] as const;

export type AppFeature = (typeof APP_FEATURES)[number];

export const APP_LOCALES = ['ja', 'ko'] as const;
export type AppLocale = (typeof APP_LOCALES)[number];

export const SUPPORTED_APP_VARIANTS = ['mediaworks-jp'] as const;
export type AppVariantId = (typeof SUPPORTED_APP_VARIANTS)[number];

export interface AppConfig {
  id: AppVariantId;
  brand: {
    name: string;
    descriptor: string;
    mobileDescriptor: string;
    marketLabel: string;
    metadataTitle: string;
    metadataDescription: string;
    themeColor: string;
    logoPath?: string;
  };
  theme: {
    forcedTheme?: 'light' | 'dark';
    enableSystem: boolean;
  };
  market: {
    countryCode: 'JP' | 'KR';
    currency: 'JPY' | 'KRW';
    timezone: 'Asia/Tokyo' | 'Asia/Seoul';
  };
  i18n: {
    defaultLocale: AppLocale;
    locales: readonly AppLocale[];
  };
  navigation: {
    memberLanding: string;
    viewerLanding: string;
  };
  storage: {
    sidebarCollapsedKey: string;
  };
  copy: {
    guestKicker: string;
    guestDescription: string;
    analyticsEyebrow: string;
    loginKicker: string;
    loginHeadline: string;
    loginDescription: string;
    loginWorkspaceLabel: string;
  };
  features: Record<AppFeature, boolean>;
  sources: {
    commerce: readonly string[];
    broadcasts: readonly string[];
  };
}

const mediaworksJapan: AppConfig = {
  id: 'mediaworks-jp',
  brand: {
    name: 'MediaWorks',
    descriptor: 'Broadcast intelligence',
    mobileDescriptor: 'Broadcast OS',
    marketLabel: 'JAPAN',
    metadataTitle: 'MediaWorks Japan — Home Shopping Research Platform',
    metadataDescription: 'AI-powered product research and broadcast operations for the Japanese home-shopping market',
    themeColor: '#2563eb',
  },
  theme: {
    enableSystem: true,
  },
  market: {
    countryCode: 'JP',
    currency: 'JPY',
    timezone: 'Asia/Tokyo',
  },
  i18n: {
    defaultLocale: 'ja',
    locales: APP_LOCALES,
  },
  navigation: {
    memberLanding: '/analytics/overview',
    viewerLanding: '/analytics/products',
  },
  storage: {
    sidebarCollapsedKey: 'mediaworks-jp-sidebar-collapsed',
  },
  copy: {
    guestKicker: 'Home shopping operations',
    guestDescription: '商品データ、市場リサーチ、放送考査、制作を一つの運用面に。',
    analyticsEyebrow: 'First-party performance · Japan',
    loginKicker: 'Broadcast operations system',
    loginHeadline: '商品情報から放送判断、制作、考査までを一つの運用面に。',
    loginDescription: 'MediaWorks は一般的なAIチャットではなく、社内データと運用ルールに接続されたホームショッピング業務基盤です。',
    loginWorkspaceLabel: 'MediaWorks Japan workspaceへログイン',
  },
  features: {
    firmAnalytics: true,
    broadcastCalendar: true,
    productDiscovery: true,
    strategy: true,
    selectionPipeline: true,
    research: true,
    koreaMarketInsights: false,
    screenplays: true,
    adminOperations: true,
    guide: true,
  },
  sources: {
    commerce: ['Rakuten Japan', 'Brave Search Japan'],
    broadcasts: ['QVC Japan', 'Shop Channel Japan', 'Japanese OA channels'],
  },
};


const APP_VARIANTS: Record<AppVariantId, AppConfig> = {
  'mediaworks-jp': mediaworksJapan,
};

/**
 * Only the Japanese product remains. The variant lookup is kept so an unknown
 * NEXT_PUBLIC_APP_VARIANT fails loudly instead of silently serving JP content
 * under someone else's branding.
 */
export function resolveAppConfig(value?: string): AppConfig {
  const variant = (value?.trim() || 'mediaworks-jp') as AppVariantId;
  const config = APP_VARIANTS[variant];
  if (!config) {
    throw new Error(
      `Unsupported NEXT_PUBLIC_APP_VARIANT "${value}". Supported values: ${SUPPORTED_APP_VARIANTS.join(', ')}`,
    );
  }
  return config;
}

export const appConfig = resolveAppConfig(process.env.NEXT_PUBLIC_APP_VARIANT);

export function isFeatureEnabled(feature: AppFeature): boolean {
  return appConfig.features[feature];
}
