#!/bin/sh
# Re-capture real hook payloads from the installed Claude Code (costs two tiny haiku subagent runs), so
# tests/fixtures/hooks stays in sync after Claude Code upgrades. Prints the capture directory; turn the new
# payloads into fixtures by replacing machine paths with {{CWD}}, {{HOME}}, {{AGENT_TYPE}}, {{FILE}}, {{COMMAND}},
# {{AGENT_TRANSCRIPT}} as in the existing files, then run tests/run.sh.
set -eu
P="$(mktemp -d /tmp/devteam-hookcap-XXXXXX)"
mkdir -p "$P/repo/.claude/agents"
cd "$P/repo"
git init -q -b main && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
cat > .claude/agents/probe-writer.md <<'EOF'
---
name: probe-writer
description: Probe agent that writes one file. Use only when told to.
model: haiku
effort: low
maxTurns: 6
isolation: worktree
tools: Write, Bash
---
Write the file probe.txt containing "hello" in your current working directory, then run `echo probe-done` with Bash, then stop.
EOF
for ev in SessionStart PreToolUse SubagentStart SubagentStop; do mkdir -p "$P/cap/$ev"; done
cat > "$P/settings.json" <<EOF
{"hooks":{
 "SessionStart":[{"hooks":[{"type":"command","command":"cat > $P/cap/SessionStart/\$(date +%s%N).json"}]}],
 "PreToolUse":[{"matcher":"Write|Edit|Bash","hooks":[{"type":"command","command":"cat > $P/cap/PreToolUse/\$(date +%s%N).json"}]}],
 "SubagentStart":[{"hooks":[{"type":"command","command":"cat > $P/cap/SubagentStart/\$(date +%s%N).json"}]}],
 "SubagentStop":[{"hooks":[{"type":"command","command":"cat > $P/cap/SubagentStop/\$(date +%s%N).json"}]}]
}}
EOF
claude -p "First dispatch the probe-writer subagent with the prompt 'go'. Then dispatch the devteam:gemini-bridge subagent with the prompt 'Run exactly: echo bridge-probe'. Report both results in one line each." \
  --model haiku --settings "$P/settings.json" --permission-mode acceptEdits --allowedTools "Agent" "Write" "Bash(echo *)" < /dev/null > "$P/out.txt" 2>&1 || true
for ev in SessionStart PreToolUse SubagentStart SubagentStop; do echo "$ev: $(ls "$P/cap/$ev" | wc -l | tr -d ' ') payload(s)"; done
echo "captured in $P/cap"
