// The rules of the Postgres browser, with no app imports, so `node --test` can run them.

const DEFAULT_PORT = 5432;
const TIMEOUT_MS = 10000;
const ROW_LIMIT = 50;
const CELL_LIMIT = 500;
const MIN_WIDTH = 80;
const MAX_WIDTH = 360;

export const DEFAULT_SERVER = `localhost:${DEFAULT_PORT}`;
export const SERVER_KEY = "pg.server";
export const SERVER_HELP = "Use user@host:port, for example app@localhost:5432.";
export const NULL_MARK = "<<NULL>>";

const SERVER_PATTERN = /^(?:([^@\s]+)@)?([^:@\s]+)(?::(\d+))?$/;

// The text is user@host:port. The user and the port are optional. Without a user, psql picks the user.
export function parseServer(text) {
  const match = String(text ?? "").trim().match(SERVER_PATTERN);
  if (!match) return null;
  const [, user = null, host, port = DEFAULT_PORT] = match;
  const number = Number(port);
  return number >= 1 && number <= 65535 ? { host, port: number, user } : null;
}

export const serverText = (stored) => (parseServer(stored) ? String(stored).trim() : DEFAULT_SERVER);

// The command for a click on a database in the panel: go to its browser tab in the shown space, or make one.
export function openCommand(spaces, database) {
  const name = `pg: ${database}`;
  const tab = spaces.find((space) => space.active)?.tabs.find((t) => t.name === name);
  return tab ? ["tab.select", { id: tab.id }] : ["tab.new", { mod: "pg", name, props: { database } }];
}

export const quoteLiteral = (text) => `'${text.replace(/'/g, "''")}'`;
export const quoteIdent = (name) => `"${name.replace(/"/g, '""')}"`;

const conninfoValue = (text) => `'${text.replace(/[\\']/g, "\\$&")}'`;

export function conninfo({ host, port, user }, database) {
  const userField = user ? `user=${conninfoValue(user)} ` : "";
  return `host=${conninfoValue(host)} port=${conninfoValue(String(port))} ${userField}dbname=${conninfoValue(database)} `
    + `connect_timeout=5 application_name=herdr-pg `
    + `options='-c default_transaction_read_only=on -c statement_timeout=${TIMEOUT_MS}'`;
}

export function psqlArgs(server, database, sql) {
  return ["-X", "-w", "--csv", "-P", `null=${NULL_MARK}`, "-d", conninfo(server, database), "-c", sql];
}

export function parseCsv(text) {
  const lines = [];
  let line = [];
  let field = "";
  let quoted = false;
  let pending = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') { quoted = true; pending = true; }
    else if (c === ",") { line.push(field); field = ""; pending = true; }
    else if (c === "\n") { line.push(field); lines.push(line); line = []; field = ""; pending = false; }
    else { field += c; pending = true; }
  }
  if (pending) { line.push(field); lines.push(line); }
  return lines;
}

export function parseRows(text) {
  const [header = [], ...rows] = parseCsv(text);
  return { header, rows: rows.map((row) => row.map((value) => (value === NULL_MARK ? null : value))) };
}

export const LIST_DATABASES_SQL = "select datname from pg_database where datallowconn and not datistemplate order by datname";

export const parseDatabases = (text) => parseRows(text).rows.map(([name]) => name);

export const LIST_TABLES_SQL = `select n.nspname as schema, c.relname as name, c.relkind as kind
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'v', 'm', 'f')
  and n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname not like 'pg_toast%' and n.nspname not like 'pg_temp%'
order by 1, 2`;

export const parseTables = (text) => parseRows(text).rows.map(([schema, name, kind]) => ({ schema, name, kind }));

const KIND_LABELS = { v: "view", m: "matview", f: "foreign" };
export const kindLabel = (kind) => KIND_LABELS[kind] ?? "";

