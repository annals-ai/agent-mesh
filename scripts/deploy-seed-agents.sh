#!/usr/bin/env bash
#
# Deploy seed agents to the local machine
#
# Usage:
#   ./deploy-seed-agents.sh                 # Deploy all seed agents
#   ./deploy-seed-agents.sh seo-writer      # Deploy specific agent
#
# Prerequisites:
#   - agent-bridge CLI installed and logged in
#   - Claude Code installed (for claude adapter)
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_DIR="$SCRIPT_DIR/../seed-agents"
AGENT_BASE_DIR="$HOME/.agent-bridge/agents"

# Seed agent definitions: name|display_name|capabilities|description
SEED_AGENTS=(
  "seo-writer|SEO Writer|seo-writing,blog,content-marketing,english|Expert SEO content writer for blog posts and marketing copy"
  "translator|Translator|translation,chinese,japanese,english|Professional translator specializing in Chinese, Japanese, and English"
  "code-reviewer|Code Reviewer|code-review,typescript,python,refactoring|Expert code reviewer for TypeScript and Python projects"
)

log_info()  { echo -e "\033[34m[INFO]\033[0m  $*"; }
log_ok()    { echo -e "\033[32m[OK]\033[0m    $*"; }
log_error() { echo -e "\033[31m[ERROR]\033[0m $*"; }
log_warn()  { echo -e "\033[33m[WARN]\033[0m  $*"; }

deploy_agent() {
  local entry="$1"
  IFS='|' read -r name display_name capabilities description <<< "$entry"

  local agent_dir="$AGENT_BASE_DIR/$name"
  local seed_claude_md="$SEED_DIR/$name/CLAUDE.md"

  if [[ ! -f "$seed_claude_md" ]]; then
    log_error "CLAUDE.md not found for $name at $seed_claude_md"
    return 1
  fi

  log_info "Deploying $display_name..."

  # 1. Create agent directory and copy CLAUDE.md
  mkdir -p "$agent_dir"
  cp "$seed_claude_md" "$agent_dir/CLAUDE.md"
  log_info "  Copied CLAUDE.md → $agent_dir/"

  # 2. Check if agent exists on platform (by name match)
  local agent_id
  agent_id=$(agent-bridge agents list --json 2>/dev/null | \
    python3 -c "
import sys, json
data = json.load(sys.stdin)
agents = data.get('agents', data) if isinstance(data, dict) else data
for a in agents:
    if a.get('name','').lower() == '${display_name,,}'.lower():
        print(a['id'])
        break
" 2>/dev/null || echo "")

  if [[ -z "$agent_id" ]]; then
    log_info "  Creating agent on platform..."
    local create_output
    create_output=$(agent-bridge agents create \
      --name "$display_name" \
      --description "$description" \
      --type claude \
      --json 2>/dev/null || echo "")

    if [[ -n "$create_output" ]]; then
      agent_id=$(echo "$create_output" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "")
    fi

    if [[ -z "$agent_id" ]]; then
      log_error "  Failed to create agent $display_name"
      return 1
    fi
    log_ok "  Created: $agent_id"
  else
    log_info "  Agent exists: $agent_id"
  fi

  # 3. Update capabilities
  log_info "  Setting capabilities: $capabilities"
  agent-bridge agents update "$agent_id" \
    --capabilities "$capabilities" 2>/dev/null || log_warn "  Failed to update capabilities"

  # 4. Start agent in background
  log_info "  Starting agent..."
  agent-bridge connect claude \
    --agent-id "$agent_id" \
    --project "$agent_dir" &
  local pid=$!
  sleep 2

  if kill -0 "$pid" 2>/dev/null; then
    log_ok "  $display_name running (PID: $pid)"
    echo "$pid" > "$agent_dir/.pid"
  else
    log_warn "  Agent process exited. Check logs."
  fi

  echo ""
}

stop_all() {
  log_info "Stopping all seed agents..."
  for entry in "${SEED_AGENTS[@]}"; do
    IFS='|' read -r name _ _ _ <<< "$entry"
    local pidfile="$AGENT_BASE_DIR/$name/.pid"
    if [[ -f "$pidfile" ]]; then
      local pid
      pid=$(cat "$pidfile")
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid"
        log_ok "Stopped $name (PID: $pid)"
      fi
      rm -f "$pidfile"
    fi
  done
}

# --- Main ---

if [[ "${1:-}" == "stop" ]]; then
  stop_all
  exit 0
fi

echo ""
echo "========================================="
echo "  Deploying Seed Agents"
echo "========================================="
echo ""

# Check prerequisites
if ! command -v agent-bridge &>/dev/null; then
  log_error "agent-bridge CLI not found. Install with: npm install -g @agents-hot/agent-bridge"
  exit 1
fi

if ! agent-bridge status &>/dev/null; then
  log_warn "agent-bridge may not be logged in. Run: agent-bridge login"
fi

target="${1:-all}"

for entry in "${SEED_AGENTS[@]}"; do
  IFS='|' read -r name _ _ _ <<< "$entry"
  if [[ "$target" == "all" || "$target" == "$name" ]]; then
    deploy_agent "$entry"
  fi
done

echo "========================================="
log_ok "Deployment complete"
echo "========================================="
echo ""
echo "To stop all seed agents: $0 stop"
echo ""
