import assert from "node:assert/strict";
import { loadRecommendationFlowStatus } from "../lib/recommendation/flow-evidence";

type QueryResult = {
	data: unknown;
	error: { message: string } | null;
	count?: number | null;
};

type Filter = { column: string; op: "eq" | "not" | "in"; value: unknown };

class FakeQuery {
	private filters: Filter[] = [];
	private limitCount: number | null = null;
	private selectOptions: { count?: string; head?: boolean } | undefined;

	constructor(
		private readonly table: string,
		private readonly resolve: (query: FakeQuery) => QueryResult,
	) {}

	select(columns: string, options?: { count?: string; head?: boolean }) {
		void columns;
		this.selectOptions = options;
		return this;
	}

	eq(column: string, value: unknown) {
		this.filters.push({ column, op: "eq", value });
		return this;
	}

	not(column: string, operator: string, value: unknown) {
		void operator;
		this.filters.push({ column, op: "not", value });
		return this;
	}

	in(column: string, values: unknown[]) {
		this.filters.push({ column, op: "in", value: values });
		return this;
	}

	order(column: string, options?: { ascending?: boolean }) {
		void column;
		void options;
		return this;
	}

	limit(count: number) {
		this.limitCount = count;
		return this;
	}

	maybeSingle() {
		const result = this.resolve(this);
		if (Array.isArray(result.data)) {
			return Promise.resolve({
				...result,
				data: result.data[0] ?? null,
			});
		}
		return Promise.resolve(result);
	}

	then<TResult1 = QueryResult, TResult2 = never>(
		onfulfilled?: ((value: QueryResult) => TResult1 | PromiseLike<TResult1>) | null,
		onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
	) {
		return Promise.resolve(this.resolve(this)).then(onfulfilled, onrejected);
	}

	getFilter(column: string, op: Filter["op"] = "eq") {
		return this.filters.find((filter) => filter.column === column && filter.op === op)?.value;
	}

	get tableName() {
		return this.table;
	}

	get limitValue() {
		return this.limitCount;
	}

	get isHeadCount() {
		return this.selectOptions?.head === true && this.selectOptions?.count === "exact";
	}
}

class FakeSupabase {
	from(table: string) {
		return new FakeQuery(table, (query) => this.resolve(query));
	}

	private resolve(query: FakeQuery): QueryResult {
		switch (query.tableName) {
			case "discovery_runs": {
				const context = query.getFilter("context");
				if (context === "home_shopping") {
					return {
						data: { id: "home-run", context: "home_shopping", status: "completed" },
						error: null,
					};
				}
				if (context === "live_commerce") {
					return {
						data: { id: "live-run", context: "live_commerce", status: "completed" },
						error: null,
					};
				}
				return {
					data: { id: "home-run", context: "home_shopping", status: "completed" },
					error: null,
				};
			}
			case "discovered_products": {
				if (query.isHeadCount) {
					const sessionId = query.getFilter("session_id");
					if (sessionId === "home-run" || sessionId === "live-run") {
						return { data: null, count: 30, error: null };
					}
					return { data: null, count: 2, error: null };
				}
				if (query.getFilter("enrichment_status") === "completed") {
					return { data: { id: "dp-1", name: "候補商品" }, error: null };
				}
				return {
					data: [
						{ id: "dp-1", name: "候補商品", category: "美容", enrichment_status: "completed", c_package: {} },
						{ id: "dp-2", name: "候補商品2", category: "美容", enrichment_status: "pending", c_package: null },
					].slice(0, query.limitValue ?? undefined),
					error: null,
				};
			}
			case "discovered_category_normalization":
				if (query.isHeadCount) {
					return { data: null, count: 10001, error: null };
				}
				if (Array.isArray(query.getFilter("raw_category", "in"))) {
					return {
						data: [
							{ raw_category: "美容" },
						],
						error: null,
					};
				}
				return {
					data: [
						{ raw_category: "OA商品名ノイズ" },
					],
					error: null,
				};
			case "broadcasts":
				return {
					data: query.isHeadCount ? null : [{ category: "美容" }],
					count: query.isHeadCount
						? query.getFilter("category", "not") === null
							? 8
							: 10
						: undefined,
					error: null,
				};
			case "historical_broadcasts":
				return {
					data: query.isHeadCount ? null : [],
					count: query.isHeadCount
						? query.getFilter("category", "not") === null
							? 0
							: 20
						: undefined,
					error: null,
				};
			case "competitor_fit_analyses":
				return {
					data: query.isHeadCount ? null : [],
					count: query.isHeadCount
						? query.getFilter("category", "not") === null
							? 0
							: 2
						: undefined,
					error: null,
				};
			case "products":
				return {
					data: {
						id: "p-1",
						name: "昇格商品",
						status: "completed",
						discovered_product_id: "dp-1",
					},
					error: null,
				};
			case "research_results":
				return { data: { product_id: "p-1" }, error: null };
			case "md_strategies":
				return {
					data: [
						{
							id: "strategy-1",
							user_goal: "月商500万",
							product_selection: {
								channel_product_matrix: [{ tier1_products: [{ code: "A-1" }] }],
								discovered_new_products: [
									{
										name: "発掘候補",
										pool_source: "discovery_pool",
										discovered_product_id: "dp-1",
									},
								],
							},
						},
					],
					error: null,
				};
			case "screenplays": {
				const productId = query.getFilter("product_id");
				return {
					data: {
						id: productId === "p-1" ? "sp-promoted" : "sp-latest",
						product_id: "p-1",
						status: "ready",
					},
					error: null,
				};
			}
			default:
				return { data: null, error: { message: `Unexpected table: ${query.tableName}` } };
		}
	}
}

async function main() {
	const status = await loadRecommendationFlowStatus(new FakeSupabase());

	assert.equal(status.strictReady, true);
	assert.equal(status.strictFailures, "");
	assert.equal(status.evidence.latestDiscoveryRun?.id, "home-run");
	assert.equal(status.evidence.contextDiscoveryRuns.length, 2);
	assert.ok(status.checks.some((check) => check.key === "integrated_md_strategy" && check.status === "pass"));
	assert.ok(
		status.checks.some((check) => check.key === "category_normalization_cache" && check.status === "pass"),
		"status includes category normalization cache coverage",
	);
	assert.ok(
		status.checks.some((check) => check.key === "broadcast_category_coverage" && check.status === "warn"),
		"status surfaces broadcast category coverage gaps",
	);
	assert.ok(
		status.checks.some((check) => check.key === "operator_fit_category_coverage" && check.status === "warn"),
		"status surfaces operator fit category coverage gaps",
	);

	console.log("PASS: recommendation flow status loader");
}

void main();
