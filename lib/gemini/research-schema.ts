import { SchemaType, type Schema } from "@google/generative-ai";

/**
 * Gemini responseSchema for ResearchOutput.
 *
 * Note: distribution_channels / pricing_strategy / marketing_strategy /
 * korea_market_fit / live_commerce are marked `?` (optional) on the
 * `ResearchOutput` TS type in `lib/gemini.ts`, but `required` here on
 * purpose. The schema forces fresh Gemini outputs to always include
 * them; the TS optionality is preserved so consumers can null-coalesce
 * pre-Phase-3 rows that may still have NULL in those columns.
 */

// The SDK's IntegerSchema/NumberSchema omit `minimum`/`maximum` from their TS
// types (v0.24.1) even though the Gemini API accepts and enforces them at
// runtime. We build the literal without explicit Schema annotations so TS infers
// the full shape, then cast to Schema at the export boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = any;

const channelType = {
	type: SchemaType.STRING,
	enum: ["TV通販", "EC", "SNSコマース", "カタログ通販", "クラウドファンディング", "メディア", "オフライン", "その他"],
	format: "enum",
} satisfies AnySchema;

const distributionChannelItem = {
	type: SchemaType.OBJECT,
	properties: {
		channel_name: { type: SchemaType.STRING },
		channel_type: channelType,
		primary_age_group: { type: SchemaType.STRING },
		fit_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
		reason: { type: SchemaType.STRING },
		monthly_visitors: { type: SchemaType.STRING },
		commission_rate: { type: SchemaType.STRING },
		url: { type: SchemaType.STRING },
		broadcaster: { type: SchemaType.STRING },
		evidence_sources: {
			type: SchemaType.ARRAY,
			maxItems: 2,
			items: {
				type: SchemaType.OBJECT,
				properties: {
					title: { type: SchemaType.STRING },
					url: { type: SchemaType.STRING },
					snippet: { type: SchemaType.STRING },
				},
				required: ["title", "url", "snippet"],
			},
		},
		similar_products_on_channel: {
			type: SchemaType.ARRAY,
			maxItems: 3,
			items: {
				type: SchemaType.OBJECT,
				properties: {
					product_name: { type: SchemaType.STRING },
					price: { type: SchemaType.STRING },
					source_url: { type: SchemaType.STRING },
				},
				required: ["product_name"],
			},
		},
		scoring_breakdown: {
			type: SchemaType.OBJECT,
			properties: {
				demographic_match: { type: SchemaType.INTEGER, minimum: 0, maximum: 25 },
				category_track_record: { type: SchemaType.INTEGER, minimum: 0, maximum: 25 },
				price_point_fit: { type: SchemaType.INTEGER, minimum: 0, maximum: 25 },
				presentation_format_fit: { type: SchemaType.INTEGER, minimum: 0, maximum: 25 },
			},
			required: ["demographic_match", "category_track_record", "price_point_fit", "presentation_format_fit"],
		},
	},
	required: ["channel_name", "channel_type", "primary_age_group", "fit_score", "reason", "scoring_breakdown"],
} satisfies AnySchema;

