import type { Command } from 'commander';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { log } from '../utils/logger.js';
import { RESET, BOLD, GREEN, YELLOW, GRAY } from '../utils/table.js';

const LABEL = 'com.agents-hot.agent-mesh';
const PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents');
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);
const LOG_PATH = join(homedir(), '.agent-mesh', 'logs', 'launchd.log');

function detectPaths(): { node: string; script: string } {
  // process.execPath = node binary
  // process.argv[1] = agent-mesh entry script
  return {
    node: process.execPath,
    script: process.argv[1],
  };
}

function generatePlist(nodePath: string, scriptPath: string): string {
  // Call node directly — no shell wrapper needed.
  // spawnBackground() in the start command handles env var sourcing
  // via getLoginShellEnv() for child processes.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(scriptPath)}</string>
    <string>start</string>
    <string>--all</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${escapeXml(LOG_PATH)}</string>

  <key>StandardErrorPath</key>
  <string>${escapeXml(LOG_PATH)}</string>

  <key>WorkingDirectory</key>
  <string>${escapeXml(homedir())}</string>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Install macOS LaunchAgent to auto-start agents on login')
    .option('--force', 'Overwrite existing LaunchAgent')
    .action(async (opts: { force?: boolean }) => {
      if (process.platform !== 'darwin') {
        log.error('LaunchAgent is macOS only. On Linux, use systemd user service instead.');
        process.exit(1);
      }

      if (existsSync(PLIST_PATH) && !opts.force) {
        console.log(`\n  ${YELLOW}⊘${RESET} LaunchAgent already installed at:`);
        console.log(`    ${GRAY}${PLIST_PATH}${RESET}`);
        console.log(`\n  Use ${BOLD}--force${RESET} to overwrite.\n`);
        return;
      }

      const { node, script } = detectPaths();

      // Ensure LaunchAgents directory exists
      if (!existsSync(PLIST_DIR)) {
        mkdirSync(PLIST_DIR, { recursive: true });
      }

      // Unload existing if present
      if (existsSync(PLIST_PATH)) {
        try {
          execSync(`launchctl bootout gui/$(id -u) "${PLIST_PATH}" 2>/dev/null`, { stdio: 'ignore' });
        } catch {
          // May not be loaded
        }
      }

      const plist = generatePlist(node, script);
      writeFileSync(PLIST_PATH, plist, { encoding: 'utf-8' });

      // Load the LaunchAgent
      try {
        execSync(`launchctl bootstrap gui/$(id -u) "${PLIST_PATH}"`, { stdio: 'pipe' });
      } catch {
        // Fallback to legacy load command
        try {
          execSync(`launchctl load "${PLIST_PATH}"`, { stdio: 'pipe' });
        } catch (err) {
          log.error(`Failed to load LaunchAgent: ${err}`);
          log.info(`Plist written to ${PLIST_PATH} — you can load it manually.`);
          return;
        }
      }

      console.log(`\n  ${GREEN}✓${RESET} LaunchAgent installed`);
      console.log(`    Plist: ${GRAY}${PLIST_PATH}${RESET}`);
      console.log(`    Log:   ${GRAY}${LOG_PATH}${RESET}`);
      console.log(`    Node:  ${GRAY}${node}${RESET}`);
      console.log(`    CLI:   ${GRAY}${script}${RESET}`);
      console.log(`\n  All registered agents will auto-start on login.`);
      console.log(`  Use ${BOLD}agent-mesh uninstall${RESET} to remove.\n`);
    });
}
