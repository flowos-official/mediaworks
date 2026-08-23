import { APP_FEATURES, appConfig, resolveAppConfig } from '../config/app';
import { localePath, pathLocale, stripLocalePrefix } from '../lib/i18n/locale-path';
import { NAV_GROUPS, visibleMembersForRole } from '../lib/nav/groups';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const japan = resolveAppConfig('mediaworks-jp');
const lotte = resolveAppConfig('lotte-kr');

assert(resolveAppConfig().id === 'mediaworks-jp', 'Japanese deployment must remain the default profile');
assert(japan.id === 'mediaworks-jp', 'Japanese deployment must resolve the mediaworks-jp profile');
assert(japan.market.countryCode === 'JP', 'Japanese deployment must target JP');
assert(japan.market.currency === 'JPY', 'Japanese deployment must use JPY');
assert(japan.market.timezone === 'Asia/Tokyo', 'Japanese deployment must use Asia/Tokyo');
assert(japan.i18n.defaultLocale === 'ja', 'Japanese deployment must default to Japanese');
assert(japan.sources.commerce.includes('Rakuten Japan'), 'Japanese commerce sources must include Rakuten Japan');
assert(japan.sources.broadcasts.includes('QVC Japan'), 'Japanese broadcast sources must include QVC Japan');
assert(!japan.features.koreaMarketInsights, 'Japanese deployment must hide Korean market insights');
assert(lotte.id === 'lotte-kr', 'LOTTE deployment must resolve the lotte-kr profile');
assert(lotte.market.countryCode === 'KR', 'LOTTE deployment must target KR');
assert(lotte.market.currency === 'KRW', 'LOTTE deployment must use KRW');
assert(lotte.market.timezone === 'Asia/Seoul', 'LOTTE deployment must use Asia/Seoul');
assert(lotte.i18n.defaultLocale === 'ko', 'LOTTE deployment must default to Korean');
assert(lotte.brand.logoPath === '/brand/lotte-symbol.svg', 'LOTTE deployment must use the LOTTE symbol');
assert(lotte.theme.forcedTheme === 'light', 'LOTTE deployment must use its light brand theme');
assert(lotte.features.koreaMarketInsights, 'LOTTE deployment must expose Korean market insights');

for (const feature of APP_FEATURES) {
  assert(feature in japan.features, `Japanese profile must declare feature "${feature}"`);
}

const defaultLocale = appConfig.i18n.defaultLocale;
const secondaryLocale = defaultLocale === 'ja' ? 'ko' : 'ja';
assert(localePath(defaultLocale, '/broadcasts') === '/broadcasts', 'Default-locale URLs must remain unprefixed');
assert(localePath(secondaryLocale, '/broadcasts') === `/${secondaryLocale}/broadcasts`, 'Secondary-locale URLs must be prefixed');
assert(stripLocalePrefix(`/${secondaryLocale}/analytics/products`) === '/analytics/products', 'Locale stripping must support prefixed paths');
assert(stripLocalePrefix('/analytics/products') === '/analytics/products', 'Locale stripping must preserve default paths');
assert(pathLocale(`/${secondaryLocale}/analytics/products`) === secondaryLocale, 'Prefixed paths must resolve their locale');
assert(pathLocale('/analytics/products') === defaultLocale, 'Unprefixed paths must resolve the configured default locale');

const adminDestinations = NAV_GROUPS.flatMap((group) => visibleMembersForRole(group, 'admin'));
assert(adminDestinations.length > 0, 'Japanese admin navigation must expose enabled product areas');
assert(
  adminDestinations.every((member) => appConfig.features[member.feature]),
  'Navigation must not expose a disabled product feature',
);

let rejectedUnknownVariant = false;
try {
  resolveAppConfig('unknown-market');
} catch {
  rejectedUnknownVariant = true;
}
assert(rejectedUnknownVariant, 'Unknown deployment variants must fail fast');

console.log(`app config checks passed (${appConfig.id}, ${adminDestinations.length} admin destinations)`);
