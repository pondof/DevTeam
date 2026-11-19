#!/bin/sh
# Run the devteam fixture tests.
exec node --test "$(dirname "$0")"/*.test.mjs
