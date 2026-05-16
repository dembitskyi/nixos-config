# Common hyprland settings shared across all versions.
{
  lib,
  pkgs,
  tools,
}:
let
  inherit (lib) getExe';
in
{
  "$mod" = "SUPER";
  env = [
    "XDG_CURRENT_DESKTOP,Hyprland"
    "XDG_SESSION_DESKTOP,Hyprland"
    "XDG_SESSION_TYPE,wayland"
    "GDK_BACKEND,wayland,x11,*"
    "NIXOS_OZONE_WL,1"
    "ELECTRON_OZONE_PLATFORM_HINT,wayland"
    "MOZ_ENABLE_WAYLAND,1"
    "OZONE_PLATFORM,wayland"
    "EGL_PLATFORM,wayland"
    "CLUTTER_BACKEND,wayland"
    "SDL_VIDEODRIVER,wayland"
    "QT_QPA_PLATFORM,wayland"
    "QT_WAYLAND_DISABLE_WINDOWDECORATION,1"
    "QT_QPA_PLATFORMTHEME,gtk2"
    "QT_AUTO_SCREEN_SCALE_FACTOR,1"
    "QT_ENABLE_HIGHDPI_SCALING,1"
    "WLR_RENDERER_ALLOW_SOFTWARE,1"
    "NIXPKGS_ALLOW_UNFREE,1"
  ];

  exec-once = [
    "nm-applet --indicator"
    "systemctl --user start hyprpolkitagent"
    "${getExe' pkgs.wl-clipboard "wl-paste"} --type text --watch cliphist store"
    "${getExe' pkgs.wl-clipboard "wl-paste"} --type image --watch cliphist store"
    "rm '$XDG_CACHE_HOME/cliphist/db'"
    "polkit-agent-helper-1"
  ];

  input = {
    kb_layout = "us,ua";
    kb_options = "grp:alt_shift_toggle";

    repeat_delay = 275;
    repeat_rate = 35;
    numlock_by_default = true;

    follow_mouse = 1;

    touchpad.natural_scroll = false;

    tablet.output = "current";

    sensitivity = 0;
    force_no_accel = true;
  };

  general = {
    gaps_in = 4;
    gaps_out = 9;
    border_size = 2;
    "col.active_border" = "rgba(ca9ee6ff) rgba(f2d5cfff) 45deg";
    "col.inactive_border" = "rgba(b4befecc) rgba(6c7086cc) 45deg";
    resize_on_border = true;
    layout = "dwindle";
  };

  decoration = {
    rounding = 10;
    dim_special = 0.3;

    shadow = {
      enabled = true;
      range = 4;
      render_power = 3;
      color = "rgba(1a1a1aee)";
    };
    blur = {
      enabled = true;
      special = true;
      size = 6;
      passes = 2;
      new_optimizations = true;
      ignore_opacity = true;
      xray = false;
      vibrancy = 0.1696;
    };
  };

  group = {
    "col.border_active" = "rgba(ca9ee6ff) rgba(f2d5cfff) 45deg";
    "col.border_inactive" = "rgba(b4befecc) rgba(6c7086cc) 45deg";
    "col.border_locked_active" = "rgba(ca9ee6ff) rgba(f2d5cfff) 45deg";
    "col.border_locked_inactive" = "rgba(b4befecc) rgba(6c7086cc) 45deg";
  };

  debug = {
    #disable_logs = false;
  };

  layerrule =
    let
      toRegex =
        list:
        let
          elements = lib.concatStringsSep "|" list;
        in
        "match:namespace ^(${elements})$";

      lowopacity = [
        "bar"
        "calendar"
        "notifications"
        "system-menu"
        "quickshell:bar"
        "quickshell:notifications:overlay"
        "quickshell:osd"
      ];

      highopacity = [
        "vicinae"
        "osd"
        "logout_dialog"
        "quickshell:sidebar"
      ];

      blurred = lib.concatLists [
        lowopacity
        highopacity
      ];
    in
    [
      "${toRegex blurred}, blur true"
      "match:namespace ^quickshell.*$, blur_popups true"
      "${
        toRegex [
          "bar"
          "quickshell:bar"
        ]
      }, xray true"
      "${toRegex (highopacity ++ [ "music" ])}, ignore_alpha 0.5"
      "${toRegex lowopacity}, ignore_alpha 0.2"
      "${
        toRegex [
          "notifications"
          "quickshell:notifications:overlay"
          "quickshell:notifictaions:panel"
        ]
      }, no_anim true"
    ];

  animations = {
    enabled = true;
    bezier = [
      "linear, 0, 0, 1, 1"
      "md3_standard, 0.2, 0, 0, 1"
      "md3_decel, 0.05, 0.7, 0.1, 1"
      "md3_accel, 0.3, 0, 0.8, 0.15"
      "overshot, 0.05, 0.9, 0.1, 1.1"
      "crazyshot, 0.1, 1.5, 0.76, 0.92"
      "hyprnostretch, 0.05, 0.9, 0.1, 1.0"
      "fluent_decel, 0.1, 1, 0, 1"
      "easeInOutCirc, 0.85, 0, 0.15, 1"
      "easeOutCirc, 0, 0.55, 0.45, 1"
      "easeOutExpo, 0.16, 1, 0.3, 1"
    ];
    animation = [
      "windows, 1, 3, md3_decel, popin 60%"
      "border, 1, 10, default"
      "fade, 1, 2.5, md3_decel"
      "workspaces, 1, 3.5, easeOutExpo, slide"
      "specialWorkspace, 1, 3, md3_decel, slidevert"
    ];
  };

  render = {
    direct_scanout = 0;
  };

  ecosystem = {
    no_update_news = true;
    no_donation_nag = true;
  };

  misc = {
    disable_hyprland_logo = true;
    mouse_move_focuses_monitor = true;
    swallow_regex = "^(Alacritty|kitty)$";
    enable_swallow = true;
    vrr = 2;
  };

  xwayland.force_zero_scaling = false;

  gesture = [
    "3, horizontal, workspace"
  ];

  dwindle = {
    pseudotile = true;
    preserve_split = true;
  };

  master = {
    new_status = "master";
    new_on_top = true;
    mfact = 0.5;
  };

  windowrule = [
    "match:title ^(Media viewer)$, float on"

    "match:class ^(org.gnome.Calculator)$, float on"
    "match:class ^(qalculate-gtk)$, float on"
    "match:class ^(org.gnome.eog)$, float on"
    "match:class ^(org.gnome.FileRoller)$, float on"
    "match:class ^(org.gnome.Nautilus)$, float on"
    "match:class ^(org.gnome.Calculator)$, float on"
    "match:class ^(org.keepassxc.KeePassXC)$, float on"
    "match:class ^(blueman-manager)$, float on"
    "match:class ^(pavucontrol)$, float on"
    "match:class ^(nm-connection-editor)$, float on"
    "match:class ^(mpv)$, float on"

    # Place the AI browser on a hidden special workspace so it stays out of
    # the way until toggled with ALT+O.
    "match:class ^(ai-browser)$, workspace special:ai-browser silent"
  ];

  bindm = [
    "$mod, mouse:272, movewindow"
    "$mod, mouse:273, resizewindow"
  ];

  bind = [
    "$mod, Q, exec, hyprctl dispatch killactive"
    "$mod SHIFT, Q, exec, hyprctl dispatch forcekillactive"

    "$mod, S, exec, grim -s 1 -g \"\$(slurp)\" - | tee ~/Pictures/Screenshots/$(date +%s).png | wl-copy"

    "$mod, F, exec, firefox"
    "$mod, B, exec, qutebrowser"
    "$mod, T, exec, alacritty"
    "$mod, h, movefocus, l"
    "$mod, l, movefocus, r"
    "$mod, k, movefocus, u"
    "$mod, j, movefocus, d"

    "ALT, TAB, cyclenext"
    "ALT, F, togglefloating"
    "ALT, N, movetoworkspacesilent, special:minimized"
    "ALT, R, movetoworkspace, e+0"

    "ALT, S, togglespecialworkspace, minimized"
    "ALT, O, togglespecialworkspace, ai-browser"

    "ALT, return, fullscreen"
    "$mod, M, fullscreen, 1"
    #"$mod, z, exec, wl-freeze -a" # Freeze/unfreeze focused window (SIGSTOP/SIGCONT)

    ", mouse:275, exec, ${./scripts/DynamicMouseEventHandler.sh} mouse_up"
    ", mouse:276, exec, ${./scripts/DynamicMouseEventHandler.sh} mouse_down"
    ", mouse:277, exec, ${./scripts/DynamicMouseEventHandler.sh} mouse_press_down"
    ", mouse_left, exec, ${./scripts/DynamicMouseEventHandler.sh} mouse_left"
    ", mouse_right, exec, ${./scripts/DynamicMouseEventHandler.sh} mouse_right"
    ",XF86AudioLowerVolume,exec,pamixer -d 1"
    ",XF86AudioRaiseVolume,exec,pamixer -i 1"
    ",XF86AudioMute,exec,pamixer -t"
    ",XF86AudioPlay,exec,playerctl --player=spotify,%any play-pause"
    ",XF86AudioPause,exec,playerctl --player=spotify,%any play-pause"
    ",xf86AudioNext,exec,playerctl --player=spotify,%any next"
    ",xf86AudioPrev,exec,playerctl --player=spotify,%any previous"

    ",F11, exec, pamixer -t"
    ",F9, exec, playerctl --player=spotify,%any play-pause"
    ",F10,exec,playerctl --player=spotify,%any next"
    ",F8,exec,playerctl --player=spotify,%any previous"
    ",F12,exec,pamixer -d 1"
    ",F13,exec,pamixer -i 1"

    "CTRL ALT, L, exec, noctalia-shell ipc call lockScreen lock"

    "$mod, A, exec, launcher drun"
    "$mod CTRL, A, exec, launcher drun-sudo"
    "$mod, R, exec, launcher run"
    "$mod CTRL, R, exec, launcher run-sudo"

    "$mod, V, exec, ${tools}/sbin/ClipManager.sh"
    "CTRL SUPER, C, exec, ${./scripts/clip-text-refiner}"

    "$mod, N, exec, noctalia-shell ipc call notifications toggleHistory"
    "$mod SHIFT, N, exec, noctalia-shell ipc call notifications clear"
    "$mod, C, exec, noctalia-shell ipc call calendar toggle"
  ]
  ++ (builtins.concatLists (
    builtins.genList (
      x:
      let
        ws =
          let
            c = (x + 1) / 10;
          in
          toString (x + 1 - (c * 10));
      in
      [
        "$mod, ${ws}, workspace, ${toString (x + 1)}"
        "$mod SHIFT, ${ws}, movetoworkspace, ${toString (x + 1)}"
        "$mod CTRL, ${ws}, movetoworkspacesilent, ${toString (x + 1)}"
      ]
    ) 10
  ));

  monitor = [
    ",preferred,auto,1"

    "desc:Dell Inc. DELL U2720Q 9S4ZS83,3840x2160@60,0x0,2.0"
  ];

  workspace = [
    "1,monitor:desc:Dell Inc. DELL U2720Q 9S4ZS83,default:true"
    "2,monitor:desc:Dell Inc. DELL U2720Q 9S4ZS83"
  ];
}
