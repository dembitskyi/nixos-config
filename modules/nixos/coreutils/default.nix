{
  lib,
  config,
  pkgs,
  ...
}:
{

  options = {
    mine.coreutils.enable = lib.mkEnableOption "enable linux coreutils";
  };

  config = lib.mkIf config.mine.coreutils.enable {
    programs.gnupg.agent = {
      enable = true;
      enableBrowserSocket = false;
      enableSSHSupport = false;
      settings = {
        default-cache-ttl = 28800; # 8 hours
      };
    };
    programs.java.enable = true;
    programs.ssh.startAgent = true;

    environment.shells = with pkgs; [ bash ]; # /etc/shells
    programs.firejail.enable = true;
    environment.systemPackages = with pkgs; [
      (python313.withPackages (
        ps: with ps; [
          pyqt6
          pyyaml
          jinja2
          python-uinput
        ]
      ))
      maven
      vim
      rpm
      pstree
      plantuml
      gradle
      bun
      kdePackages.okular
      p7zip
      mpv
      ssh-to-age
      killall
      chrpath
      diffstat
      rpcsvc-proto
      uv
      nix-diff
      gparted
      pciutils
      ninja
      bashInteractive
      lnav
      yt-dlp
      file
      wget
      clang-tools
      net-tools
      picocom
      gnupg
      jq
      atuin
      meson
      cmake
      bc
      git-lfs
      python313.pkgs.pip
      statix
      shellcheck
      nixfmt
      gcc
      clang
      rustup
      socat
      qdirstat
      go
      gdb
      bat
      #steam-run - does not work on aarch64
      cryptsetup
      delta
      curl
      dig
      ethtool
      fd
      ffmpeg
      git
      git-remote-codecommit
      gnumake
      home-manager
      htop
      inetutils
      lshw
      neovim
      netcat
      nmap
      openssl
      pciutils
      python314
      ripgrep
      sops
      tmux
      tree
      unzip
      usbutils
      wget
      wireguard-tools
      zip
      tmux
      fastfetch
      apacheHttpd
    ];
  };
}
