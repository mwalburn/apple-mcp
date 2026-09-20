import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAttributedBodyForTest } from "../src/modules/messages/decode.js";
import { isoToAppleNs } from "../src/modules/messages/db.js";
import type { ModuleContext } from "../src/core/types.js";

/**
 * Builds a chat.db with the subset of Apple's schema the module reads.
 * `filler` appends that many extra attributedBody-only rows to chat 2 (ids from 1000),
 * all newer than the base rows. SQL cannot prefilter them, so they must be decoded
 * in Node — for tests that need to exhaust a scan limit.
 */
export function makeChatDb(opts: { filler?: number } = {}): string {
  const path = join(mkdtempSync(join(tmpdir(), "applemcp-")), "chat.db");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, display_name TEXT, service_name TEXT, style INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER,
      date INTEGER, is_from_me INTEGER, service TEXT, cache_has_attachments INTEGER DEFAULT 0, associated_message_type INTEGER DEFAULT 0);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    INSERT INTO handle VALUES (1,'+16515550100'),(2,'pat@example.com'),(3,'+16125550199');
    INSERT INTO chat VALUES (1,'g1','+16515550100',NULL,'iMessage',45),(2,'g2','chat999','Trip planning','iMessage',43);
    INSERT INTO chat_handle_join VALUES (1,1),(2,2),(2,3);
  `);
  const ins = db.prepare("INSERT INTO message (ROWID,guid,text,attributedBody,handle_id,date,is_from_me,service,cache_has_attachments,associated_message_type) VALUES (?,?,?,?,?,?,?,?,?,?)");
  const join_ = db.prepare("INSERT INTO chat_message_join VALUES (?,?)");
  const now = Date.now();
  const at = (minAgo: number) => isoToAppleNs(new Date(now - minAgo * 60_000).toISOString());
  const long = "x".repeat(300) + " needle-in-long-body";
  const rows: [number, number, string | null, Buffer | null, number, number, number, number, number][] = [
    // id, chat, text, blob, handle, minutesAgo, fromMe, attach, amt
    [1, 1, "Plain text column works", null, 1, 300, 0, 0, 0],
    [2, 1, null, encodeAttributedBodyForTest("Body only in attributedBody"), 1, 200, 0, 0, 0],
    [3, 1, null, encodeAttributedBodyForTest("Reply from me — with unicode ✓", false), 0, 190, 1, 0, 0],
    [4, 1, null, encodeAttributedBodyForTest('Loved "Reply from me"'), 1, 180, 0, 0, 2000],
    [5, 2, null, encodeAttributedBodyForTest(long), 2, 100, 0, 1, 0],
    [6, 2, "100% sure_thing", null, 3, 50, 0, 0, 0],
    [7, 2, "Old message", null, 3, 60 * 24 * 400, 0, 0, 0],
  ];
  ins.run(9, "m9", "Username: walburns\npassword: hunter2!x", null, 0, at(40), 1, "iMessage", 0, 0); join_.run(1, 9);
  ins.run(10, "m10", null, encodeAttributedBodyForTest("Your Chase verification code is 482913. Do not share it."), 3, at(30), 0, "SMS", 0, 0); join_.run(2, 10);
  // Legacy row: pre-High Sierra databases stored whole seconds, not nanoseconds.
  ins.run(8, "m8", "Legacy seconds row", null, 1, 500_000_000, 0, "SMS", 0, 0);
  join_.run(1, 8);
  for (const [id, chat, text, blob, handle, minAgo, fromMe, attach, amt] of rows) {
    ins.run(id, `m${id}`, text, blob, handle, at(minAgo), fromMe, "iMessage", attach, amt);
    join_.run(chat, id);
  }
  for (let i = 0; i < (opts.filler ?? 0); i++) {
    const id = 1000 + i;
    ins.run(id, `m${id}`, null, encodeAttributedBodyForTest(`filler ${i}`), 3, at(20) + BigInt(i), 0, "iMessage", 0, 0);
    join_.run(2, id);
  }
  db.close();
  return path;
}

export function fakeCtx(over: Partial<ModuleContext> = {}): ModuleContext {
  return { jxa: async () => { throw new Error("jxa not faked"); }, env: {}, homeDir: "/nonexistent", services: {}, ...over };
}

/** AddressBook layout: one top-level store plus one per account under Sources/. Handles line up with makeChatDb(). */
export function makeContactsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "applemcp-ab-"));
  const schema = `
    CREATE TABLE ZABCDRECORD (Z_PK INTEGER PRIMARY KEY, ZFIRSTNAME TEXT, ZLASTNAME TEXT, ZNICKNAME TEXT, ZORGANIZATION TEXT);
    CREATE TABLE ZABCDPHONENUMBER (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZFULLNUMBER TEXT, ZLABEL TEXT);
    CREATE TABLE ZABCDEMAILADDRESS (Z_PK INTEGER PRIMARY KEY, ZOWNER INTEGER, ZADDRESS TEXT, ZLABEL TEXT);`;
  const mk = (path: string, sql: string) => { const db = new DatabaseSync(path); db.exec(schema + sql); db.close(); };
  mkdirSync(join(dir, "Sources", "ICLOUD-UUID"), { recursive: true });
  mk(join(dir, "AddressBook-v22.abcddb"), ""); // on-device store is typically empty
  mk(join(dir, "Sources", "ICLOUD-UUID", "AddressBook-v22.abcddb"), `
    INSERT INTO ZABCDRECORD VALUES (1,'Alex','Rivera',NULL,NULL),(2,'Pat','Rivera','Patty',NULL),
      (3,NULL,NULL,NULL,'Acme Plumbing'),(4,NULL,NULL,NULL,NULL),(5,'Alex','Chen',NULL,NULL);
    INSERT INTO ZABCDPHONENUMBER VALUES (1,1,'(651) 555-0100','_$!<Mobile>!$_'),(2,3,'+1 612-555-0199','_$!<Work>!$_'),
      (3,4,'555-000-0000',NULL),(4,5,'+1 (415) 555-0142','iPhone');
    INSERT INTO ZABCDEMAILADDRESS VALUES (1,2,'Pat@Example.com','_$!<Home>!$_'),(2,1,'alex@example.com',NULL);`);
  // Same person in a second account, with one extra number: must merge, not duplicate.
  mkdirSync(join(dir, "Sources", "GOOGLE-UUID"), { recursive: true });
  mk(join(dir, "Sources", "GOOGLE-UUID", "AddressBook-v22.abcddb"), `
    INSERT INTO ZABCDRECORD VALUES (1,'Alex','Rivera',NULL,NULL),(2,'Dad💖',NULL,NULL,NULL),(3,NULL,NULL,NULL,'Alexandria Dental'),(4,'Pat','Oldfriend',NULL,NULL);
    INSERT INTO ZABCDPHONENUMBER VALUES (1,1,'+16515550100','_$!<Mobile>!$_'),(2,1,'651-555-0177','_$!<Home>!$_'),
      (3,2,'6515550100',NULL),(4,3,'612-555-0111',NULL),(5,4,'763-555-0123',NULL);`);
  return dir;
}

/** Reminders stores: one per account. Exercises every id encoding the real schema might use. */
export function makeRemindersStoreDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "applemcp-rem-"));
  const hexToBlob = (h: string) => Buffer.from(h.replace(/-/g, ""), "hex");
  const mk = (file: string, ddl: string, fill: (db: DatabaseSync) => void) => { const db = new DatabaseSync(join(dir, file)); db.exec(ddl); fill(db); db.close(); };
  const full = `CREATE TABLE ZREMCDREMINDER (Z_PK INTEGER PRIMARY KEY, ZCKIDENTIFIER TEXT, ZIDENTIFIER BLOB, ZDACALENDARITEMUNIQUEIDENTIFIER TEXT, ZISURGENTSTATEENABLEDFORCURRENTUSER INTEGER, ZFLAGGED INTEGER);`;
  mk("Data-AAAA.sqlite", full, (db) => {
    const ins = db.prepare("INSERT INTO ZREMCDREMINDER (ZCKIDENTIFIER, ZIDENTIFIER, ZDACALENDARITEMUNIQUEIDENTIFIER, ZISURGENTSTATEENABLEDFORCURRENTUSER) VALUES (?,?,?,?)");
    ins.run("11111111-1111-4111-8111-111111111111", null, null, 1);                                   // urgent, text id
    ins.run(null, hexToBlob("22222222-2222-4222-8222-222222222222"), null, 1);                        // urgent, blob id only
    ins.run(null, null, "33333333-3333-4333-8333-333333333333", 0);                                   // not urgent, DA id only
    ins.run("44444444-4444-4444-8444-444444444444", null, null, null);                                // NULL flag = not urgent
    ins.run("55555555-5555-4555-8555-555555555555", null, null, 0);                                   // not urgent here...
  });
  mk("Data-BBBB.sqlite", full, (db) => {
    db.prepare("INSERT INTO ZREMCDREMINDER (ZCKIDENTIFIER, ZISURGENTSTATEENABLEDFORCURRENTUSER) VALUES (?,?)").run("55555555-5555-4555-8555-555555555555", 1); // ...urgent in another store
  });
  // An older store without the column, and a junk file: both must be skipped, not fatal.
  mk("Data-local.sqlite", `CREATE TABLE ZREMCDREMINDER (Z_PK INTEGER PRIMARY KEY, ZCKIDENTIFIER TEXT);`, () => {});
  writeFileSync(join(dir, "Data-corrupt.sqlite"), "not a database");
  return dir;
}
