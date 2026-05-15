import { z } from "zod";

const activity = z.object({
	channel: z.string(),
	activity: z.string(),
	budget: z.number(),
	expected_impressions: z.string(),
	expected_conversions: z.string(),
	content_type: z.string(),
});

const monthlyPlan = z.object({
	month: z.string(),
	total_budget: z.number(),
	activities: z.array(activity),
});

const contentCalendarEntry = z.object({
	week: z.string(),
	channel: z.string(),
	content_type: z.string(),
	topic: z.string(),
	product_focus: z.string(),
});

const influencerEntry = z.object({
	tier: z.enum(["mega", "macro", "micro"]),
	count: z.number(),
	budget_per_person: z.string(),
	selection_criteria: z.string(),
	expected_roi: z.string(),
	platform: z.string(),
});

export const outputSchema = z.object({
	monthly_plans: z.array(monthlyPlan),
	content_calendar: z.array(contentCalendarEntry),
	influencer_plan: z.array(influencerEntry),
	budget_summary: z.object({
		total_6month: z.number(),
		by_channel: z.record(z.string(), z.number()),
		by_type: z.record(z.string(), z.number()),
	}),
	sources_cited: z
		.array(
			z.object({
				index: z.number(),
				title: z.string(),
				url: z.string(),
			}),
		)
		.optional(),
});

export type MarketingExecutionOutput = z.infer<typeof outputSchema>;
