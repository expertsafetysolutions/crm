---
name: codebase-cleanup
description: Use this skill whenever the user wants to audit a Node.js/JavaScript/TypeScript codebase for unused dependencies, dead code, orphaned files, unused exports/components, or general cruft, and safely remove it without breaking the app. Trigger for requests like "clean up the codebase", "find unused dependencies", "remove dead code", "audit the code", "shrink the bundle", "technical debt cleanup", or any mention of unused imports/exports/packages/files/CSS/env vars. Always run the full inventory-verify-remove-report workflow below instead of deleting anything based on a single tool's output alone.
---

# Codebase Cleanup & Dead Code Audit

## Purpose

Find things in this codebase that are genuinely not used anywhere — dependencies, files, exported functions/components, variables, CSS classes, env vars — and remove them. The two things that matter equally here: actually finding the cruft, and never breaking the app while removing it. A cleanup that ships a broken build is a failed cleanup, full stop. When in doubt about whether something is used, treat it as used.

## Non-negotiable safety rules

These apply for the entire task, no exceptions:

1. **Never work on the main/default branch.** Create a new branch (e.g. `chore/codebase-cleanup`) before touching anything.
2. **Confirm the app currently builds and runs before changing anything.** Run the build, run the test suite (if one exists), run the linter. Save this as your baseline — you need to know the app was healthy before you started.
3. **Never delete based on one tool's output alone.** Static analysis tools produce false positives constantly (dynamic imports, string-based requires, code only reached at runtime, things used by a mobile app or another service hitting this API). Every candidate for removal gets a manual verification pass (see below) before it's touched.
4. **Remove in small batches, verify after every batch.** Never do one giant delete-everything pass. Batch by category (e.g. "unused npm dependencies" is one batch, "unused React components" is another). After each batch: run build + lint + tests. If anything breaks, revert that batch immediately and figure out why before retrying.
5. **Commit after each batch that passes verification**, with a clear message describing what was removed and why. This gives the user (and you) a clean rollback point at every step, instead of one huge diff that's hard to review or undo.
6. **When genuinely unsure, don't delete — flag it.** List uncertain items in the final report for the user to decide on manually, along with why you weren't confident. A smaller, trustworthy cleanup beats a larger, risky one.

## Workflow

### Phase 1 — Setup & baseline

- Create and switch to a new branch.
- Identify the package manager (npm/yarn/pnpm — check for `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`) and the build/test/lint commands from `package.json` scripts.
- Run the build, test suite, and linter. Record whether each currently passes. If the build or tests are already broken before you start, stop and tell the user — don't clean up on top of a broken baseline.

### Phase 2 — Inventory

- Map the project structure: entry points (main app files, API route definitions, background job/worker entry points), and how the app is organized (pages/routes, components, services, utils, config).
- List all dependencies from `package.json` (both `dependencies` and `devDependencies`).
- Note anything that looks CRM-specific and easy to misjudge: scheduled jobs/cron tasks, webhook receivers, email/notification templates, migration or seed scripts, admin-only routes, multi-tenant or plugin-style code loaded dynamically.

### Phase 3 — Dependency audit

Run dependency-checking tools and cross-reference their findings against actual usage:

```bash
npx knip          # unused files, exports, AND dependencies in one pass — best starting point
npx depcheck      # unused + missing dependencies, catches some things knip misses
```

For every dependency a tool flags as unused, manually check before removing:
- Is it referenced in config files (`.eslintrc`, `tailwind.config`, `next.config`, `babel.config`, CI workflow files) rather than in application code?
- Is it a peer dependency or plugin loaded by name as a string, not an `import`/`require`?
- Is it a CLI tool only invoked via an npm script (`postinstall`, `prebuild`, etc.)?
- Is it a type-only package (`@types/...`) whose corresponding runtime package is still used?

Only remove a dependency once you've confirmed none of the above apply.

### Phase 4 — Dead code audit

Look for:
- **Unused exports/components/functions** — `knip` covers this; also grep for components or utility functions with zero import references.
- **Unused variables/imports** — run `eslint` with `no-unused-vars` / `unused-imports` rules if configured, or add them temporarily for this audit.
- **Unreachable code** — code after early returns, conditions that can never be true, feature branches gated behind flags that no longer exist.
- **Duplicate/orphaned files** — old versions of a file left alongside the current one (e.g. `Component.old.jsx`, commented-out entire files), files not imported from anywhere.
- **Commented-out code blocks** — dead code someone left "just in case." If it's not paired with a comment explaining why it's intentionally kept, it's a removal candidate.
- **Unused CSS** — if using Tailwind, purge/JIT already strips unused utility classes from the build, so this is lower priority; still worth checking hand-written CSS/SCSS files for selectors matching nothing in the markup.
- **Unused environment variables** — vars declared in `.env.example` or config schemas but never read via `process.env` anywhere in the code.
- **Unused API routes/endpoints** — routes not called by any frontend code in this repo. Flag rather than delete (see verification pass below — these are the highest false-positive-risk category for a CRM).

### Phase 5 — Verification pass (before removing anything from Phase 3 or 4)

For every candidate, check for these usage patterns that static analysis tools commonly miss:
- Dynamic imports (`import(variablePath)`) or `require(someVariable)`.
- Reflection-style access (`obj[stringKey]`, dynamic route/handler registration).
- Code reached only via a scheduler/cron job, message queue consumer, or webhook — these have no import chain from the "main" app but run in production.
- API routes/endpoints that a mobile app, another internal service, or a third-party integration calls — nothing in this repo will "import" them, so they'll always look unused to static tools.
- Test files, fixtures, or mocks that reference the code even if application code doesn't.
- Type-only exports used purely for TypeScript type-checking/documentation, not runtime.
- Anything behind an environment check (`if (process.env.NODE_ENV === 'development')`) — looks dead in one environment but isn't.

If you can't find any usage after this check, search the whole repo (not just `src/`) for the identifier name as a plain text string, since string-based references won't show up in an import graph. If it's still clean, it's safe to remove.

### Phase 6 — Remove in batches

For each category (dependencies, dead files, unused exports, unused CSS, unused env vars, etc.):
1. Remove that batch only.
2. Run build + lint + tests.
3. If green: commit with a message like `chore: remove unused <category> (<what>, <why safe>)`.
4. If red: revert the batch, note in your findings what broke and why you're leaving it, and move to the next category.

### Phase 7 — Final report

Give the user a summary in this format:

```markdown
## Codebase Cleanup Report

### Removed (verified safe, build/tests passing)
- [Category]: [what was removed] — [why it was confirmed unused]
  ...

### Flagged but NOT removed (needs your judgment)
- [Item] — [why it looked unused] — [why I wasn't confident enough to delete it]
  ...

### Impact
- Dependencies removed: [count], approx size saved: [if known]
- Files/lines removed: [count]
- Build/test/lint status: [pass/fail after final batch]

### Recommended next steps
- [Anything worth a human second look before merging]
```

## Notes

- If the project has no test suite, say so explicitly in the report — it means "build succeeds" is your only safety net, and the user should manually smoke-test key flows (login, core CRM actions like creating/editing a contact or deal) before merging.
- Prefer `knip` as the primary tool — it covers dependencies, dead files, and unused exports in one consistent pass and tends to have fewer false positives than combining several single-purpose tools.
- Never touch database migration files, seed scripts, or anything under a `migrations/` folder even if a tool flags them as "unused" — they're often only invoked by a migration runner, not imported by application code.
