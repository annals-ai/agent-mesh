import { createRequire } from 'node:module';
import { program } from 'commander';
import { registerConnectCommand } from './commands/connect.js';
import { registerLoginCommand } from './commands/login.js';
import { registerStatusCommand } from './commands/status.js';
import { registerListCommand } from './commands/list.js';
import { registerStartCommand } from './commands/start.js';
import { registerStopCommand } from './commands/stop.js';
import { registerRestartCommand } from './commands/restart.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerRemoveCommand } from './commands/remove.js';
import { registerOpenCommand } from './commands/open.js';
import { registerInstallCommand } from './commands/install.js';
import { registerUninstallCommand } from './commands/uninstall.js';
import { registerAgentsCommand } from './commands/agents.js';
import { registerChatCommand } from './commands/chat.js';
import { registerSkillsCommand } from './commands/skills.js';
import { registerDiscoverCommand } from './commands/discover.js';
import { registerCallCommand } from './commands/call.js';
import { registerConfigCommand } from './commands/config.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerSubscribeCommand } from './commands/subscribe.js';
import { registerRegisterCommand } from './commands/register.js';
import { registerRateCommand } from './commands/rate.js';
import { registerRuntimeCommand } from './commands/runtime.js';
import { registerProfileCommand } from './commands/profile.js';
import { registerFilesCommand } from './commands/files.js';
import { maybeAutoUpgradeOnStartup } from './utils/auto-updater.js';
import { maybePrintDocsHint } from './utils/config.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

const autoUpgrade = maybeAutoUpgradeOnStartup({ currentVersion: version });
if (autoUpgrade.relaunched) {
  process.exit(autoUpgrade.exitCode ?? 0);
}

program
  .name('agent-mesh')
  .description('Connect local AI agents to the Agents.Hot platform')
  .version(version)
  .option('-v', 'output the version number')
  .on('option:v', () => { console.log(version); process.exit(0); });

program.configureOutput({
  outputError: (str, write) => {
    write(str);
    if (str.trim().length > 0) {
      write('\nDocs: https://agents.hot/docs/cli\n');
    }
  },
});

registerConnectCommand(program);
registerLoginCommand(program);
registerStatusCommand(program);
registerListCommand(program);
registerStartCommand(program);
registerStopCommand(program);
registerRestartCommand(program);
registerLogsCommand(program);
registerRemoveCommand(program);
registerOpenCommand(program);
registerInstallCommand(program);
registerUninstallCommand(program);
registerAgentsCommand(program);
registerChatCommand(program);
registerSkillsCommand(program);
registerDiscoverCommand(program);
registerCallCommand(program);
registerConfigCommand(program);
registerStatsCommand(program);
registerSubscribeCommand(program);
registerRegisterCommand(program);
registerRateCommand(program);
registerRuntimeCommand(program);
registerProfileCommand(program);
registerFilesCommand(program);

program
  .command('help')
  .description('Show CLI help')
  .option('--json', 'Output machine-readable command reference')
  .action((opts: { json?: boolean }) => {
    if (opts.json) {
      const commands = program.commands
        .map((cmd) => cmd.name())
        .filter((name) => name !== 'help');
      console.log(JSON.stringify({
        name: 'agent-mesh',
        docs: 'https://agents.hot/docs/cli',
        commands,
      }));
      return;
    }
    program.outputHelp();
  });

const wantsJsonOutput = process.argv.includes('--json');
if (!wantsJsonOutput && !process.argv.includes('--version') && !process.argv.includes('-v')) {
  maybePrintDocsHint('https://agents.hot/docs/cli');
}

program.parse();
