#!/usr/bin/env bash
# Create the app Secret `euta-cloud-secrets` once (values generated locally, never written to the repo,
# never printed). Idempotent: an existing Secret is left untouched.
#
#   k8s/dev/create-secrets.sh            create if missing
#   k8s/dev/create-secrets.sh --rotate   new BETTER_AUTH_SECRET (everyone signs in again) + RUNNER_TOKEN;
#                                        keeps CREDENTIALS_KEY, POSTGRES_PASSWORD/DATABASE_URL and
#                                        MICROSOFT_CLIENT_SECRET
#   k8s/dev/create-secrets.sh --microsoft  add/replace MICROSOFT_CLIENT_SECRET (Entra app client secret),
#                                        typed at a hidden prompt — never an argument, never printed
#
# CREDENTIALS_KEY and POSTGRES_PASSWORD are never rotated here: a new CREDENTIALS_KEY makes every stored
# test credential unreadable, and a new POSTGRES_PASSWORD does not change the password inside an
# initialized database (the server could no longer connect). See README.
#
# Env: NAMESPACE (default euta) · KUBECONFIG as usual.
set -euo pipefail
ns="${NAMESPACE:-euta}"
name=euta-cloud-secrets
rotate=false
microsoft=false
case "${1:-}" in
  "") ;;
  --rotate) rotate=true ;;
  --microsoft) microsoft=true ;;
  *) echo "usage: $0 [--rotate | --microsoft]" >&2; exit 2 ;;
esac

command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }
echo "cluster: $(kubectl config current-context 2>/dev/null || echo '?') · namespace: $ns" >&2
exists=false
# Only a NotFound for this Secret means "missing" — a wrong cluster/namespace or an expired login must not.
if err="$(kubectl -n "$ns" get secret "$name" -o name 2>&1 >/dev/null)"; then
  exists=true
elif [[ "$err" != *"secrets \"$name\" not found"* ]]; then
  echo "cannot read secret/$name in $ns: $err" >&2
  echo "wrong cluster or namespace? check KUBECONFIG / NAMESPACE (README §1)" >&2
  exit 1
fi

if $microsoft; then
  $exists || { echo "secret/$name does not exist in $ns — run without options first" >&2; exit 1; }
  umask 077
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  read -r -s -p 'Entra client secret (value, hidden): ' ms_secret; echo >&2
  [[ -n "$ms_secret" ]] || { echo "empty value — nothing changed" >&2; exit 1; }
  printf '{"data":{"MICROSOFT_CLIENT_SECRET":"%s"}}' "$(printf '%s' "$ms_secret" | base64 | tr -d '\n')" > "$tmp/patch.json"
  unset ms_secret
  kubectl -n "$ns" patch secret "$name" --type merge --patch-file "$tmp/patch.json" >/dev/null
  echo "MICROSOFT_CLIENT_SECRET set. Next: MICROSOFT_TENANT_ID / MICROSOFT_CLIENT_ID in config.yaml, apply, then"
  echo "  kubectl -n $ns rollout restart deployment/euta-server"
  exit 0
fi
if $exists && ! $rotate; then
  echo "secret/$name already exists in $ns — unchanged (use --rotate to renew BETTER_AUTH_SECRET and RUNNER_TOKEN)"
  exit 0
fi
if ! $exists && $rotate; then
  echo "secret/$name does not exist in $ns — run without --rotate first" >&2
  exit 1
fi

umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Read one key of the existing Secret into a file (decoded; nothing printed).
keep() {
  kubectl -n "$ns" get secret "$name" -o "go-template={{index .data \"$1\" | base64decode}}" > "$tmp/$1"
  [[ -s "$tmp/$1" ]] || { echo "existing secret has no $1 — aborting" >&2; exit 1; }
}

openssl rand -base64 48 | tr -d '\n' > "$tmp/BETTER_AUTH_SECRET"
openssl rand -hex 32 | tr -d '\n' > "$tmp/RUNNER_TOKEN"
ms_from=()
if $rotate; then
  for k in CREDENTIALS_KEY POSTGRES_PASSWORD DATABASE_URL; do keep "$k"; done
  # Optional (Microsoft login on): carried over when present.
  kubectl -n "$ns" get secret "$name" -o "go-template={{with index .data \"MICROSOFT_CLIENT_SECRET\"}}{{. | base64decode}}{{end}}" > "$tmp/MICROSOFT_CLIENT_SECRET"
  if [[ -s "$tmp/MICROSOFT_CLIENT_SECRET" ]]; then ms_from=(--from-file=MICROSOFT_CLIENT_SECRET="$tmp/MICROSOFT_CLIENT_SECRET"); fi
else
  openssl rand -base64 32 | tr -d '\n' > "$tmp/CREDENTIALS_KEY"
  # Hex only: the password goes into DATABASE_URL unescaped.
  openssl rand -hex 24 | tr -d '\n' > "$tmp/POSTGRES_PASSWORD"
  printf 'postgres://euta:%s@euta-db:5432/euta' "$(cat "$tmp/POSTGRES_PASSWORD")" > "$tmp/DATABASE_URL"
fi

kubectl -n "$ns" create secret generic "$name" \
  --from-file=BETTER_AUTH_SECRET="$tmp/BETTER_AUTH_SECRET" \
  --from-file=CREDENTIALS_KEY="$tmp/CREDENTIALS_KEY" \
  --from-file=RUNNER_TOKEN="$tmp/RUNNER_TOKEN" \
  --from-file=POSTGRES_PASSWORD="$tmp/POSTGRES_PASSWORD" \
  --from-file=DATABASE_URL="$tmp/DATABASE_URL" \
  ${ms_from[@]+"${ms_from[@]}"} \
  --dry-run=client -o yaml | kubectl -n "$ns" apply -f -

if $rotate; then
  echo "rotated — restart to pick up the new values: kubectl -n $ns rollout restart deployment/euta-server deployment/euta-runner"
fi
