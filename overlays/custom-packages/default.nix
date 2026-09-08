# keep-sorted start skip_lines=1
(final: prev: {
  browser-use = import ../pkgs/browser-use.nix { pkgs = final; };
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
