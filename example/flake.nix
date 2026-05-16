{
  description = "Example NixOS configuration using nixos-config modules";

  inputs = {
    nixpkgs.url = "nixpkgs/nixos-unstable";

    nixos-config = {
      url = "path:..";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    flake-parts.url = "github:hercules-ci/flake-parts";
    flake-root.url = "github:srid/flake-root";
  };

  outputs =
    { flake-parts, ... }@inputs:
    flake-parts.lib.mkFlake { inherit inputs; } (
      { ... }:
      {
        imports = [
          inputs.flake-root.flakeModule
          inputs.home-manager.flakeModules.home-manager
          inputs.nixos-config.flakeModules.nixos-hosts
          inputs.nixos-config.flakeModules.overlays
        ];

        systems = [ "x86_64-linux" ];

        nixos-hosts = {
          sharedModules = [
            inputs.home-manager.nixosModules.home-manager
          ];

          hosts = {
            example-host = {
              system = "x86_64-linux";
              modules = [
                inputs.nixos-config.nixosModules.default
                ./configuration.nix
              ];
            };
          };
        };
      }
    );
}