const _researchOutputSchema = {
	type: SchemaType.OBJECT,
	properties: {
		marketability_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
		marketability_description: { type: SchemaType.STRING },

		demographics: {
			type: SchemaType.OBJECT,
			properties: {
				age_group: { type: SchemaType.STRING },
				gender: { type: SchemaType.STRING },
				interests: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
				income_level: { type: SchemaType.STRING },
			},
			required: ["age_group", "gender", "interests", "income_level"],
		},

		seasonality: {
			type: SchemaType.OBJECT,
			properties: {
				jan: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
				feb: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
				mar: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
				apr: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
				may: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
				jun: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
				jul: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
				aug: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
				sep: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
				oct: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
				nov: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
				dec: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
			},
			required: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
		},

		cogs_estimate: {
			type: SchemaType.OBJECT,
			properties: {
				items: {
					type: SchemaType.ARRAY,
					items: {
						type: SchemaType.OBJECT,
						properties: {
							supplier: { type: SchemaType.STRING },
							estimated_cost: { type: SchemaType.STRING },
							moq: { type: SchemaType.STRING },
							link: { type: SchemaType.STRING },
						},
						required: ["supplier", "estimated_cost", "moq"],
					},
				},
				summary: { type: SchemaType.STRING },
			},
			required: ["items", "summary"],
		},

		influencers: {
			type: SchemaType.ARRAY,
			minItems: 3,
			maxItems: 5,
			items: {
				type: SchemaType.OBJECT,
				properties: {
					name: { type: SchemaType.STRING },
					platform: { type: SchemaType.STRING },
					followers: { type: SchemaType.STRING },
					match_reason: { type: SchemaType.STRING },
					profile_url: { type: SchemaType.STRING },
				},
				required: ["name", "platform", "followers", "match_reason"],
			},
		},

		content_ideas: {
			type: SchemaType.ARRAY,
			minItems: 3,
			maxItems: 5,
			items: {
				type: SchemaType.OBJECT,
				properties: {
					title: { type: SchemaType.STRING },
					description: { type: SchemaType.STRING },
					format: { type: SchemaType.STRING },
				},
				required: ["title", "description", "format"],
			},
		},

		competitor_analysis: {
			type: SchemaType.ARRAY,
			minItems: 3,
			maxItems: 3,
			items: {
				type: SchemaType.OBJECT,
				properties: {
					name: { type: SchemaType.STRING },
					price: { type: SchemaType.STRING },
					platform: { type: SchemaType.STRING },
					key_difference: { type: SchemaType.STRING },
				},
				required: ["name", "price", "platform", "key_difference"],
			},
		},

		recommended_price_range: { type: SchemaType.STRING },

		broadcast_scripts: {
			type: SchemaType.OBJECT,
			properties: {
				sec30: { type: SchemaType.STRING },
				sec60: { type: SchemaType.STRING },
				min5: { type: SchemaType.STRING },
			},
			required: ["sec30", "sec60", "min5"],
		},

		japan_export_fit_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },

		distribution_channels: {
			type: SchemaType.ARRAY,
			minItems: 6,
			maxItems: 10,
			items: distributionChannelItem,
		},

		pricing_strategy: {
			type: SchemaType.OBJECT,
			properties: {
				channel_pricing: {
					type: SchemaType.ARRAY,
					minItems: 2,
					maxItems: 4,
					items: {
						type: SchemaType.OBJECT,
						properties: {
							channel: { type: SchemaType.STRING },
							benchmark_price: { type: SchemaType.STRING },
							recommended_price: { type: SchemaType.STRING },
							estimated_margin_pct: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
							reason: { type: SchemaType.STRING },
						},
						required: ["channel", "benchmark_price", "recommended_price", "estimated_margin_pct", "reason"],
					},
				},
				bep_analysis: {
					type: SchemaType.OBJECT,
					properties: {
						estimated_cogs_per_unit: { type: SchemaType.STRING },
						fixed_cost_assumption: { type: SchemaType.STRING },
						bep_units_per_channel: {
							type: SchemaType.ARRAY,
							items: {
								type: SchemaType.OBJECT,
								properties: {
									channel: { type: SchemaType.STRING },
									bep_units: { type: SchemaType.INTEGER, minimum: 0 },
									bep_revenue: { type: SchemaType.STRING },
								},
								required: ["channel", "bep_units", "bep_revenue"],
							},
						},
						summary: { type: SchemaType.STRING },
					},
					required: ["estimated_cogs_per_unit", "fixed_cost_assumption", "bep_units_per_channel", "summary"],
				},
			},
			required: ["channel_pricing", "bep_analysis"],
		},

		marketing_strategy: {
			type: SchemaType.ARRAY,
			minItems: 3,
			maxItems: 5,
			items: {
				type: SchemaType.OBJECT,
				properties: {
					strategy_name: { type: SchemaType.STRING },
					type: { type: SchemaType.STRING },
					estimated_cost: { type: SchemaType.STRING },
					expected_reach: { type: SchemaType.STRING },
					efficiency_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
					steps: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
					best_for_channels: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
				},
				required: ["strategy_name", "type", "estimated_cost", "expected_reach", "efficiency_score", "steps", "best_for_channels"],
			},
		},

		korea_market_fit: {
			type: SchemaType.OBJECT,
			properties: {
				fit_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
				target_products: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
				recommended_channels: {
					type: SchemaType.ARRAY,
					items: {
						type: SchemaType.OBJECT,
						properties: {
							channel_name: { type: SchemaType.STRING },
							target_age: { type: SchemaType.STRING },
							strategy: { type: SchemaType.STRING },
							estimated_entry_cost: { type: SchemaType.STRING },
						},
						required: ["channel_name", "target_age", "strategy", "estimated_entry_cost"],
					},
				},
				korean_consumer_insight: { type: SchemaType.STRING },
			},
			required: ["fit_score", "target_products", "recommended_channels", "korean_consumer_insight"],
		},

		live_commerce: {
			type: SchemaType.OBJECT,
			properties: {
				platforms: {
					type: SchemaType.ARRAY,
					minItems: 3,
					maxItems: 3,
					items: {
						type: SchemaType.OBJECT,
						properties: {
							platform_name: { type: SchemaType.STRING },
							platform_type: { type: SchemaType.STRING },
							target_audience: { type: SchemaType.STRING },
							fit_score: { type: SchemaType.INTEGER, minimum: 0, maximum: 100 },
							reason: { type: SchemaType.STRING },
						},
						required: ["platform_name", "platform_type", "target_audience", "fit_score", "reason"],
					},
				},
				scripts: {
					type: SchemaType.OBJECT,
					properties: {
						instagram_live: { type: SchemaType.STRING },
						tiktok_live: { type: SchemaType.STRING },
						youtube_live: { type: SchemaType.STRING },
					},
					required: ["instagram_live", "tiktok_live", "youtube_live"],
				},
				talking_points: { type: SchemaType.ARRAY, minItems: 5, maxItems: 5, items: { type: SchemaType.STRING } },
				engagement_tips: { type: SchemaType.ARRAY, minItems: 3, maxItems: 3, items: { type: SchemaType.STRING } },
				recommended_products_angle: { type: SchemaType.STRING },
			},
			required: ["platforms", "scripts", "talking_points", "engagement_tips", "recommended_products_angle"],
		},
	},
	required: [
		"marketability_score", "marketability_description",
		"demographics", "seasonality", "cogs_estimate", "influencers",
		"content_ideas", "competitor_analysis", "recommended_price_range",
		"broadcast_scripts", "japan_export_fit_score",
		"distribution_channels", "pricing_strategy", "marketing_strategy",
		"korea_market_fit", "live_commerce",
	],
};

// Cast to Schema so callers (synthesizeResearch, etc.) receive the correct SDK type.
export const researchOutputSchema: Schema = _researchOutputSchema as unknown as Schema;
