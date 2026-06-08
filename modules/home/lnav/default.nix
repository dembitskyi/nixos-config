{
  lib,
  config,
  pkgs,
  ...
}:
let
  # Pop the top of the view stack only when more than one view is on it.
  # This preserves "go back" behavior for help/histogram/SQL views while
  # preventing accidental exits.  Use :q, :quit, or :q! to exit lnav.
  popViewNoQuit = ''
    ;DELETE FROM lnav_view_stack WHERE rowid = (SELECT max(rowid) FROM lnav_view_stack) AND (SELECT count(*) FROM lnav_view_stack) > 1
  '';

  cheatsheet = pkgs.writeText "lnav-cheatsheet.md" ''
    # lnav cheatsheet

    Press **`X`** to close this cheatsheet, or **`q`** to step back to your logs.
    Press **`F1`** for the full built-in lnav help.

    ## Exit
    | Key | Action |
    | --- | --- |
    | `:q` / `:quit` / `:q!` | Exit lnav. The only way to exit. |
    | `q` / `Q`              | Pop temporary view (help, histogram, SQL). Never quits. |
    | `Ctrl-C`               | **Disabled.** Use `:q` to exit. |
    | `X`                    | Close the current file (use this to dismiss this cheatsheet). |

    ## Movement (vim-friendly)
    | Key | Action |
    | --- | --- |
    | `j` / `k`             | Line down / up |
    | `Ctrl-d` / `Ctrl-u`   | Half page down / up |
    | `Space` / `b`         | Full page down / up |
    | `g` / `G`             | Top / bottom of view |
    | `h` / `l`             | Half-page left / right |

    ## Search
    | Key | Action |
    | --- | --- |
    | `/`           | Open search prompt |
    | `n` / `N`     | Next / previous search hit |
    | `>` / `<`     | Next / previous hit, scroll horizontally |
    | `e` / `E`     | Next / previous **error** message |
    | `w` / `W`     | Next / previous **warning** message |

    ## Marking and selecting a range

    > **Goal:** copy a contiguous block of log lines, or hide everything else
    > so only the range is visible.

    **Select a range with marks:**

    1. Move to the **first** line of the range, press `m`.
    2. Move to the **last** line of the range, press `Shift-M` — fills in
       every line between the previous mark and the cursor.
    3. `c` copies the marked lines, `Shift-C` clears all marks.

    `Shift-M` always uses the **last-marked** line as its anchor, so two
    scattered `m` presses make two single-line marks, not a range. To turn
    them into a range: jump to one (`u` / `Shift-U`), move to the other,
    press `Shift-M`.

    **Show only the range, hide the rest:**

    Once the range is fully marked: `:hide-unmarked-lines`. Restore with
    `:show-unmarked-lines`.

    **Range by line number — `|range`:**

    ```
    |range 400 1000     Mark lines 400-1000 and hide the rest
    |range-clear        Clear all marks and restore the full view
    ```

    `|range` is **additive** — call it again to add another range.

    **Mark hotkeys:**

    | Key | Action |
    | --- | --- |
    | `m`             | Toggle mark on current line |
    | `Shift-M`       | Mark range from last-marked line through cursor |
    | `Shift-J` / `Shift-K` | Extend mark one line down / up |
    | `c`             | Copy marked lines to clipboard |
    | `Shift-C`       | Clear all marks |
    | `u` / `Shift-U` | Jump to next / previous mark |

    ## Views
    | Key | Action |
    | --- | --- |
    | `t`               | Text view |
    | `i` / `Shift-I`   | Histogram (with / without time sync) |
    | `v` / `Shift-V`   | SQL result view |
    | `Shift-P`         | Toggle pretty-printed view |
    | `Tab`             | Focus filters / files panel |
    | `?`               | This cheatsheet (override) |
    | `F1`              | Built-in lnav help (full reference) |

    ## Prompts
    | Key | Action |
    | --- | --- |
    | `:`           | Command prompt (e.g. `:filter-out ERROR`) |
    | `;`           | SQL prompt |
    | `\|`          | Run an lnav script |
    | `Esc`         | Cancel any prompt |
    | `Ctrl-]`      | Abort the prompt |

    ## Filters
    | Key | Action |
    | --- | --- |
    | `Ctrl-f`     | Toggle all filters on / off |
    | `Tab`        | Open the filters panel to add / edit |

    ## Cursor mode
    | Key | Action |
    | --- | --- |
    | `Ctrl-x`     | Toggle between cursor and top-fixed mode |

    ## Clearing color / visual noise

    lnav layers several kinds of coloring on top of each other.  Here is how
    to clear each one:

    | Source | How to clear |
    | --- | --- |
    | Search hits (yellow band from `/`)   | Press `/` then `Enter` on an empty prompt |
    | User `:highlight <pat>` patterns      | `:clear-highlight <pat>` — Tab-complete to list active patterns |
    | Field highlights (`:highlight-field`) | `:clear-highlight-field <name>` |
    | Bookmarks (lines marked with `m`)     | `Shift-C` |
    | All filters                           | `:disable-filter <name>` per filter, or `Ctrl-f` to toggle the lot |
    | Hidden fields (`x` toggle)            | Press `x` again |
    | Parser results (`p` toggle)           | Press `p` again |

    **Nuclear option:** `:reset-session` (or press `Ctrl-R`) clears **all**
    filters, highlights, and bookmarks at once — useful when the screen has
    accumulated too much state.

    Log-level colors (red for errors, yellow for warnings, etc.) come from
    the theme, not from highlights, and cannot be cleared per-line.  To dim
    them globally, run `:config /ui/dim-text true` or switch theme with
    `:config /ui/theme <name>`.
  '';
in
{

  options = {
    mine.home.lnav.enable = lib.mkEnableOption "enable lnav with vim-style keymap overrides";
  };

  config = lib.mkIf config.mine.home.lnav.enable {
    xdg.configFile."lnav/configs/vim-mode/keymap.json".text = builtins.toJSON {
      "$schema" = "https://lnav.org/schemas/config-v1.schema.json";
      ui.keymap-defs.default = {
        # q / Q no longer quit lnav; they only pop temporary views.
        "x71".command = popViewNoQuit;
        "x51".command = popViewNoQuit;
        # ? opens our custom cheatsheet instead of the built-in help view.
        # F1 still opens the built-in help (see default keymap).
        "x3f".command = ":open ${cheatsheet}";
      };
    };

    # Custom scripts. lnav discovers them under ~/.config/lnav/formats/*/*.lnav
    # and they are invoked at the `|` prompt by basename, e.g. `|range 400 1000`.
    xdg.configFile."lnav/formats/mine/range.lnav".text = ''
      # @synopsis: range <start-line> <end-line>
      # @description: Mark log lines in [start, end] and hide everything not marked. Additive — run again to add another range. Use |range-clear to reset.
      ;UPDATE all_logs SET log_mark = 1 WHERE log_line BETWEEN CAST($1 AS INTEGER) AND CAST($2 AS INTEGER)
      :hide-unmarked-lines
    '';

    xdg.configFile."lnav/formats/mine/range-clear.lnav".text = ''
      # @synopsis: range-clear
      # @description: Clear marks set by |range and restore the full view.
      ;UPDATE all_logs SET log_mark = 0 WHERE log_mark = 1
      :show-unmarked-lines
    '';
  };
}
