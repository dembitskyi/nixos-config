_: {
  nix = {
    settings = {
      experimental-features = [
        "nix-command"
        "flakes"
        "pipe-operators"
      ];

      connect-timeout = 2;
      fallback = true;
    };

  };
}
