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
		<main className="bg-background">
			<section className="border-b border-border bg-muted/30">
				<div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
					<div className="max-w-3xl">
						<div className="mb-3 flex items-center gap-2 text-sm font-medium text-blue-600">
							<BookOpen size={18} />
							<span>{guide.badge}</span>
						</div>
						<h1 className="text-3xl font-bold tracking-normal text-foreground sm:text-4xl">
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
								className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition-colors hover:border-blue-300 hover:text-blue-600"
							>
								{link.label}
							</Link>
						))}
					</div>
				</div>
			</section>

			<div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
				<section aria-labelledby="workflow-title" className="mb-12">
					<div className="mb-4 flex items-center gap-2">
						<CheckCircle2 size={20} className="text-blue-600" />
						<h2 id="workflow-title" className="text-xl font-semibold text-foreground">
							{guide.workflowTitle}
						</h2>
					</div>
					<div className="grid gap-3 md:grid-cols-2">
						{guide.workflows.map((workflow) => (
							<div key={workflow.role} className="rounded-lg border border-border bg-card p-4">
								<h3 className="text-base font-semibold text-foreground">{workflow.role}</h3>
								<ol className="mt-3 flex flex-wrap gap-2">
									{workflow.path.map((step, index) => (
										<li
											key={step}
											className="rounded-md bg-muted px-2.5 py-1.5 text-sm text-foreground"
										>
											<span className="mr-1 text-blue-600">{index + 1}</span>
											{step}
										</li>
									))}
								</ol>
							</div>
						))}
					</div>
				</section>

				<section aria-label={guide.sectionsLabel} className="space-y-10">
					{guide.sections.map((section, index) => {
						const Icon = sectionIcons[index] ?? BookOpen;
						return (
							<article
								key={section.title}
								className="rounded-xl border border-border bg-card p-6 shadow-sm"
							>
								<header className="mb-6 flex items-start gap-3 border-b border-border pb-5">
									<div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-blue-600 text-white">
										<Icon size={20} />
									</div>
									<div>
										<div className="text-xs font-medium uppercase tracking-wide text-blue-600">
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
													<div className="mb-2 text-xs font-semibold uppercase tracking-wide text-blue-600">
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
		</main>
	);
}
