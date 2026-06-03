#!/bin/zsh
set -euo pipefail

cd /Users/worker/odcasa-ticket-system
exec /Users/worker/.local/bin/node /Users/worker/odcasa-ticket-system/server.js
