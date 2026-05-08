#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${D_AI_BASE_URL:-http://localhost:5174/api/v1}"
MODEL="${D_AI_MODEL:-d-ai-casibase}"
TOKEN="${D_AI_TOKEN:-}"
COUNT="${D_AI_TEST_COUNT:-5}"
DELAY_SECONDS="${D_AI_TEST_DELAY:-1}"
HISTORY_KEY="${D_AI_HISTORY_KEY:-test-token-$(date +%Y%m%d%H%M%S)}"
MESSAGE="${D_AI_TEST_MESSAGE:-Hello from D-AI token loop test. Reply with one short sentence.}"
STREAM=false
UNTIL_FAIL=false
FOREVER=false
FAIL_FAST=false
TIMEOUT_SECONDS="${D_AI_TEST_TIMEOUT:-120}"

usage() {
  cat <<'EOF'
Usage: ./scripts/test-token.sh --token <dai_token> [options]

Options:
  --token <token>        D-AI bearer token. Can also use D_AI_TOKEN.
  --count <n>            Number of requests to send. Default: 5.
  --forever              Loop forever, including after non-2xx responses.
  --until-fail           Keep looping until the API returns a non-2xx response.
  --delay <seconds>      Delay between requests. Default: 1.
  --base-url <url>       D-AI API base URL. Default: http://localhost:5174/api/v1.
  --model <model>        Model name. Default: d-ai-casibase.
  --history-key <key>    X-D-AI-History-Key value. Default: test-token-<timestamp>.
  --message <text>       User message to send.
  --stream               Send stream=true.
  --no-stream            Send stream=false. Default.
  --timeout <seconds>    Per-request curl timeout. Default: 120.
  --fail-fast            Stop immediately on the first non-2xx response.
  -h, --help             Show this help.

Examples:
  ./scripts/test-token.sh --token dai_xxx
  ./scripts/test-token.sh --token dai_xxx --base-url http://localhost:5175/api/v1 --count 20 --delay 0.5
  ./scripts/test-token.sh --token dai_xxx --forever --delay 2
  ./scripts/test-token.sh --token dai_xxx --until-fail --history-key quota-smoke
EOF
}

log() {
  printf '==> %s\n' "$*"
}

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

is_success_status() {
  case "$1" in
    2??)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --token)
      TOKEN="${2:-}"
      shift
      ;;
    --count)
      COUNT="${2:-}"
      shift
      ;;
    --until-fail)
      UNTIL_FAIL=true
      ;;
    --forever)
      FOREVER=true
      ;;
    --delay)
      DELAY_SECONDS="${2:-}"
      shift
      ;;
    --base-url)
      BASE_URL="${2:-}"
      shift
      ;;
    --model)
      MODEL="${2:-}"
      shift
      ;;
    --history-key)
      HISTORY_KEY="${2:-}"
      shift
      ;;
    --message)
      MESSAGE="${2:-}"
      shift
      ;;
    --stream)
      STREAM=true
      ;;
    --no-stream)
      STREAM=false
      ;;
    --timeout)
      TIMEOUT_SECONDS="${2:-}"
      shift
      ;;
    --fail-fast)
      FAIL_FAST=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
  shift
done

