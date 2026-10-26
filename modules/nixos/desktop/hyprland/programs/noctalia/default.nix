{
  lib,
  config,
  pkgs,
  ...
}:
let
  cfg = config.mine.hyprland.noctalia;
  home = "/home/${config.variables.username}";

  plugins = {
    "nixos/corner-alert" = ./plugins/corner-alert;
    "nixos/lock-header" = ./plugins/lock-header;
  }
  // cfg.extraPlugins;

  # Lock screen in the v4 layout: greeting card on top, cards stacked right above the
  # login box, sizes in logical px of the main output (1920x1080 without one).
  output = config.mine.hyprland.mainOutput;
  screen =
    if output == null then
      {
        width = 1920;
        height = 1080;
      }
    else
      let
        size = map lib.toInt (lib.splitString "x" (lib.head (lib.splitString "@" output.mode)));
      in
      {
        width = lib.elemAt size 0 / output.scale;
        height = lib.elemAt size 1 / output.scale;
      };
  centerX = screen.width / 2.0;
  onOutput = lib.optionalAttrs (output != null) { output = output.name; };
  cardScale = 1.1;
  cardGap = 9;
  cardWidth = lib.foldl' (
    w: card: lib.max w (builtins.ceil (cardScale * card.width))
  ) 0 cfg.lockCards;
  login = {
    width = if cfg.lockCards == [ ] then 860 else cardWidth;
    height = 148;
    bottom = screen.height - 162;
  };
  # Bottom-up from the login box, each card one gap above the previous one.
  stack =
    lib.foldl'
      (acc: card: {
        bottom = acc.bottom - cardScale * card.height - cardGap;
        widgets = acc.widgets // {
          ${card.name} = onOutput // {
            inherit (card) type settings;
            cx = centerX;
            cy = acc.bottom - cardScale * card.height / 2.0;
            box_width = builtins.ceil (cardScale * card.width);
            box_height = builtins.ceil (cardScale * card.height);
          };
        };
      })
      {
        bottom = login.bottom - login.height - cardGap;
        widgets = { };
      }
      (lib.reverseList cfg.lockCards);

  pluginDir = pkgs.runCommand "noctalia-plugins" { } ''
    mkdir $out
    ${lib.concatStringsSep "\n" (
      lib.mapAttrsToList (id: path: "cp -r ${path} $out/${lib.replaceStrings [ "/" ] [ "-" ] id}") plugins
    )}
  '';
in
{
  config = lib.mkIf config.mine.hyprland.enable {
    environment.systemPackages = [ pkgs.noctalia ];

    home-manager.users.${config.variables.username} = {
      programs.noctalia = {
        enable = true;
        package = pkgs.noctalia;
        systemd.enable = true;
        settings = {
          shell = {
            avatar_path = "${../../icons/avatars/profile.png}";
            clipboard_enabled = false;
            corner_radius_scale = 0.2;
            launch_apps_as_systemd_services = true;
            setup_wizard_enabled = false;
            shadow.direction = "down_right";
            panel.open_near_click_control_center = true;
            session.actions = [
              { action = "lock"; }
              { action = "lock_and_suspend"; }
              {
                action = "command";
                label = "Hibernate";
                glyph = "zzz";
                command = "systemctl hibernate";
              }
              { action = "reboot"; }
              {
                action = "logout";
                # Through UWSM, so logout still works when Hyprland's IPC socket is
                # stale after a compositor crash; `hyprctl dispatch exit` would hang.
                command = "${lib.getExe pkgs.uwsm} stop";
              }
              { action = "shutdown"; }
            ];
          };

          theme = {
            mode = "dark";
            source = "builtin";
            builtin = "Ayu";
            templates.enable_community_templates = false;
          };

          wallpaper = {
            directory = "${home}/Pictures/Wallpapers";
            fill_color = "#000000";
            edge_smoothness = 5.0e-2;
            default.path = "${../../wallpapers/wallhaven_433729.jpg}";
          };

          bar.default = {
            background_opacity = 0.93;
            margin_edge = 0;
            margin_ends = 0;
            radius = 0;
            start = [ ];
            center = [
              "clock"
              "notifications"
            ];
            end = [
              "tray"
              "keyboard_layout"
            ]
            ++ map (w: w.name) cfg.extraBarWidgets
            ++ [
              "volume"
              "battery"
              "cpu"
              "temp"
              "ram"
              "control-center"
            ];
          };

          widget = {
            clock = {
              format = "{:%a, %b %-d | %H:%M:%S}";
              vertical_format = "{:%H\n%M}";
              tooltip_format = "{:%H:%M %a, %b %d}";
              font_family = "Hack Nerd Font Mono";
              color = "primary";
            };
            notifications.hide_when_no_unread = false;
            tray = {
              drawer = true;
              hide_passive = false;
              pinned = config.variables.pinnedTrayApps;
            };
            keyboard_layout.show_label = true;
            control-center.custom_image = "${pkgs.nixos-icons}/share/icons/hicolor/scalable/apps/nix-snowflake.svg";
          }
          // lib.listToAttrs (map (w: lib.nameValuePair w.name w.settings) cfg.extraBarWidgets);

          battery.warning_threshold = 30;

          control_center.shortcuts = map (type: { inherit type; }) [
            "wifi"
            "bluetooth"
            "notification"
            "power_profile"
            "caffeine"
            "nightlight"
          ];

          desktop_widgets.enabled = false;

          lockscreen = {
            blur_intensity = 0.0;
            tint_intensity = 0.4;
            transition = [ ];
          };

          lockscreen_widgets = {
            enabled = true;
            widget = {
              header = onOutput // {
                type = "nixos/lock-header:card";
                cx = centerX;
                cy = 161.0;
                settings.background = false;
              };
            }
            // lib.optionalAttrs (output != null) {
              "lockscreen-login-box@${output.name}" = {
                type = "login_box";
                output = output.name;
                cx = centerX;
                cy = login.bottom - login.height / 2.0;
                box_width = login.width;
                settings = {
                  show_media = false;
                  show_session_buttons = false;
                  show_unlock_hint = false;
                  background_radius = 4.0;
                };
              };
            }
            // stack.widgets;
          };

          notification = {
            layer = "overlay";
            background_opacity = 1.0;
          };

          osd = {
            position = "top_right";
            hide_delay_ms = 2000;
            background_opacity = 1.0;
            kinds.lock_keys = false;
          };

          hooks = {
            session_locked = "dbus-send --session --type=signal /org/noctalia/Session org.noctalia.Session.Lock";
            session_unlocked = "dbus-send --session --type=signal /org/noctalia/Session org.noctalia.Session.Unlock";
          };

          location.address = "Dallas, USA";
          weather.enabled = true;

          system.monitor = {
            cpu_poll_seconds = 3.0;
            memory_poll_seconds = 3.0;
            network_poll_seconds = 3.0;
            disk_poll_seconds = 3.0;
          };

          plugins = {
            auto_update = "none";
            enabled = lib.attrNames plugins;
            source = [
              {
                name = "nix";
                kind = "path";
                location = "${pluginDir}";
              }
            ];
          };
        };
      };
    };
  };
}