export function filterTables(tables, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tables.filter((t) => {
    const text = `${t.schema}.${t.name}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function groupBySchema(tables) {
  const groups = new Map();
  for (const table of tables) {
    if (!groups.has(table.schema)) groups.set(table.schema, []);
    groups.get(table.schema).push(table);
  }
  return [...groups].map(([schema, list]) => ({ schema, tables: list }));
}

// The sidebar as flat rows of one height, so the view can draw only the rows on screen.
export function listRows(databases, open, filter) {
  const filtering = filter.trim() !== "";
  const rows = [];
  for (const name of databases) {
    const state = open[name];
    const expanded = Boolean(state?.expanded);
    if (!expanded) {
      rows.push({ kind: "database", key: `d/${name}`, name, expanded, count: null });
      continue;
    }
    const firstLoad = state.loading && state.tables.length === 0;
    const tables = filterTables(state.tables, filter);
    rows.push({ kind: "database", key: `d/${name}`, name, expanded, count: firstLoad ? null : tables.length });
    if (firstLoad) rows.push({ kind: "note", key: `n/${name}`, text: "Loading tables…", tone: "dim" });
    if (state.error) rows.push({ kind: "note", key: `e/${name}`, text: state.error, tone: "error" });
    const groups = groupBySchema(tables);
    for (const group of groups) {
      const schemaOpen = filtering || (state.schemas[group.schema] ?? groups.length === 1);
      rows.push({ kind: "schema", key: `s/${name}/${group.schema}`, database: name, schema: group.schema, expanded: schemaOpen, count: group.tables.length });
      if (!schemaOpen) continue;
      for (const table of group.tables) {
        rows.push({ kind: "table", key: `t/${name}/${group.schema}/${table.name}`, database: name, table });
      }
    }
  }
  return rows;
}

export function columnsSql(schema, table) {
  const name = quoteLiteral(`${quoteIdent(schema)}.${quoteIdent(table)}`);
  return `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
  case when a.attnotnull then 'no' else 'yes' end as nullable,
  pg_get_expr(d.adbin, d.adrelid) as "default",
  array_position(i.indkey::int2[], a.attnum) as pk
from pg_attribute a
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
left join pg_index i on i.indrelid = a.attrelid and i.indisprimary
where a.attrelid = to_regclass(${name}) and a.attnum > 0 and not a.attisdropped
order by a.attnum`;
}

export function parseColumns(text) {
  return parseRows(text).rows.map(([name, type, nullable, def, pk]) => ({
    name,
    type,
    nullable: nullable === "yes",
    default: def,
    pk: pk === null ? null : Number(pk),
  }));
}

export function rowsSql({ schema, table, columns, search }) {
  const select = columns.map((c) => `left(t.${quoteIdent(c.name)}::text, ${CELL_LIMIT}) as ${quoteIdent(c.name)}`).join(", ");
  const parts = [`select ${select} from ${quoteIdent(schema)}.${quoteIdent(table)} as t`];
  const term = search.trim();
  if (term) {
    const pattern = quoteLiteral(`%${term.replace(/[\\%_]/g, "\\$&")}%`);
    parts.push(`where ${columns.map((c) => `t.${quoteIdent(c.name)}::text ilike ${pattern}`).join(" or ")}`);
  }
  const key = columns.filter((c) => c.pk !== null).sort((a, b) => a.pk - b.pk);
  if (key.length > 0) parts.push(`order by ${key.map((c) => `t.${quoteIdent(c.name)}`).join(", ")}`);
  parts.push(`limit ${ROW_LIMIT}`);
  return parts.join(" ");
}

export function rowsLabel(count, search) {
  const [one, many] = search.trim() ? ["match", "matches"] : ["row", "rows"];
  if (count === 0) return `no ${many}`;
  if (count === 1) return `1 ${one}`;
  return count >= ROW_LIMIT ? `first ${ROW_LIMIT} ${many}` : `${count} ${many}`;
}

export function errorMessage(stderr) {
  if (stderr.includes("statement timeout")) return `The query stopped after ${TIMEOUT_MS / 1000} seconds.`;
  if (stderr.includes("no password supplied")) return "The server needs a password. Add it to ~/.pgpass.";
  const first = stderr.split("\n")[0].trim().replace(/^(psql: error: |ERROR:\s+|FATAL:\s+)/, "");
  return first || "psql failed with no message.";
}

export const cellText = (value) => (value === null ? null : value.replace(/[\r\n\t]+/g, " "));

export function columnWidths(header, rows) {
  return header.map((name, i) => {
    const longest = rows.reduce((max, row) => Math.max(max, row[i]?.length ?? 0), name.length);
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, longest * 7 + 20));
  });
}
