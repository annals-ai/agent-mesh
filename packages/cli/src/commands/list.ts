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
const ALT_ON = '\x1b[?1049h';
const ALT_OFF = '\x1b[?1049l';
const CUR_HIDE = '\x1b[?25l';
const CUR_SHOW = '\x1b[?25h';
const HOME = '\x1b[H';
const CLR = '\x1b[K';
const DIM = '\x1b[2m';

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

const W_NAME = 20, W_TYPE = 12, W_STATUS = 14, W_PID = 8;

function renderScreen(rows: AgentRow[], sel: number, msg: string): string {
  const out: string[] = [];
  const ln = (s = '') => out.push(s + CLR);

  ln();
  ln(`  ${BOLD}AGENT BRIDGE${RESET}`);
  ln();

  if (rows.length === 0) {
    ln(`  No agents registered. Use ${BOLD}agent-bridge connect --setup <url>${RESET} to add one.`);
    ln();
    ln(`  ${DIM}q quit${RESET}`);
    return out.join('\n');
  }

  // Header
  ln(`${BOLD}${GRAY}  ${'NAME'.padEnd(W_NAME)}${'TYPE'.padEnd(W_TYPE)}${'STATUS'.padEnd(W_STATUS)}${'PID'.padStart(W_PID)}  URL${RESET}`);

  // Rows
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const isSel = i === sel;
    const mark = isSel ? `${GREEN}▸${RESET}` : ' ';
    const nm = isSel ? `${BOLD}${r.name}${RESET}` : r.name;
    ln(`${mark} ${pad(nm, W_NAME)}${pad(r.type, W_TYPE)}${pad(`${r.statusColor}${r.status}${RESET}`, W_STATUS)}${r.pid.padStart(W_PID)}  ${GRAY}${r.url}${RESET}`);
  }

  // Summary
  let on = 0, run = 0, off = 0;
  for (const r of rows) {
    if (r.status.includes('online')) on++;
    else if (r.status.includes('running')) run++;
    else off++;
  }
  const parts = [`${rows.length} agents`];
  if (on) parts.push(`${on} online`);
  if (run) parts.push(`${run} running`);
  if (off) parts.push(`${off} stopped`);
  ln();
  ln(`  ${GRAY}${parts.join(' · ')}${RESET}`);

  // Status message
  ln();
  ln(msg ? `  ${msg}` : '');

  // Help bar
  ln();
  ln(`  ${DIM}↑↓${RESET} navigate  ${DIM}s${RESET} start  ${DIM}x${RESET} stop  ${DIM}r${RESET} restart  ${DIM}l${RESET} logs  ${DIM}o${RESET} open  ${DIM}d${RESET} remove  ${DIM}q${RESET} quit`);

  return out.join('\n');
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
      return 'Token revoked — run `agent-bridge login` to get a new token';
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

export class ListTUI {
  private rows: AgentRow[] = [];
  private sel = 0;
  private msg = '';
  private ok = true;
  private busy = false;
  private confirm: { name: string } | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private msgTimer: ReturnType<typeof setTimeout> | null = null;
  private token?: string;
  private keyHandler = (k: string) => this.onKey(k);

  async run(): Promise<void> {
    // Non-interactive fallback (piped output)
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

    this.refreshTimer = setInterval(() => {
      if (!this.ok || this.busy) return;
      this.refresh().then(() => this.draw());
    }, 5000);

    process.stdin.on('data', this.keyHandler);
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
    process.stdout.write(HOME + renderScreen(this.rows, this.sel, this.msg));
  }

  private flash(m: string, ms = 3000): void {
    this.msg = m;
    if (this.msgTimer) clearTimeout(this.msgTimer);
    if (ms > 0) {
      this.msgTimer = setTimeout(() => { this.msg = ''; this.draw(); }, ms);
    }
  }

  private onKey(k: string): void {
    // Always allow quit via Ctrl+C
    if (k === '\x03') { this.exit(); return; }

    // Quit via q/Esc when not busy or confirming
    if (!this.busy && !this.confirm && (k === 'q' || k === 'Q' || k === '\x1b')) {
      this.exit();
      return;
    }

    // Confirm mode (for remove)
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

    // Navigation
    if (k === '\x1b[A' || k === 'k') {
      if (this.sel > 0) { this.sel--; this.draw(); }
      return;
    }
    if (k === '\x1b[B' || k === 'j') {
      if (this.sel < this.rows.length - 1) { this.sel++; this.draw(); }
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
      // Delayed recheck: auth failures may take 1-3s (WS connect + register + reject)
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

  /** Recheck after 3s: catch auth failures that take longer than initial 600ms wait */
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

    // Pause TUI — exit alternate screen, restore cursor, cooked mode
    this.busy = true;
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    process.stdin.removeListener('data', this.keyHandler);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(ALT_OFF + CUR_SHOW);

    console.log(`\n  ─── ${BOLD}${row.name}${RESET} (${row.type}) ───────────────────────`);
    console.log(`  ${GRAY}${logPath}${RESET}`);
    console.log(`  ${GRAY}Press Ctrl+C to return to list${RESET}\n`);

    // Swallow SIGINT in parent so only tail exits
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

    await this.refresh();
    this.busy = false;
    this.draw();

    this.refreshTimer = setInterval(() => {
      if (!this.ok || this.busy) return;
      this.refresh().then(() => this.draw());
    }, 5000);
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
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.msgTimer) clearTimeout(this.msgTimer);
    process.stdout.write(ALT_OFF + CUR_SHOW);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.exit(0);
  }

  // Static fallback for piped/non-interactive output
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
