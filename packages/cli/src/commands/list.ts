import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, removeAgent, type AgentEntry } from '../utils/config.js';
import {
  cleanStalePids, readPid, isProcessAlive,
  spawnBackground, stopProcess, getLogPath, removePid,
} from '../utils/process-manager.js';
import { RESET, RED, GREEN, YELLOW, GRAY, BOLD } from '../utils/table.js';

// ANSI escape sequences
const ALT_ON  = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const CUR_HIDE = '\x1b[?25l';
const CUR_SHOW = '\x1b[?25h';
const HOME = '\x1b[H';
const CLR  = '\x1b[K';
const DIM  = '\x1b[2m';

// Move cursor to row, col (1-based)
function moveTo(row: number, col: number): string {
  return `\x1b[${row};${col}H`;
}

// Minimum terminal width to enable split layout
const SPLIT_MIN_WIDTH = 90;

interface AgentRow {
  name: string;
  entry: AgentEntry;
  type: string;
  status: string;
  statusColor: string;
  pid: string;
  alive: boolean;
  url: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function pad(text: string, width: number): string {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  const diff = width - plain.length;
  return diff > 0 ? text + ' '.repeat(diff) : text;
}

function truncate(text: string, maxLen: number): string {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (plain.length <= maxLen) return text;
  return plain.slice(0, maxLen - 1) + '…';
}

async function fetchRemoteStatus(token?: string): Promise<Record<string, boolean>> {
  const map: Record<string, boolean> = {};
  if (!token) return map;
  try {
    const res = await fetch('https://agents.hot/api/developer/agents', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      for (const a of (await res.json()) as { id: string; is_online: boolean }[]) {
        map[a.id] = a.is_online;
      }
    }
  } catch {}
  return map;
}

function buildRows(agents: Record<string, AgentEntry>, remote: Record<string, boolean>): AgentRow[] {
  return Object.keys(agents).sort().map(name => {
    const entry = agents[name];
    const pidNum = readPid(name);
    const alive = pidNum !== null && isProcessAlive(pidNum);
    const isOnline = remote[entry.agentId];

    let status: string, statusColor: string;
    if (alive && isOnline === true) {
      status = '● online'; statusColor = GREEN;
    } else if (alive) {
      status = '◐ running'; statusColor = YELLOW;
    } else {
      status = '○ stopped'; statusColor = GRAY;
    }

    return {
      name, entry,
      type: entry.agentType,
      status, statusColor,
      pid: alive && pidNum !== null ? String(pidNum) : '—',
      alive,
      url: `agents.hot/agents/${entry.agentId}`,
    };
  });
}

/** Check last N lines of log file for a failure reason */
function getFailReason(name: string): string | null {
  try {
    const logPath = getLogPath(name);
    if (!existsSync(logPath)) return null;
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').slice(-20);
    const text = lines.join('\n');
    if (/token.*revoked|revoked.*token/i.test(text)) {
      return 'Token revoked — run `agent-mesh login` to get a new token';
    }
    if (/auth_failed|Not authenticated/i.test(text)) {
      return 'Authentication failed — check your token';
    }
    if (/ECONNREFUSED|Gateway unreachable/i.test(text)) {
      return 'Agent runtime unreachable — check if gateway is running';
    }
    return null;
  } catch {
    return null;
  }
}

/** Read last N non-empty lines from log file */
function getRecentLogLines(name: string, count: number): string[] {
  try {
    const logPath = getLogPath(name);
    if (!existsSync(logPath)) return [];
    const content = readFileSync(logPath, 'utf-8');
    return content.split('\n')
      .filter(l => l.trim().length > 0)
      .slice(-count);
  } catch {
    return [];
  }
}

/** Estimate active sessions from recent log lines */
function estimateActiveSessions(name: string): number {
  try {
    const logPath = getLogPath(name);
    if (!existsSync(logPath)) return 0;
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').slice(-200);
    let active = 0;
    for (const line of lines) {
      if (/Message received/.test(line)) active++;
      if (/Request done|request.*error|Session cleaned/.test(line)) active = Math.max(0, active - 1);
    }
    return active;
  } catch {
    return 0;
  }
}

/** Format uptime from startedAt ms timestamp */
function formatUptime(startedAt: number | undefined): string {
  if (!startedAt) return '—';
  const ms = Date.now() - startedAt;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
}

/** Strip log timestamp prefix for compact display */
function formatLogLine(line: string): string {
  // Match "2026-02-19 12:01:23 INFO  ..." → "12:01 INFO  ..."
  return line.replace(/^\d{4}-\d{2}-\d{2} (\d{2}:\d{2}):\d{2}\s+/, '$1 ');
}

/** Colorize log level keyword */
function colorizeLogLine(line: string): string {
  if (/\bERROR\b/.test(line)) return RED + line + RESET;
  if (/\bWARN\b/.test(line))  return YELLOW + line + RESET;
  if (/\bINFO\b/.test(line))  return line;
  return GRAY + line + RESET;
}

// ─── Single-column layout (narrow terminals) ────────────────────────────────

const W_NAME = 20, W_TYPE = 12, W_STATUS = 14, W_PID = 8;

function renderSingleScreen(rows: AgentRow[], sel: number, msg: string): string {
  const out: string[] = [];
  const ln = (s = '') => out.push(s + CLR);

  ln();
  ln(`  ${BOLD}AGENT BRIDGE${RESET}`);
  ln();

  if (rows.length === 0) {
    ln(`  No agents registered. Use ${BOLD}agent-mesh connect --setup <url>${RESET} to add one.`);
    ln();
    ln(`  ${DIM}q quit${RESET}`);
    return out.join('\n');
  }

  ln(`${BOLD}${GRAY}  ${'NAME'.padEnd(W_NAME)}${'TYPE'.padEnd(W_TYPE)}${'STATUS'.padEnd(W_STATUS)}${'PID'.padStart(W_PID)}  URL${RESET}`);

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const isSel = i === sel;
    const mark = isSel ? `${GREEN}▸${RESET}` : ' ';
    const nm = isSel ? `${BOLD}${r.name}${RESET}` : r.name;
    ln(`${mark} ${pad(nm, W_NAME)}${pad(r.type, W_TYPE)}${pad(`${r.statusColor}${r.status}${RESET}`, W_STATUS)}${r.pid.padStart(W_PID)}  ${GRAY}${r.url}${RESET}`);
  }

