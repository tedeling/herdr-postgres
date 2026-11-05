// Run with: node --test ~/.config/herdr-app/mods/pg/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SERVER,
  LIST_TABLES_SQL,
  NULL_MARK,
  cellText,
  columnWidths,
  columnsSql,
  conninfo,
  errorMessage,
  filterTables,
  groupBySchema,
  kindLabel,
  listRows,
  openCommand,
  parseColumns,
  parseCsv,
  parseRows,
  parseServer,
  parseTables,
  psqlArgs,
  quoteIdent,
  quoteLiteral,
  rowsLabel,
  rowsSql,
  serverText,
} from "./logic.js";

const shownSpace = (...tabs) => ({ active: true, tabs });
const otherSpace = (...tabs) => ({ active: false, tabs });
const tab = (id, name) => ({ id, name });

test("open: a database with no tab gets a new browser tab", () => {
  assert.deepEqual(openCommand([shownSpace(tab("t1", "1"))], "shop"), [
    "tab.new",
    { mod: "pg", name: "pg: shop", props: { database: "shop" } },
  ]);
});

test("open: a database with a tab in the shown space selects that tab", () => {
  const spaces = [shownSpace(tab("t1", "1"), tab("t2", "pg: shop"))];
  assert.deepEqual(openCommand(spaces, "shop"), ["tab.select", { id: "t2" }]);
});

test("open: a tab in another space does not count", () => {
  const spaces = [otherSpace(tab("t9", "pg: shop")), shownSpace(tab("t1", "1"))];
  assert.equal(openCommand(spaces, "shop")[0], "tab.new");
});

test("open: the tab of a longer database name does not count", () => {
  const spaces = [shownSpace(tab("t2", "pg: shop_eu"))];
  assert.equal(openCommand(spaces, "shop")[0], "tab.new");
});

test("open: with no shown space, the command is a new tab", () => {
  assert.equal(openCommand([], "shop")[0], "tab.new");
});

test("quote: a literal doubles its single quotes", () => {
  assert.equal(quoteLiteral("it's"), "'it''s'");
});

test("quote: an identifier doubles its double quotes", () => {
  assert.equal(quoteIdent('a"b'), '"a""b"');
});

const SERVER = { host: "db.example.com", port: 6543, user: "app" };

test("server: reads the user, the host and the port", () => {
  assert.deepEqual(parseServer("app@db.example.com:6543"), SERVER);
});

test("server: with no user, the user is null so that psql picks it", () => {
  assert.deepEqual(parseServer("localhost:5432"), { host: "localhost", port: 5432, user: null });
});

test("server: with no port, the port is 5432", () => {
  assert.equal(parseServer("localhost").port, 5432);
});

test("server: a socket folder can be the host", () => {
  assert.equal(parseServer("/var/run/postgresql").host, "/var/run/postgresql");
});

test("server: ignores spaces around the text", () => {
  assert.equal(parseServer("  localhost:5432 ").host, "localhost");
});

for (const bad of ["", "   ", "a b", "host:abc", "host:70000", "host:0", "@host", "a@b@c", ":5432", undefined]) {
  test(`server: refuses ${JSON.stringify(bad)}`, () => {
    assert.equal(parseServer(bad), null);
  });
}

test("server: the default is the standard local port", () => {
  assert.equal(DEFAULT_SERVER, "localhost:5432");
});

test("server: with nothing stored, the text is the default", () => {
  assert.equal(serverText(undefined), DEFAULT_SERVER);
});

test("server: with a bad value stored, the text is the default", () => {
  assert.equal(serverText("bad host"), DEFAULT_SERVER);
});

test("server: with a good value stored, the text is that value", () => {
  assert.equal(serverText("app@db:1"), "app@db:1");
});

test("conninfo: connects with the host, the port, the user and the database", () => {
  assert.match(conninfo(SERVER, "shop"), /^host='db\.example\.com' port='6543' user='app' dbname='shop' /);
});

test("conninfo: with no user, the text has no user field", () => {
  assert.doesNotMatch(conninfo({ ...SERVER, user: null }, "shop"), /user=/);
});

