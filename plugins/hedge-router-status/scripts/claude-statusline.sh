#!/bin/sh
# Claude Code supplies session JSON on stdin. hedge router only needs its local ledger.
cat >/dev/null
exec hedge-router status
