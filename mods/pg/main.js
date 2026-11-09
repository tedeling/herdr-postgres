import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, notify, props, setShared, settings, shared, theme } from "herdr";
import { Panel } from "./panel.js";
import {
  LIST_DATABASES_SQL,
  LIST_TABLES_SQL,
  SERVER_HELP,
  SERVER_KEY,
  cellText,
  columnWidths,
  columnsSql,
  errorMessage,
  kindLabel,
  listRows,
  parseColumns,
  parseDatabases,
  parseRows,
  parseServer,
  parseTables,
  psqlArgs,
  rowsLabel,
  rowsSql,
  serverText,
} from "./logic.js";

const ADMIN_DATABASE = "postgres";
const LIST_ROW_HEIGHT = 24;

const currentServer = () => serverText(shared(SERVER_KEY));

async function runPsql(database, sql) {
  const result = await exec("psql", psqlArgs(parseServer(currentServer()), database, sql)).catch(() => {
    throw new Error("Could not start psql. Install the PostgreSQL client.");
  });
  if (result.code !== 0) throw new Error(errorMessage(result.stderr));
  return result.stdout;
}

const listDatabases = async () => parseDatabases(await runPsql(ADMIN_DATABASE, LIST_DATABASES_SQL));

const messageOf = (e) => String(e?.message ?? e);

export default class Pg extends View {
  init(_props, cx) {
    this.server = currentServer();
    // The app refuses an import from another mod folder, so the sidebar panel is a second view of this mod.
    if (props()?.view === "panel") {
      this.panel = new Panel(listDatabases, cx);
      return;
    }
    this.handle = cx.focus_handle();
    // A newer load makes the answer of an older load worthless.
    this.databaseLoad = 0;
    this.tableLoad = 0;
    this.rowLoad = 0;

    this.serverError = null;
    this.typingServer = false;
    this.serverInput = InputState.new({ placeholder: "user@host:port", value: this.server });
    this.serverInput.on("submit", (_e, cx) => this.saveServer(cx));
    this.serverInput.on("focus", (_e, cx) => { this.typingServer = true; cx.notify(); });
    this.serverInput.on("blur", (_e, cx) => { this.typingServer = false; cx.notify(); });

    this.tableFilter = "";
    this.typingFilter = false;
    this.filterInput = InputState.new({ placeholder: "Filter tables" });
    this.filterInput.on("change", (_e, cx) => { this.tableFilter = this.filterInput.value(); cx.notify(); });
    this.filterInput.on("focus", (_e, cx) => { this.typingFilter = true; cx.notify(); });
    this.filterInput.on("blur", (_e, cx) => { this.typingFilter = false; cx.notify(); });

    this.typingSearch = false;
    this.searchInput = InputState.new({ placeholder: "Search all rows, press Enter" });
    this.searchInput.on("submit", (_e, cx) => this.search(this.searchInput.value(), cx));
    this.searchInput.on("focus", (_e, cx) => { this.typingSearch = true; cx.notify(); });
    this.searchInput.on("blur", (_e, cx) => { this.typingSearch = false; cx.notify(); });

    this.connect(cx);
  }

  // Start from nothing on the current server.
  connect(cx) {
    this.databases = [];
    this.databasesError = null;
    this.open = {};
    this.listIndex = new Map();
    this.selected = null;
    this.columns = [];
    this.setRows({ header: [], rows: [] });
    this.rowsError = null;
    this.loadingTable = false;
    this.loadingRows = false;
    this.rowSearch = "";
    this.tableLoad++;
    this.rowLoad++;
    this.searchInput.set_value("");
    this.serverInput.set_value(this.server);
    this.serverError = null;
    this.loadDatabases(cx);
    const database = props()?.database;
    if (database) this.loadTables(database, cx);
  }

  // A save in one copy of the mod makes every copy draw again, and each copy then follows the new server.
  followServer(cx) {
    const server = currentServer();
    if (server === this.server) return;
    this.server = server;
    cx.spawn(async (cx) => {
      // This call comes from render, and cx.notify() throws in render. The sleep leaves that phase.
      await cx.sleep(0);
      if (this.panel) this.panel.reconnect(cx);
      else this.connect(cx);
      cx.notify();
    });
  }

  saveServer(cx) {
    const text = this.serverInput.value().trim();
    this.serverError = parseServer(text) ? null : SERVER_HELP;
    if (!this.serverError) setShared(SERVER_KEY, text);
    cx.notify();
  }