  let on = 0, run = 0, off = 0;
  for (const r of rows) {
    if (r.status.includes('online')) on++;
    else if (r.status.includes('running')) run++;
    else off++;
  }
  const parts = [`${rows.length} agents`];
  if (on)  parts.push(`${on} online`);
  if (run) parts.push(`${run} running`);
  if (off) parts.push(`${off} stopped`);
  ln();
  ln(`  ${GRAY}${parts.join(' · ')}${RESET}`);
  ln();
  ln(msg ? `  ${msg}` : '');
  ln();
  ln(`  ${DIM}↑↓${RESET} navigate  ${DIM}s${RESET} start  ${DIM}x${RESET} stop  ${DIM}r${RESET} restart  ${DIM}l${RESET} logs  ${DIM}o${RESET} open  ${DIM}d${RESET} remove  ${DIM}q${RESET} quit`);

  return out.join('\n');
}

// ─── Split-column layout ─────────────────────────────────────────────────────

function renderSplitScreen(
  rows: AgentRow[],
  sel: number,
  msg: string,
  rightFocus: boolean,
  logScroll: number,
): string {
  const tw = process.stdout.columns || 120;
  const th = process.stdout.rows || 30;

  const LEFT_W  = Math.max(22, Math.min(30, Math.floor(tw * 0.30)));
  const RIGHT_W = tw - LEFT_W - 1; // 1 for divider '│'
  // usable content rows: total - 1 (top border) - 1 (header) - 1 (summary) - 1 (msg) - 1 (help) - 1 (bottom)
  const BODY_H  = Math.max(4, th - 6);

  const selRow = rows[sel] as AgentRow | undefined;

  // Build left column lines (agent list)
  const leftLines: string[] = [];

  if (rows.length === 0) {
    leftLines.push(`  ${GRAY}No agents${RESET}`);
    leftLines.push(`  ${DIM}connect --setup <url>${RESET}`);
  } else {
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const isSel = i === sel;
      const mark  = isSel
        ? (rightFocus ? `${DIM}▸${RESET}` : `${GREEN}▸${RESET}`)
        : ' ';
      const nameW = LEFT_W - 4;
      const nm = truncate(isSel ? `${BOLD}${r.name}${RESET}` : r.name, nameW);
      leftLines.push(`${mark} ${pad(nm, nameW)} ${r.statusColor}${r.status.slice(0, 2)}${RESET}`);
    }
  }

  // Build right column lines (detail panel)
  const rightLines: string[] = [];
  const rw = RIGHT_W - 3; // 2-char left pad + 1 right margin

  if (!selRow) {
    rightLines.push(`${GRAY}No agent selected${RESET}`);
  } else {
    const sessions  = selRow.alive ? estimateActiveSessions(selRow.name) : 0;
    const uptime    = selRow.alive ? formatUptime(selRow.entry.startedAt) : '—';
    const pidStr    = selRow.alive ? `(PID ${selRow.pid})` : '';
    const statusStr = `${selRow.statusColor}${selRow.status}${RESET}${pidStr ? ` ${GRAY}${pidStr}${RESET}` : ''}`;

    rightLines.push(`${BOLD}${truncate(selRow.name, rw)}${RESET}`);
    rightLines.push('─'.repeat(Math.min(rw, 40)));
    rightLines.push(`${GRAY}Type:    ${RESET}${selRow.type}`);
    rightLines.push(`${GRAY}Status:  ${RESET}${statusStr}`);
    rightLines.push(`${GRAY}Sessions:${RESET} ${sessions > 0 ? `${GREEN}${sessions} active${RESET}` : `${GRAY}—${RESET}`}`);
    rightLines.push(`${GRAY}Uptime:  ${RESET}${uptime}`);
    rightLines.push(`${GRAY}URL:     ${RESET}${GRAY}${truncate(selRow.url, rw - 9)}${RESET}`);
    rightLines.push('');

    // Recent log section
    const logHeaderLine = `${DIM}── Recent Log ${'─'.repeat(Math.max(0, Math.min(rw - 14, 20)))}${RESET}`;
    rightLines.push(logHeaderLine);

    const logLines = getRecentLogLines(selRow.name, 40);
    if (logLines.length === 0) {
      rightLines.push(`${GRAY}No log yet${RESET}`);
    } else {
      // Available space for log: BODY_H minus info lines above
      const logAreaH = Math.max(3, BODY_H - rightLines.length - 1);
      const maxScroll = Math.max(0, logLines.length - logAreaH);
      const clampedScroll = Math.min(logScroll, maxScroll);
      const visibleLines = logLines.slice(
        Math.max(0, logLines.length - logAreaH - clampedScroll),
        logLines.length - clampedScroll || undefined,
      );
      for (const l of visibleLines) {
        const formatted = colorizeLogLine(formatLogLine(l));
        rightLines.push(truncate(formatted, rw));
      }
      if (maxScroll > 0) {
        const scrollInfo = clampedScroll > 0
          ? `${GRAY}↑↓ scroll (${clampedScroll}/${maxScroll})${RESET}`
          : `${GRAY}↑ scroll up for more${RESET}`;
        rightLines.push(scrollInfo);
      }
    }
  }

  // Render line by line
  const out: string[] = [HOME];

  // Top border
  out.push(`${'─'.repeat(LEFT_W)}┬${'─'.repeat(RIGHT_W)}${CLR}`);

  // Header row
  const leftHeader  = pad(`  ${BOLD}AGENT BRIDGE${RESET}`, LEFT_W);
  const rightHeader = selRow
    ? `  ${GRAY}${selRow.type}${RESET}`
    : '  ';
  out.push(`${leftHeader}│${rightHeader}${CLR}`);

  // Body rows
  for (let row = 0; row < BODY_H; row++) {
    const leftCell  = leftLines[row]  ?? '';
    const rightCell = rightLines[row] ?? '';

    const leftPad  = LEFT_W - (leftCell.replace(/\x1b\[[0-9;]*m/g, '').length);
    const leftFull = `  ${leftCell}${leftPad > 0 ? ' '.repeat(Math.max(0, leftPad - 2)) : ''}`;
    const rightFull = `  ${rightCell}`;

    out.push(`${truncate(leftFull, LEFT_W)}│${rightFull}${CLR}`);
  }

  // Summary + divider
  let on = 0, run = 0, off = 0;
  for (const r of rows) {
    if (r.status.includes('online')) on++;
    else if (r.status.includes('running')) run++;
    else off++;
  }
  const summaryParts = [`${rows.length} agent${rows.length !== 1 ? 's' : ''}`];
  if (on)  summaryParts.push(`${GREEN}${on} online${RESET}`);
  if (run) summaryParts.push(`${YELLOW}${run} running${RESET}`);
  if (off) summaryParts.push(`${GRAY}${off} stopped${RESET}`);
  const summary = `  ${summaryParts.join(' · ')}`;

  out.push(`${'─'.repeat(LEFT_W)}┴${'─'.repeat(RIGHT_W)}${CLR}`);

  // Message or summary
  out.push(`${summary}${CLR}`);
  out.push(msg ? `  ${msg}${CLR}` : `${CLR}`);

  // Help bar
  const focusHint = rightFocus
    ? `${DIM}↑↓${RESET} scroll log  ${DIM}←/Esc${RESET} focus list  ${DIM}l${RESET} full logs  ${DIM}q${RESET} quit`
    : `${DIM}↑↓${RESET} navigate  ${DIM}s${RESET} start  ${DIM}x${RESET} stop  ${DIM}r${RESET} restart  ${DIM}l${RESET} logs  ${DIM}o${RESET} open  ${DIM}Tab/→${RESET} detail  ${DIM}q${RESET} quit`;
  out.push(`  ${focusHint}${CLR}`);

  return out.join('\n');
}

