# worker-version-verify

Prove the Cloudflare Worker version you are about to deploy is the one you meant to build.

```
$ worker-version-verify my-worker 5f2c8e1a-7b3d-4c9e-a1f0-2d6b8e4c9a71 --allow API_ORIGIN
SAME main_module
SAME compatibility_date
SAME compatibility_flags
SAME usage_model
SAME bindings
SAME modules
SAME assets_config
ALLOWED API_ORIGIN: https://old-origin.example -> https://new-origin.example
STATIC {"_headers":"text/plain 1f0c47e2…"}
5f2c8e1a-… matches 1e7d4b2c-… except its static files
```

## Why

`wrangler versions upload` lets you upload a Worker version without sending it traffic. The dangerous part comes
next: the version you deploy is built from whatever was on disk. That might be a stale bundle, a config missing a
binding, a different compatibility date, or a worktree that lost someone else's hotfix. The usual check is a diff of
your source against git, which says nothing about what Cloudflare will actually run.

This tool reads both versions back from Cloudflare and compares what runs:

- **Code:** every module, byte for byte (SHA-256 plus content type). Module names are normalized, so `./index.js`
  and `index.js` match.
- **Bindings:** plain-text values are compared. Secrets are compared by name and type, since their values are never
  readable. A dropped secret counts as a difference.
- **Settings:** compatibility date and flags, usage model, and static-asset routing (`run_worker_first`,
  `html_handling`, `not_found_handling`).
- **Static configuration:** `_headers` and `_redirects` travel with the code as asset configuration. They are listed
  separately rather than reported as code changes.

If the only change you meant to make is static files, or one binding you name with `--allow`, it passes. Anything
else fails before a single request reaches the new version.

## Usage

```
worker-version-verify <worker> <new-version-id> [base-version-id|live] [--allow NAME[,NAME]] [--json]
```

- `<worker>`: the Worker (script) name.
- `<new-version-id>`: the version you uploaded with `wrangler versions upload`.
- `[base]`: the version to compare against. Defaults to `live`, the version serving 100% of traffic. During a
  gradual deployment, name the base explicitly.
- `--allow`: plain-text bindings that may differ, such as an origin URL you are deliberately moving.
- `--json`: machine-readable output for CI.

Environment: `CLOUDFLARE_API_TOKEN` (needs Workers Scripts: Read) and `CLOUDFLARE_ACCOUNT_ID`.

Exit codes: `0` same, `1` different, `2` usage or API error. Zero dependencies, plain Node 20+.

```bash
id=$(npx wrangler versions upload --message "release" | sed -n 's/^Worker Version ID: //p')
node worker-version-verify.mjs my-worker "$id" || exit 1
npx wrangler versions deploy "$id@100%" -y
```

As a library:

```js
import { verifyVersion } from './worker-version-verify.mjs';
const r = await verifyVersion({ worker: 'my-worker', next: id, account, token });
if (!r.same) throw new Error(r.results.filter((x) => !x.same).map((x) => x.check).join(', '));
```

## Free templates

- [Canary script](examples/canary.sh): verify, send 1% of traffic, check the new version directly with
  Cloudflare's version-override header, then promote. Rollback is one command.
- [Release checklist](docs/release-checklist.md): what to prove before and after a Worker release.

## What it doesn't do

- It does not compare static asset contents. Cloudflare does not expose a version's asset manifest. Check the
  files you ship after deploying, against the live URL.
- It does not read secret values. Nobody can, which is the point of secrets.
- It does not deploy anything. Use it as the gate before `wrangler versions deploy`.

## License

MIT
