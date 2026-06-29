_: {
  nix = {
    settings = {
      experimental-features = "nix-command flakes pipe-operators";

      substituters = [
        "https://hyprland.cachix.org"
      ];
      trusted-public-keys = [
        "hyprland.cachix.org-1:a7pgxzMz7+chwVL3/pzj6jIBMioiJM7ypFP8PwtkuGc="
      ];
      connect-timeout = 2;
      fallback = true;
    };

  };
}
