# Clipboard images for the agent sessions, right after a Ctrl+V.
{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.ai-sandbox.clipboard;

  armedFile = "/run/user/$(id -u)/ai-sandbox-clipboard.armed";
  armSeconds = 5;

  arm = pkgs.writeShellApplication {
    name = "ai-sandbox-clipboard-arm";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      touch "${armedFile}"
    '';
  };

  # One request per connection: `list` or `get <type>`.
  serve = pkgs.writeShellApplication {
    name = "ai-sandbox-clipboard-serve";
    runtimeInputs = with pkgs; [
      coreutils
      gnugrep
      wl-clipboard
    ];
    text = ''
      armed_file="${armedFile}"
      armed() {
        local since
        since="$(stat -c %Y "$armed_file" 2>/dev/null)" || return 1
        [ $(($(date +%s) - since)) -le ${toString armSeconds} ]
      }

      request=""
      IFS= read -r -n 256 request || true

      tries=10
      until armed; do
        tries=$((tries - 1))
        if [ "$tries" -le 0 ]; then
          exit 0
        fi
        sleep 0.1
      done

      offered="$(wl-paste --list-types 2>/dev/null | grep -E '^image/[A-Za-z0-9.+-]+$' || true)"
      case "$request" in
        list)
          if [ -n "$offered" ]; then
            printf '%s\n' "$offered"
          fi
          ;;
        "get "*)
          type="''${request#get }"
          if [ -n "$offered" ] && grep -qxF -- "$type" <<<"$offered"; then
            rm -f "$armed_file"
            exec wl-paste --type "$type"
          fi
          ;;
      esac
    '';
  };
in
{
  options.mine.ai-sandbox.clipboard.enable =
    lib.mkEnableOption "pasting clipboard images into the agent sessions (Claude Code's Ctrl+V) through a host-side bridge that serves images only, right after a Ctrl+V";

  config = lib.mkIf cfg.enable {
    systemd.tmpfiles.rules = [
      "d /run/ai-sandbox-clipboard 0700 ${config.variables.username} ${
        config.users.users.${config.variables.username}.group
      } -"
    ];

    home-manager.users.${config.variables.username} = {
      wayland.windowManager.hyprland.settings.bindn = [ "CTRL, V, exec, ${lib.getExe arm}" ];

      systemd.user.sockets.ai-sandbox-clipboard = {
        Unit.Description = "AI Sandbox clipboard image bridge";
        Socket = {
          ListenStream = "/run/ai-sandbox-clipboard/socket";
          SocketMode = "0600";
          Accept = true;
        };
        Install.WantedBy = [ "sockets.target" ];
      };

      systemd.user.services."ai-sandbox-clipboard@" = {
        Unit = {
          Description = "AI Sandbox clipboard image request";
          CollectMode = "inactive-or-failed";
          X-SwitchMethod = "keep-old";
        };
        Service = {
          ExecStart = lib.getExe serve;
          StandardInput = "socket";
          StandardError = "journal";
          RuntimeMaxSec = 30;
        };
      };
    };
  };
}
