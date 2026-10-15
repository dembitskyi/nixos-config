# Clipboard images for the agent sessions. The sessions see no Wayland socket
# (any Wayland client may type into host windows or capture the screen), so
# Claude Code's image paste (Ctrl+V), which runs `wl-paste -l` and then
# `wl-paste --type image/png`, found nothing. This host-side bridge answers
# those requests on a socket that the sessions' own `wl-paste` (default.nix)
# forwards them to. It lists and serves image types only: text, passwords
# included, never reaches the sandbox.
#
# A session must not read the clipboard behind the user's back, so the bridge
# answers only after a physical Ctrl+V: a non-consuming Hyprland binding
# (the focused window still gets the key) arms it for a few seconds, and
# serving an image disarms it. The arming file lies outside the sessions'
# view, and they cannot press keys on the host.
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

  # One request per connection, a line on the socket: `list` (the offered
  # image types) or `get <type>` (the image, if that type is offered). Nothing
  # to serve, no Ctrl+V in the last seconds, or any other request gets an
  # empty answer.
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

      # The key reaches Hyprland's binding and Claude Code at once, so the
      # arming may land just after the request.
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
            # One image per Ctrl+V.
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
    home-manager.users.${config.variables.username} = {
      wayland.windowManager.hyprland.settings.bindn = [ "CTRL, V, exec, ${lib.getExe arm}" ];

      systemd.user.sockets.ai-sandbox-clipboard = {
        Unit.Description = "AI Sandbox clipboard image bridge";
        Socket = {
          # The sessions bind this directory, which outlives socket restarts.
          ListenStream = "%t/ai-sandbox-clipboard/socket";
          DirectoryMode = "0700";
          SocketMode = "0600";
          Accept = true;
        };
        Install.WantedBy = [ "sockets.target" ];
      };

      # One instance per request, with the user manager's WAYLAND_DISPLAY.
      systemd.user.services."ai-sandbox-clipboard@" = {
        Unit = {
          Description = "AI Sandbox clipboard image request";
          CollectMode = "inactive-or-failed";
        };
        Service = {
          ExecStart = lib.getExe serve;
          StandardInput = "socket";
          StandardError = "journal";
          # wl-paste waits for the app that owns the clipboard.
          RuntimeMaxSec = 30;
        };
      };
    };
  };
}
