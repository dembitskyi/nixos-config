{
  ...
}:
{
  nix = {
    settings = {
      experimental-features = "nix-command flakes pipe-operators";

      substituters = [
        "https://ros.cachix.org"
        "https://hyprland.cachix.org"
      ];
      trusted-public-keys = [
        "ros.cachix.org-1:dSyZxI8geDCJrwgvCOHDoAfOm5sV1wCPjBkKL+38Rvo="
        "hyprland.cachix.org-1:a7pgxzMz7+chwVL3/pzj6jIBMioiJM7ypFP8PwtkuGc="
      ];
    };

  };
}