test("conninfo: a quote in the user stays inside its value", () => {
  assert.match(conninfo({ ...SERVER, user: "a'b" }, "shop"), /user='a\\'b' /);
});

test("conninfo: every session is read-only", () => {
  assert.match(conninfo(SERVER, "shop"), /-c default_transaction_read_only=on/);
});

test("conninfo: every statement stops after 10 seconds", () => {
  assert.match(conninfo(SERVER, "shop"), /-c statement_timeout=10000/);
});

test("conninfo: escapes a quote and a backslash in the database name", () => {
  assert.match(conninfo(SERVER, "a'b\\c"), /dbname='a\\'b\\\\c' /);
});

test("psql args: never prompt, skip psqlrc, use CSV and mark NULL", () => {
  const args = psqlArgs(SERVER, "shop", "select 1");
  assert.ok(args.includes("-d"));
  assert.match(args[args.indexOf("-d") + 1], /^host='db\.example\.com' /);
  assert.ok(args.includes("-w"));
  assert.ok(args.includes("-X"));
  assert.ok(args.includes("--csv"));
  assert.ok(args.includes(`null=${NULL_MARK}`));
  assert.deepEqual(args.slice(-2), ["-c", "select 1"]);
});

test("csv: reads plain fields", () => {
  assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
});

test("csv: reads an empty field", () => {
  assert.deepEqual(parseCsv("a,b\n,2\n"), [["a", "b"], ["", "2"]]);
});

test("csv: reads a comma, a doubled quote and a newline inside quotes", () => {
  assert.deepEqual(parseCsv('a\n"x,""y""\nz"\n'), [["a"], ['x,"y"\nz']]);
});

test("csv: reads text with no final newline", () => {
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]);
});

test("csv: reads an empty result as no lines", () => {
  assert.deepEqual(parseCsv(""), []);
});

test("rows: splits the header from the rows and maps the mark to null", () => {
  const { header, rows } = parseRows(`id,name\n1,${NULL_MARK}\n2,\n`);
  assert.deepEqual(header, ["id", "name"]);
  assert.deepEqual(rows, [["1", null], ["2", ""]]);
});

test("rows: a result with a header only has no rows", () => {
  assert.deepEqual(parseRows("id,name\n").rows, []);
});

test("tables: the list skips system schemas", () => {
  assert.match(LIST_TABLES_SQL, /not in \('pg_catalog', 'information_schema'\)/);
  assert.match(LIST_TABLES_SQL, /not like 'pg_toast%'/);
  assert.match(LIST_TABLES_SQL, /not like 'pg_temp%'/);
});

test("tables: the list includes tables and views", () => {
  assert.match(LIST_TABLES_SQL, /relkind in \('r', 'p', 'v', 'm', 'f'\)/);
});

test("tables: parses schema, name and kind", () => {
  assert.deepEqual(parseTables("schema,name,kind\npublic,users,r\n"), [{ schema: "public", name: "users", kind: "r" }]);
});

test("kind label: a table has no label and other kinds have one", () => {
  assert.equal(kindLabel("r"), "");
  assert.equal(kindLabel("p"), "");
  assert.equal(kindLabel("v"), "view");
  assert.equal(kindLabel("m"), "matview");
  assert.equal(kindLabel("f"), "foreign");
});

const TABLES = [
  { schema: "public", name: "users", kind: "r" },
  { schema: "public", name: "user_roles", kind: "r" },
  { schema: "billing", name: "invoices", kind: "r" },
];

test("filter: an empty query keeps all tables", () => {
  assert.equal(filterTables(TABLES, "  ").length, 3);
});

test("filter: matches a table name with no case sensitivity", () => {
  assert.deepEqual(filterTables(TABLES, "INVOICE").map((t) => t.name), ["invoices"]);
});

test("filter: matches the schema name", () => {
  assert.deepEqual(filterTables(TABLES, "billing").map((t) => t.name), ["invoices"]);
});

test("filter: all words must match", () => {
  assert.deepEqual(filterTables(TABLES, "public role").map((t) => t.name), ["user_roles"]);
});

test("schema groups: keep the order of the list", () => {
  const groups = groupBySchema([TABLES[2], TABLES[0], TABLES[1]]);
  assert.deepEqual(groups.map((g) => [g.schema, g.tables.length]), [["billing", 1], ["public", 2]]);
});

