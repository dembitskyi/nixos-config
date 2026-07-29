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

    # opencode from the pinned upstream flake (see the `opencode` input).
    opencode-pin = _final: prev: {
      opencode = inputs.opencode.packages.${prev.stdenv.hostPlatform.system}.opencode;
    };

    default = inputs.nixpkgs.lib.composeManyExtensions [
      inputs.self.overlays.custom-packages
      inputs.self.overlays.playwright-mcp-pin
      inputs.self.overlays.opencode-pin
    ];
  };
}
