import Link from "next/link";
import {
	AlertCircle,
	BookOpen,
	CheckCircle2,
	ClipboardList,
	FileText,
	Map,
	MonitorCheck,
	Search,
	Sparkles,
	Tv,
	type LucideIcon,
} from "lucide-react";
import { getGuideContent } from "@/lib/user-guide/content";
import { localePath } from "@/lib/i18n/locale-path";

const sectionIcons: LucideIcon[] = [
	Map,
	MonitorCheck,
	Search,
	FileText,
	Sparkles,
	Tv,
	ClipboardList,
	AlertCircle,
	CheckCircle2,
];

export default async function GuidePage({
	params,
}: {
	params: Promise<{ locale: string }>;
}) {
	const { locale } = await params;
	const guide = getGuideContent(locale);

	return (
		<main className="mw-page">
			<section className="mw-panel relative overflow-hidden">
				<span className="absolute inset-y-0 left-0 w-1 bg-primary" />
				<div className="px-5 py-6 sm:px-7 sm:py-8">
					<div className="max-w-3xl">
						<div className="mw-kicker mb-3 flex items-center gap-2">
							<BookOpen size={18} />
							<span>{guide.badge}</span>
						</div>
						<h1 className="text-2xl font-bold tracking-[-0.035em] text-foreground sm:text-3xl">
							{guide.heroTitle}
						</h1>
						<p className="mt-4 text-base leading-7 text-muted-foreground">
							{guide.heroDescription}
						</p>
					</div>

					<div className="mt-6 flex flex-wrap gap-2">
						{guide.quickLinks.map((link) => (
							<Link
								key={link.href}
								href={localePath(locale, link.href)}
								className="inline-flex min-h-9 items-center rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground transition-colors hover:border-primary/30 hover:text-primary"
							>
								{link.label}
							</Link>
						))}
					</div>
				</div>
			</section>

			<div className="mx-auto max-w-6xl py-8">
				<section aria-labelledby="workflow-title" className="mb-12">
					<div className="mb-4 flex items-center gap-2">
						<CheckCircle2 size={20} className="text-primary" />
						<h2 id="workflow-title" className="text-xl font-semibold text-foreground">
							{guide.workflowTitle}
						</h2>
					</div>
					<div className="grid gap-3 md:grid-cols-2">
						{guide.workflows.map((workflow) => (
							<div key={workflow.role} className="mw-panel p-4">
								<h3 className="text-base font-semibold text-foreground">{workflow.role}</h3>
								<ol className="mt-3 flex flex-wrap gap-2">
									{workflow.path.map((step, index) => (
										<li
											key={step}
											className="rounded-md bg-muted px-2.5 py-1.5 text-sm text-foreground"
										>
											<span className="mr-1 text-primary">{index + 1}</span>
											{step}
										</li>
									))}
								</ol>
							</div>
						))}
					</div>
				</section>

				<div className="grid gap-5 xl:grid-cols-[220px_minmax(0,1fr)] xl:items-start">
					<nav aria-label={guide.sectionsLabel} className="mw-scrollbar sticky top-3 z-10 flex gap-1.5 overflow-x-auto rounded-xl border border-border bg-card/95 p-2 shadow-sm backdrop-blur xl:block xl:space-y-1 xl:overflow-visible">
						<div className="mw-kicker hidden px-2 pb-2 pt-1 xl:block">{guide.sectionsLabel}</div>
						{guide.sections.map((section, index) => (
							<a key={section.title} href={`#guide-section-${index + 1}`} className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground xl:flex">
								<span className="font-mono text-[10px] text-primary">{String(index + 1).padStart(2, "0")}</span>
								<span className="max-w-40 truncate">{section.title}</span>
							</a>
						))}
					</nav>
				<section aria-label={guide.sectionsLabel} className="min-w-0 space-y-10">
					{guide.sections.map((section, index) => {
						const Icon = sectionIcons[index] ?? BookOpen;
						return (
							<article
								key={section.title}
								id={`guide-section-${index + 1}`}
								className="mw-panel scroll-mt-24 p-5 sm:p-6"
							>
								<header className="mb-6 flex items-start gap-3 border-b border-border pb-5">
									<div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/10 text-primary">
										<Icon size={20} />
									</div>
									<div>
										<div className="mw-kicker">
											Step {index + 1}
										</div>
										<h2 className="mt-1 text-xl font-semibold text-foreground">
											{section.title}
										</h2>
										<p className="mt-1 text-sm leading-6 text-muted-foreground">
											{section.summary}
										</p>
									</div>
								</header>
								<div className="space-y-8">
									{section.items.map((item) => (
										<div key={item.title} className="space-y-3">
											<h3 className="text-base font-semibold text-foreground">{item.title}</h3>
											<p className="text-sm leading-7 text-muted-foreground">{item.body}</p>
											{item.steps && item.steps.length > 0 ? (
												<div className="rounded-md border border-border bg-muted/40 p-4">
											<div className="mb-2 text-xs font-semibold uppercase tracking-wide text-primary">
														{guide.stepsLabel}
													</div>
													<ol className="space-y-2 text-sm leading-6 text-foreground">
														{item.steps.map((step, stepIdx) => (
															<li key={step} className="flex gap-3">
																<span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-semibold text-white">
																	{stepIdx + 1}
																</span>
																<span>{step}</span>
															</li>
														))}
													</ol>
												</div>
											) : null}
											{item.image ? (
												<figure className="overflow-hidden rounded-md border border-border bg-background">
													{/* eslint-disable-next-line @next/next/no-img-element */}
													<img
														src={item.image.src}
														alt={item.image.alt}
														className="block h-auto w-full"
													/>
													{item.image.caption ? (
														<figcaption className="border-t border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
															{item.image.caption}
														</figcaption>
													) : null}
												</figure>
											) : null}
										</div>
									))}
								</div>
							</article>
						);
					})}
				</section>
				</div>
			</div>
		</main>
	);
}
