import type { Command } from 'commander';
import { createClient, PlatformApiError } from '../platform/api-client.js';
import { log } from '../utils/logger.js';
import { renderTable, GRAY, RESET } from '../utils/table.js';

const BASE_URL = 'https://agents.hot';

interface ResolvedAuthor {
  id: string;
  login: string;
  name: string | null;
  avatar_url: string | null;
}

interface SubscriptionEntry {
  author_id: string;
  created_at: string;
  author: ResolvedAuthor;
}

interface SubscriptionsResponse {
  subscriptions: SubscriptionEntry[];
}

function handleError(err: unknown): never {
  if (err instanceof PlatformApiError) {
    log.error(err.message);
  } else {
    log.error((err as Error).message);
  }
  process.exit(1);
}

async function resolveAuthorLogin(login: string): Promise<ResolvedAuthor> {
  const res = await fetch(`${BASE_URL}/api/authors/resolve?login=${encodeURIComponent(login)}`);
  if (!res.ok) {
    if (res.status === 404) {
      throw new PlatformApiError(404, 'not_found', `Author not found: ${login}`);
    }
    throw new PlatformApiError(res.status, 'unknown', `Failed to resolve author: HTTP ${res.status}`);
  }
  return res.json() as Promise<ResolvedAuthor>;
}

export function registerSubscribeCommand(program: Command): void {
  program
    .command('subscribe <author-login>')
    .description('Subscribe to an author to access their private agents')
    .action(async (authorLogin: string) => {
      try {
        const client = createClient();
        const author = await resolveAuthorLogin(authorLogin);
        await client.post(`/api/authors/${author.id}/subscribe`);
        log.success(`Subscribed to ${author.login}${author.name ? ` (${author.name})` : ''}`);
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command('unsubscribe <author-login>')
    .description('Unsubscribe from an author')
    .action(async (authorLogin: string) => {
      try {
        const client = createClient();
        const author = await resolveAuthorLogin(authorLogin);
        await client.del(`/api/authors/${author.id}/subscribe`);
        log.success(`Unsubscribed from ${author.login}`);
      } catch (err) {
        handleError(err);
      }
    });

  program
    .command('subscriptions')
    .description('List your author subscriptions')
    .option('--json', 'Output raw JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const client = createClient();
        const data = await client.get<SubscriptionsResponse>('/api/user/subscriptions');

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }

        if (data.subscriptions.length === 0) {
          console.log('  No subscriptions yet.');
          return;
        }

        const table = renderTable(
          [
            { key: 'login', label: 'AUTHOR', width: 24 },
            { key: 'name', label: 'NAME', width: 24 },
            { key: 'since', label: 'SINCE', width: 20 },
          ],
          data.subscriptions.map((s) => ({
            login: s.author.login,
            name: s.author.name || `${GRAY}—${RESET}`,
            since: new Date(s.created_at).toLocaleDateString(),
          })),
        );
        console.log(table);
        console.log(`\n  ${GRAY}${data.subscriptions.length} subscription(s)${RESET}`);
      } catch (err) {
        handleError(err);
      }
    });
}
