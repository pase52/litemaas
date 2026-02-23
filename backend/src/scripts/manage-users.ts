#!/usr/bin/env ts-node

/**
 * User Management Script for LiteMaaS
 *
 * Interactive CLI to manage users in the LiteMaaS database and LiteLLM.
 *
 * Commands:
 *   list                     - List all users
 *   create                   - Create a new user interactively
 *   delete <username>        - Delete a user by username
 *   add <username> <email>   - Quick add a user with defaults
 *   random [count]           - Generate random test users (default: 1)
 *
 * Usage:
 *   npm run users -- list
 *   npm run users -- create
 *   npm run users -- delete testuser
 *   npm run users -- add johndoe john@example.com
 *   npm run users -- random 5
 */

import { createApp } from '../app';
import { FastifyInstance } from 'fastify';
import * as crypto from 'crypto';
import * as readline from 'readline/promises';

// ─── Color helpers ──────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
} as const;

function c(text: string, color: keyof typeof C): string {
  return `${C[color]}${text}${C.reset}`;
}

// ─── Constants ──────────────────────────────────────────────

const DEFAULT_TEAM_ID = 'a0000000-0000-4000-8000-000000000001';

const RANDOM_FIRST_NAMES = [
  'Alice', 'Bob', 'Charlie', 'Diana', 'Eve', 'Frank', 'Grace', 'Hank',
  'Ivy', 'Jack', 'Karen', 'Leo', 'Mia', 'Nick', 'Olivia', 'Paul',
  'Quinn', 'Rita', 'Sam', 'Tina', 'Uma', 'Vince', 'Wendy', 'Xander',
  'Yara', 'Zach',
];

const RANDOM_LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller',
  'Davis', 'Rodriguez', 'Martinez', 'Anderson', 'Taylor', 'Thomas',
  'Moore', 'Jackson', 'Martin', 'Lee', 'Clark', 'Lewis', 'Walker',
];

const DOMAINS = ['example.com', 'test.local', 'litemaas.dev', 'demo.io'];

// ─── Helpers ────────────────────────────────────────────────

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateRandomUser() {
  const first = randomElement(RANDOM_FIRST_NAMES);
  const last = randomElement(RANDOM_LAST_NAMES);
  const suffix = crypto.randomBytes(2).toString('hex');
  const username = `${first.toLowerCase()}.${last.toLowerCase()}.${suffix}`;
  const email = `${username}@${randomElement(DOMAINS)}`;
  return {
    username,
    email,
    full_name: `${first} ${last}`,
    oauth_provider: 'script',
    oauth_id: `script-${crypto.randomUUID()}`,
    roles: ['user'],
  };
}

function printTable(rows: Record<string, string | number | boolean | null>[]): void {
  if (rows.length === 0) {
    console.log(c('  (no results)', 'dim'));
    return;
  }

  const keys = Object.keys(rows[0]);
  const widths: Record<string, number> = {};
  for (const key of keys) {
    widths[key] = Math.max(key.length, ...rows.map(r => String(r[key] ?? '').length));
  }

  const header = keys.map(k => k.padEnd(widths[k])).join('  ');
  const separator = keys.map(k => '─'.repeat(widths[k])).join('──');

  console.log(c(`  ${header}`, 'bold'));
  console.log(c(`  ${separator}`, 'dim'));
  for (const row of rows) {
    const line = keys.map(k => String(row[k] ?? '').padEnd(widths[k])).join('  ');
    console.log(`  ${line}`);
  }
}

async function prompt(rl: readline.Interface, question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? c(` [${defaultVal}]`, 'dim') : '';
  const answer = await rl.question(`${c('?', 'green')} ${question}${suffix}: `);
  return answer.trim() || defaultVal || '';
}

// ─── Commands ───────────────────────────────────────────────

async function listUsers(app: FastifyInstance): Promise<void> {
  console.log(c('\n📋 Listing users\n', 'cyan'));

  const result = await app.dbUtils.query(`
    SELECT id, username, email, full_name, 
           array_to_string(roles, ',') as roles, 
           is_active, sync_status, 
           to_char(created_at, 'YYYY-MM-DD HH24:MI') as created_at
    FROM users 
    WHERE id != '00000000-0000-0000-0000-000000000001'
    ORDER BY created_at DESC
  `);

  const rows = result.rows.map((r: Record<string, unknown>) => ({
    username: String(r.username),
    email: String(r.email),
    name: String(r.full_name || ''),
    roles: String(r.roles),
    active: r.is_active ? '✓' : '✗',
    sync: String(r.sync_status),
    created: String(r.created_at),
  }));

  printTable(rows);
  console.log(c(`\n  Total: ${rows.length} user(s)\n`, 'dim'));
}

