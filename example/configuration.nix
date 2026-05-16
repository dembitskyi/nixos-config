{
  self,
  inputs,
  config,
  pkgs,
  ...
}:
{
  nixpkgs.config.allowUnfree = true;

  # Required base options for a bootable NixOS config.
  boot.loader.grub.devices = [ "/dev/sda" ];
  fileSystems."/" = {
    device = "/dev/sda1";
    fsType = "ext4";
  };
  system.stateVersion = "25.05";

  # Set required variables.
  variables = {
    username = "demo";
    email = "demo@example.com";
    pretty_name = "Demo User";
  };

  # Enable selected modules from the public config.
  mine = {
    coreutils.enable = true;
    fzf.enable = true;
    fonts.enable = true;
    sound.enable = true;
    ollama.enable = true;
    npm.enable = true;
  };

  # Set up a user with home-manager and public home modules.
  users.users.demo = {
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    shell = pkgs.bash;
  };

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;

    extraSpecialArgs = {
      inherit self inputs;
      inherit (config) variables;
    };

    users.demo = {
      imports = [
        inputs.nixos-config.homeModules.default
      ];

      mine.home = {
        starship.enable = true;
        bash.enable = true;
        tmux.enable = true;
        git.enable = true;
        home-manager.enable = true;
      };
    };
  };
}
