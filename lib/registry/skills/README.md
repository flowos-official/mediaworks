# Skill Registry

This directory holds the versioned source of every skill exposed in the runtime registry. **Git is canonical; Supabase is an immutable mirror keyed by `git_sha`.**

See: `docs/superpowers/specs/2026-05-13-skill-agent-registry-design.md`

## Layout

```
lib/registry/skills/
  <skill_slug>/
    active.txt            # one line: "v1" (which version is currently active)
    v1/
      index.ts            # exports default SkillDefinition (without versionLabel/versionDir)
      prompt.ts           # buildPrompt(ctx) → string
      schema.ts           # outputSchema: z.ZodTypeAny
      meta.ts             # { model, provider, generationConfig, validators }
      README.md           # human-readable change log + intent
    v2/
      ...
```

## Rules

- **Each `v<N>/` directory is immutable once merged.** A "fix" is a new `v<N+1>/` directory, never an edit in place. The DB trigger on `skill_versions` enforces this at the storage layer too.
- **`active.txt` is the only mutable file** per skill. It selects which version `runPipeline()` reads.
- **The `index.ts`** must `export default` a `SkillDefinition` fragment (without `versionLabel` and `versionDir` — the walker fills those in from the path).
- **Zod schema must be JSON-Schema convertible.** The publish CI runs `zodToJsonSchema()` and fails the merge if the schema is malformed.

## Adding a new skill

1. Create `lib/registry/skills/<slug>/v1/` with the four files above.
2. Create `lib/registry/skills/<slug>/active.txt` containing `v1`.
3. Open a PR. After merge to `main`, the `publish-registry` GitHub Action publishes a new `skill_versions` row and updates `skills.active_version_id`.

## Updating a skill

1. Create `lib/registry/skills/<slug>/v<N+1>/` with the new files (copy from v\<N\> as a starting point).
2. Update `active.txt` to point at `v<N+1>` only when you're ready to flip traffic.
3. Open a PR. The new version publishes; the active pointer flips on merge.

To rollback: change `active.txt` back to the previous version label and open a PR. The old version still lives in `skill_versions` — no code restore needed.
