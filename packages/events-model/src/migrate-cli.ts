import { migrateVault } from "./migration.js";
if (process.argv.length !== 3) throw new Error("Usage: tsx src/migrate-cli.ts /path/to/copied/event");
const result = await migrateVault(process.argv[2]);
process.stdout.write(`Migrated ${result.events.length} sessions; note and asset paths preserved\n`);
