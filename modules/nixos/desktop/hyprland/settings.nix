# Common hyprland settings, rendered by home-manager as hyprland.lua.
{
  lib,
  tools,
}:
let
  inline = lib.generators.mkLuaInline;
  lua = lib.generators.toLua { };

  mod = "SUPER";
  bind = keys: dispatcher: {
    _args = [
      keys
      (inline dispatcher)
    ];
  };
  exec = keys: command: bind keys "hl.dsp.exec_cmd(${lua command})";
  mouseBind = keys: dispatcher: {
    _args = [
      keys
      (inline dispatcher)
      { mouse = true; }
    ];
  };
  env = name: value: {
    _args = [
      name
      value
    ];
  };
  curve = name: x1: y1: x2: y2: {
    _args = [
      name
      {
        type = "bezier";
        points = [
          [
            x1
            y1
          ]
          [
            x2
            y2
          ]
        ];
      }
    ];
  };
  gradient = from: to: {
    colors = [
      from
      to
    ];
    angle = 45;
  };
  activeBorder = gradient "rgba(ca9ee6ff)" "rgba(f2d5cfff)";
  inactiveBorder = gradient "rgba(b4befecc)" "rgba(6c7086cc)";

  namespaces = list: "^(${lib.concatStringsSep "|" list})$";
  lowOpacity = [
    "bar"
    "calendar"
    "notifications"
    "system-menu"
    "noctalia-bar-.+"
    "noctalia-notification"
    "noctalia-osd"
  ];
  highOpacity = [
    "vicinae"
    "osd"
    "logout_dialog"
    "noctalia-panel"
    "noctalia-attached-panel"
  ];

  dell = "desc:Dell Inc. DELL U2720Q 9S4ZS83";
  mouseHandler = "${./scripts/DynamicMouseEventHandler.sh}";
  spotify = "playerctl --player=spotify,%any";