  loadDatabases(cx) {
    const load = ++this.databaseLoad;
    cx.spawn(async (cx) => {
      try {
        const databases = await listDatabases();
        if (load !== this.databaseLoad) return;
        this.databases = databases;
        this.databasesError = null;
      } catch (e) {
        if (load !== this.databaseLoad) return;
        this.databasesError = messageOf(e);
      }
      cx.notify();
    });
  }

  toggleDatabase(name, cx) {
    const state = this.open[name];
    if (state) state.expanded = !state.expanded;
    else this.loadTables(name, cx);
    cx.notify();
  }

  loadTables(name, cx) {
    const old = this.open[name];
    const state = { expanded: old?.expanded ?? true, loading: true, tables: old?.tables ?? [], error: null, schemas: old?.schemas ?? {} };
    this.open[name] = state;
    cx.spawn(async (cx) => {
      try {
        state.tables = parseTables(await runPsql(name, LIST_TABLES_SQL));
        state.error = null;
      } catch (e) {
        state.error = messageOf(e);
      }
      state.loading = false;
      cx.notify();
    });
  }

  pick(database, table, cx) {
    this.selected = { database, ...table };
    this.searchInput.set_value("");
    this.rowSearch = "";
    this.loadTable(cx);
  }

  loadTable(cx) {
    const { database, schema, name } = this.selected;
    const load = ++this.tableLoad;
    this.rowLoad++;
    this.selectedCell = null;
    this.loadingTable = true;
    this.loadingRows = false;
    this.rowsError = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const columns = parseColumns(await runPsql(database, columnsSql(schema, name)));
        if (load !== this.tableLoad) return;
        this.columns = columns;
        await this.loadRows(cx);
      } catch (e) {
        if (load !== this.tableLoad) return;
        this.columns = [];
        this.setRows({ header: [], rows: [] });
        this.rowsError = messageOf(e);
      } finally {
        if (load === this.tableLoad) { this.loadingTable = false; cx.notify(); }
      }
    });
  }

  setRows({ header, rows }) {
    this.selectedCell = null;
    this.header = header;
    this.rows = rows;
    this.widths = columnWidths(header, rows);
  }

  async loadRows(cx) {
    const { database, schema, name } = this.selected;
    const load = ++this.rowLoad;
    this.selectedCell = null;
    this.loadingRows = true;
    cx.notify();
    try {
      const sql = rowsSql({ schema, table: name, columns: this.columns, search: this.rowSearch });
      const result = parseRows(await runPsql(database, sql));
      if (load !== this.rowLoad) return;
      this.setRows(result);
      this.rowsError = null;
    } catch (e) {
      if (load !== this.rowLoad) return;
      this.setRows({ header: this.columns.map((c) => c.name), rows: [] });
      this.rowsError = messageOf(e);
    } finally {
      if (load === this.rowLoad) { this.loadingRows = false; cx.notify(); }
    }
  }

  search(text, cx) {
    if (!this.selected || this.loadingTable) return;
    this.rowSearch = text.trim();
    cx.spawn(async (cx) => { await this.loadRows(cx); });
  }

  refresh(cx) {
    this.loadDatabases(cx);
    for (const name of Object.keys(this.open)) this.loadTables(name, cx);
    if (this.selected) this.loadTable(cx);
    cx.notify();
  }

  selectCell(row, column, cx) {
    if (this.loadingTable || this.loadingRows) return;
    this.selectedCell = { row, column };
    this.handle.focus();
    cx.stop_propagation();
    cx.notify();
  }

  // Only copy a cell when the view itself has focus; inputs handle their own copy shortcut.
  onKey(e, cx) {
    if ((e.keystroke === "ctrl-c" || e.keystroke === "cmd-c") && this.handle.is_focused() && this.selectedCell) {
      const { row, column } = this.selectedCell;
      const value = this.rows[row]?.[column];
      if (value === undefined) return;
      cx.write_to_clipboard(value ?? "NULL");
      cx.stop_propagation();
      notify({ title: "Copied", level: "success", timeout: 1000 });
      return;
    }
    if (e.key !== "escape") return;
    if (this.typingServer) {
      this.serverInput.set_value(this.server);
      this.serverError = null;
      this.typingServer = false;
    } else if (this.typingFilter) {
      this.filterInput.set_value("");
      this.tableFilter = "";
      this.typingFilter = false;
    } else if (this.typingSearch) {
      this.searchInput.set_value("");
      this.typingSearch = false;
      if (this.rowSearch) this.search("", cx);
    } else if (this.selectedCell) {
      this.selectedCell = null;
    } else {
      return;
    }
    this.handle.focus();
    cx.stop_propagation();
    cx.notify();
  }

  inputBox(id, state, typing, t) {
    return div().id(id).h(28).px(8).flex().items_center().rounded(7).border_1().border_color(typing ? t.accent : t.border).cursor_text()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(Input.new(state).h_full().text_size(12).text_color(t.foreground));
  }

  toggleSchema(row, cx) {
    this.open[row.database].schemas[row.schema] = !row.expanded;
    cx.notify();
  }

  // The app refuses a click handler inside a virtual list row, so the list has one handler for all rows.
  clickListRow(key, cx) {
    const row = this.listIndex.get(key);
    if (row?.kind === "database") this.toggleDatabase(row.name, cx);
    else if (row?.kind === "schema") this.toggleSchema(row, cx);
    else if (row?.kind === "table") this.pick(row.database, row.table, cx);
  }

  // A row in the sidebar. All kinds have one height, as the virtual list needs.
  listRow(row, t) {
    const base = h_flex().id(row.key).w_full().h(LIST_ROW_HEIGHT).flex_none().pr(8).gap(6).items_center().rounded(6);
    const chevron = (open) => div().w(10).flex_none().text_size(11).text_color(t.dim).child(open ? "▾" : "▸");
    const count = (n) => div().flex_none().text_size(11).text_color(t.dim).child(String(n));
    if (row.kind === "note") {
      return base.pl(38).text_size(11).text_color(row.tone === "error" ? t.ansi1 : t.dim).tooltip(row.text).child(div().min_w(0).truncate().child(row.text));
    }
    if (row.kind === "database") {
      return base.pl(8).cursor_pointer().hover((s) => s.bg(t.hover))
        .child(chevron(row.expanded))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(row.name))
        .when(row.count !== null, (e) => e.child(count(row.count)));
    }
    if (row.kind === "schema") {
      return base.pl(20).cursor_pointer().hover((s) => s.bg(t.hover))
        .child(chevron(row.expanded))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(row.schema))
        .child(count(row.count));
    }
    const { database, table } = row;
    const isSelected = this.selected?.database === database && this.selected?.schema === table.schema && this.selected?.name === table.name;
    const kind = kindLabel(table.kind);
    return base.pl(38).cursor_pointer()
      .when(isSelected, (e) => e.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .child(div().flex_1().min_w(0).truncate().child(table.name))
      .when(kind !== "", (e) => e.child(div().flex_none().text_size(10).text_color(t.dim).child(kind)));
  }

  sidebar(t, icon) {
    const rows = listRows(this.databases, this.open, this.tableFilter);
    this.listIndex = new Map(rows.map((row) => [row.key, row]));
    return v_flex().w(280).flex_none().h_full().min_h(0).border_r(1).border_color(t.border)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Postgres"))
        .child(div().flex_1())
        .child(div().id("pg-refresh").w(24).h(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip("Load again")
          .on_click((_e, cx) => this.refresh(cx))
          .child(icon)))
      .child(v_flex().flex_none().px(8).py(6).gap(6).border_b(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_none().pl(6).text_size(11).text_color(t.dim).child("Server"))
          .child(div().flex_1().min_w(0).child(this.inputBox("pg-server", this.serverInput, this.typingServer, t))))
        .when(Boolean(this.serverError), (e) => e.child(div().px(6).text_size(11).text_color(t.ansi1).child(this.serverError)))
        .when(this.typingServer && !this.serverError, (e) => e.child(div().px(6).text_size(11).text_color(t.dim).child("Enter connects. Esc cancels.")))
        .child(this.inputBox("pg-filter", this.filterInput, this.typingFilter, t)))
      .when(Boolean(this.databasesError), (e) => e.child(div().flex_none().p(14).text_size(11).text_color(t.ansi1).child(this.databasesError)))
      .when(!this.databasesError && this.databases.length === 0, (e) => e.child(div().flex_none().p(14).text_color(t.dim).child("Loading databases…")))
      .child(div().flex_1().min_h(0).relative().px(6).py(4)
        .child(v_virtual_list("pg-list", rows.length, LIST_ROW_HEIGHT, (i) => rows[i]?.key ?? String(i),
          (range) => rows.slice(range.start, range.end).map((row) => this.listRow(row, t))).size_full()
          .on_item_click((key, cx) => this.clickListRow(key, cx)))
        .child(Scrollbar.vertical("pg-list").viewport_from_layout().absolute().inset_0()));
  }

  columnsBlock(t) {
    const cell = (width) => div().w(width).flex_none().px(8).truncate();
    const height = Math.min(220, (this.columns.length + 1) * 22 + 8);
    return v_flex().id("pg-columns").flex_none().h(height).overflow_y_scrollbar().px(6).py(4).border_b(1).border_color(t.border)
      .child(h_flex().h(22).flex_none().items_center().text_size(11).text_color(t.dim)
        .child(cell(260).child("column")).child(cell(220).child("type")).child(cell(70).child("nullable")).child(div().flex_1().min_w(0).px(8).child("default")))
      .children(this.columns.map((c) => h_flex().h(22).flex_none().items_center().text_size(12)
        .child(h_flex().w(260).flex_none().px(8).gap(6).items_center()
          .child(div().min_w(0).truncate().child(c.name))
          .when(c.pk !== null, (e) => e.child(div().flex_none().px(4).rounded(3).bg(t.accent).text_color(t.accent_foreground).text_size(9).child("PK"))))
        .child(cell(220).text_color(t.muted).child(c.type))
        .child(cell(70).text_color(t.muted).child(c.nullable ? "yes" : "no"))
        .child(div().flex_1().min_w(0).px(8).truncate().text_color(t.dim).child(c.default ?? ""))));
  }

  rowsBlock(t) {
    const total = this.widths.reduce((sum, width) => sum + width, 0);
    return div().id("pg-rows-x").flex_1().min_h(0).overflow_x_scrollbar().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
      .child(v_flex().min_w(total).h_full().min_h(0)
        .when(this.header.length > 0, (e) => e.child(h_flex().h(26).flex_none().bg(t.raised).border_b(1).border_color(t.border).children(this.header.map((name, i) =>
          div().w(this.widths[i]).flex_none().h_full().flex().items_center().px(8).font_semibold().text_color(t.muted).child(div().truncate().child(name))))))
        .child(v_flex().id("pg-rows-y").flex_1().min_h(0).overflow_y_scrollbar().children(this.rows.map((row, rowIndex) =>
          h_flex().h(24).flex_none().border_b(1).border_color(t.border).children(row.map((value, i) => {
            const text = cellText(value);
            const selected = this.selectedCell?.row === rowIndex && this.selectedCell?.column === i;
            return div().id(`pg-cell-${rowIndex}-${i}`).w(this.widths[i]).flex_none().h_full().flex().items_center().px(8).cursor_pointer()
              .when(selected, (e) => e.bg(t.selected))
              .hover((s) => s.bg(selected ? t.selected : t.hover))
              .on_click((_e, cx) => this.selectCell(rowIndex, i, cx))
              .child(div().truncate().text_color(text === null ? t.dim : t.foreground).child(text ?? "NULL"));
          }))))));
  }

  detail(t) {
    if (!this.selected) {
      return v_flex().flex_1().min_w(0).h_full().items_center().justify_center().text_color(t.dim).child("Pick a table on the left");
    }
    const { database, schema, name, kind } = this.selected;
    const busy = this.loadingTable || this.loadingRows;
    const label = busy ? "Loading…" : this.rowsError ? "" : rowsLabel(this.rows.length, this.rowSearch);
    return v_flex().flex_1().min_w(0).h_full().min_h(0)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().text_color(t.dim).child(database))
        .child(div().min_w(0).truncate().font_semibold().child(`${schema}.${name}`))
        .when(kindLabel(kind) !== "", (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(kindLabel(kind))))
        .child(div().flex_1())
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`${this.columns.length} columns`)))
      .child(this.columnsBlock(t))
      .child(h_flex().h(40).flex_none().px(8).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().w(320).flex_none().child(this.inputBox("pg-search", this.searchInput, this.typingSearch, t)))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(label)))
      .when(Boolean(this.rowsError), (e) => e.child(div().flex_none().px(14).py(6).border_b(1).border_color(t.border).text_size(11).text_color(t.ansi1).child(this.rowsError)))
      .child(this.rowsBlock(t));
  }

  render(cx) {
    this.followServer(cx);
    if (this.panel) return this.panel.render();
    const t = theme();
    const anyLoading = this.loadingTable || this.loadingRows || Object.values(this.open).some((s) => s.loading);
    const icon = svg("mods/pg/refresh.svg").size(14).flex_none().text_color(t.muted);
    return h_flex().id("pg").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(this.sidebar(t, anyLoading ? icon.spin(900) : icon))
      .child(this.detail(t));
  }
}
