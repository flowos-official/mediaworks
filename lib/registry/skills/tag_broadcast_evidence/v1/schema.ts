import { z } from "zod";

const broadcastTag = z.enum(["broadcast_confirmed", "broadcast_likely", "unknown"]);

const broadcastResult = z.object({
	productUrl: z.string(),
	tag: broadcastTag,
	sources: z.array(
		z.object({
			title: z.string(),
			url: z.string(),
		}),
	),
});

export const outputSchema = z.array(broadcastResult);

export type BroadcastEvidenceOutput = z.infer<typeof outputSchema>;