// ─── TUI class ───────────────────────────────────────────────────────────────

export class ListTUI {
  private rows: AgentRow[] = [];
  private sel = 0;
  private msg = '';
  private ok = true;
  private busy = false;
  private confirm: { name: string } | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private rightRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private msgTimer: ReturnType<typeof setTimeout> | null = null;
  private token?: string;
  private keyHandler = (k: string) => this.onKey(k);
  private resizeHandler = () => this.draw();

  // Split layout state
  private rightFocus = false;
  private logScroll  = 0;

  private get isSplit(): boolean {
    return (process.stdout.columns || 80) >= SPLIT_MIN_WIDTH;
  }

  async run(): Promise<void> {
    if (!process.stdin.isTTY) {
      await this.staticFallback();
      return;
    }

    this.ok = true;
    process.stdout.write(ALT_ON + CUR_HIDE);

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');

    await this.refresh();
    this.draw();

    // Full refresh every 5s (remote status)
    this.refreshTimer = setInterval(() => {
      if (!this.ok || this.busy) return;
      this.refresh().then(() => this.draw());
    }, 5000);

    // Right panel log refresh every 2s (local file read, cheap)
    this.rightRefreshTimer = setInterval(() => {
      if (!this.ok || this.busy) return;
      this.draw();
    }, 2000);

    process.stdin.on('data', this.keyHandler);
    process.stdout.on('resize', this.resizeHandler);
  }

