{
  inputs,
  ...
}:
{
  flake.overlays = {
    custom-packages = import ./custom-packages;

    # Pins playwright-mcp so its MCP tool surface can't drift on nixpkgs bumps.
    playwright-mcp-pin = _final: prev: {
      playwright-mcp =
        inputs.nixpkgs-playwright-mcp.legacyPackages.${prev.stdenv.hostPlatform.system}.playwright-mcp;
    };

    # opencode from the pinned upstream flake (see the `opencode` input), with a
    # TUI patch that lets plugins add tabs to the session composer.
    opencode-pin =
      _final: prev:
      let
        system = prev.stdenv.hostPlatform.system;
        upstream = inputs.opencode.packages.${system};
        # v2.2.5's nix/hashes.json predates the last bun.lock changes before the
        # tag, so upstream's node_modules hashes are stale. Drop this on the next
        # tag bump.
        nodeModulesHash =
          {
            aarch64-linux = "sha256-x903Q+5ThC84PQjCp/4Id/2pRXT7YtYNFHfkLvFsO+0=";
            x86_64-linux = "sha256-+GgLX4lq8fPOJVoDGp220uiCTLB0ZwrBkcNo36q9MZU=";
          }
          .${system} or null;
        opencode =
          if nodeModulesHash == null then
            upstream.opencode
          else
            upstream.opencode.override {
              node_modules = upstream.opencode.node_modules.override { hash = nodeModulesHash; };
            };
      in
      {
        opencode = opencode.overrideAttrs (old: {
          patches = (old.patches or [ ]) ++ [
            ../patches/opencode-composer-plugin-tabs.diff
            ../patches/opencode-plugin-model-set.diff
          ];
        });
      };

    default = inputs.nixpkgs.lib.composeManyExtensions [
      inputs.self.overlays.opencode-pin
      inputs.self.overlays.custom-packages
      inputs.self.overlays.playwright-mcp-pin
    ];
  };
}
