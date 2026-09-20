import type { AppModule } from "../core/types.js";
import { remindersModule } from "./reminders/index.js";
import { messagesModule } from "./messages/index.js";
import { contactsModule } from "./contacts/index.js";

/**
 * The registry. To add an app:
 *   1. create src/modules/<app>/index.ts exporting an AppModule
 *   2. add it to this array
 * Nothing else in the codebase needs to change.
 */
export const modules: AppModule[] = [remindersModule, messagesModule, contactsModule];