  private async refresh(): Promise<void> {
    cleanStalePids();
    const cfg = loadConfig();
    this.token = cfg.token;
    const remote = await fetchRemoteStatus(cfg.token);
    this.rows = buildRows(cfg.agents, remote);
    if (this.sel >= this.rows.length) this.sel = Math.max(0, this.rows.length - 1);
  }

  private draw(): void {
    if (!this.ok) return;
    const screen = this.isSplit
      ? renderSplitScreen(this.rows, this.sel, this.msg, this.rightFocus, this.logScroll)
      : renderSingleScreen(this.rows, this.sel, this.msg);
    process.stdout.write(HOME + screen);
  }

  private flash(m: string, ms = 3000): void {
    this.msg = m;
    if (this.msgTimer) clearTimeout(this.msgTimer);
    if (ms > 0) {
      this.msgTimer = setTimeout(() => { this.msg = ''; this.draw(); }, ms);
    }
  }

  private onKey(k: string): void {
    if (k === '\x03') { this.exit(); return; }

    if (!this.busy && !this.confirm && (k === 'q' || k === 'Q' || k === '\x1b')) {
      // Escape from right focus first, then quit
      if (this.rightFocus && k === '\x1b') {
        this.rightFocus = false;
        this.logScroll = 0;
        this.draw();
        return;
      }
      if (!this.rightFocus) {
        this.exit();
        return;
      }
    }

    if (this.confirm) {
      if (k === 'y' || k === 'Y') {
        const name = this.confirm.name;
        this.confirm = null;
        this.doRemove(name);
      } else {
        this.confirm = null;
        this.flash('', 0);
        this.draw();
      }
      return;
    }

    if (this.busy) return;

    // Tab or → to switch focus to right panel
    if ((k === '\t' || k === '\x1b[C') && this.isSplit) {
      this.rightFocus = true;
      this.logScroll = 0;
      this.draw();
      return;
    }

    // ← or Escape to return focus to left panel
    if (k === '\x1b[D' && this.rightFocus) {
      this.rightFocus = false;
      this.logScroll = 0;
      this.draw();
      return;
    }

    // Navigation
    if (k === '\x1b[A' || k === 'k') {
      if (this.rightFocus) {
        this.logScroll++;
        this.draw();
      } else if (this.sel > 0) {
        this.sel--;
        this.logScroll = 0;
        this.draw();
      }
      return;
    }
    if (k === '\x1b[B' || k === 'j') {
      if (this.rightFocus) {
        this.logScroll = Math.max(0, this.logScroll - 1);
        this.draw();
      } else if (this.sel < this.rows.length - 1) {
        this.sel++;
        this.logScroll = 0;
        this.draw();
      }
      return;
    }

    const row = this.rows[this.sel];
    if (!row) return;

    switch (k.toLowerCase()) {
      case 's': this.doStart(row); break;
      case 'x': this.doStop(row); break;
      case 'r': this.doRestart(row); break;
      case 'l': this.doLogs(row); break;
      case 'o': this.doOpen(row); break;
      case '\r': this.doOpen(row); break;
      case 'd':
        this.confirm = { name: row.name };
        this.flash(`${YELLOW}Remove ${BOLD}${row.name}${RESET}${YELLOW}? Press y to confirm${RESET}`, 15000);
        this.draw();
        break;
    }
  }

