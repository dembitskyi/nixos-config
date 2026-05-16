{
  lib,
  config,
  pkgs,
  variables,
  ...
}:
{

  options = {
    mine.home.mpv.enable = lib.mkEnableOption "enable mpv player";
  };

  config = lib.mkIf config.mine.home.mpv.enable {
    xdg.configFile."mpv/scripts/osc-toggle.lua".text = ''
      local mp = require 'mp'
      local osc_visible = false

       mp.register_script_message("osc-toggle", function()
          osc_visible = not osc_visible
          local visibility = osc_visible and "always" or "never"
          mp.commandv("script-message", "osc-visibility", visibility)
       end)
    '';
    xdg.configFile."mpv/scripts/ctrl-wheel-zoom.lua".text = ''
      local mp = require 'mp'

      local state = { zoom = 0, pan_x = 0, pan_y = 0 }

      local function sync_from_mpv()
        state.zoom  = mp.get_property_number("video-zoom", 0)
        state.pan_x = mp.get_property_number("video-pan-x", 0)
        state.pan_y = mp.get_property_number("video-pan-y", 0)
      end

      local function zoom(delta)
        local new_zoom = state.zoom + delta

        local mx, my = mp.get_mouse_pos()
        local dw = mp.get_property_number("osd-width", 1)
        local dh = mp.get_property_number("osd-height", 1)

        local nx = mx / dw - 0.5
        local ny = my / dh - 0.5

        local old_scale = 2 ^ state.zoom
        local new_scale = 2 ^ new_zoom

        local new_pan_x = state.pan_x + nx * (1/new_scale - 1/old_scale)
        local new_pan_y = state.pan_y + ny * (1/new_scale - 1/old_scale)

        state.zoom  = new_zoom
        state.pan_x = new_pan_x
        state.pan_y = new_pan_y

        mp.set_property_number("video-zoom",  state.zoom)
        mp.set_property_number("video-pan-x", state.pan_x)
        mp.set_property_number("video-pan-y", state.pan_y)
      end

      local function reset()
        state.zoom  = 0
        state.pan_x = 0
        state.pan_y = 0
        mp.set_property_number("video-zoom",  0)
        mp.set_property_number("video-pan-x", 0)
        mp.set_property_number("video-pan-y", 0)
      end

      mp.register_event("file-loaded", sync_from_mpv)
      mp.register_event("seek",        sync_from_mpv)

      mp.register_script_message("ctrl-zoom-in",  function() zoom( 0.1) end)
      mp.register_script_message("ctrl-zoom-out", function() zoom(-0.1) end)
      mp.register_script_message("reset-zoom",    reset)
    '';

    programs.mpv = {
      enable = true;
      scripts = with pkgs.mpvScripts; [
        modernx
        mpris
        sponsorblock
        quality-menu
      ];
      bindings = rec {
        "Ctrl+WHEEL_UP" = "script-message ctrl-zoom-in";
        "Ctrl+WHEEL_DOWN" = "script-message ctrl-zoom-out";
        "Shift+WHEEL_DOWN" = "script-message reset-zoom";

        MBTN_LEFT_DBL = "cycle fullscreen";
        MBTN_RIGHT = "cycle pause";
        MBTN_BACK = "playlist-prev";
        MBTN_FORWARD = "playlist-next";
        WHEEL_DOWN = "seek -5";
        WHEEL_UP = "seek 5";
        WHEEL_LEFT = "seek -60";
        WHEEL_RIGHT = "seek 60";

        h = "no-osd seek -5 exact";
        LEFT = h;
        l = "no-osd seek 5 exact";
        RIGHT = l;
        j = "seek -30";
        DOWN = j;
        k = "seek 30";
        UP = k;
        r = "cycle-values loop-file no inf";

        H = "no-osd seek -1 exact";
        "Shift+LEFT" = "no-osd seek -1 exact";
        L = "no-osd seek 1 exact";
        "Shift+RIGHT" = "no-osd seek 1 exact";
        J = "seek -300";
        "Shift+DOWN" = "seek -300";
        K = "seek 300";
        "Shift+UP" = "seek 300";

        "Ctrl+LEFT" = "no-osd sub-seek -1";
        "Ctrl+h" = "no-osd sub-seek -1";
        "Ctrl+RIGHT" = "no-osd sub-seek 1";
        "Ctrl+l" = "no-osd sub-seek 1";
        "Ctrl+DOWN" = "add chapter -1";
        "Ctrl+j" = "add chapter -1";
        "Ctrl+UP" = "add chapter 1";
        "Ctrl+k" = "add chapter 1";

        "Alt+LEFT" = "frame-back-step";
        "Alt+h" = "frame-back-step";
        "Alt+RIGHT" = "frame-step";
        "Alt+l" = "frame-step";

        PGUP = "add chapter 1";
        PGDWN = "add chapter -1";

        u = "revert-seek";

        "Ctrl++" = "add sub-scale 0.1";
        "Ctrl+-" = "add sub-scale -0.1";
        "Ctrl+0" = "set sub-scale 0";

        q = "quit";
        Q = "quit-watch-later";
        "q {encode}" = "quit 4";
        p = "cycle pause";
        SPACE = p;
        f = "cycle fullscreen";

        n = "playlist-next";
        N = "playlist-prev";
        i = "script-message osc-toggle";

        o = "show-progress";
        O = "script-binding stats/display-stats-toggle";
        "`" = "script-binding console/enable";
        ":" = "script-binding console/enable";
        ";" = "seek 0 absolute-percent; set pause no";

        z = "add sub-delay -0.1";
        x = "add sub-delay 0.1";
        Z = "add audio-delay -0.1";
        X = "add audio-delay 0.1";

        "1" = "add volume -1";
        "2" = "add volume 1";
        "=" = "add speed 0.1";
        "-" = "add speed -0.1";
        "0" = "set speed 1";
        m = "cycle mute";
        s = "cycle sub";
        v = "cycle video";
        a = "cycle audio";
        S = ''cycle-values sub-ass-override "force" "no"'';
        PRINT = "screenshot";
        c = "add panscan 0.1";
        C = "add panscan -0.1";
        PLAY = "cycle pause";
        PAUSE = "cycle pause";
        PLAYPAUSE = "cycle pause";
        PLAYONLY = "set pause no";
        PAUSEONLY = "set pause yes";
        STOP = "stop";
        CLOSE_WIN = "quit";
        "CLOSE_WIN {encode}" = "quit 4";
        "Ctrl+w" = ''set hwdec "no"'';
        # T = "script-binding generate-thumbnails";
      };
      config = {
        osc = false;
        osd-bar = false;
        border = false;
        fs = true;
        mute = true;
        keepaspect = true;
        autofit-larger = "1920x1080";
        keep-open = "always";
        resume-playback-check-mtime = true;
        audio-file-auto = "fuzzy";
        sub-auto = "fuzzy";
        wayland-edge-pixels-pointer = 0;
        wayland-edge-pixels-touch = 0;
        screenshot-format = "webp";
        screenshot-webp-lossless = true;
        screenshot-directory = "/home/${variables.username}/Pictures/Screenshots/mpv";
        screenshot-sw = true;
        input-default-bindings = false;
      };
      scriptOpts = {
        osc = {
          showonpause = false;
          donttimeoutonpause = true;
          hidetimeout = 2000;
        };
        modernx = {
        };
      };
    };
  };
}
