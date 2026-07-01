{
  lib,
  config,
  pkgs,
  ncInputs,
  ...
}:
let
  scripts = ./scripts;

  # Use the pinned hyprland input (v0.53.3) with a glaze compatibility patch,
  # or the latest hyprland from the rolling flake input.
  hyprlandPackage =
    if config.mine.hyprland.pinned then
      ncInputs.hyprland-v0_53_3.packages.${pkgs.stdenv.hostPlatform.system}.default.overrideAttrs (old: {
        patches = (old.patches or [ ]) ++ [ ../../../../patches/hyprland-hyprpm-glaze-7.diff ];
      })
    else
      ncInputs.hyprland.packages.${pkgs.stdenv.hostPlatform.system}.default;

  hyprlandPortalPackage =
    if config.mine.hyprland.pinned then
      ncInputs.hyprland-v0_53_3.packages.${pkgs.stdenv.hostPlatform.system}.xdg-desktop-portal-hyprland
    else
      ncInputs.hyprland.packages.${pkgs.stdenv.hostPlatform.system}.xdg-desktop-portal-hyprland;

  # Settings only valid for the pinned version (v0.53.3).
  pinnedSettings = {
    misc = {
      vfr = true;
    };
  };

  # Settings only valid for the latest version.
  latestSettings = {
  };

  versionSettings = if config.mine.hyprland.pinned then pinnedSettings else latestSettings;
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
    mine.hyprland.pinned = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Use the pinned hyprland version (v0.53.3) instead of the latest.";
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
    ./programs/rofi
  ];

  config = lib.mkIf config.mine.hyprland.enable {
    mine.hyprland.package = hyprlandPackage;
    environment.systemPackages = with pkgs; [
      (import ./scripts/launcher.nix { inherit lib pkgs; })
      ncInputs.noctalia.packages.${pkgs.stdenv.hostPlatform.system}.default

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
    # folder"). Drop the cap to stop the leak; the only cost is no SCHED_RR for
    # Hyprland. Only needed for the pinned version.
    security.wrappers.Hyprland = lib.mkIf config.mine.hyprland.pinned (
      lib.mkForce {
        owner = "root";
        group = "root";
        source = lib.getExe config.programs.hyprland.package;
      }
    );

    # nixpkgs flipped programs.fuse.enable to default false, dropping the SUID
    # fusermount3 wrapper that xdg-document-portal needs; without it the portal
    # exits 6/NOTCONFIGURED. xdg.portal doesn't pull fuse in, so enable it here.
    programs.fuse.enable = true;

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
      ];

      xdg.configFile."hypr/icons" = {
        source = ./icons;
        recursive = true;
      };

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
        settings = lib.recursiveUpdate commonSettings versionSettings;
      };

    };
  };
}