  private async doStart(row: AgentRow): Promise<void> {
    if (row.alive) {
      this.flash(`${YELLOW}⊘${RESET} ${BOLD}${row.name}${RESET} already running`);
      this.draw();
      return;
    }
    this.busy = true;
    this.flash(`Starting ${row.name}...`, 10000);
    this.draw();
    const pid = spawnBackground(row.name, row.entry, this.token);
    await sleep(600);
    await this.refresh();
    this.busy = false;
    if (!isProcessAlive(pid)) {
      const reason = getFailReason(row.name);
      this.flash(reason
        ? `${RED}✗${RESET} ${BOLD}${row.name}${RESET} — ${reason}`
        : `${RED}✗${RESET} ${BOLD}${row.name}${RESET} failed to start — press ${BOLD}l${RESET} for logs`);
    } else {
      this.flash(`${GREEN}✓${RESET} ${BOLD}${row.name}${RESET} started (PID: ${pid})`);
      this.schedulePostStartCheck(row.name, pid);
    }
    this.draw();
  }

  private async doStop(row: AgentRow): Promise<void> {
    if (!row.alive) {
      this.flash(`${YELLOW}⊘${RESET} ${BOLD}${row.name}${RESET} not running`);
      this.draw();
      return;
    }
    this.busy = true;
    this.flash(`Stopping ${row.name}...`, 10000);
    this.draw();
    const ok = await stopProcess(row.name);
    await this.refresh();
    this.busy = false;
    this.flash(ok
      ? `${GREEN}✓${RESET} ${BOLD}${row.name}${RESET} stopped`
      : `${YELLOW}⊘${RESET} ${BOLD}${row.name}${RESET} was not running`);
    this.draw();
  }

  private async doRestart(row: AgentRow): Promise<void> {
    this.busy = true;
    this.flash(`Restarting ${row.name}...`, 10000);
    this.draw();
    if (row.alive) await stopProcess(row.name);
    await sleep(500);
    const pid = spawnBackground(row.name, row.entry, this.token);
    await sleep(600);
    await this.refresh();
    this.busy = false;
    if (!isProcessAlive(pid)) {
      const reason = getFailReason(row.name);
      this.flash(reason
        ? `${RED}✗${RESET} ${BOLD}${row.name}${RESET} — ${reason}`
        : `${RED}✗${RESET} ${BOLD}${row.name}${RESET} failed to restart — press ${BOLD}l${RESET} for logs`);
    } else {
      this.flash(`${GREEN}✓${RESET} ${BOLD}${row.name}${RESET} restarted (PID: ${pid})`);
      this.schedulePostStartCheck(row.name, pid);
    }
    this.draw();
  }

