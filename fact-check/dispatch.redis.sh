#!/bin/bash
# Fact-check script for Dispatch Intelligence tools
# Usage: REDIS_HOST=<host> REDIS_PORT=6379 bash fact-check/dispatch.redis.sh
#
# If your Redis requires a password:
#   REDIS_HOST=<host> REDIS_PORT=6379 REDIS_PASSWORD=<pass> bash fact-check/dispatch.redis.sh

HOST="${REDIS_HOST:-127.0.0.1}"
PORT="${REDIS_PORT:-6379}"
AUTH=""
if [ -n "$REDIS_PASSWORD" ]; then
  AUTH="-a $REDIS_PASSWORD"
fi

CLI="redis-cli -h $HOST -p $PORT $AUTH"

echo ""
echo "=== DISPATCH QUEUE STATUS ==="
echo ""

TOTAL=$($CLI ZCARD orderDispatchQueue)
echo "Total in queue: $TOTAL"

NOW_MS=$(date +%s%3N)
READY=$($CLI ZRANGEBYSCORE orderDispatchQueue 0 "$NOW_MS" | wc -l | tr -d ' ')
echo "Ready to dispatch (score <= now): $READY"

SCHEDULED=$($CLI ZRANGEBYSCORE orderDispatchQueue "$NOW_MS" +inf | wc -l | tr -d ' ')
echo "Scheduled for later (score > now): $SCHEDULED"

echo ""
echo "=== OLDEST WAITING ORDERS (top 5) ==="
echo ""

OLDEST=$($CLI ZRANGEBYSCORE orderDispatchQueue 0 "$NOW_MS" WITHSCORES LIMIT 0 5)
if [ -n "$OLDEST" ]; then
  echo "$OLDEST" | paste - - | while read -r ORDER_ID SCORE; do
    WAIT_SEC=$(( (NOW_MS - SCORE) / 1000 ))
    WAIT_MIN=$(( WAIT_SEC / 60 ))
    echo "  Order: $ORDER_ID - waiting ${WAIT_MIN} min (${WAIT_SEC}s)"

    # Check iteration count
    ITER=$($CLI GET "$ORDER_ID")
    if [ -n "$ITER" ]; then
      echo "    Dispatch iteration: $ITER"
    fi
  done
else
  echo "  (none)"
fi

echo ""
echo "=== Done. Compare with MCP dispatch_queue_status output. ==="
