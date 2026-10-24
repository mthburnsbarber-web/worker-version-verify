# Cloudflare Worker release checklist

## Before any traffic

- [ ] Note the live version ID. That is your rollback.
- [ ] Upload with `wrangler versions upload`, not `wrangler deploy`. Deploy also rewrites routes, the `workers.dev`
      setting and queue consumers from your local config.
- [ ] `worker-version-verify <worker> <new>` passes: the same code, bindings and settings as live, apart from what
      you meant to change (named with `--allow`).
- [ ] Script-level settings (logs, tail consumers, observability) are either identical in your config or left out
      of it. Some apply on the next deployment of anyone's version.

## Canary

- [ ] Deploy at 1%: `wrangler versions deploy <new>@1% <live>@99%`.
- [ ] Request the new version directly with `Cloudflare-Workers-Version-Overrides: <worker>="<new>"`. Check the
      pages and API answers your users depend on, not only a health route.
- [ ] Watch errors for the new version in Workers logs.

## After promoting

- [ ] Fetch the live URLs and compare them with what you shipped: changed files byte for byte, and headers such as
      `Content-Security-Policy` on the paths they protect.
- [ ] Write down the live version, the rollback version and the rollback command where the next person will find
      them.
