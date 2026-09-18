# Security

This is a first implementation, not a security-audited production service. Do not put real credentials, user data or undisclosed vulnerabilities in public issues. Operators must provide a private reporting/contact address before public launch.

## Boundaries

- Use the production Wrangler configuration for deployment. Local loopback bypasses must remain local.
- Set strong random ADMIN_TOKEN and TypeSafe/Turnstile secrets with Wrangler secrets; never commit .dev.vars, .env, cookies, database dumps or recovery codes.
- Production authentication fails closed if Turnstile cannot be verified. Passwords use scrypt; tokens/recovery codes are high-entropy secrets whose hashes are stored.
- All state-changing browser requests require matching Origin and CSRF. Private-rule, evaluation and snapshot access is owner-scoped. Source HTML is reconstructed through a small allowlist.
- Source fetching rejects private/invalid URL targets, checks DNS and each redirect, imposes byte/time caps and conservatively honors robots. DNS rebinding is not completely eliminated by pre-resolution; never attach private-network fetch permissions to this Worker.
- Articles and preferences are untrusted model input. Rule compilation produces a validated DSL, never executable SQL/JavaScript. Typed answers are not evidence of factual truth.
- No HN credentials, automated HN voting or bypass of login/paywalls.

## Before launch

Run the local checks, staging integrations and abuse tests; inspect dependency advisories; validate cookie/Turnstile domains; configure private R2 lifecycle rules; run backup/restore and account deletion exercises; inspect logs for PII. Do not publicize the site as production-ready merely because unit tests passed.

Operator budget controls are not universal cloud spending caps. Disable ANALYSIS_ENABLED/RULE_COMPILATION_ENABLED and use vendor controls when stopping paid model work. Disable SYNC_ENABLED to stop DO discovery; persistent jobs remain inspectable.