async function createUserInteractive(app: FastifyInstance): Promise<void> {
  console.log(c('\n🆕 Create a new user\n', 'cyan'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const username = await prompt(rl, 'Username');
    if (!username) {
      console.log(c('  ✗ Username is required', 'red'));
      return;
    }

    const email = await prompt(rl, 'Email');
    if (!email) {
      console.log(c('  ✗ Email is required', 'red'));
      return;
    }

    const fullName = await prompt(rl, 'Full name', '');
    const rolesInput = await prompt(rl, 'Roles (comma-separated)', 'user');
    const roles = rolesInput.split(',').map(r => r.trim()).filter(Boolean);

    await insertUser(app, {
      username,
      email,
      full_name: fullName || null,
      oauth_provider: 'script',
      oauth_id: `script-${crypto.randomUUID()}`,
      roles,
    });
  } finally {
    rl.close();
  }
}

async function addUser(app: FastifyInstance, username: string, email: string): Promise<void> {
  console.log(c(`\n➕ Adding user: ${username}\n`, 'cyan'));

  await insertUser(app, {
    username,
    email,
    full_name: username,
    oauth_provider: 'script',
    oauth_id: `script-${crypto.randomUUID()}`,
    roles: ['user'],
  });
}

async function deleteUser(app: FastifyInstance, username: string): Promise<void> {
  console.log(c(`\n🗑️  Deleting user: ${username}\n`, 'cyan'));

  // Find user
  const findResult = await app.dbUtils.query(
    'SELECT id, username, email FROM users WHERE username = $1',
    [username],
  );

  if (findResult.rows.length === 0) {
    console.log(c(`  ✗ User "${username}" not found`, 'red'));
    return;
  }

  const user = findResult.rows[0] as { id: string; username: string; email: string };

  // Delete related records in order (respecting foreign keys)
  const deletions: { table: string; column: string; label: string }[] = [
    { table: 'audit_logs', column: 'user_id', label: 'audit logs' },
    { table: 'api_key_models', column: 'api_key_id', label: 'API key model links' },
    { table: 'api_keys', column: 'user_id', label: 'API keys' },
    { table: 'subscription_status_history', column: 'subscription_id', label: 'subscription history' },
    { table: 'subscriptions', column: 'user_id', label: 'subscriptions' },
    { table: 'team_members', column: 'user_id', label: 'team memberships' },
    { table: 'notifications', column: 'user_id', label: 'notifications' },
  ];

  for (const { table, column, label } of deletions) {
    try {
      let query: string;
      let params: string[];

      if (table === 'api_key_models') {
        // api_key_models references api_keys, not users directly
        query = `DELETE FROM api_key_models WHERE api_key_id IN (SELECT id FROM api_keys WHERE user_id = $1)`;
        params = [user.id];
      } else if (table === 'subscription_status_history') {
        query = `DELETE FROM subscription_status_history WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id = $1)`;
        params = [user.id];
      } else {
        query = `DELETE FROM ${table} WHERE ${column} = $1`;
        params = [user.id];
      }

      const delResult = await app.dbUtils.query(query, params);
      if (delResult.rowCount && delResult.rowCount > 0) {
        console.log(c(`  ↳ Removed ${delResult.rowCount} ${label}`, 'dim'));
      }
    } catch (err) {
      // Table may not exist or column may differ — skip silently
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('does not exist')) {
        console.log(c(`  ⚠ Warning cleaning ${label}: ${msg}`, 'yellow'));
      }
    }
  }

  // Delete the user
  await app.dbUtils.query('DELETE FROM users WHERE id = $1', [user.id]);
  console.log(c(`  ✓ Deleted user "${user.username}" (${user.email})`, 'green'));

  // Try to delete from LiteLLM (best-effort)
  try {
    if (app.liteLLMService) {
      await (app.liteLLMService as { deleteUser?: (id: string) => Promise<unknown> }).deleteUser?.(user.id);
      console.log(c('  ✓ Removed from LiteLLM', 'green'));
    }
  } catch {
    console.log(c('  ⚠ Could not remove from LiteLLM (may not exist there)', 'yellow'));
  }
}

async function generateRandom(app: FastifyInstance, count: number): Promise<void> {
  console.log(c(`\n🎲 Generating ${count} random user(s)\n`, 'cyan'));

  let created = 0;
  for (let i = 0; i < count; i++) {
    const userData = generateRandomUser();
    try {
      await insertUser(app, userData, false);
      created++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Retry on duplicate (rare collision)
      if (msg.includes('duplicate') || msg.includes('unique')) {
        const retry = generateRandomUser();
        try {
          await insertUser(app, retry, false);
          created++;
        } catch {
          console.log(c(`  ✗ Failed to create user (skip)`, 'yellow'));
        }
      } else {
        console.log(c(`  ✗ Error: ${msg}`, 'red'));
      }
    }
  }

  console.log(c(`\n  ✓ Created ${created}/${count} user(s)\n`, 'green'));
}

