import { readFileSync } from "node:fs";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const navbar = readFileSync("components/Navbar.tsx", "utf8");
const userMenu = readFileSync("components/UserMenu.tsx", "utf8");
const themeMenu = readFileSync("components/theme/ThemeSubmenu.tsx", "utf8");
const navGroups = readFileSync("lib/nav/groups.ts", "utf8");
const preferencesPage = readFileSync("app/[locale]/(admin)/admin/preferences/page.tsx", "utf8");
const proxy = readFileSync("proxy.ts", "utf8");
const i18n = readFileSync("i18n.ts", "utf8");

assert(!navbar.includes("ThemeMenu"), "Navbar should not render the theme menu as a top-level icon control");
assert(!navbar.includes("LanguageSwitcher"), "Navbar should not render language switching as a top-level control");
assert(!navbar.includes("t('guide')"), "Navbar should not render guide as a top-level text link");
assert(!navbar.includes("href={localePath(locale, '/guide')}"), "Navbar should not link to guide directly");

assert(!userMenu.includes("href={localePath(locale, '/guide')}"), "User menu should not contain the guide link");
assert(!userMenu.includes("navT('guide')"), "User menu should not use guide navigation labels");
assert(!userMenu.includes("LanguageSwitcher"), "User menu should not contain language switching");
assert(!userMenu.includes("ThemeSubmenu"), "Theme selector should not live inside the user menu");

assert(themeMenu.includes("export function ThemeMenu"), "Theme menu should export an icon-triggered menu");
assert(themeMenu.includes('aria-label={t("label")}') || themeMenu.includes("aria-label={t('label')}"), "Theme icon trigger should be accessible");
assert(navGroups.includes("nav.admin.preferences"), "Admin navigation should include preferences next to the registry");
assert(navGroups.includes("'/admin/preferences'"), "Admin navigation should link to the preferences page");
assert(preferencesPage.includes("LanguageSwitcher"), "Preferences page should contain language switching");
assert(preferencesPage.includes("ThemePreferenceControl"), "Preferences page should contain theme selection");
assert(preferencesPage.includes("localePath(locale, '/guide')"), "Preferences page should keep guide access discoverable");
assert(proxy.includes("defaultLocale: 'ja'"), "Middleware default locale should be Japanese");
assert(i18n.includes("|| 'ja'"), "i18n request config should fall back to Japanese");

console.log("navbar guide/theme placement checks passed");
