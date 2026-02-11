import type { Command } from 'commander';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { log } from '../utils/logger.js';
import { RESET, BOLD, GREEN, YELLOW, GRAY } from '../utils/table.js';

const LABEL = 'com.agents-hot.agent-bridge';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

export function registerUninstallCommand(program: Command): void {
  program
    .command('uninstall')
    .description('Remove macOS LaunchAgent (agents will no longer auto-start)')
    .action(async () => {
      if (process.platform !== 'darwin') {
        log.error('LaunchAgent is macOS only.');
        process.exit(1);
      }

      if (!existsSync(PLIST_PATH)) {
        console.log(`\n  ${YELLOW}⊘${RESET} No LaunchAgent found at ${GRAY}${PLIST_PATH}${RESET}\n`);
        return;
      }

      // Unload the LaunchAgent
      try {
        execSync(`launchctl bootout gui/$(id -u) "${PLIST_PATH}" 2>/dev/null`, { stdio: 'ignore' });
      } catch {
        try {
          execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null`, { stdio: 'ignore' });
        } catch {
          // May already be unloaded
        }
      }

      // Remove the plist file
      try {
        unlinkSync(PLIST_PATH);
      } catch (err) {
        log.error(`Failed to remove plist: ${err}`);
        return;
      }

      console.log(`\n  ${GREEN}✓${RESET} LaunchAgent removed`);
      console.log(`    Agents will no longer auto-start on login.`);
      console.log(`    Use ${BOLD}agent-bridge install${RESET} to re-install.\n`);
    });
}
