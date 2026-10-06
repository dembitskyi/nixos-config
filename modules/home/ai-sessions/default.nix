# Sandboxed, on-demand AI agent sessions (Claude Code, Codex, ...). Each
# session runs in a transient systemd user unit that its `<name>-sandbox`
# launcher starts on demand, inside a tmux session for re-attaching. The
# sandbox comes from the AI sandbox NixOS module (`sandbox`) and is applied
# through a unit-name-prefix drop-in.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.home.ai-sessions;

  # systemd applies "<prefix>-.service.d/" drop-ins to every unit whose name
  # starts with "<prefix>-", transient units included.
  unitPrefix = name: "${name}-sandbox";

  # Same rendering as home-manager's own unit files.
  toSystemdIni = lib.generators.toINI {
    listsAsDuplicateKeys = true;
    mkKeyValue =
      key: value:
      let
        value' = if lib.isBool value then (if value then "true" else "false") else toString value;
      in
      "${key}=${value'}";
  };

  # Merges unit sections, concatenating list-valued settings.
  mergeUnits = lib.zipAttrsWith (
    _:
    lib.zipAttrsWith (
      _: values: if lib.all lib.isList values then lib.concatLists values else lib.last values
    )
  );

  # The sentinel tells the entry script that the drop-in was applied.
  sandboxDropIn =
    session:
    if cfg.sandbox == { } then
      throw "mine.home.ai-sessions requires mine.ai-sandbox.enable, which defines the session sandbox."
    else
      toSystemdIni (mergeUnits [
        cfg.sandbox
        session.sandbox
        { Service.Environment = [ "AI_SESSION_SANDBOX=1" ]; }
      ]);

  exportLines =
    env: lib.mapAttrsToList (key: value: "export ${key}=${lib.escapeShellArg (toString value)}") env;

  # Runs inside the session unit as `<entry> <backend> [ARGS...]`.
  mkEntry =
    name: session:
    let
      launcher = unitPrefix name;
      envBlock = lib.optionalString (session.env != { }) (
        lib.concatLines (exportLines session.env) + "\n"
      );
      backendCase =
        backend: backendCfg:
        [ "  ${backend})" ]
        ++ map (line: "    ${line}") (
          exportLines backendCfg.env
          ++ [ "exec ${lib.escapeShellArg session.command} \\" ]
          ++ map (arg: "  ${lib.escapeShellArg arg} \\") (backendCfg.args ++ session.args)
          ++ [ "  \"$@\"" ]
        )
        ++ [ "    ;;" ];
    in
    pkgs.writeShellApplication {
      name = "${launcher}-entry";
      text = ''
        # Fail closed: without the drop-in, the unit would run with the full
        # home. Its sentinel and the hidden user bus prove it was applied.
        if [ "''${AI_SESSION_SANDBOX:-}" != 1 ] || [ -e "/run/user/$(${lib.getExe' pkgs.coreutils "id"} -u)/bus" ]; then
          echo "${launcher}: the session sandbox is not active; run 'systemctl --user daemon-reload' and retry." >&2
          exit 1
        fi

        ${envBlock}backend="$1"
        shift
        case "$backend" in
        ${lib.concatStringsSep "\n" (lib.concatLists (lib.mapAttrsToList backendCase session.backends))}
          *)
            echo "${launcher}: unknown backend '$backend'." >&2
            exit 2
            ;;
        esac
      '';
    };

  mkLauncher =
    name: session:
    let
      launcher = unitPrefix name;
      backends = lib.attrNames session.backends;
    in
    pkgs.writeShellApplication {
      name = launcher;
      runtimeInputs = [ pkgs.systemd ];
      text = ''
        usage() {
          echo "Usage: ${launcher} [--backend ${lib.concatStringsSep "|" backends}] [--slot NAME] [ARGS...]" >&2
        }

        backend=${session.defaultBackend}
        slot=s1
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --backend | --slot)
              if [ "$#" -lt 2 ]; then
                usage
                exit 2
              fi
              if [ "$1" = --backend ]; then
                backend="$2"
              else
                slot="$2"
              fi
              shift 2
              ;;
            -h | --help)
              usage
              exit 0
              ;;
            --)
              shift
              break
              ;;
            *)
              break
              ;;
          esac
        done

        case "$backend" in
          ${lib.concatStringsSep " | " backends}) ;;
          *)
            echo "${launcher}: unknown backend '$backend'." >&2
            usage
            exit 2
            ;;
        esac
        case "$slot" in
          "" | *[!A-Za-z0-9_]*)
            echo "${launcher}: slot names may only contain letters, digits and underscores." >&2
            exit 2
            ;;
        esac
        unit="${launcher}-$slot.service"

        # ~/workspace is the sandbox home's workspace (a symlink to it on the
        # host), so paths below it are valid on both sides of the sandbox.
        workspace="$HOME/workspace"
        sandbox_workspace="''${XDG_STATE_HOME:-$HOME/.local/state}/ai-sandbox/workspace"
        case "$PWD" in
          "$workspace" | "$workspace"/*) dir="$PWD" ;;
          "$sandbox_workspace" | "$sandbox_workspace"/*) dir="$workspace''${PWD#"$sandbox_workspace"}" ;;
          *) dir="$workspace" ;;
        esac

        if systemctl --user --quiet is-active "$unit"; then
          echo "${launcher}: $unit is already running; attach to its tmux session or run 'systemctl --user stop $unit'." >&2
          exit 1
        fi

        # Closing the tmux pane kills systemd-run, which never stops its unit.
        trap 'systemctl --user stop "$unit" 2>/dev/null || true' EXIT
        trap 'exit 129' HUP
        trap 'exit 143' TERM

        setenv=()
        for var in LANG LC_ALL; do
          if [ -n "''${!var:-}" ]; then
            setenv+=("--setenv=$var=''${!var}")
          fi
        done

        SYSTEMD_ADJUST_TERMINAL_TITLE=0 systemd-run --user --pty --quiet --collect \
          --service-type=exec --expand-environment=no \
          --unit="$unit" --description="${session.title} ($slot, $backend)" \
          --working-directory="$dir" "''${setenv[@]}" \
          -- ${lib.getExe (mkEntry name session)} "$backend" "$@"
      '';
    };

  mkDesktopEntries =
    name: session:
    lib.mapAttrs' (
      slot: slotCfg:
      lib.nameValuePair "${name}-${slot}" {
        name = "${session.title} ${lib.toUpper slot}";
        genericName = "${session.title} - AI coding agent";
        inherit (slotCfg) comment;
        exec = "tmux new-session -A -D -s ${name}_${slot} ${unitPrefix name} --backend ${slotCfg.backend} --slot ${slot}";
        terminal = true;
        icon = "utilities-terminal";
        type = "Application";
        categories = [ "Utility" ];
      }
    ) session.slots;

  envType = lib.types.attrsOf (lib.types.either lib.types.str lib.types.int);

  backendType = lib.types.submodule {
    options = {
      env = lib.mkOption {
        type = envType;
        default = { };
        description = "Environment variables of this backend.";
      };
      args = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Arguments of this backend, passed before the session-wide ones.";
      };
    };
  };

  slotType = lib.types.submodule {
    options = {
      backend = lib.mkOption {
        type = lib.types.str;
        description = "Backend of the slot's session.";
      };
      comment = lib.mkOption {
        type = lib.types.str;
        description = "Comment of the slot's desktop entry.";
      };
    };
  };

  sessionType = lib.types.submodule {
    options = {
      title = lib.mkOption {
        type = lib.types.str;
        example = "Claude Code";
        description = "Name shown in desktop entries and unit descriptions.";
      };
      command = lib.mkOption {
        type = lib.types.str;
        description = "Agent executable run inside the session unit.";
      };
      env = lib.mkOption {
        type = envType;
        default = { };
        description = "Environment variables of every backend.";
      };
      args = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Arguments of every backend.";
      };
      backends = lib.mkOption {
        type = lib.types.attrsOf backendType;
        description = "Backends selectable with --backend.";
      };
      defaultBackend = lib.mkOption {
        type = lib.types.str;
        description = "Backend used without --backend.";
      };
      slots = lib.mkOption {
        type = lib.types.attrsOf slotType;
        default = { };
        description = "One desktop entry per slot, opening (or re-attaching to) the slot's tmux session.";
      };
      sandbox = lib.mkOption {
        type = lib.types.attrsOf (lib.types.attrsOf lib.types.anything);
        default = { };
        description = "Unit sections merged into the shared sandbox of this session's units.";
      };
    };
  };
in
{
  options.mine.home.ai-sessions = {
    sandbox = lib.mkOption {
      type = lib.types.attrsOf (lib.types.attrsOf lib.types.anything);
      default = { };
      internal = true;
      description = "systemd unit sections that sandbox every session unit. Populated by the AI sandbox NixOS module.";
    };

    sessions = lib.mkOption {
      type = lib.types.attrsOf sessionType;
      default = { };
      description = "Sandboxed agent sessions, each with a `<name>-sandbox` launcher. Defined by the agent modules.";
    };
  };

  config = lib.mkIf (cfg.sessions != { }) {
    home.packages = lib.mapAttrsToList mkLauncher cfg.sessions;

    xdg.configFile = lib.mapAttrs' (
      name: session:
      lib.nameValuePair "systemd/user/${unitPrefix name}-.service.d/10-sandbox.conf" {
        text = sandboxDropIn session;
      }
    ) cfg.sessions;

    xdg.desktopEntries = lib.concatMapAttrs mkDesktopEntries cfg.sessions;
  };
}
