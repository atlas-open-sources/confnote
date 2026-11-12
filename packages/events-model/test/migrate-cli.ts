import { readFileSync } from "node:fs";
import { migrateAgenda } from "../src/migration.js";
process.stdout.write(JSON.stringify(migrateAgenda(JSON.parse(readFileSync(process.argv[2],"utf8")))));
