# keep-sorted start skip_lines=1
(final: prev: {
  browser-use = import ../pkgs/browser-use.nix { pkgs = final; };
  # Pinned ahead of nixpkgs: Opus 5.5 needs >= 2.1.280 and native AGENTS.md on
  # third-party endpoints >= 2.1.281. The guard hands back to nixpkgs once it
  # catches up. Refresh the manifest from
  # https://downloads.claude.ai/claude-code-releases/<version>/manifest.zst.json.
  claude-code =
    let
      manifest = prev.lib.importJSON ./claude-code-manifest.json;
    in
    if prev.lib.versionOlder prev.claude-code.version manifest.version then
      prev.claude-code.override { inherit manifest; }
    else
      prev.claude-code;
  # Pinned ahead of nixpkgs: gpt-6-luna needs >= 0.156.1. ../pkgs/codex holds
  # nixpkgs' own package files, vendored verbatim from NixOS/nixpkgs@d9cdc029,
  # and the guard hands back to nixpkgs once it catches up.
  codex =
    let
      pinned = final.callPackage ../pkgs/codex/package.nix { };
    in
    if prev.lib.versionOlder prev.codex.version pinned.version then pinned else prev.codex;
  lnav = prev.lnav.overrideAttrs (old: {
    postPatch = (old.postPatch or "") + ''
      # Make Ctrl-C a no-op so it cannot accidentally quit lnav.
      # Use :q / :quit to exit.
      substituteInPlace src/lnav.cc \
        --replace-fail \
          '(void) signal(SIGINT, sigint);' \
          '(void) signal(SIGINT, SIG_IGN);'
    '';
  });
  opencode = import ./opencode.nix prev;
  otterwiki = final.callPackage ../pkgs/otterwiki.nix { };

  pythonPackagesExtensions = (prev.pythonPackagesExtensions or [ ]) ++ [
    (_python-final: python-prev: {
      # These two plots/nyquist tests are sensitive to matplotlib/numpy
      # versions and fail on the current nixpkgs; skip just those.
      control = python-prev.control.overridePythonAttrs (old: {
        disabledTests = (old.disabledTests or [ ]) ++ [
          "test_pole_zero_subplots"
          "test_nyquist_basic"
        ];
      });
    })
  ];
})
# keep-sorted end
