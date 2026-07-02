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

    default = inputs.nixpkgs.lib.composeManyExtensions [
      inputs.self.overlays.custom-packages
      inputs.self.overlays.playwright-mcp-pin
    ];
  };
}
