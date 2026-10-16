# Interactive agent sessions (Claude Code, Codex). `<name>-sandbox <slot>` runs
# the agent in the transient unit <name>-sandbox-<slot>, which its drop-in
# sandboxes, with the slot's folder ~/workspace/<name>-<folder>.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.ai-sandbox;
  units = import ./units.nix { inherit lib pkgs config; };
  inherit (units) userHome;

  toIni = lib.generators.toINI {
    listsAsDuplicateKeys = true;
    mkKeyValue =
      key: value: "${key}=${if lib.isBool value then lib.boolToString value else toString value}";
  };
  # Unit sections, lists concatenated.
  merge = lib.zipAttrsWith (
    _:
    lib.zipAttrsWith (
      _: values: if lib.all lib.isList values then lib.concatLists values else lib.last values
    )
  );

  # Claude Code's image paste, forwarded to the clipboard bridge (images only).
  wlPaste = pkgs.writeShellApplication {
    name = "wl-paste";
    runtimeInputs = with pkgs; [
      coreutils
      socat
    ];
    text = ''
      request=""
      case "$#:''${1:-}" in
        1:-l | 1:--list-types) request=list ;;
        2:-t | 2:--type)
          case "$2" in
            image/*) request="get $2" ;;
          esac
          ;;
      esac
      if [ -z "$request" ]; then
        echo "wl-paste: the AI sandbox only lists and pastes clipboard images (-l, --type image/...)." >&2
        exit 1
      fi

      answer="$(mktemp)"
      trap 'rm -f "$answer"' EXIT
      printf '%s\n' "$request" |
        socat -t 30 - "UNIX-CONNECT:/run/user/$(id -u)/ai-sandbox-clipboard/socket" >"$answer"
      if [ ! -s "$answer" ]; then
        exit 1
      fi
      cat "$answer"
    '';
  };
  clipboard = lib.optional cfg.clipboard.enable "ai-sandbox-clipboard.socket";

  workspaceOf =
    name: id: slot:
    "${userHome}/workspace/${name}-${if slot.folder == null then id else slot.folder}";
  # The slot's own copies of `slotDirs` (host paths), in the shared home.
  slotDirsOf =
    _name: session: id: slot:
    lib.optionals (!slot.isolated) (map (dir: "${cfg.home}/${dir}/${id}") session.slotDirs);

  dropIn =
    name: session: id: slot:
    let
      workspace = workspaceOf name id slot;
    in
    toIni (merge [
      (units.sandbox {
        home = if slot.isolated then "${name}-${id}" else "ai-sandbox";
        proxy = !slot.isolated;
        extraPackages = lib.optional cfg.clipboard.enable wlPaste;
      })
      {
        Unit = {
          After = clipboard;
          Wants = clipboard;
        };
        Service = {
          # The entry's proof that this drop-in applies.
          Environment = [ "AI_SESSION_SANDBOX=1" ];
          TemporaryFileSystem = [ "${userHome}/workspace:ro" ];
          BindPaths = [
            "${workspace}:${workspace}"
          ]
          ++ lib.zipListsWith (src: dir: "${src}:${userHome}/${dir}") (slotDirsOf name session id
            slot
          ) session.slotDirs;
          BindReadOnlyPaths = lib.optional cfg.clipboard.enable "%t/ai-sandbox-clipboard:%t/ai-sandbox-clipboard";
          PrivatePIDs = true;
        };
      }
      session.sandbox
    ]);

  exports =
    env: lib.mapAttrsToList (key: value: "export ${key}=${lib.escapeShellArg (toString value)}") env;

  # Runs in the unit as `<entry> <backend> [ARGS...]`, as PID 1 of its
  # namespace: the agent is its child, so orphans get reaped. The agent gets
  # its own session and takes back the terminal, which systemd's fork into
  # the PID namespace left without a session (no resizes otherwise).
  entry =
    name: session:
    pkgs.writeShellApplication {
      name = "${name}-sandbox-entry";
      text = ''
        # Fail closed: without its drop-in the unit would see the whole home.
        if [ "''${AI_SESSION_SANDBOX:-}" != 1 ] || [ -e "/run/user/$(${lib.getExe' pkgs.coreutils "id"} -u)/bus" ]; then
          echo "${name}-sandbox: the session sandbox is not active; run 'systemctl --user daemon-reload' and retry." >&2
          exit 1
        fi
        ${lib.concatLines (exports session.env)}
        backend="$1"
        shift
        status=0
        case "$backend" in
        ${lib.concatStrings (
          lib.mapAttrsToList (backend: b: ''
            ${backend})
              ${lib.concatLines (exports b.env)}
              ${
                lib.escapeShellArgs (
                  [
                    "${pkgs.util-linux}/bin/setsid"
                    "--ctty"
                    session.command
                  ]
                  ++ b.args
                  ++ session.args
                )
              } "$@" || status=$?
              ;;
          '') session.backends
        )}
        esac
        exit "$status"
      '';
    };

  launcher =
    name: session:
    pkgs.writeShellApplication {
      name = "${name}-sandbox";
      runtimeInputs = [
        pkgs.coreutils
        pkgs.findutils
        pkgs.systemd
      ];
      text = ''
        own=()
        case "''${1:-}" in
        ${lib.concatStrings (
          lib.mapAttrsToList (id: slot: ''
            ${id})
              backend=${slot.backend}
              workspace=${workspaceOf name id slot}
              own=(${toString (slotDirsOf name session id slot)})
              ;;
          '') session.slots
        )}
          *)
            echo "usage: ${name}-sandbox <${lib.concatStringsSep "|" (lib.attrNames session.slots)}> [${session.title} options]" >&2
            exit 2
            ;;
        esac
        slot="$1"
        shift
        unit="${name}-sandbox-$slot.service"
        if systemctl --user --quiet is-active "$unit"; then
          echo "${name}-sandbox: $unit is already running; attach to its tmux session or run 'systemctl --user stop $unit'." >&2
          exit 1
        fi

        # Records of an earlier run are stale.
        for dir in "''${own[@]}"; do
          mkdir -p "$dir"
          find "$dir" -mindepth 1 -delete
        done
        mkdir -p "$workspace"
        case "$PWD/" in
          "$workspace"/*) dir="$PWD" ;;
          *) dir="$workspace" ;;
        esac

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
          --unit="$unit" --description="${session.title} ($slot)" \
          --working-directory="$dir" "''${setenv[@]}" \
          -- ${lib.getExe (entry name session)} "$backend" "$@"
      '';
    };

  envType = lib.types.attrsOf (lib.types.either lib.types.str lib.types.int);
in
{
  options.mine.ai-sandbox = {
    sessions = lib.mkOption {
      default = { };
      description = "Interactive agent sessions, each with a `<name>-sandbox` launcher.";
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            title = lib.mkOption {
              type = lib.types.str;
              description = "Name in desktop entries and unit descriptions.";
            };
            command = lib.mkOption {
              type = lib.types.str;
              description = "The agent's executable.";
            };
            env = lib.mkOption {
              type = envType;
              default = { };
              description = "Environment of every backend.";
            };
            args = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = "Arguments of every backend, after the backend's own.";
            };
            backends = lib.mkOption {
              description = "Backends a slot can use.";
              type = lib.types.attrsOf (
                lib.types.submodule {
                  options = {
                    env = lib.mkOption {
                      type = envType;
                      default = { };
                    };
                    args = lib.mkOption {
                      type = lib.types.listOf lib.types.str;
                      default = [ ];
                    };
                  };
                }
              );
            };
            slots = lib.mkOption {
              default = { };
              description = "Slots: a desktop entry each (tmux session <name>_<slot>).";
              type = lib.types.attrsOf (
                lib.types.submodule {
                  options = {
                    backend = lib.mkOption { type = lib.types.str; };
                    folder = lib.mkOption {
                      type = lib.types.nullOr (lib.types.strMatching "[A-Za-z0-9_]+");
                      default = null;
                      description = "Workspace folder ~/workspace/<name>-<folder> (default: the slot's own). Slots may share one.";
                    };
                    isolated = lib.mkEnableOption "its own home (~/.local/state/<name>-<slot>) instead of the shared one, with its login and history";
                  };
                }
              );
            };
            slotDirs = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ ];
              description = "Home dirs each slot of the shared home keeps to itself (emptied at start).";
            };
            sandbox = lib.mkOption {
              type = lib.types.attrsOf (lib.types.attrsOf lib.types.anything);
              default = { };
              description = "Extra unit sections of every slot.";
            };
          };
        }
      );
    };

    launchers = lib.mkOption {
      type = lib.types.attrsOf lib.types.package;
      readOnly = true;
      default = lib.mapAttrs launcher cfg.sessions;
      description = "Each session's launcher, for services that start slots themselves.";
    };
  };

  config = lib.mkIf (cfg.sessions != { }) {
    assertions = [
      {
        assertion = cfg.enable;
        message = "Agent sessions (mine.ai-sandbox.sessions) need mine.ai-sandbox.enable.";
      }
    ]
    ++ lib.concatLists (
      lib.mapAttrsToList (
        name: session:
        lib.mapAttrsToList (id: slot: {
          assertion = session.backends ? ${slot.backend};
          message = "${name} slot ${id}: no backend ${slot.backend}.";
        }) session.slots
      ) cfg.sessions
    );

    home-manager.users.${config.variables.username} = {
      home.packages = lib.attrValues cfg.launchers;

      xdg.configFile = lib.concatMapAttrs (
        name: session:
        lib.mapAttrs' (
          id: slot:
          lib.nameValuePair "systemd/user/${name}-sandbox-${id}.service.d/10-sandbox.conf" {
            text = dropIn name session id slot;
          }
        ) session.slots
      ) cfg.sessions;

      xdg.desktopEntries = lib.concatMapAttrs (
        name: session:
        lib.mapAttrs' (
          id: slot:
          lib.nameValuePair "${name}-${id}" {
            name = "${session.title} ${lib.toUpper id}";
            genericName = "${session.title} - AI coding agent";
            comment = "Sandboxed ${session.title} (${slot.backend})";
            exec = "tmux new-session -A -D -s ${name}_${id} ${name}-sandbox ${id}";
            terminal = true;
            icon = "utilities-terminal";
            type = "Application";
            categories = [ "Utility" ];
          }
        ) session.slots
      ) cfg.sessions;
    };
  };
}
