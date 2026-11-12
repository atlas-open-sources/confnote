// Bryntum island entry: exposes the classes the module uses on one global.
// The licence key (if any) is set on globalThis.bryntum before this loads.

// "@bryntum/calendar" is the public trial package (npm alias in package.json);
// a licensed build swaps only the alias.
import { Calendar, DateHelper, Scheduler, StringHelper } from "@bryntum/calendar";

window.__confnoteBryntum = { Scheduler, Calendar, DateHelper, StringHelper };