// LIST_TABLES_SQL sorts by schema, so the tables here have the same order.
const SORTED_TABLES = [TABLES[2], TABLES[0], TABLES[1]];
const opened = (overrides = {}) => ({ expanded: true, loading: false, error: null, schemas: {}, tables: SORTED_TABLES, ...overrides });
const shape = (rows) => rows.map((r) => (r.kind === "table" ? `table:${r.table.name}` : r.kind === "schema" ? `schema:${r.schema}:${r.count}:${r.expanded}` : r.kind === "database" ? `database:${r.name}:${r.count}:${r.expanded}` : `note:${r.tone}:${r.text}`));

test("list: a database that is not open shows only its own row", () => {
  assert.deepEqual(shape(listRows(["a", "b"], {}, "")), ["database:a:null:false", "database:b:null:false"]);
});

test("list: a folded database hides its tables", () => {
  assert.deepEqual(shape(listRows(["a"], { a: opened({ expanded: false }) }, "")), ["database:a:null:false"]);
});

test("list: a first load shows a loading note", () => {
  const rows = listRows(["a"], { a: opened({ loading: true, tables: [] }) }, "");
  assert.deepEqual(shape(rows), ["database:a:null:true", "note:dim:Loading tables…"]);
});

test("list: a refresh keeps the tables on screen", () => {
  const rows = listRows(["a"], { a: opened({ loading: true, schemas: { public: true } }) }, "");
  assert.ok(shape(rows).includes("table:users"));
  assert.ok(!shape(rows).includes("note:dim:Loading tables…"));
});

test("list: an error shows as a note", () => {
  const rows = listRows(["a"], { a: opened({ tables: [], error: "no access" }) }, "");
  assert.deepEqual(shape(rows), ["database:a:0:true", "note:error:no access"]);
});

test("list: with many schemas, all schemas start closed", () => {
  assert.deepEqual(shape(listRows(["a"], { a: opened() }, "")), ["database:a:3:true", "schema:billing:1:false", "schema:public:2:false"]);
});

test("list: an open schema shows its tables", () => {
  const rows = listRows(["a"], { a: opened({ schemas: { public: true } }) }, "");
  assert.deepEqual(shape(rows), ["database:a:3:true", "schema:billing:1:false", "schema:public:2:true", "table:users", "table:user_roles"]);
});

test("list: a database with one schema starts open", () => {
  const rows = listRows(["a"], { a: opened({ tables: [TABLES[0]] }) }, "");
  assert.deepEqual(shape(rows), ["database:a:1:true", "schema:public:1:true", "table:users"]);
});

test("list: a person can close the only schema", () => {
  const rows = listRows(["a"], { a: opened({ tables: [TABLES[0]], schemas: { public: false } }) }, "");
  assert.deepEqual(shape(rows), ["database:a:1:true", "schema:public:1:false"]);
});

test("list: a filter opens all schemas and drops those with no match", () => {
  const rows = listRows(["a"], { a: opened() }, "invoice");
  assert.deepEqual(shape(rows), ["database:a:1:true", "schema:billing:1:true", "table:invoices"]);
});

test("list: a filter opens every schema that has a match", () => {
  const tables = [{ schema: "billing", name: "user_invoices", kind: "r" }, { schema: "public", name: "users", kind: "r" }];
  const rows = listRows(["a"], { a: opened({ tables }) }, "user");
  assert.deepEqual(shape(rows), ["database:a:2:true", "schema:billing:1:true", "table:user_invoices", "schema:public:1:true", "table:users"]);
});

test("list: a filter with no match keeps the database row", () => {
  assert.deepEqual(shape(listRows(["a"], { a: opened() }, "nothing")), ["database:a:0:true"]);
});

test("list: each row has a unique key", () => {
  const rows = listRows(["a", "b"], { a: opened({ schemas: { public: true } }), b: opened({ schemas: { public: true } }) }, "");
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
});

test("list: a table row knows its database", () => {
  const rows = listRows(["a"], { a: opened({ tables: [TABLES[0]] }) }, "");
  assert.equal(rows.at(-1).database, "a");
});

test("columns: the query reads the table by its quoted name", () => {
  assert.match(columnsSql("pub'lic", 'us"er'), /to_regclass\('"pub''lic"\."us""er"'\)/);
});

test("columns: parses the fields, with a null default and no key", () => {
  const columns = parseColumns(`name,type,nullable,default,pk\nnote,text,yes,${NULL_MARK},${NULL_MARK}\n`);
  assert.deepEqual(columns, [{ name: "note", type: "text", nullable: true, default: null, pk: null }]);
});

