# nixos-config

Public NixOS modules, home-manager modules, overlays, and packages. Consumed as
a flake input by a private configuration that supplies host-specific settings,
secrets, and hardware configs.

## Structure

```
modules/nixos/    NixOS modules (all behind mkEnableOption)
modules/home/     Home-manager modules (all behind mkEnableOption)
overlays/         Custom overlays and packages
extra/            Flake-parts helpers (nixos-hosts builder)
patches/          Nixpkgs patches
example/          Minimal working example
tests/            Evaluation tests
```

## Usage

See [example/](example/) for a complete working configuration.

```nix
inputs.nixos-config = {
  url = "github:dembitskyi/nixos-config";
  inputs.nixpkgs.follows = "nixpkgs";
};
```

All modules are gated behind `mine.<name>.enable` / `mine.home.<name>.enable`.
Nothing activates unless explicitly enabled.