[ -n "$TOKEN" ] || fail "Missing --token <dai_token> or D_AI_TOKEN"
[[ "$COUNT" =~ ^[0-9]+$ ]] || fail "--count must be a positive integer"
[ "$COUNT" -gt 0 ] || fail "--count must be greater than 0; use --until-fail for an open-ended loop"
[[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || fail "--timeout must be a positive integer"
[ "$TIMEOUT_SECONDS" -gt 0 ] || fail "--timeout must be greater than 0"

require_command curl
require_command node
require_command mktemp

BASE_URL="${BASE_URL%/}"
CHAT_URL="${BASE_URL}/chat/completions"

log "Testing D-AI token"
printf 'URL:         %s\n' "$CHAT_URL"
printf 'Model:       %s\n' "$MODEL"
printf 'History key: %s\n' "$HISTORY_KEY"
if [ "$FOREVER" = true ]; then
  printf 'Loop:        forever\n'
elif [ "$UNTIL_FAIL" = true ]; then
  printf 'Loop:        until first non-2xx response\n'
else
  printf 'Loop:        %s request(s)\n' "$COUNT"
fi
printf 'Stream:      %s\n' "$STREAM"

successes=0
failures=0
attempt=1

while true; do
  if [ "$FOREVER" != true ] && [ "$UNTIL_FAIL" != true ] && [ "$attempt" -gt "$COUNT" ]; then
    break
  fi

  body_file="$(mktemp)"
  error_file="$(mktemp)"
  prompt="${MESSAGE} Attempt ${attempt}."
  payload="$(
    MODEL="$MODEL" PROMPT="$prompt" STREAM="$STREAM" node <<'NODE'
const payload = {
  model: process.env.MODEL,
  messages: [{role: "user", content: process.env.PROMPT}],
  stream: process.env.STREAM === "true",
};
process.stdout.write(JSON.stringify(payload));
NODE
  )"

  set +e
  curl_meta="$(
    curl -sS \
      --max-time "$TIMEOUT_SECONDS" \
      -o "$body_file" \
      -w '%{http_code} %{time_total}' \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "X-D-AI-History-Key: ${HISTORY_KEY}" \
      -H "Content-Type: application/json" \
      --data "$payload" \
      "$CHAT_URL" 2>"$error_file"
  )"
  curl_exit=$?
  set -e

  http_status="000"
  time_total="0"
  if [ -n "$curl_meta" ]; then
    http_status="${curl_meta%% *}"
    time_total="${curl_meta#* }"
  fi

  if [ "$curl_exit" -ne 0 ]; then
    failures=$((failures + 1))
    printf '[%03d] curl failed exit=%s status=%s time=%ss %s\n' \
      "$attempt" "$curl_exit" "$http_status" "$time_total" "$(tr '\n' ' ' < "$error_file")"
    rm -f "$body_file" "$error_file"

    if [ "$FOREVER" = true ]; then
      attempt=$((attempt + 1))
      sleep "$DELAY_SECONDS"
      continue
    fi

    exit 1
  fi

  summary="$(
    BODY_FILE="$body_file" node <<'NODE'
const fs = require("fs");
const raw = fs.readFileSync(process.env.BODY_FILE, "utf8");

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 180);
}

try {
  const json = JSON.parse(raw || "{}");
  if (json.error) {
    console.log(compact(json.error.message || JSON.stringify(json.error)));
  } else if (json.choices?.[0]?.message?.content) {
    const usage = json.usage ? ` tokens=${json.usage.total_tokens || 0}` : "";
    console.log(`${compact(json.choices[0].message.content)}${usage}`);
  } else {
    console.log(compact(JSON.stringify(json)));
  }
} catch {
  let text = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const json = JSON.parse(data);
      text += json.choices?.[0]?.delta?.content || "";
      if (json.error?.message) text += json.error.message;
    } catch {
      text += `${data} `;
    }
  }
  console.log(compact(text || raw));
}
NODE
  )"

  if is_success_status "$http_status"; then
    successes=$((successes + 1))
    printf '[%03d] ok status=%s time=%ss %s\n' "$attempt" "$http_status" "$time_total" "$summary"
  else
    failures=$((failures + 1))
    printf '[%03d] failed status=%s time=%ss %s\n' "$attempt" "$http_status" "$time_total" "$summary"
    rm -f "$body_file" "$error_file"

    if [ "$UNTIL_FAIL" = true ] && [ "$FOREVER" != true ]; then
      log "Stopped after first non-2xx response"
      printf 'Summary: successes=%s failures=%s attempts=%s\n' "$successes" "$failures" "$attempt"
      exit 0
    fi

    if [ "$FAIL_FAST" = true ]; then
      printf 'Summary: successes=%s failures=%s attempts=%s\n' "$successes" "$failures" "$attempt"
      exit 1
    fi

    attempt=$((attempt + 1))
    sleep "$DELAY_SECONDS"
    continue
  fi

  rm -f "$body_file" "$error_file"
  attempt=$((attempt + 1))

  if [ "$FOREVER" = true ] || [ "$UNTIL_FAIL" = true ] || [ "$attempt" -le "$COUNT" ]; then
    sleep "$DELAY_SECONDS"
  fi
done

printf 'Summary: successes=%s failures=%s attempts=%s\n' "$successes" "$failures" "$((attempt - 1))"

if [ "$failures" -gt 0 ]; then
  exit 1
fi