test("columns: parses a key position and a not-null column", () => {
  const columns = parseColumns(`name,type,nullable,default,pk\nid,integer,no,nextval('s'),0\n`);
  assert.deepEqual(columns, [{ name: "id", type: "integer", nullable: false, default: "nextval('s')", pk: 0 }]);
});

const COLUMNS = [
  { name: "tenant", pk: 1 },
  { name: "id", pk: 0 },
  { name: "note", pk: null },
];
const rows = (search = "") => rowsSql({ schema: "public", table: "users", columns: COLUMNS, search });

test("rows sql: reads the quoted table and stops at 50 rows", () => {
  assert.match(rows(), /from "public"\."users" as t/);
  assert.match(rows(), /limit 50$/);
});

test("rows sql: cuts each value to 500 characters and keeps the column name", () => {
  assert.match(rows(), /left\(t\."note"::text, 500\) as "note"/);
});

test("rows sql: sorts by the real primary key columns in key order", () => {
  assert.match(rows(), /order by t\."id", t\."tenant" limit/);
});

test("rows sql: has no order when the table has no primary key", () => {
  const sql = rowsSql({ schema: "public", table: "log", columns: [{ name: "note", pk: null }], search: "" });
  assert.doesNotMatch(sql, /order by/);
});

test("rows sql: has no search condition with an empty search", () => {
  assert.doesNotMatch(rows(), /where/);
  assert.doesNotMatch(rows("   "), /where/);
});

test("rows sql: a search looks in every column with no case sensitivity", () => {
  const sql = rows("anna");
  assert.match(sql, /where t\."tenant"::text ilike '%anna%' or t\."id"::text ilike '%anna%' or t\."note"::text ilike '%anna%'/);
});

test("rows sql: a search escapes the like wildcards", () => {
  assert.match(rows("5%_a\\b"), /ilike '%5\\%\\_a\\\\b%'/);
});

test("rows sql: a search escapes a single quote", () => {
  assert.match(rows("o'brien"), /ilike '%o''brien%'/);
});

test("rows sql: a search trims outer spaces", () => {
  assert.match(rows("  anna  "), /ilike '%anna%'/);
});

test("rows label: counts rows", () => {
  assert.equal(rowsLabel(0, ""), "no rows");
  assert.equal(rowsLabel(1, ""), "1 row");
  assert.equal(rowsLabel(49, ""), "49 rows");
});

test("rows label: says first 50 at the limit", () => {
  assert.equal(rowsLabel(50, ""), "first 50 rows");
});

test("rows label: counts matches during a search", () => {
  assert.equal(rowsLabel(0, "x"), "no matches");
  assert.equal(rowsLabel(1, "x"), "1 match");
  assert.equal(rowsLabel(50, "x"), "first 50 matches");
});

test("error: a timeout gets a clear message", () => {
  assert.equal(errorMessage("ERROR:  canceling statement due to statement timeout\n"), "The query stopped after 10 seconds.");
});

test("error: removes the prefix and keeps the first line", () => {
  assert.equal(errorMessage('ERROR:  relation "x" does not exist\nLINE 1: select\n'), 'relation "x" does not exist');
  assert.equal(errorMessage("psql: error: connection refused\n\tmore\n"), "connection refused");
});

test("error: has a text when psql gives none", () => {
  assert.equal(errorMessage(""), "psql failed with no message.");
});

test("error: a missing password points to the password file", () => {
  const stderr = 'psql: error: connection to server at "localhost" (127.0.0.1), port 5432 failed: fe_sendauth: no password supplied\n';
  assert.equal(errorMessage(stderr), "The server needs a password. Add it to ~/.pgpass.");
});

test("cell: keeps null", () => {
  assert.equal(cellText(null), null);
});

test("cell: puts multi-line text on one line", () => {
  assert.equal(cellText("a\nb\r\n\tc"), "a b c");
});

test("widths: fit the longest value inside the limits", () => {
  const widths = columnWidths(["id", "name", "body"], [["1", "Anna Maria", "x".repeat(400)], ["2", null, ""]]);
  assert.equal(widths[0], 80);
  assert.equal(widths[1], 10 * 7 + 20);
  assert.equal(widths[2], 360);
});

test("widths: use the header when it is longer than the values", () => {
  assert.equal(columnWidths(["a_long_column_name"], [["1"]])[0], 18 * 7 + 20);
});
