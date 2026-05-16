import * as xlsx from "xlsx";
import * as path from "path";

const file = path.join(process.cwd(), "docs", "他局OA（2020年4月～）.xlsx");
const wb = xlsx.readFile(file);

console.log("workbook:", path.basename(file));
console.log("sheet count:", wb.SheetNames.length);
console.log("sheets:");
for (const name of wb.SheetNames) {
	const ws = wb.Sheets[name];
	const ref = ws["!ref"] ?? "";
	const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(ws, {
		defval: null,
		raw: false,
	});
	console.log(`  - ${name}: range=${ref}, rows=${rows.length}`);
}

const first = wb.SheetNames[0];
const ws = wb.Sheets[first];
const rows = xlsx.utils.sheet_to_json<Record<string, unknown>>(ws, {
	defval: null,
	raw: false,
});
console.log(`\nfirst sheet "${first}" — first 5 rows:`);
console.log(JSON.stringify(rows.slice(0, 5), null, 2));
