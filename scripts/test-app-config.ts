import { APP_FEATURES, appConfig, resolveAppConfig } from '../config/app';
import { localePath, pathLocale, stripLocalePrefix } from '../lib/i18n/locale-path';
import { NAV_GROUPS, visibleMembersForRole } from '../lib/nav/groups';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

const japan = resolveAppConfig('mediaworks-jp');

assert(resolveAppConfig().id === 'mediaworks-jp', 'Japanese deployment must remain the default profile');
assert(japan.id === 'mediaworks-jp', 'Japanese deployment must resolve the mediaworks-jp profile');
assert(japan.market.countryCode === 'JP', 'Japanese deployment must target JP');
assert(japan.market.currency === 'JPY', 'Japanese deployment must use JPY');
assert(japan.market.timezone === 'Asia/Tokyo', 'Japanese deployment must use Asia/Tokyo');
assert(japan.i18n.defaultLocale === 'ja', 'Japanese deployment must default to Japanese');
assert(japan.sources.commerce.includes('Rakuten Japan'), 'Japanese commerce sources must include Rakuten Japan');
assert(japan.sources.broadcasts.includes('QVC Japan'), 'Japanese broadcast sources must include QVC Japan');
assert(!japan.features.koreaMarketInsights, 'Japanese deployment must hide Korean market insights');

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
