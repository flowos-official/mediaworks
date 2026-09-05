/**
 * The contracts a screenplay is generated FROM.
 *
 * Everything here is designed around one distinction the generator has never
 * been able to make: what we KNOW about a product versus what somebody has
 * SAID about it versus what we have inferred. A fact carries its evidence
 * class all the way to the prompt, and `usage` says what the writer may do
 * with it — state it, attribute it, or use it only to plan structure.
 *
 * NO `import "server-only"` — imported by tsx unit tests.
 */
import type { EvidenceClass } from "@/lib/intelligence/types";

/** What the script may do with a fact.
 *
 *  - `direct`          state it as fact
 *  - `attributed_only` state it only with its source named ("メーカーによると")
 *  - `planning_only`   never say it on air; use it to choose structure */
export type FactUsage = "direct" | "attributed_only" | "planning_only";

export interface ProductFact {
	key: string;
	label: string;
	value: unknown;
	unit?: string;
	evidenceClass: EvidenceClass;
	usage: FactUsage;
	/** Every stored row that supported this key, the winning one first. The
	 *  knowledge snapshot records all of them: a superseded row was still
	 *  consulted, and coverage has to reflect that. */
	evidenceItemIds: string[];
	sourceLabel: string;
	observedAt: string;
}

export interface ProductFactPack {
	/** The Screenplay ID — also the subject of any brief-derived evidence. */
	subjectId: string;
	canonicalProductId: string | null;
	facts: ProductFact[];
	/** Required facts we hold nothing KNOWN for. Named, never inferred to zero. */
	missing: string[];
	/** Statements the script must not make, derived from what is missing plus
	 *  the operator's own mustAvoid list. */
	forbiddenClaims: string[];
	builtAt: string;
}

// ── Rundown and demo plan (Task 4) ─────────────────────────────────────────
// The running order is decided BEFORE prose and persisted, so the version can
// be read back as "this is the broadcast that was planned" rather than
// reverse-engineered from the script's headings.

export interface ScreenplayOutlineSection {
	id: string;
	title: string;
	purpose: string;
	/** Share of the runtime. Normalised to sum to exactly 1. */
	runtimeShare: number;
	keyMessages: string[];
	/** Fact-pack keys this section may make factual statements from. Anything
	 *  outside this list is, by construction, not grounded. */
	factKeys: string[];
	/** Which aggregate competitor observations shaped it — empty when the plan
	 *  is generic. */
	patternBasis: string[];
}

export interface DemoPlanItem {
	id: string;
	sectionId: string;
	title: string;
	hostAction: string;
	cameraCue: string;
	requiredFactKeys: string[];
	safetyNote: string | null;
}

export interface ScreenplayStructurePlan {
	/** Whether competitor structure informed the plan. Derived from the pattern
	 *  status, never from the model — a model asked to self-report its basis
	 *  will say whatever the prompt implied. */
	basis: "competitor_pattern" | "generic";
	runtimeMinutes: number;
	sections: ScreenplayOutlineSection[];
	demos: DemoPlanItem[];
}