in
{
  env = [
    (env "XDG_CURRENT_DESKTOP" "Hyprland")
    (env "XDG_SESSION_DESKTOP" "Hyprland")
    (env "XDG_SESSION_TYPE" "wayland")
    (env "GDK_BACKEND" "wayland,x11,*")
    (env "NIXOS_OZONE_WL" "1")
    (env "ELECTRON_OZONE_PLATFORM_HINT" "wayland")
    (env "MOZ_ENABLE_WAYLAND" "1")
    (env "OZONE_PLATFORM" "wayland")
    (env "EGL_PLATFORM" "wayland")
    (env "CLUTTER_BACKEND" "wayland")
    (env "SDL_VIDEODRIVER" "wayland")
    (env "QT_QPA_PLATFORM" "wayland")
    (env "QT_WAYLAND_DISABLE_WINDOWDECORATION" "1")
    (env "QT_QPA_PLATFORMTHEME" "gtk2")
    (env "QT_AUTO_SCREEN_SCALE_FACTOR" "1")
    (env "QT_ENABLE_HIGHDPI_SCALING" "1")
    (env "WLR_RENDERER_ALLOW_SOFTWARE" "1")
    (env "NIXPKGS_ALLOW_UNFREE" "1")
  ];

  config = {
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
      col = {
        active_border = activeBorder;
        inactive_border = inactiveBorder;
      };
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

    group.col = {
      border_active = activeBorder;
      border_inactive = inactiveBorder;
      border_locked_active = activeBorder;
      border_locked_inactive = inactiveBorder;
    };

    animations.enabled = true;
    render.direct_scanout = 0;

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
    dwindle.preserve_split = true;

    master = {
      new_status = "master";
      new_on_top = true;
      mfact = 0.5;
    };
  };

  curve = [
    (curve "linear" 0 0 1 1)
    (curve "md3_standard" 0.2 0 0 1)
    (curve "md3_decel" 0.05 0.7 0.1 1)
    (curve "md3_accel" 0.3 0 0.8 0.15)
    (curve "overshot" 0.05 0.9 0.1 1.1)
    (curve "crazyshot" 0.1 1.5 0.76 0.92)
    (curve "hyprnostretch" 0.05 0.9 0.1 1.0)
    (curve "fluent_decel" 0.1 1 0 1)
    (curve "easeInOutCirc" 0.85 0 0.15 1)
    (curve "easeOutCirc" 0 0.55 0.45 1)
    (curve "easeOutExpo" 0.16 1 0.3 1)
  ];

  animation = [
    {
      leaf = "windows";
      enabled = true;
      speed = 3;
      bezier = "md3_decel";
      style = "popin 60%";
    }
    {
      leaf = "border";
      enabled = true;
      speed = 10;
      bezier = "default";
    }
    {
      leaf = "fade";
      enabled = true;
      speed = 2.5;
      bezier = "md3_decel";
    }
    {
      leaf = "workspaces";
      enabled = true;
      speed = 3.5;
      bezier = "easeOutExpo";
      style = "slide";
    }
    {
      leaf = "specialWorkspace";
      enabled = true;
      speed = 3;
      bezier = "md3_decel";
      style = "slidevert";
    }
  ];

  gesture = {
    fingers = 3;
    direction = "horizontal";
    action = "workspace";
  };

  layer_rule = [
    {
      match.namespace = namespaces (lowOpacity ++ highOpacity);
      blur = true;
    }
    {
      match.namespace = "^noctalia-.*$";
      blur_popups = true;
    }
    {
      match.namespace = namespaces [
        "bar"
        "noctalia-bar-.+"
      ];
      xray = true;
    }
    {
      match.namespace = namespaces (highOpacity ++ [ "music" ]);
      ignore_alpha = 0.5;
    }
    {
      match.namespace = namespaces lowOpacity;
      ignore_alpha = 0.2;
    }
    {
      match.namespace = namespaces [
        "notifications"
        "noctalia-(bar-.+|notification|dock|panel|attached-panel|osd|window-switcher)"
      ];
      no_anim = true;
    }
  ];

  window_rule =
    map
      (class: {
        match.class = "^(${class})$";
        float = true;
      })
      [
        "org.gnome.Calculator"
        "qalculate-gtk"
        "org.gnome.eog"
        "org.gnome.FileRoller"
        "org.gnome.Nautilus"
        "org.keepassxc.KeePassXC"
        "blueman-manager"
        "pavucontrol"
        "nm-connection-editor"
        "mpv"
      ]
    ++ [
      {
        match.title = "^(Media viewer)$";
        float = true;
      }
      # Place the AI browser on a hidden special workspace so it stays out of
      # the way until toggled with ALT+O. render_unfocused keeps its hidden
      # windows presenting frames, which CDP screenshots wait for.
      {
        match.class = "^(ai-browser)$";
        workspace = "special:ai-browser silent";
        render_unfocused = true;
      }
    ];

  bind = [
    (mouseBind "${mod} + mouse:272" "hl.dsp.window.drag()")
    (mouseBind "${mod} + mouse:273" "hl.dsp.window.resize()")

    (bind "${mod} + Q" "hl.dsp.window.close()")
    (bind "${mod} + SHIFT + Q" "hl.dsp.window.kill()")

    (exec "${mod} + S" "grim -s 1 -g \"$(slurp)\" - | tee ~/Pictures/Screenshots/$(date +%s).png | wl-copy")

    (exec "${mod} + F" "firefox")
    (exec "${mod} + B" "qutebrowser")
    (exec "${mod} + T" "alacritty")
    (bind "${mod} + h" "hl.dsp.focus({ direction = \"left\" })")
    (bind "${mod} + l" "hl.dsp.focus({ direction = \"right\" })")
    (bind "${mod} + k" "hl.dsp.focus({ direction = \"up\" })")
    (bind "${mod} + j" "hl.dsp.focus({ direction = \"down\" })")

    (bind "ALT + TAB" "hl.dsp.window.cycle_next()")
    (bind "ALT + F" "hl.dsp.window.float({ action = \"toggle\" })")
    (bind "ALT + N" "hl.dsp.window.move({ workspace = \"special:minimized\", follow = false })")
    (bind "ALT + R" "hl.dsp.window.move({ workspace = \"e+0\" })")

    (bind "ALT + S" "hl.dsp.workspace.toggle_special(\"minimized\")")
    (bind "ALT + O" "hl.dsp.workspace.toggle_special(\"ai-browser\")")

    (bind "ALT + return" "hl.dsp.window.fullscreen()")
    (bind "${mod} + M" "hl.dsp.window.fullscreen({ mode = \"maximized\" })")

    (exec "mouse:275" "${mouseHandler} mouse_up")
    (exec "mouse:276" "${mouseHandler} mouse_down")
    (exec "mouse:277" "${mouseHandler} mouse_press_down")
    (exec "mouse_left" "${mouseHandler} mouse_left")
    (exec "mouse_right" "${mouseHandler} mouse_right")
    (exec "XF86AudioLowerVolume" "pamixer -d 1")
    (exec "XF86AudioRaiseVolume" "pamixer -i 1")
    (exec "XF86AudioMute" "pamixer -t")
    (exec "XF86AudioPlay" "${spotify} play-pause")
    (exec "XF86AudioPause" "${spotify} play-pause")
    (exec "XF86AudioNext" "${spotify} next")
    (exec "XF86AudioPrev" "${spotify} previous")

    (exec "F11" "pamixer -t")
    (exec "F9" "${spotify} play-pause")
    (exec "F10" "${spotify} next")
    (exec "F8" "${spotify} previous")
    (exec "F12" "pamixer -d 1")
    (exec "F13" "pamixer -i 1")

    (exec "CTRL + ALT + L" "noctalia msg session lock")

    (exec "${mod} + A" "launcher drun")
    (exec "${mod} + CTRL + A" "launcher drun-sudo")
    (exec "${mod} + R" "launcher run")
    (exec "${mod} + CTRL + R" "launcher run-sudo")

    (exec "${mod} + V" "${tools}/sbin/ClipManager.sh")
    (exec "CTRL + SUPER + C" "${./scripts/clip-text-refiner}")

    (exec "${mod} + N" "noctalia msg panel-toggle control-center notifications")
    (exec "${mod} + SHIFT + N" "noctalia msg notification-clear-history")
    (exec "${mod} + C" "noctalia msg panel-toggle control-center calendar")
  ]
  ++ lib.concatMap (
    i:
    let
      key = toString (lib.mod i 10);
      ws = toString i;
    in
    [
      (bind "${mod} + ${key}" "hl.dsp.focus({ workspace = ${ws} })")
      (bind "${mod} + SHIFT + ${key}" "hl.dsp.window.move({ workspace = ${ws} })")
      (bind "${mod} + CTRL + ${key}" "hl.dsp.window.move({ workspace = ${ws}, follow = false })")
    ]
  ) (lib.range 1 10);

  monitor = [
    {
      output = "";
      mode = "preferred";
      position = "auto";
      scale = "1";
    }
    {
      output = dell;
      mode = "3840x2160@60";
      position = "0x0";
      scale = "2";
    }
  ];

  workspace_rule = [
    {
      workspace = "1";
      monitor = dell;
      default = true;
    }
    {
      workspace = "2";
      monitor = dell;
    }
  ];
}
