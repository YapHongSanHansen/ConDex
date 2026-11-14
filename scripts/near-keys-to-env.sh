#!/bin/sh
# Copies the secret keys of ConDex's two NEAR accounts (operator and reporter) from the macOS Keychain, where
# near-cli saved them, into .env, which git ignores. The keys are never printed.
#
#   scripts/near-keys-to-env.sh [operator-account] [reporter-account]
#
# Defaults: dryward2518.testnet and reporter.dryward2518.testnet. Then start the API with CONDEX_LEDGER=near.
set -eu
cd "$(dirname "$0")/.."
OPERATOR="${1:-dryward2518.testnet}"
REPORTER="${2:-reporter.$OPERATOR}"
ENV_FILE=.env

git check-ignore -q "$ENV_FILE" || { echo "$ENV_FILE is not ignored by git; refusing to write keys into it" >&2; exit 1; }

key_of() {
  security find-generic-password -s "near-testnet-$1" -w 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).private_key;if(!/^ed25519:/.test(k||""))process.exit(1);process.stdout.write(k)})' \
    || { echo "No near-cli key for $1 in the Keychain. Import it with: near account import-account" >&2; exit 1; }
}

OPERATOR_KEY=$(key_of "$OPERATOR")
REPORTER_KEY=$(key_of "$REPORTER")

touch "$ENV_FILE"
# Replace earlier values, keep everything else.
grep -v -E '^CONDEX_NEAR_(OPERATOR|REPORTER)_(ID|KEY)=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
{
  echo "CONDEX_NEAR_OPERATOR_ID=$OPERATOR"
  echo "CONDEX_NEAR_OPERATOR_KEY=$OPERATOR_KEY"
  echo "CONDEX_NEAR_REPORTER_ID=$REPORTER"
  echo "CONDEX_NEAR_REPORTER_KEY=$REPORTER_KEY"
} >> "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"
chmod 600 "$ENV_FILE"
echo "Wrote the keys of $OPERATOR and $REPORTER to $ENV_FILE (not printed). Start the API with CONDEX_LEDGER=near."
