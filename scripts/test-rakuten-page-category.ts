import assert from "node:assert/strict";
import { __test } from "@/lib/discovery/tools/rakuten-page";

const html = `
<html>
<head>
<script type="application/ld+json">
{
 "@context": "http://schema.org",
 "@type": "BreadcrumbList",
 "itemListElement": [
  {
   "@type": "ListItem",
   "position": 1,
   "item": {
    "@id": "https://www.rakuten.co.jp/",
    "name": "楽天市場"
   }
  },
  {
   "@type": "ListItem",
   "position": 2,
   "item": {
    "@id": "https://www.rakuten.co.jp/category/551167/",
    "name": "スイーツ・お菓子"
   }
  },
  {
   "@type": "ListItem",
   "position": 3,
   "item": {
    "@id": "https://www.rakuten.co.jp/category/201136/",
    "name": "チョコレート"
   }
  },
  {
   "@type": "ListItem",
   "position": 4,
   "item": {
    "@id": "https://www.rakuten.co.jp/category/562614/",
    "name": "割れチョコ"
   }
  }
 ]
}
</script>
</head>
</html>
`;

const path = __test.extractRakutenCategoryPath(html);
assert.deepEqual(path, ["スイーツ・お菓子", "チョコレート", "割れチョコ"]);
assert.equal(
	__test.formatRakutenCategory(path),
	"スイーツ・お菓子 > チョコレート > 割れチョコ",
);

console.log("PASS: Rakuten breadcrumb categories parse into a stable category path");
