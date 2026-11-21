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
    # TUI patch that lets plugins select the prompt's model.
    opencode-pin =
      _final: prev:
      let
        system = prev.stdenv.hostPlatform.system;
        upstream = inputs.opencode.packages.${system};
        # Upstream's nix/hashes.json lags behind bun.lock changes made before
        # the tag, so its node_modules hashes can be stale. Recheck on each tag
        # bump and drop this once upstream's hashes match.
        nodeModulesHash =
          {
            aarch64-linux = "sha256-aYIkUpvJG2FHjcTfQaeuMZR+I89cqMCtXvZ26rnbQPY=";
            x86_64-linux = "sha256-At902X9Dxopt9Z2oHelDXwb9mgM9wPpI44UlQApLVYg=";
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
            ../patches/opencode-plugin-model-set.diff
          ];
          # build.ts re-exports `extension`/`subprotocol` from "ws", which only
          # bun >= 1.4.4's built-in ws provides; the nix bun (1.4.2) lacks them and
          # the compiled binary dies at startup with "Export named 'extension' not
          # found in module 'ws'". Drop this once the nix bun catches up.
          postPatch = (old.postPatch or "") + ''
            substituteInPlace packages/cli/script/build.ts \
              --replace-fail \
                'export { createWebSocketStream, extension, Receiver, Sender, subprotocol, WebSocket, WebSocketServer } from "ws"' \
                'export { createWebSocketStream, Receiver, Sender, WebSocket, WebSocketServer } from "ws"'
          '';
        });
      };

    default = inputs.nixpkgs.lib.composeManyExtensions [
      inputs.self.overlays.opencode-pin
      inputs.self.overlays.custom-packages
      inputs.self.overlays.playwright-mcp-pin
    ];
  };
}
