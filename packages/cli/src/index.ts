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

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

program
  .name('agent-mesh')
  .description('Connect local AI agents to the Agents.Hot platform')
  .version(version)
  .option('-v', 'output the version number')
  .on('option:v', () => { console.log(version); process.exit(0); });

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

program.parse();
