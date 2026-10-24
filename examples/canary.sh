#!/usr/bin/env bash
# Verify, canary at 1%, check the new version directly, then promote. Rollback is a single command.
# Usage: WORKER=my-worker CHECK_URL=https://example.com/health ./canary.sh
set -euo pipefail
: "${WORKER:?set WORKER}" "${CHECK_URL:?set CHECK_URL}"

live=$(node --input-type=module -e "
  const r = await fetch('https://api.cloudflare.com/client/v4/accounts/' + process.env.CLOUDFLARE_ACCOUNT_ID + '/workers/scripts/' + process.env.WORKER + '/deployments', { headers: { authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN } });
  console.log((await r.json()).result.deployments[0].versions[0].version_id);")

new=$(npx wrangler versions upload --message "canary" | sed -n 's/^Worker Version ID: //p')
echo "live $live, uploaded $new"

# 1. Same code, bindings and settings as live, except what you meant to change.
node worker-version-verify.mjs "$WORKER" "$new" "$live" ${ALLOW:+--allow "$ALLOW"}

# 2. Send 1% of traffic to the new version.
npx wrangler versions deploy "$new@1%" "$live@99%" --name "$WORKER" -y

# 3. Hit the new version directly: Cloudflare routes this request to it whatever the split.
curl -fsS -H "Cloudflare-Workers-Version-Overrides: $WORKER=\"$new\"" "$CHECK_URL" > /dev/null
echo "canary answered"

# 4. Promote. To roll back instead: npx wrangler versions deploy "$live@100%" --name "$WORKER" -y
npx wrangler versions deploy "$new@100%" --name "$WORKER" -y
echo "rollback: npx wrangler versions deploy $live@100% --name $WORKER -y"
