import { getServiceClient } from "@/lib/supabase";

const EMAIL = "guide-capture@mediaworks.local";
const PASSWORD = process.argv[2] ?? "";

async function main() {
	const sb = getServiceClient();
	const action = process.argv[3] ?? "create";

	if (action === "delete") {
		const { data } = await sb.auth.admin.listUsers();
		const u = data.users.find((x) => x.email === EMAIL);
		if (!u) { console.log("no temp user"); return; }
		await sb.from("profiles").delete().eq("id", u.id);
		const { error } = await sb.auth.admin.deleteUser(u.id);
		console.log(error ? `delete failed: ${error.message}` : `deleted ${u.id}`);
		return;
	}

	const { data, error } = await sb.auth.admin.createUser({
		email: EMAIL,
		password: PASSWORD,
		email_confirm: true,
	});
	if (error) { console.error("create failed:", error.message); process.exit(1); }
	const id = data.user!.id;
	const { error: pErr } = await sb
		.from("profiles")
		.upsert({ id, email: EMAIL, display_name: "가이드 캡처용(임시)", role: "member", must_change_password: false });
	if (pErr) { console.error("profile failed:", pErr.message); process.exit(1); }
	console.log(`created ${id} role=member`);
}
main().catch((e) => { console.error(e); process.exit(1); });