  private schedulePostStartCheck(name: string, pid: number): void {
    setTimeout(async () => {
      if (!this.ok || this.busy) return;
      if (!isProcessAlive(pid)) {
        await this.refresh();
        const reason = getFailReason(name);
        this.flash(reason
          ? `${RED}✗${RESET} ${BOLD}${name}${RESET} — ${reason}`
          : `${RED}✗${RESET} ${BOLD}${name}${RESET} exited shortly after start — press ${BOLD}l${RESET} for logs`, 8000);
        this.draw();
      }
    }, 3000);
  }

  private async doLogs(row: AgentRow): Promise<void> {
    const logPath = getLogPath(row.name);
    if (!existsSync(logPath)) {
      this.flash(`${YELLOW}No logs yet for ${BOLD}${row.name}${RESET}`);
      this.draw();
      return;
    }

    // Pause TUI
    this.busy = true;
    if (this.refreshTimer)      { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (this.rightRefreshTimer) { clearInterval(this.rightRefreshTimer); this.rightRefreshTimer = null; }
    process.stdin.removeListener('data', this.keyHandler);
    process.stdout.removeListener('resize', this.resizeHandler);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(ALT_OFF + CUR_SHOW);

    console.log(`\n  ─── ${BOLD}${row.name}${RESET} (${row.type}) ───────────────────────`);
    console.log(`  ${GRAY}${logPath}${RESET}`);
    console.log(`  ${GRAY}Press Ctrl+C to return to list${RESET}\n`);

    const noop = () => {};
    process.on('SIGINT', noop);

    const tail = spawn('tail', ['-f', '-n', '50', logPath], { stdio: 'inherit' });
    await new Promise<void>(resolve => {
      tail.on('close', resolve);
      tail.on('error', resolve);
    });

    process.removeListener('SIGINT', noop);

    // Resume TUI
    process.stdout.write(ALT_ON + CUR_HIDE);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', this.keyHandler);
    process.stdout.on('resize', this.resizeHandler);

    await this.refresh();
    this.busy = false;
    this.draw();

    this.refreshTimer = setInterval(() => {
      if (!this.ok || this.busy) return;
      this.refresh().then(() => this.draw());
    }, 5000);
    this.rightRefreshTimer = setInterval(() => {
      if (!this.ok || this.busy) return;
      this.draw();
    }, 2000);
  }

  private doOpen(row: AgentRow): void {
    const url = `https://agents.hot/agents/${row.entry.agentId}`;
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
    child.unref();
    this.flash(`${GREEN}✓${RESET} Opened ${GRAY}${url}${RESET}`);
    this.draw();
  }

  private async doRemove(name: string): Promise<void> {
    this.busy = true;
    this.flash(`Removing ${name}...`, 10000);
    this.draw();
    await stopProcess(name);
    removeAgent(name);
    removePid(name);
    await this.refresh();
    this.busy = false;
    this.flash(`${GREEN}✓${RESET} ${BOLD}${name}${RESET} removed`);
    this.draw();
  }

  private exit(): void {
    if (!this.ok) return;
    this.ok = false;
    if (this.refreshTimer)      clearInterval(this.refreshTimer);
    if (this.rightRefreshTimer) clearInterval(this.rightRefreshTimer);
    if (this.msgTimer)          clearTimeout(this.msgTimer);
    process.stdout.removeListener('resize', this.resizeHandler);
    process.stdout.write(ALT_OFF + CUR_SHOW);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.exit(0);
  }

  private async staticFallback(): Promise<void> {
    cleanStalePids();
    const cfg = loadConfig();
    const names = Object.keys(cfg.agents);
    if (names.length === 0) {
      console.log('No agents registered.');
      return;
    }
    const remote = await fetchRemoteStatus(cfg.token);
    const rows = buildRows(cfg.agents, remote);

    console.log('');
    console.log(`  ${BOLD}${GRAY}${'NAME'.padEnd(W_NAME)}${'TYPE'.padEnd(W_TYPE)}${'STATUS'.padEnd(W_STATUS)}${'PID'.padStart(W_PID)}  URL${RESET}`);
    for (const r of rows) {
      console.log(`  ${pad(`${BOLD}${r.name}${RESET}`, W_NAME)}${pad(r.type, W_TYPE)}${pad(`${r.statusColor}${r.status}${RESET}`, W_STATUS)}${r.pid.padStart(W_PID)}  ${GRAY}${r.url}${RESET}`);
    }
    console.log('');
  }
}

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .alias('ls')
    .description('Interactive agent management dashboard')
    .action(async () => {
      const tui = new ListTUI();
      await tui.run();
    });
}
