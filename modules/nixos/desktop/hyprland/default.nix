{
  lib,
  config,
  pkgs,
  ncInputs,
  ...
}:
let
  scripts = ./scripts;

  # The flake input pins the release; fetching it the way nixpkgs does keeps the
  # build identical to nixpkgs' (cached) while both name the same version.
  hyprlandPackage = pkgs.hyprland.overrideAttrs {
    src = pkgs.fetchFromGitHub {
      owner = "hyprwm";
      repo = "hyprland";
      inherit (ncInputs.hyprland) rev;
      hash = ncInputs.hyprland.narHash;
    };
  };
  hyprlandPortalPackage = pkgs.xdg-desktop-portal-hyprland;
  userHome = "/${config.variables.homePrefix}/${config.variables.username}";

  tools = pkgs.stdenv.mkDerivation {
    name = "hyprland-tools";
    src = scripts;
    dontBuild = true;
    installPhase = ''
      mkdir -p $out/sbin
      cp -r $src/ClipManager.sh $out/sbin/
    '';
  };

  commonSettings = import ./settings.nix { inherit lib pkgs tools; };
in
{
  options = {
    mine.hyprland.enable = lib.mkEnableOption "enable hyprland";
    mine.hyprland.textConsoles = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [
        "tty3"
        "tty4"
      ];
      description = "Virtual terminals that always run a text login, as a fallback when the graphical session fails.";
    };
    mine.hyprland.greeterOutput = lib.mkOption {
      type = lib.types.nullOr (
        lib.types.submodule {
          options = {
            name = lib.mkOption {
              type = lib.types.str;
              example = "HDMI-A-1";
              description = "Connector name (`ls /sys/class/drm`).";
            };
            mode = lib.mkOption {
              type = lib.types.str;
              example = "3840x2160@60";
              description = "Mode, matching the Hyprland monitor line.";
            };
            scale = lib.mkOption {
              type = lib.types.ints.positive;
              default = 1;
              description = "Integer scale, matching the Hyprland monitor line.";
            };
          };
        }
      );
      default = null;
      description = "Output mode of the SDDM greeter (Weston); null keeps Weston's default.";
    };
    mine.hyprland.noctalia.extraPlugins = lib.mkOption {
      type = lib.types.attrsOf lib.types.path;
      default = { };
      description = "Extra Noctalia plugins, plugin id (author/name) -> plugin directory; each is installed and enabled.";
    };
    mine.hyprland.noctalia.extraBarWidgets = lib.mkOption {
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            name = lib.mkOption {
              type = lib.types.str;
              description = "Widget instance name.";
            };
            settings = lib.mkOption {
              type = lib.types.attrsOf lib.types.anything;
              description = "The `[widget.<name>]` table, including its `type`.";
            };
          };
        }
      );
      default = [ ];
      description = "Extra Noctalia bar widgets, in order, added to the bar's end section after the keyboard layout.";
    };
    mine.hyprland.package = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      description = "Resolved Hyprland package used by the system and Home Manager configuration.";
    };
  };

  imports = [
    ./themes/Catppuccin
    ./programs/greetd
    ./programs/noctalia
    ./programs/fuzzel
  ];

  config = lib.mkIf config.mine.hyprland.enable {
    mine.hyprland.package = hyprlandPackage;

    systemd.targets.getty.wants = map (tty: "getty@${tty}.service") config.mine.hyprland.textConsoles;
    environment.systemPackages = with pkgs; [
      (import ./scripts/launcher.nix { inherit lib pkgs; })

      eog
      nautilus
      feh
      gnome-disk-utility
      popsicle
      ubootTools
      meld
      gnome-calculator
      file-roller
      gedit
      qalculate-gtk
    ];

    # nixpkgs#507419 added security.wrappers.Hyprland with cap_sys_nice+ep so
    # Hyprland can give itself SCHED_RR. NixOS setcap wrappers raise granted
    # caps into the *ambient* set, leaking cap_sys_nice to every process in the
    # session. A non-zero CapEff makes apps look privileged to the same-uid
    # xdg-desktop-portal, whose ptrace-based /proc/<pid>/root check then fails
    # with EACCES, breaking all portal file dialogs (e.g. Chromium's "Change
    # folder"). The flake's bin/Hyprland is also a bash wrapper, which NixOS's
    # wrapper integrity check rejects. Drop the wrapper; the only cost is no
    # SCHED_RR for Hyprland.
    security.wrappers.Hyprland.enable = false;

    # nixpkgs flipped programs.fuse.enable to default false, dropping the SUID
    # fusermount3 wrapper that xdg-document-portal needs; without it the portal
    # exits 6/NOTCONFIGURED. xdg.portal doesn't pull fuse in, so enable it here.
    programs.fuse.enable = true;

    # GLib can't find Alacritty for Terminal=true apps (nvim.desktop) on its own.
    xdg.terminal-exec = {
      enable = true;
      settings.default = [ "Alacritty.desktop" ];
    };

    # udisks2 hardcodes the automount base to /run/media/$USER; it cannot mount
    # into an arbitrary path. Symlink ~/mnt to that base so removable media
    # auto-mounted by udiskie shows up under the home directory as ~/mnt/<label>.
    systemd.tmpfiles.rules = [
      "L+ ${userHome}/mnt - - - - /run/media/${config.variables.username}"
    ];

    services.displayManager.defaultSession = "hyprland-uwsm";
    programs.hyprland = {
      enable = true;
      withUWSM = true;
      package = hyprlandPackage;
      portalPackage = hyprlandPortalPackage;
    };
    programs.uwsm.waylandCompositors.hyprland = {
      prettyName = "Hyprland";
      comment = "Hyprland compositor managed by UWSM";
      binPath = "/run/current-system/sw/bin/start-hyprland";
    };

    home-manager.users.${config.variables.username} = {

      # Auto-mount removable media (USB drives) via the udisks2 backend. tray is
      # "never" to avoid a Requires=tray.target dependency the Noctalia bar does
      # not provide; notifications still report mount/unmount events.
      services.udiskie = {
        enable = true;
        automount = true;
        notify = true;
        tray = "never";
      };

      xdg = {
        userDirs = {
          enable = true;
          createDirectories = true;
          desktop = "${userHome}/Desktop";
          documents = "${userHome}/Documents";
          download = "${userHome}/Downloads";
          music = "${userHome}/Music";
          pictures = "${userHome}/Pictures";
          publicShare = "${userHome}/Public";
          templates = "${userHome}/Templates";
          videos = "${userHome}/Videos";
        };

        desktopEntries.hyprpicker = {
          name = "hyprpicker";
          genericName = "Color picker";
          comment = "Launch it. Click. That's it.";
          exec = "bash -c \"sleep 1 && hyprpicker -a\"";
          terminal = false;
          icon = "utilities-terminal";
          type = "Application";
          categories = [ "Utility" ];
        };
        portal = {
          enable = true;
          extraPortals = with pkgs; [
            xdg-desktop-portal-gtk
          ];
          xdgOpenUsePortal = true;
          config.hyprland = {
            default = [
              "hyprland"
              "gtk"
            ];
            "org.freedesktop.impl.portal.OpenURI" = "gtk";
            "org.freedesktop.impl.portal.FileChooser" = "gtk";
            "org.freedesktop.impl.portal.Print" = "gtk";
          };
        };
        mimeApps =
          let
            file-manager = [ "org.gnome.Nautilus.desktop" ];
            browser = [ "firefox.desktop" ];
            text-editor = [ "nvim.desktop" ];
            pdf = [ "okularApplication_pdf.desktop" ];
            image = [ "org.gnome.eog.desktop" ];
            mail = [ "thunderbird.desktop" ];
            playback = [ "umpv.desktop" ];
            archive = [ "org.gnome.FileRoller.desktop" ];
          in
          rec {
            enable = true;
            associations.added = defaultApplications;
            defaultApplications = {
              "text/html" = browser;
              "x-scheme-handler/http" = browser;
              "x-scheme-handler/https" = browser;
              "x-scheme-handler/ftp" = browser;
              "x-scheme-handler/chrome" = browser;
              "x-scheme-handler/about" = browser;
              "x-scheme-handler/unknown" = browser;
              "application/x-extension-htm" = browser;
              "application/x-extension-html" = browser;
              "application/x-extension-shtml" = browser;
              "application/xhtml+xml" = browser;
              "application/x-extension-xhtml" = browser;
              "application/x-extension-xht" = browser;
              "x-scheme-handler/miru" = [ "miru.desktop" ];
              "inode/directory" = file-manager;
              "x-scheme-handler/mailto" = mail;
              "application/pdf" = pdf;
              "application/json" = text-editor;
              "application/zip" = archive;
              "application/x-tar" = archive;
              "application/gzip" = archive;
              "application/x-bzip2" = archive;
              "application/x-xz" = archive;
              "text/plain" = text-editor;
              "text/csv" = text-editor;
              "image/png" = image;
              "image/webp" = image;
              "image/jpeg" = image;
              "image/jpg" = image;
              "video/mp4" = playback;
              "video/x-matroska" = playback;
              "video/avi" = playback;
            };
          };
      };

      home.packages = with pkgs; [
        kazam
        slurp
        grim
        awww
        hyprpicker
        cliphist
        wf-recorder
        grimblast
        swappy
        libnotify
        brightnessctl
        networkmanagerapplet
        pamixer
        pavucontrol
        playerctl
        waybar
        wtype
        wl-clipboard
        #wl-freeze
        xdotool
        yad
        wev
        blueman
        hyprpolkitagent
        hyprsysteminfo
        papirus-icon-theme
      ];

      wayland.windowManager.hyprland = {
        enable = true;
        # Preserve pre-26.05 HM default; new default is "lua".
        configType = "hyprlang";
        package = hyprlandPackage;
        portalPackage = hyprlandPortalPackage;
        plugins = [ ];
        systemd = {
          enable = false;
          variables = [ "--all" ];
        };
        settings = commonSettings;
      };

    };
  };
}
