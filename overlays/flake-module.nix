{
  inputs,
  ...
}:
{
  flake.overlays = {
    custom-packages = import ./custom-packages;

    default = inputs.nixpkgs.lib.composeManyExtensions [
      inputs.self.overlays.custom-packages
    ];
  };
}