// ─── Core insert helper ─────────────────────────────────────

interface UserInsertData {
  username: string;
  email: string;
  full_name: string | null;
  oauth_provider: string;
  oauth_id: string;
  roles: string[];
}

async function insertUser(app: FastifyInstance, data: UserInsertData, verbose = true): Promise<void> {
  // Insert into database
  const result = await app.dbUtils.query(
    `INSERT INTO users (username, email, full_name, oauth_provider, oauth_id, roles, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     RETURNING id, username, email`,
    [
      data.username,
      data.email,
      data.full_name,
      data.oauth_provider,
      data.oauth_id,
      `{${data.roles.join(',')}}`,
    ],
  );

  const user = result.rows[0] as { id: string; username: string; email: string };

  if (verbose) {
    console.log(c(`  ✓ Created user: ${user.username} (${user.email})`, 'green'));
    console.log(c(`    ID: ${user.id}`, 'dim'));
  }

  // Add to default team
  try {
    await app.dbUtils.query(
      `INSERT INTO team_members (team_id, user_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [DEFAULT_TEAM_ID, user.id],
    );
    if (verbose) {
      console.log(c('  ✓ Added to default team', 'green'));
    }
  } catch {
    if (verbose) {
      console.log(c('  ⚠ Could not add to default team (may not exist yet)', 'yellow'));
    }
  }

  // Sync to LiteLLM (best-effort)
  try {
    if (app.liteLLMService) {
      await app.liteLLMService.createUser({
        user_id: user.id,
        user_email: data.email,
        user_alias: data.username,
        user_role: data.roles.includes('admin') ? 'proxy_admin' : 'internal_user',
        teams: [DEFAULT_TEAM_ID],
        auto_create_key: false,
      });
      if (verbose) {
        console.log(c('  ✓ Synced to LiteLLM', 'green'));
      }
    }
  } catch {
    if (verbose) {
      console.log(c('  ⚠ Could not sync to LiteLLM (mock mode or service unavailable)', 'yellow'));
    }
  }
}

// ─── Usage ──────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
${c('LiteMaaS User Management', 'bold')}

${c('Usage:', 'cyan')}
  npm run users -- <command> [options]

${c('Commands:', 'cyan')}
  ${c('list', 'green')}                       List all users
  ${c('create', 'green')}                     Create a new user interactively
  ${c('delete', 'green')} ${c('<username>', 'dim')}          Delete a user by username
  ${c('add', 'green')} ${c('<username> <email>', 'dim')}     Quick add a user with defaults
  ${c('random', 'green')} ${c('[count]', 'dim')}             Generate random test users (default: 1)

${c('Examples:', 'cyan')}
  npm run users -- list
  npm run users -- create
  npm run users -- delete testuser
  npm run users -- add johndoe john@example.com
  npm run users -- random 5
`);
}

// ─── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }

  let app: FastifyInstance | null = null;

  try {
    // Initialize app (connects to DB, loads plugins)
    app = await createApp({ logger: false });
    await app.ready();

    switch (command) {
      case 'list':
      case 'ls':
        await listUsers(app);
        break;

      case 'create':
      case 'new':
        await createUserInteractive(app);
        break;

      case 'delete':
      case 'rm':
      case 'remove': {
        const username = args[1];
        if (!username) {
          console.log(c('\n  ✗ Usage: npm run users -- delete <username>\n', 'red'));
          process.exit(1);
        }
        await deleteUser(app, username);
        break;
      }

      case 'add': {
        const addUsername = args[1];
        const addEmail = args[2];
        if (!addUsername || !addEmail) {
          console.log(c('\n  ✗ Usage: npm run users -- add <username> <email>\n', 'red'));
          process.exit(1);
        }
        await addUser(app, addUsername, addEmail);
        break;
      }

      case 'random':
      case 'generate':
      case 'gen': {
        const count = Math.max(1, parseInt(args[1] || '1', 10));
        if (isNaN(count) || count < 1 || count > 100) {
          console.log(c('\n  ✗ Count must be between 1 and 100\n', 'red'));
          process.exit(1);
        }
        await generateRandom(app, count);
        break;
      }

      default:
        console.log(c(`\n  ✗ Unknown command: "${command}"\n`, 'red'));
        printUsage();
        process.exit(1);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(c(`\n  ✗ Error: ${msg}\n`, 'red'));
    process.exit(1);
  } finally {
    if (app) {
      await app.close();
    }
  }

  process.exit(0);
}

main();
