import * as xlsx from "xlsx";
import * as path from "path";

const file = path.join(process.cwd(), "docs", "他局OA（2020年4月～）.xlsx");
const wb = xlsx.readFile(file);

for (const name of wb.SheetNames) {
	const ws = wb.Sheets[name];
	const aoa = xlsx.utils.sheet_to_json<unknown[]>(ws, {
		header: 1,
		defval: null,
		raw: false,
	});
	console.log(`\n========= sheet: ${name} =========`);
	console.log("first 6 rows (header detection):");
	for (let i = 0; i < Math.min(6, aoa.length); i++) {
		console.log(`  [${i}]`, JSON.stringify(aoa[i]));
	}
	console.log(`total rows: ${aoa.length}`);
	console.log("last 2 rows:");
	for (let i = Math.max(0, aoa.length - 2); i < aoa.length; i++) {
		console.log(`  [${i}]`, JSON.stringify(aoa[i]));
	}
}
